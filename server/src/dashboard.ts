/**
 * Read-only dashboard (T6 stretch) — served at GET /.
 * Plain HTML/CSS/JS embedded so the reference server has no static-file
 * build step. Uses the REST API for state + SSE (/v1/events) for updates.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentBoard</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel-2: #1e222b; --border: #2a2f3a;
    --text: #d8dee9; --muted: #7b8496; --accent: #6cb2eb; --ok: #4caf7d;
    --warn: #d9a441; --bad: #d96a6a; --dead: #a35bd9;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 12px 20px; background: var(--panel); border-bottom: 1px solid var(--border); }
  h1 { font-size: 16px; margin: 0; color: var(--accent); letter-spacing: .5px; }
  header input, header button { background: var(--panel-2); color: var(--text);
    border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font: inherit; }
  header button { cursor: pointer; }
  header button:hover { border-color: var(--accent); }
  #status { color: var(--muted); font-size: 12px; margin-left: auto; }
  main { padding: 20px; display: grid; grid-template-columns: 320px 1fr; gap: 20px; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin: 0 0 12px; }
  .agent { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .dot.online { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
  .dot.offline { background: #3a4150; }
  .agent .id { font-weight: 600; }
  .agent .meta { color: var(--muted); font-size: 12px; }
  .agent .task { margin-left: auto; font-size: 12px; color: var(--accent); max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: var(--muted); font-style: italic; }
  .thread { margin: 0; padding: 0; }
  .thread li { list-style: none; border-left: 2px solid var(--border); margin-left: 10px; padding: 8px 0 0 14px; }
  .thread .root { border-left: none; margin-left: 0; padding-left: 0; }
  .msg { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
  .msg .row { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .msg .from { color: var(--accent); }
  .msg .arrow { color: var(--muted); }
  .msg .to { color: var(--warn); }
  .msg .type { color: var(--muted); }
  .msg .payload { margin-top: 6px; white-space: pre-wrap; word-break: break-word; }
  .msg .reply { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .badge { font-size: 11px; padding: 1px 8px; border-radius: 10px; border: 1px solid; margin-left: auto; }
  .badge.pending  { color: var(--muted); border-color: var(--border); }
  .badge.claimed  { color: var(--accent); border-color: var(--accent); }
  .badge.done     { color: var(--ok); border-color: var(--ok); }
  .badge.failed   { color: var(--bad); border-color: var(--bad); }
  .badge.dead     { color: var(--dead); border-color: var(--dead); }
  .badge.expired  { color: var(--muted); border-color: var(--border); }
</style>
</head>
<body>
<header>
  <h1>AGENTBOARD</h1>
  <input id="board" placeholder="board (e.g. sprint-7)" size="16">
  <input id="token" type="password" placeholder="workspace token" size="20">
  <button id="connect">connect</button>
  <span id="status">disconnected</span>
</header>
<main>
  <section>
    <h2>Presence</h2>
    <div id="agents"><p class="empty">connect to see agents</p></div>
  </section>
  <section>
    <h2>Board</h2>
    <div id="messages"><p class="empty">connect to see messages</p></div>
  </section>
</main>
<script>
(function () {
  var boardEl = document.getElementById('board');
  var tokenEl = document.getElementById('token');
  var statusEl = document.getElementById('status');
  var agentsEl = document.getElementById('agents');
  var messagesEl = document.getElementById('messages');
  var es = null;
  var pollTimer = null;

  function params() {
    var q = new URLSearchParams(location.search);
    return { board: q.get('board') || '', token: q.get('token') || '' };
  }
  var initial = params();
  boardEl.value = initial.board;
  tokenEl.value = initial.token;
  if (initial.board && initial.token) connect();

  function setStatus(text) { statusEl.textContent = text; }

  function connect() {
    var board = boardEl.value.trim();
    var token = tokenEl.value.trim();
    if (!board || !token) { setStatus('board + token required'); return; }
    if (es) es.close();
    setStatus('listening on ' + board);
    var url = '/v1/events?board=' + encodeURIComponent(board) + '&token=' + encodeURIComponent(token);
    es = new EventSource(url);
    es.onopen = function () { setStatus('listening on ' + board); refresh(board, token); };
    es.onerror = function () { setStatus('SSE error - polling'); };
    es.addEventListener('message', function () { refresh(board, token); });
    es.addEventListener('agent', function () { refresh(board, token); });
    pollTimer = setInterval(function () { refresh(board, token); }, 10000);
    refresh(board, token);
  }

  document.getElementById('connect').addEventListener('click', connect);

  function api(path, token) {
    return fetch(path, { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  function refresh(board, token) {
    api('/v1/agents', token).then(function (d) { renderAgents(d.agents); }).catch(function () {});
    api('/v1/boards/' + encodeURIComponent(board) + '/messages', token)
      .then(function (d) { renderMessages(d.messages); }).catch(function () {});
  }

  function renderAgents(agents) {
    if (!agents.length) { agentsEl.innerHTML = '<p class="empty">no agents yet</p>'; return; }
    agentsEl.innerHTML = agents.map(function (a) {
      var roles = a.roles.length ? a.roles.join(', ') : 'no roles';
      return '<div class="agent"><span class="dot ' + a.presence + '"></span>' +
        '<span class="id">' + escapeHtml(a.agentId) + '</span>' +
        '<span class="meta">' + escapeHtml(a.status) + ' · ' + escapeHtml(roles) + '</span>' +
        (a.currentTask ? '<span class="task" title="' + escapeHtml(a.currentTask) + '">' + escapeHtml(a.currentTask) + '</span>' : '') +
        '</div>';
    }).join('');
  }

  function renderMessages(messages) {
    if (!messages.length) { messagesEl.innerHTML = '<p class="empty">no messages yet</p>'; return; }
    var byId = {};
    messages.forEach(function (m) { byId[m.id] = m; });
    var roots = messages.filter(function (m) { return !m.replyTo || !byId[m.replyTo]; });
    var depth = {};
    function resolve(m) {
      if (depth[m.id] !== undefined) return depth[m.id];
      depth[m.id] = m.replyTo && byId[m.replyTo] ? resolve(byId[m.replyTo]) + 1 : 0;
      return depth[m.id];
    }
    messages.forEach(function (m) { resolve(m); });
    function msgHtml(m) {
      var payload = typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload, null, 2);
      return '<div class="msg"><div class="row">' +
        '<span class="from">' + escapeHtml(m.from) + '</span><span class="arrow">→</span>' +
        '<span class="to">' + escapeHtml(m.to) + '</span>' +
        '<span class="type">[' + escapeHtml(m.type) + ']</span>' +
        '<span class="badge ' + m.state + '">' + m.state + '</span></div>' +
        '<div class="payload">' + escapeHtml(payload) + '</div>' +
        (m.replyTo ? '<div class="reply">↳ replies to ' + escapeHtml(m.replyTo) + '</div>' : '') +
        '</div>';
    }
    var html = '<ul class="thread">';
    roots.forEach(function (root) {
      html += '<li class="root">' + msgHtml(root);
      var kids = messages.filter(function (m) { return m.replyTo === root.id; });
      if (kids.length) {
        html += '<ul class="thread">' + kids.map(function (k) { return '<li>' + msgHtml(k) + '</li>'; }).join('') + '</ul>';
      }
      html += '</li>';
    });
    html += '</ul>';
    messagesEl.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
})();
</script>
</body>
</html>
`;