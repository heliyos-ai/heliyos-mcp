# Security policy

## Reporting a vulnerability

Please report security issues privately through [GitHub security advisories](https://github.com/heliyos-ai/heliyos-mcp/security/advisories/new). Do not open a public issue or pull request for a vulnerability.

Include what you found, how to reproduce it, and the version of `@heliyos/mcp` you tested. We acknowledge reports within three working days and keep you informed until the fix is released. We credit reporters in the release notes unless they prefer not to be named.

## Supported versions

Only the latest published version receives security fixes. Upgrade with `npx -y @heliyos/mcp@latest` or by restarting a client that uses `npx -y @heliyos/mcp`, which fetches the current release.

## What this package does with your data

- The server runs on your machine and talks only to the Heliyos API at `HELIYOS_BASE_URL` (default `https://api-prod.heliyos.ai`) over https. It refuses a base URL that is not https, other than localhost for development.
- Your API key is read from the environment and sent as a bearer token to that API and nowhere else. File uploads go to a short-lived signed storage URL without the key.
- Nothing is written to disk, no telemetry is sent, and no logs are kept. Diagnostics go to the client's stderr with credentials removed.
- Every tool result passes through a redaction step so keys, tokens and grant ids never reach the agent, whatever the API returned.

## Good practice for users

- Create one API key per person and machine, give it an expiry, and revoke it in Heliyos under Settings, API keys when you stop using it.
- Prefer clients that keep the key in a secure credential store (Claude Code plugin, VS Code inputs) over config files that hold it in plain text.
- Never paste a key into an issue, a chat or a repository. If one leaks, revoke it first and ask questions later.
