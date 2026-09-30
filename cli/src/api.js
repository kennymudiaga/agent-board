/**
 * Minimal HTTP client for the AgentBoard v0.1 protocol (docs/spec.md).
 * Node >= 20 (global fetch).
 */

export class CliError extends Error {
  constructor(message, { status, code, originalMessageId } = {}) {
    super(message);
    this.name = 'CliError';
    this.status = status;
    this.code = code;
    this.originalMessageId = originalMessageId;
  }
}

export async function apiCall(cfg, method, path, { agent, body } = {}) {
  const headers = {
    authorization: `Bearer ${cfg.token}`,
    'content-type': 'application/json',
  };
  if (agent) headers['x-agent-id'] = agent;

  let res;
  try {
    res = await fetch(`${cfg.server}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    throw new CliError(`cannot reach server at ${cfg.server} (${cause.message})`);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error;
    throw new CliError(e?.message ?? `HTTP ${res.status}`, {
      status: res.status,
      code: e?.code,
      originalMessageId: e?.originalMessageId,
    });
  }
  return data;
}