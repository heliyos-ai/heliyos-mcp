# Changelog

All notable changes to `@heliyos/heliyos-mcp` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- The server re-executes itself on the newest Node 20+ it can find when a client starts it with an older Node (a version manager's default, for example), instead of failing before the MCP handshake; it explains what to install when none exists.
- `--version` prints the package version without starting a server, so `npx -y @heliyos/heliyos-mcp --version` warms the npx cache before a client's first start.
- The Claude Code install documentation passes the API key with `--config`; the CLI does not prompt for it.

## [1.0.0]

First public release.

### Added

- 73 tools, plus 4 behind `HELIYOS_MCP_EXPERIMENTAL=1`, covering records, objects and fields, timeline and activity, emails and meetings, notes, tasks, scouts and signals, the watchlist, labels, reviews, workers with their trigger and tool catalogs, the knowledge base and files, team members, notification settings, usage, and `heliyos_ask` for handing a job to Heliyos.
- A `heliyos://records/{id}` resource template and two prompts, `prepare_account_review` and `daily_pipeline_summary`.
- A Claude Code plugin with a marketplace manifest and an agent skill, plus Cursor and portable Agent Plugins manifests, and a `server.json` for the MCP registry.
- Request validation against the Heliyos OpenAPI documents before anything is sent, keyset and page cursors with one `next_cursor` convention, a 120 second tool budget with one retry on rate limiting, and redaction of credentials from every result.

[Unreleased]: https://github.com/heliyos-ai/heliyos-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/heliyos-ai/heliyos-mcp/releases/tag/v1.0.0
