# Contributing to the Heliyos MCP server

Thank you for helping make Heliyos easier to use from AI agents. This document covers the development workflow, the rules every change follows, how to add a tool, and the one-time setup a maintainer needs to publish releases.

## Getting started

```sh
git clone https://github.com/heliyos-ai/heliyos-mcp.git
cd heliyos-mcp
npm ci
npm test
```

You need Node.js 20 or later. The tests run against a mocked Heliyos API, so no API key is required for development. `npm run smoke` runs read-only checks against a real workspace when `HELIYOS_API_KEY` is set; it is optional.

Useful commands:

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests (vitest) with a mocked API |
| `npm run typecheck` | `tsc` over source and tests |
| `npm run build` | Code generation from the OpenAPI copies, then `tsc` into `dist/` |
| `npm run readme:tools` | Regenerates the tool table in the README from the registered tools |
| `npm run test:update-tool-snapshot` | Refreshes the snapshot of the public tool contract after an intentional change |
| `npm run prepublish:check` | Checks manifests, versions and package contents before a release |
| `npm run install-links` | Prints the Cursor and VS Code install links used in the README |

## Repository layout

```
src/
  bin/stdio.ts        the executable: reads config, starts the server over stdio
  index.ts            assembles the server: tools, resources, prompts, in a fixed order
  config.ts           environment variables and their validation
  client/             HTTP client, the generated operation table, bundled OpenAPI copies
  tools/              one file per resource; define.ts is the only way to register a tool
  format/             text rendering that keeps results inside client size limits
  secrets.ts          redaction so no credential ever reaches a tool result
scripts/              codegen, README table, version bump, prepublish checks
skills/heliyos/       the agent skill shipped with the Claude Code plugin
tests/                vitest suites, msw fixtures, the tool contract snapshot
```

## Rules every change follows

1. **The server only calls the Heliyos API.** It never embeds business logic that belongs in Heliyos, never reaches another service, and never stores anything on disk.
2. **No secrets in results.** Every tool result passes through `src/secrets.ts`. Tests assert that the API key never appears in text, structured content or errors. Keep it that way.
3. **One registration path.** Tools go through `defineTool` in `src/tools/define.ts`, which enforces the naming rule `heliyos_<resource>_<verb>`, explicit annotations and an output schema.
4. **Every parameter is described.** A tool input without a `.describe()` is a bug; agents only see what the description says.
5. **Reads take `response_format`, lists take `limit` and `cursor`.** Use the helpers in `src/tools/common.ts` rather than new conventions.
6. **No em dashes** in any text an agent or a user reads. Use a full stop, a comma or a colon.
7. **Validate before you send.** Refuse bad input locally with a message that says how to fix it, instead of letting the API answer 400.
8. **Tests for every tool.** Each tool has at least one happy path, one validation failure that proves no request was sent, and one API error that is surfaced with its code.

## Adding a tool

1. Pick the resource file in `src/tools/` or create one. Export a `xxxTools(ctx)` function that returns `ToolSpec[]`, and register it in `src/index.ts` in the right place in the order.
2. Reference the API operation by its `operationId` through `callOperation(client, "operationId", ...)`. The code generator only emits operations that are referenced, so run `npm run build` after adding one.
3. Write the input schema with zod and a description on every field, an output schema for `structuredContent`, and a `description` that says when to use the tool, what it returns and which tool to use instead when this one does not fit.
4. Choose annotations from `src/tools/common.ts`: `READ_ONLY`, `CREATES`, `UPDATES`, `REPLACES`, `DESTROYS`, `STARTS_RUN` or `DECIDES`.
5. Add tests in `tests/tools/`, then run `npm run readme:tools` and `npm run test:update-tool-snapshot` and commit the generated changes.
6. If the agent should know when to reach for it, update `skills/heliyos/SKILL.md`.
7. Add the tool to `scripts/tool-table.mjs` groups if no group pattern claims it; the README check fails otherwise.

## Updating the API client

The bundled OpenAPI documents in `src/client/openapi/` are the source of truth for request validation. When the Heliyos API changes:

```sh
curl -s https://api-prod.heliyos.ai/v1/platform/openapi.json -o /tmp/platform.json
curl -s https://api-prod.heliyos.ai/v1/auth/openapi.json -o /tmp/auth.json
HELIYOS_PLATFORM_OPENAPI=/tmp/platform.json HELIYOS_AUTH_OPENAPI=/tmp/auth.json npm run sync-openapi
npm run codegen && npm test
```

Commit the updated JSON and `src/client/generated.ts` together. CI checks that the generated file matches the bundled documents.

## Pull requests

- Branch from `main`, keep one change per PR, and fill in the PR template.
- CI runs on every PR: codegen drift, typecheck, tests on Node 20 and 22, build, README table, package checks and plugin validation. All of it must be green.
- A maintainer reviews within a few working days. Small, well-tested PRs merge fastest.

## Releasing (maintainers)

Every push to `main` publishes. The workflow in `.github/workflows/publish-package.yml` bumps the patch version if the current one is already on npm, publishes to npm with provenance, and then to the MCP registry.

### One-time setup

**npm, trusted publishing (no token is stored anywhere).**

1. Publish the first version by hand from a machine logged in to npm as a member of the `@heliyos` organisation: `npm publish --access public`. npm needs the package to exist before a trusted publisher can be attached to it.
2. On npmjs.com open the package, **Settings**, **Publishing access**, **Add trusted publisher**: provider GitHub Actions, organisation `heliyos-ai`, repository `heliyos-mcp`, workflow filename `publish-package.yml`, environment `release`.
3. Optionally set **Require two-factor authentication or an automation token or trusted publisher** so nothing else can publish.

**GitHub repository.**

1. **Settings**, **Environments**, create `release`. Under deployment branches allow `main` only.
2. In that environment add two secrets: `GIT_USER_EMAIL` and `GIT_USER_NAME`, the identity the workflow commits version bumps with (a bot account or a maintainer).
3. **Settings**, **Actions**, **General**: workflow permissions "Read and write permissions" are not needed; the workflow requests `contents: write` and `id-token: write` itself.
4. Protect `main`: require the Test workflow to pass before merging.

**MCP registry (optional, adds the server to registry.modelcontextprotocol.io).**

```sh
openssl genpkey -algorithm Ed25519 -out heliyos-mcp.pem
# TXT record value for the apex domain heliyos.ai
echo "v=MCPv1; k=ed25519; p=$(openssl pkey -in heliyos-mcp.pem -pubout -outform DER | tail -c 32 | base64)"
# value of the MCP_PRIVATE_KEY secret (64 hex characters)
openssl pkey -in heliyos-mcp.pem -noout -text | grep -A3 'priv:' | grep -v priv | tr -d ' :\n'
```

Add the TXT record on `heliyos.ai`, then add `MCP_PRIVATE_KEY` to the `release` environment. Until that secret exists the registry steps are skipped and the npm publish still runs.

### Cutting a specific version

```sh
node scripts/set-version.mjs 1.2.0
git add -A && git commit -m "Release 1.2.0"
git push origin main
```

`set-version.mjs` keeps `package.json`, the lockfile, `server.json`, every plugin manifest and `src/version.ts` in step. Add the release notes to `CHANGELOG.md` in the same commit.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind, be precise, assume good faith.
