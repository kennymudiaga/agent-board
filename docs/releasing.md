# Releasing AgentBoard

How a release happens, and what the account owner must set up once.

## Versioning

The sprint ships one release. Version numbers live in `package.json` files
(root, `cli/`, `server/`, `mcp/`, `vscode-ext/`) and the protocol version in
`docs/spec.md` — keep them in sync. A release is a `vX.Y.Z` tag on `main`.

## Release flow (fully automated on tag)

Tag `v0.2.1` (e.g. `git tag v0.2.1 && git push origin v0.2.1`) triggers
`.github/workflows/release.yml`:

1. `npm-publish` — build + test, then `npm publish --workspace cli --access
   public --provenance` via **trusted publishing (OIDC)** — no token in the
   repo or workflow.
2. `ghcr-push` — builds the server image and pushes
   `ghcr.io/kennymudiaga/agent-board:<tag>` + `:latest`.
3. `github-release` — GitHub Release with auto-generated notes.

## Trusted publishing (chosen path — after first publish)

npm has removed classic tokens; direct publish with bypass-2FA GATs dies
January 2027. **Trusted publishing (OIDC) is the long-term path** — no token
at all — but npm requires the package to already exist on the registry before
a trusted publisher can be bound. So:

- **First publish (v0.2.1): stage-only GAT** (below) creates `@agentboard/cli`
  on the registry.
- **Then:** bind the trusted publisher (below) and switch the workflow back to
  OIDC (`id-token: write`, no token, `npm publish --provenance`).

### Binding the trusted publisher (after first publish)

1. Go to npmjs.com → account → **Access → Trusted Publishers → Add publisher**.
2. Configure:
   - **Provider:** GitHub Actions
   - **Package:** `@agentboard/cli`
   - **Owner:** `kennymudiaga`
   - **Repository:** `agent-board`
   - **Workflow:** `release.yml` (restricts publishing to the release workflow)
   - **Environments:** `release`
3. Switch `release.yml`'s npm job to OIDC: drop `NODE_AUTH_TOKEN`, add
   `permissions: { id-token: write }`, publish with `--provenance`.

### Stage-only GAT (first publish, current)

A **stage-only Granular Access Token** (scope: `@agentboard/cli`, "stage only" —
never direct publish):

1. Create the GAT on npmjs.com → install as repo secret `NPM_TOKEN` in a
   `release` **environment** (Settings → Environments → release → secrets).
2. The workflow's npm job already runs with `environment: release` and
   `npm stage publish` — the package lands **staged**.
3. A human approves with 2FA: `npm stage approve` (or the npmjs.com UI).
4. `npm stage promote` (or the UI) makes it live.

This keeps a human in the loop per release and never creates a long-lived
direct-publish token.

## Verify after a release

```bash
# clean machine
npm i -g @agentboard/cli && ab --version   # → ab 0.2.1
docker pull ghcr.io/kennymudiaga/agent-board:v0.2.1

# provenance
npm view @agentboard/cli@0.2.1 --json | grep -i provenance
```

## Account-owner checklist

**For the first publish (v0.2.1):**

- [ ] Create a **stage-only** GAT scoped to `@agentboard/cli`
- [ ] Create the `release` environment (Settings → Environments) and install the GAT as `NPM_TOKEN`
- [ ] Tag `v0.2.1` → workflow stages the package → run `npm stage approve` (2FA) to publish
- [ ] ghcr: image auto-pushes via the workflow (`packages: write`); make the package public or verify with an authenticated pull

**After the first publish (migrate to OIDC):**

- [ ] Bind the trusted publisher: `@agentboard/cli` → `kennymudiaga/agent-board` → `release.yml` → environment `release`
- [ ] Switch the npm job to OIDC (`id-token: write`, `--provenance`, drop `NODE_AUTH_TOKEN`); optionally delete the GAT

## CI parity

`ci.yml` runs build + tests + a Docker build on every PR (the Docker job
catches Dockerfile drift before it reaches a tag).