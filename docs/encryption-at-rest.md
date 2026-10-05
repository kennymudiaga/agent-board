# At-rest encryption (`AB_ENCRYPTION_KEY`) — spike record + implementation (sprint 10 T3, #111)

> Authority: `docs/spec.md` §10.7 (resolved direction). This page records the
> spike choice, the implementation, and the migration path for existing
> deployments. Security-sensitive: the merge gate is **independent QA sign-off**.

## The choice: field-level AES-256-GCM (not SQLCipher)

The sprint-6 decision (#71) already compared the two candidates. The board gate
re-ran the spike on this machine (win32, Node v24, the repo's own dev platform):

| Criterion | SQLCipher (`@journeyapps/sqlcipher`) | Field-level AES (`node:crypto`) |
|---|---|---|
| Install on win32 | **`EBADPLATFORM`** — v6.0.0 declares `os: darwin,linux`; uninstallable on this repo's dev/CI platform | Pure JS/native Node — works everywhere |
| DB file format | changes (SQLCipher file) → dump/restore migration | unchanged → additive, in-place |
| Encryption scope | whole file | `payload` column only (everything else the server must read stays plaintext by design — dashboard previews, `reads` aggregates, wake prompts) |
| Key story | env/file/KMS + native build | `AB_ENCRYPTION_KEY` env → scrypt → AES-256-GCM |
| Measured cost (this machine) | n/a (not installable) | 32,481 enc/s over 20k real-payload samples (~16 MB); ~39.7% payload-cell growth on small payloads (a ~145-byte constant IV+tag+base64 per cell; ~4% at 4 KB) |

**Decision: field-level AES-256-GCM.** Zero native dependencies, keeps the
SQLite format (no dump/restore), scopes encryption to exactly what the spec
allows, and byte-identical behavior when the key is absent.

## Envelope

A stored `payload` cell is either plaintext JSON (legacy rows, or any
deployment without a key) or an `abenc1:`-prefixed, self-describing envelope:

```
abenc1:<iv-base64>.<gcm-tag-base64>.<ciphertext-base64>
```

- **Algorithm:** AES-256-GCM (authenticated — tamper detection, not just secrecy).
- **Key derivation:** `scrypt(AB_ENCRYPTION_KEY, salt="agentboard-payload-at-rest-v1", 32 bytes)`.
- **IV:** 12 random bytes per payload (GCM standard); tag: 16 bytes.
- **GCM auth:** a wrong key or a tampered cell throws during read — never
  returns corrupted plaintext.

## Behavior

- `AB_ENCRYPTION_KEY` **unset** (the default, transport-only stance): the cipher
  is a pass-through. Schema, payload cells, and every byte are identical to
  pre-feature behavior — covered by a test asserting a plaintext, un-enveloped
  cell.
- `AB_ENCRYPTION_KEY` **set**: every newly written payload is encrypted before
  the `INSERT` and transparently decrypted at every read (pickup, observability
  views, replies, the A2A relay, dashboard previews — all share the same
  decryption point in `toMessage`). Encryption and decryption live at the
  payload-cell boundary in `server/src/db.ts` (`Store`), keyed from
  `server/src/crypto.ts`.
- **Mixed databases read transparently:** rows written before a key was set stay
  plaintext and read as-is; only `abenc1:` envelopes are decrypted.

## Security boundary (what is and is not encrypted)

Only the **`payload` column** is encrypted at rest. Every other column —
message ids, `seq`, `board`, addressing (`to`/`from`), `type`, `state`,
`attempts`, `claim_agent`, leases, timestamps, `reply_to`, `idempotency_key`,
and the workspace/board/agent metadata — stays plaintext by design: the server
needs it to query, route, water-mark, scope, and map A2A tasks. The guarantee
this feature provides is precisely *"an untrusted disk cannot read message
contents"*, not *"the table structure is hidden"*.

## Migration path (existing deployments)

**In-place — no dump/restore required:**

1. Set `AB_ENCRYPTION_KEY` in the server env and restart.
2. Existing rows keep their plaintext payloads (readable, unchanged); all *new*
   writes are encrypted at rest.
3. To encrypt historical rows too, re-send/rewrite them (e.g. a one-off replay
   of the message history) — or leave them: mixed databases are fully supported
   and equally readable.
4. **Removing the key is DESTRUCTIVE.** To disable the feature you must set
   `AB_ENCRYPTION_KEY` to its previous value every time the process restarts;
   if the key is truly removed, the pass-through default cannot decrypt
   `abenc1:` cells and every encrypted row becomes unreadable (reads fail with
   an explicit error naming `AB_ENCRYPTION_KEY`). The key is the only secret
   material and must be backed up to recover a keyed database — treat key
   removal like throwing away the DB.

## Key management notes

- The key is a secret: put it in the process environment (or the deployment
  secret store / container secret), never in the repository, message payloads,
  or logs.
- Key rotation is out of scope for v0.5 (documented in the sprint plan as
  post-v0.5 hardening alongside KMS integration).