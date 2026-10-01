# Releasing AgentBoard

How a release happens, and what the account owner must set up once.

## Versioning

The sprint ships one release. Version numbers live in `package.json` files
(root, `cli/`, `server/`, `mcp/`, `vscode-ext/`) and the protocol version in
`docs/spec.md` — keep them in sync. A release is a `vX.Y.Z` tag on `main`.

## Release flow (tag-triggered)

Tag `v0.2.1` (for example, `git tag v0.2.1 && git push origin v0.2.1`) triggers
`.github/workflows/release.yml`:

1. `npm-publish` — build + test, then the one-time bootstrap publish of
   `@agent_board/cli` using the publish-and-stage GAT in the `release`
   environment.
2. `ghcr-push` — builds the server image and pushes
   `ghcr.io/kennymudiaga/agent-board:<tag>` + `:latest`.
3. `github-release` — creates a GitHub Release with generated notes.

## First publish: publish-and-stage GAT

`@agent_board/cli` is the first package in the new `agent_board` organization
scope. For this bootstrap only, use a Granular Access Token with **Read and
write (publish and stage)** and **Bypass 2FA** enabled:

1. Store the token as `NPM_TOKEN` in the GitHub `release` environment.
2. The workflow runs `npx --yes npm@12 publish --workspace cli --access public`.
3. Review the package at `https://www.npmjs.com/package/@agent_board/cli`.
4. If npm presents an approval prompt, approve it interactively with 2FA.

The token is used only to bootstrap the first package. Do not use it for
routine releases; bypass-2FA direct publishing is being deprecated. Revoke it
after the bootstrap and replace it with the chosen long-term path below.

## Future releases

### Preferred: trusted publishing (OIDC)

After `@agent_board/cli` exists on npm, configure the trusted publisher from
the package's npm access/settings page:

- Provider: GitHub Actions
- Package: `@agent_board/cli`
- Owner: `kennymudiaga`
- Repository: `agent-board`
- Workflow: `release.yml`
- Environment: `release`

Then change the npm job to add `id-token: write`, remove `NODE_AUTH_TOKEN`,
and run `npm publish --workspace cli --access public --provenance`.
No long-lived npm token is needed.

### Alternative: stage-only GAT

For a human approval gate on every release, create a GAT scoped to
`@agent_board/cli` with **Read and write — stage only**:

1. Store it as `NPM_TOKEN` in the `release` environment.
2. Run `npx --yes npm@12 stage publish --workspace cli --access public`.
3. Review with `npm stage list` / `npm stage view <stage-id>` or the npm UI.
4. Approve with 2FA using `npm stage approve <stage-id>`.

## Verify after a release

```bash
# clean machine
npm i -g @agent_board/cli && ab --version   # → ab 0.2.1
docker pull ghcr.io/kennymudiaga/agent-board:v0.2.1

# package metadata
npm view @agent_board/cli@0.2.1 --json
```

## Account-owner checklist

**Bootstrap v0.2.1:**

- [x] Create `agent_board` organization/scope
- [x] Create publish-and-stage GAT with `@agent_board` package/scope access
- [x] Create `release` environment and add `NPM_TOKEN`
- [x] Tag `v0.2.1`
- [x] Package is public at `@agent_board/cli@0.2.1` (no approval prompt was required)

**After bootstrap:**

- [ ] Revoke the publish-and-stage GAT
- [ ] Bind trusted publishing for `@agent_board/cli`, or create a stage-only GAT
- [ ] Update `release.yml` to the selected routine-release path

## CI parity

`ci.yml` runs build + tests + a Docker build on every PR. The Docker job
catches Dockerfile drift before it reaches a tag.