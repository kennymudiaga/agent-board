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

## Trusted publishing (chosen path)

npm has removed classic tokens; direct publish with bypass-2FA GATs dies
January 2027. We publish with **no token at all**:

1. Go to npmjs.com → account → **Access → Trusted Publishers → Add publisher**.
2. Configure:
   - **Provider:** GitHub Actions
   - **Package:** `@agentboard/cli`
   - **Owner:** `kennymudiaga`
   - **Repository:** `agent-board`
   - **Workflow:** `release.yml` (restricts publishing to the release workflow)
   - **Environments:** leave empty (or `release` if you create one)
3. That's it — the workflow's `permissions: { id-token: write }` + `npm
   publish --provenance` does the rest. No secrets needed.

### Fallback (if trusted publishing is unavailable)

A **stage-only Granular Access Token** (scope: `@agentboard/cli`, "Read and
write (stage and publish)" is NOT allowed — choose **stage only**):

1. `npm stage publish --workspace cli` (workflow change) → package staged.
2. A human approves with 2FA: `npm stage approve` (or npmjs.com UI).
3. `npm stage promote` or leave staged; the release notes link it.

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

## Account-owner checklist (one-time)

- [ ] npm trusted publisher bound: `@agentboard/cli` → `kennymudiaga/agent-board` → `release.yml`
- [ ] (fallback only) stage-only GAT installed as repo secret `NPM_TOKEN` **with the workflow switched to `npm stage publish`**
- [ ] ghcr is public (Package settings → Change visibility) or the pull
      verify step uses an authenticated `docker login`

## CI parity

`ci.yml` runs build + tests + a Docker build on every PR (the Docker job
catches Dockerfile drift before it reaches a tag).