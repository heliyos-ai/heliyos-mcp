<p align="center">
  <a href="https://www.heliyos.ai">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/heliyos-ai/heliyos-mcp/main/assets/logo-dark.png">
      <img alt="Heliyos" src="https://raw.githubusercontent.com/heliyos-ai/heliyos-mcp/main/assets/logo-light.png" width="220">
    </picture>
  </a>
</p>

<h1 align="center">Heliyos MCP server</h1>

<p align="center">
  Connect AI agents to <a href="https://www.heliyos.ai">Heliyos</a>, the AI operating system for revenue.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@heliyos/heliyos-mcp"><img alt="npm version" src="https://img.shields.io/npm/v/%40heliyos%2Fmcp?label=npm"></a>
  <a href="https://github.com/heliyos-ai/heliyos-mcp/actions/workflows/test.yml"><img alt="CI" src="https://github.com/heliyos-ai/heliyos-mcp/actions/workflows/test.yml/badge.svg"></a>
  <a href="https://nodejs.org"><img alt="Node 20+" src="https://img.shields.io/badge/node-%3E%3D20-brightgreen"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://modelcontextprotocol.io"><img alt="MCP" src="https://img.shields.io/badge/protocol-MCP-black"></a>
</p>

`@heliyos/heliyos-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server for [Heliyos](https://www.heliyos.ai). It runs on your machine over stdio and calls the [Heliyos API](https://docs.heliyos.ai/api-reference/introduction) with a workspace API key, so an agent in Claude Code, Codex, Cursor, VS Code, Antigravity or any other MCP client can work in your CRM.

**Documentation: [docs.heliyos.ai/mcp](https://docs.heliyos.ai/mcp/overview)** · [Install guides](https://docs.heliyos.ai/mcp/install) · [All tools](https://docs.heliyos.ai/mcp/tools/index) · [API reference](https://docs.heliyos.ai/api-reference/introduction) · [Changelog](CHANGELOG.md)

With it, an agent can:

- find and update companies, people, deals and custom objects, and add fields to them
- read a record's timeline, change history, emails and meetings
- write notes and tasks, and start Heliyos workers on a task
- list the reviews waiting for a person and approve or reject them
- create and configure workers from the trigger and tool catalogs
- manage scouts, read their signals and keep the watchlist
- read and edit the knowledge base, and upload the files the workers read
- hand a job to Heliyos with `heliyos_ask` and follow the run

Important actions that workers take still wait for review in Heliyos, so the team stays in control.

## Quick start

1. Create an API key in Heliyos under **Settings → API keys** (details [below](#before-you-start)).
2. Add the server to your client. For Claude Code:

   ```sh
   claude mcp add --transport stdio --env HELIYOS_API_KEY=YOUR_HELIYOS_API_KEY --scope user heliyos -- npx -y @heliyos/heliyos-mcp
   ```

3. Ask your agent *"Which Heliyos workspace am I connected to?"*. It calls `heliyos_organization_get` and answers with your workspace name.

Every other client is covered in [Install](#install).

## Contents

- [Quick start](#quick-start)
- [Before you start](#before-you-start)
- [Install](#install)
- [Tool timeout](#tool-timeout)
- [Configuration](#configuration)
- [Tools](#tools)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Before you start

You need Node.js 20 or later (`node -v`) and a Heliyos API key.

To create a key:

1. Open Heliyos and go to **Settings → API keys** ([gtm.heliyos.ai/settings/api-keys](https://gtm.heliyos.ai/settings/api-keys)).
2. Click **New key**. Give it a name you will recognise, such as "Claude Code on my laptop", and an expiry date if you want one, then click **Create key**.
3. Copy the key. It starts with `heliyos_` and is shown once. If you lose it, revoke it and create a new one.

Only workspace owners and admins can create keys. A key has admin access to one workspace, the one you created it in, and to nothing else. Use one key per person and machine, so you can revoke one without breaking the others.

## Install

Every client runs the same command, `npx -y @heliyos/heliyos-mcp`, with your key in the `HELIYOS_API_KEY` environment variable. In the snippets below, replace `YOUR_HELIYOS_API_KEY` with your key.

### Claude Code

Install the plugin. It asks for your key and keeps it in your system's secure credential store, and it adds a skill that teaches Claude when to use which tool.

```sh
claude plugin marketplace add heliyos-ai/heliyos-mcp
claude plugin install heliyos@heliyos
```

Or add only the MCP server:

```sh
claude mcp add --transport stdio --env HELIYOS_API_KEY=YOUR_HELIYOS_API_KEY --scope user heliyos -- npx -y @heliyos/heliyos-mcp
```

Check it with `claude mcp list`, or `/mcp` inside a session.

### Claude Desktop

Open **Settings → Developer → Edit Config** and add the server to `claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "heliyos": {
      "command": "npx",
      "args": ["-y", "@heliyos/heliyos-mcp"],
      "env": { "HELIYOS_API_KEY": "YOUR_HELIYOS_API_KEY" }
    }
  }
}
```

This file stores the key in plain text, so keep it private. Custom connectors on claude.ai and in the Claude connector directory need a hosted (remote) MCP server with OAuth. Heliyos does not offer one yet, so use a local client for now.

### Codex

Add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.heliyos]
command = "npx"
args = ["-y", "@heliyos/heliyos-mcp"]
env_vars = ["HELIYOS_API_KEY"]
startup_timeout_sec = 30
tool_timeout_sec = 120
```

`env_vars` passes `HELIYOS_API_KEY` from the shell you start Codex in, so export it there (for example in `~/.zshrc`). To keep the key in the file instead, replace the `env_vars` line with an env table at the end:

```toml
[mcp_servers.heliyos.env]
HELIYOS_API_KEY = "YOUR_HELIYOS_API_KEY"
```

The CLI does the same in one line, after which you add `tool_timeout_sec = 120` to the table it writes:

```sh
codex mcp add heliyos --env HELIYOS_API_KEY=YOUR_HELIYOS_API_KEY -- npx -y @heliyos/heliyos-mcp
```

### Cursor

[Add Heliyos to Cursor](https://cursor.com/install-mcp?name=heliyos&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBoZWxpeW9zL2hlbGl5b3MtbWNwIl0sImVudiI6eyJIRUxJWU9TX0FQSV9LRVkiOiIke2VudjpIRUxJWU9TX0FQSV9LRVl9In19)

The link opens this deeplink, which you can also paste into your browser:

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=heliyos&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBoZWxpeW9zL2hlbGl5b3MtbWNwIl0sImVudiI6eyJIRUxJWU9TX0FQSV9LRVkiOiIke2VudjpIRUxJWU9TX0FQSV9LRVl9In19
```

It adds this entry to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "heliyos": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@heliyos/heliyos-mcp"],
      "env": { "HELIYOS_API_KEY": "${env:HELIYOS_API_KEY}" }
    }
  }
}
```

Cursor reads `${env:HELIYOS_API_KEY}` from its own environment. Export the variable in your shell profile and start Cursor from that shell, or replace the value with your key. Run `npm run install-links` in this repository to print the links again.

### VS Code

[Install Heliyos in VS Code](https://vscode.dev/redirect/mcp/install?name=heliyos&inputs=%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22heliyos-api-key%22%2C%22description%22%3A%22Heliyos+API+key+%28Settings+%E2%86%92+API+keys%29%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40heliyos%2Fheliyos-mcp%22%5D%2C%22env%22%3A%7B%22HELIYOS_API_KEY%22%3A%22%24%7Binput%3Aheliyos-api-key%7D%22%7D%7D)

The link opens this deeplink, which you can also paste into your browser:

```text
vscode:mcp/install?%7B%22name%22%3A%22heliyos%22%2C%22inputs%22%3A%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22heliyos-api-key%22%2C%22description%22%3A%22Heliyos%20API%20key%20(Settings%20%E2%86%92%20API%20keys)%22%2C%22password%22%3Atrue%7D%5D%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40heliyos%2Fheliyos-mcp%22%5D%2C%22env%22%3A%7B%22HELIYOS_API_KEY%22%3A%22%24%7Binput%3Aheliyos-api-key%7D%22%7D%7D)%22%2C%22password%22%3Atrue%7D%5D%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40heliyos%2Fmcp%22%5D%2C%22env%22%3A%7B%22HELIYOS_API_KEY%22%3A%22%24%7Binput%3Aheliyos-api-key%7D%22%7D%7D
```

VS Code asks for the key the first time the server starts and keeps it in its secret storage. To set it up by hand, add this to `.vscode/mcp.json` in a project, or to your user `mcp.json` (**MCP: Open User Configuration**):

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "heliyos-api-key",
      "description": "Heliyos API key (Settings → API keys)",
      "password": true
    }
  ],
  "servers": {
    "heliyos": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@heliyos/heliyos-mcp"],
      "env": { "HELIYOS_API_KEY": "${input:heliyos-api-key}" }
    }
  }
}
```

### Antigravity

In the agent panel, open **… → MCP Servers → Manage MCP Servers → View raw config**, or edit `~/.gemini/config/mcp_config.json` directly (`.agents/mcp_config.json` for one project):

```json
{
  "mcpServers": {
    "heliyos": {
      "command": "npx",
      "args": ["-y", "@heliyos/heliyos-mcp"],
      "env": { "HELIYOS_API_KEY": "YOUR_HELIYOS_API_KEY" }
    }
  }
}
```

### Any other client

Run the package over stdio with the key in the environment:

```sh
HELIYOS_API_KEY=YOUR_HELIYOS_API_KEY npx -y @heliyos/heliyos-mcp
```

The repository also ships portable [Agent Plugins](https://agent-plugins.org) manifests (`plugin.json` and `mcp.json`) for clients that install plugins from a Git repository. They do not carry a key, so set `HELIYOS_API_KEY` in the environment your client starts servers with. In the MCP Registry the server is listed as `ai.heliyos/heliyos-mcp`.

## Tool timeout

`heliyos_ask` waits up to 90 seconds for Heliyos to answer, so give tool calls at least 120 seconds.

| Client | Setting |
| --- | --- |
| Codex | `tool_timeout_sec = 120` in the `[mcp_servers.heliyos]` table (the default is 60). Installed as a plugin from a marketplace, Codex keeps the 60 second default, because the plugin's `.mcp.json` cannot carry `tool_timeout_sec`, so a long `heliyos_ask` stops at 60 seconds; use the `config.toml` setup above for 120. |
| Claude Code | The default is long enough. If you set `MCP_TOOL_TIMEOUT`, keep it at 120000 or more, for example `MCP_TOOL_TIMEOUT=120000 claude`. |
| Claude Desktop | No documented setting. |
| Cursor | No documented tool timeout setting. |
| VS Code | No documented tool timeout setting. |
| Antigravity | No documented tool timeout setting. |

When a client cuts a call short, the run keeps going in Heliyos. Find it with `heliyos_runs_list` and follow it with `heliyos_runs_get` and `wait: true`, which waits up to 30 seconds per call.

A rate-limited request (HTTP 429) is retried once after the `Retry-After` delay, capped at 30 s, so a `heliyos_ask` that hits the limit can take about 125 seconds. If you see timeouts while you are near the limit, raise the timeout to 150 seconds.

## Configuration

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `HELIYOS_API_KEY` | Yes | None | Your Heliyos API key. It must start with `heliyos_`. |
| `HELIYOS_BASE_URL` | No | `https://api-prod.heliyos.ai` | The Heliyos API to call. It must use https; plain http is accepted only for localhost. |
| `HELIYOS_MCP_EXPERIMENTAL` | No | Off | `1`, `true`, `yes` or `on` adds the experimental tools marked below. |

The server also offers a resource template, `heliyos://records/{id}`, which returns one record as JSON, and two prompts: `prepare_account_review` (for one company) and `daily_pipeline_summary`.

## Tools

Every tool is named `heliyos_<resource>_<verb>` and declares whether it reads, writes or deletes, so your client can ask before it changes anything. Reads take `response_format` (`concise` or `detailed`), and lists take `limit` and `cursor`.

<!-- tools:start (generated by scripts/tool-table.mjs; do not edit) -->
73 tools by default, and 4 more with `HELIYOS_MCP_EXPERIMENTAL=1`. Kind is read (no changes), write (creates or updates) or destructive (deletes or removes).

#### Records

| Tool | What it does | Kind |
| --- | --- | --- |
| `heliyos_records_list` | List records | read |
| `heliyos_records_get` | Get a record | read |
| `heliyos_records_create` | Create a record | write |
| `heliyos_records_update` | Update a record | write |
| `heliyos_records_delete` | Delete records | destructive |
| `heliyos_records_lookup` | Find records by name | read |
| `heliyos_records_enrich` | Enrich a person (experimental) | write |

#### Timeline and activity

| Tool | What it does | Kind |
| --- | --- | --- |
| `heliyos_records_timeline` | Read a record's timeline | read |
| `heliyos_records_events` | Read a record's change history | read |
| `heliyos_interactions_list` | List emails and meetings | read |
| `heliyos_interactions_get` | Get an email or meeting | read |

#### Workspace, objects and fields

| Tool | What it does | Kind |
| --- | --- | --- |
| `heliyos_organization_get` | Get the workspace | read |
| `heliyos_objects_list` | List objects | read |
| `heliyos_objects_get` | Get an object's fields | read |
| `heliyos_objects_create` | Create a custom object (experimental) | write |
| `heliyos_objects_update` | Rename or describe an object (experimental) | write |
| `heliyos_objects_delete` | Delete a custom object (experimental) | destructive |
| `heliyos_fields_create` | Add a field to an object | write |
| `heliyos_fields_update` | Change a field | destructive |
| `heliyos_fields_delete` | Delete a field | destructive |

#### Notes

| Tool | What it does | Kind |
| --- | --- | --- |
| `heliyos_notes_list` | List notes | read |
| `heliyos_notes_get` | Get a note | read |
| `heliyos_notes_create` | Create a note | write |
| `heliyos_notes_update` | Update a note | write |
| `heliyos_notes_delete` | Delete a note | destructive |

#### Tasks

| Tool | What it does | Kind |
| --- | --- | --- |
| `heliyos_tasks_list` | List tasks | read |
| `heliyos_tasks_get` | Get a task | read |
| `heliyos_tasks_events` | Read a task's activity | read |
| `heliyos_tasks_create` | Create a task | write |
| `heliyos_tasks_update` | Update a task | write |
| `heliyos_tasks_delete` | Delete a task | destructive |
| `heliyos_tasks_run` | Run workers on a task | destructive |

#### Scouts and signals

| Tool | What it does | Kind |
| --- | --- | --- |
| `heliyos_scouts_list` | List scouts | read |
| `heliyos_scouts_get` | Get a scout | read |
| `heliyos_scouts_create` | Create a scout | write |
| `heliyos_scouts_update` | Update a scout | write |
| `heliyos_scouts_delete` | Delete a scout | destructive |
| `heliyos_companies_scouts_list` | List a company's scouts | read |
| `heliyos_companies_scouts_add` | Add scouts to a company | write |
| `heliyos_companies_scouts_remove` | Remove a company's scouts | destructive |
| `heliyos_signals_list` | List signals | read |
| `heliyos_signals_mark_read` | Mark signals read | write |

#### Ask, runs and reviews

| Tool | What it does | Kind |
| --- | --- | --- |
| `heliyos_ask` | Ask Heliyos | destructive |
| `heliyos_runs_get` | Get a run | read |
| `heliyos_runs_list` | List runs | read |
| `heliyos_reviews_list` | List reviews | read |
| `heliyos_reviews_get` | Get a review | read |
| `heliyos_reviews_decide` | Approve or reject a review | destructive |

#### Workers, triggers and tools

| Tool | What it does | Kind |
| --- | --- | --- |
| `heliyos_workers_list` | List workers | read |
| `heliyos_workers_get` | Get a worker | read |
| `heliyos_workers_create` | Create a worker | write |
| `heliyos_workers_update` | Update a worker | write |
| `heliyos_workers_delete` | Delete a worker | destructive |
| `heliyos_triggers_list` | List worker triggers | read |
| `heliyos_workers_tools_list` | List tools a worker can use | read |

#### Knowledge base and files

| Tool | What it does | Kind |
| --- | --- | --- |
| `heliyos_knowledge_get` | Read the knowledge base | read |
| `heliyos_knowledge_update` | Update the knowledge base | write |
| `heliyos_knowledge_entries_set` | Add or change a knowledge entry | write |
| `heliyos_knowledge_entries_delete` | Delete a knowledge entry | destructive |
| `heliyos_files_list` | List files | read |
| `heliyos_files_get` | Get a file | read |
| `heliyos_files_upload` | Upload a file | write |
| `heliyos_files_delete` | Delete a file | destructive |

#### Watchlist

| Tool | What it does | Kind |
| --- | --- | --- |
| `heliyos_watchlist_get` | Get the watchlist | read |
| `heliyos_companies_watch` | Watch a company | write |
| `heliyos_companies_unwatch` | Unwatch a company | destructive |

#### Labels

| Tool | What it does | Kind |
| --- | --- | --- |
| `heliyos_labels_list` | List label groups | read |
| `heliyos_labels_create` | Create a label group | write |
| `heliyos_labels_update` | Update a label group | destructive |
| `heliyos_labels_delete` | Delete a label group | destructive |

#### Team

| Tool | What it does | Kind |
| --- | --- | --- |
| `heliyos_team_members_list` | List team members | read |
| `heliyos_team_members_invite` | Invite a team member | write |
| `heliyos_team_members_remove` | Remove a team member | destructive |
| `heliyos_team_members_change_role` | Change a team member's role | write |

#### Notification settings

| Tool | What it does | Kind |
| --- | --- | --- |
| `heliyos_notification_settings_get` | Get notification settings | read |
| `heliyos_notification_settings_update` | Update notification settings | write |

#### Usage

| Tool | What it does | Kind |
| --- | --- | --- |
| `heliyos_usage_get` | Get credit usage | read |
<!-- tools:end -->

## Security

- **Your key stays on your machine.** The server reads it from its environment and sends it only to the Heliyos API (`HELIYOS_BASE_URL`), as a bearer token over https. It refuses a base URL that is not https, other than localhost.
- **File uploads skip the key.** File content goes to a short-lived signed storage URL, and that request does not carry your key.
- **No telemetry.** The server sends nothing anywhere else and keeps no logs. Diagnostics go to your client's stderr, and error messages have keys removed.
- **Rate limits.** The API allows 60 requests per minute per key, and per IP address. When it answers 429, the server waits for `Retry-After` and retries once.
- **Least access.** A key has admin rights in one workspace. Give it an expiry, keep one key per person and machine, and revoke it in **Settings → API keys** when you no longer need it.
- **Destructive tools are marked.** Deletes and removals are annotated as destructive, and the agent skill tells agents to confirm them first.

Report a security issue privately through [GitHub security advisories](https://github.com/heliyos-ai/heliyos-mcp/security/advisories/new) rather than in a public issue.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `heliyos-mcp: Set HELIYOS_API_KEY to a Heliyos API key` | The client did not pass the key. Check the `env` block, or that the variable is exported in the shell that started the client. |
| `HELIYOS_API_KEY does not look like a Heliyos API key` | The value is not a Heliyos key. Keys start with `heliyos_`. Copy it again or create a new one. |
| `UNAUTHENTICATED` | The key was revoked, has expired or was mistyped. Create a new key in **Settings → API keys**. |
| `FORBIDDEN_ACTION` | The workspace plan or billing status does not allow the action, or the action is not available to API keys. |
| `RATE_LIMITED` | You are above 60 requests per minute. Wait a minute, and prefer list calls over many single gets. |
| `heliyos_ask` times out | Raise the client's tool timeout (see [Tool timeout](#tool-timeout)). The run keeps going; follow it with `heliyos_runs_get`. |
| The server does not start or shows no tools | Check `node -v` is 20 or later. The first start downloads the package, which can take longer than a 10 second startup timeout; raise it (Codex `startup_timeout_sec`, Claude Code `MCP_TIMEOUT`). Apps opened from the dock may not find `npx`; use its full path from `which npx`. |
| Experimental tools are missing | Set `HELIYOS_MCP_EXPERIMENTAL=1` and restart the client. |

Still stuck? Open an issue at [github.com/heliyos-ai/heliyos-mcp/issues](https://github.com/heliyos-ai/heliyos-mcp/issues). Never paste your key.

## Development

Requirements: Node.js 20 or later and npm. Everything else is a dev dependency.

```sh
git clone https://github.com/heliyos-ai/heliyos-mcp.git
cd heliyos-mcp
npm ci
npm test                  # unit tests with a mocked Heliyos API
npm run typecheck
npm run build             # codegen, then tsc into dist/
npm run readme:tools      # regenerate the tool table above
npm run install-links     # print the Cursor and VS Code install links
npm run prepublish:check  # manifests, versions and package contents
HELIYOS_API_KEY=YOUR_HELIYOS_API_KEY npm run smoke   # read-only checks against a real workspace
```

To run your local build in a client instead of the published package, point the client at `dist/src/bin/stdio.js`:

```sh
claude mcp add --transport stdio --env HELIYOS_API_KEY=YOUR_HELIYOS_API_KEY --scope user heliyos-dev -- node /path/to/heliyos-mcp/dist/src/bin/stdio.js
```

### How it is built

- `src/client/openapi/` holds copies of the Heliyos API's OpenAPI documents. `npm run codegen` turns them into a typed operation table (`src/client/generated.ts`) with zod schemas, so every request is validated before it is sent.
- `src/tools/` defines one file per resource. Each tool declares its input and output schemas, its annotations (read, write or destructive) and a handler that calls one or two API operations and renders a short text plus `structuredContent`.
- `tests/` runs every tool against a mocked API with msw. A snapshot test pins the public tool contract (names, annotations, input keys), so an accidental change fails the build.
- `skills/heliyos/SKILL.md` ships with the Claude Code plugin and teaches the agent when to use which tool.

### Updating the API client

When the Heliyos API changes, save the new OpenAPI documents and resync:

```sh
curl -s https://api-prod.heliyos.ai/v1/platform/openapi.json -o /tmp/platform.json
curl -s https://api-prod.heliyos.ai/v1/auth/openapi.json -o /tmp/auth.json
HELIYOS_PLATFORM_OPENAPI=/tmp/platform.json HELIYOS_AUTH_OPENAPI=/tmp/auth.json npm run sync-openapi
npm run codegen && npm test
```

With those two variables set, `npm run prepublish:check` and the drift test also refuse a bundled copy that no longer matches.

### Releasing

Releases are published by GitHub Actions on every push to `main` (`.github/workflows/publish-package.yml`):

1. CI builds, tests and checks the package and manifests.
2. If the version in `package.json` is already on npm, the workflow bumps the patch version with `node scripts/set-version.mjs`, which keeps `package.json`, the lockfile, `server.json`, every plugin manifest and `src/version.ts` on the same version, and commits the bump.
3. It publishes to npm with provenance through npm trusted publishing (no token is stored anywhere), waits until the version is served, and then publishes `server.json` to the MCP registry when the `MCP_PRIVATE_KEY` secret is configured.

To cut a specific version, run `node scripts/set-version.mjs 1.2.0`, commit, and push to `main`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the one-time repository setup.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, the coding rules and how to add a tool, and [SECURITY.md](SECURITY.md) for how to report a vulnerability. By participating you agree to the [code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
