#!/usr/bin/env node
/**
 * One-click install links for the stdio server.
 *
 *   node scripts/cursor-link.mjs     prints the Cursor and VS Code links
 *
 * Neither link carries an API key: Cursor reads it from the
 * HELIYOS_API_KEY environment variable, VS Code prompts for it and keeps it
 * in its secret storage. README.md embeds these exact strings and
 * tests/readme.test.ts fails when they drift.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The name the server is installed under in MCP clients. */
export const SERVER_NAME = "heliyos";
/** The npm package that clients run to start the server. */
export const PACKAGE_NAME = "@heliyos/mcp";

const VSCODE_KEY_INPUT = "heliyos-api-key";

/** The stdio launch every client shares. */
const launch = () => ({ type: "stdio", command: "npx", args: ["-y", PACKAGE_NAME] });

/** Cursor's mcp.json entry; `${env:...}` is Cursor's own interpolation. */
export const cursorConfig = () => ({ ...launch(), env: { HELIYOS_API_KEY: "${env:HELIYOS_API_KEY}" } });

/** VS Code's server entry plus the secret prompt it references. */
export const vscodeInputs = () => [
  { type: "promptString", id: VSCODE_KEY_INPUT, description: "Heliyos API key (Settings → API keys)", password: true },
];
/** VS Code's server entry. The API key comes from the prompt declared in vscodeInputs. */
export const vscodeConfig = () => ({ ...launch(), env: { HELIYOS_API_KEY: `\${input:${VSCODE_KEY_INPUT}}` } });

const base64 = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
const query = (params) => new URLSearchParams(params).toString();

/** cursor://anysphere.cursor-deeplink/mcp/install?name=…&config=<base64 JSON>. */
export const cursorInstallLink = () =>
  `cursor://anysphere.cursor-deeplink/mcp/install?${query({ name: SERVER_NAME, config: base64(cursorConfig()) })}`;

/** The https form of the Cursor link, which GitHub renders as a clickable link. */
export const cursorWebLink = () =>
  `https://cursor.com/install-mcp?${query({ name: SERVER_NAME, config: base64(cursorConfig()) })}`;

/** vscode:mcp/install?<url-encoded JSON of {name, inputs, ...config}>. */
export const vscodeInstallLink = () =>
  `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: SERVER_NAME, inputs: vscodeInputs(), ...vscodeConfig() }))}`;

/** The https redirect that opens vscodeInstallLink() from a browser or GitHub. */
export const vscodeWebLink = () =>
  `https://vscode.dev/redirect/mcp/install?${query({
    name: SERVER_NAME,
    inputs: JSON.stringify(vscodeInputs()),
    config: JSON.stringify(vscodeConfig()),
  })}`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(
    [
      `Cursor (deeplink):  ${cursorInstallLink()}`,
      `Cursor (web):       ${cursorWebLink()}`,
      `VS Code (deeplink): ${vscodeInstallLink()}`,
      `VS Code (web):      ${vscodeWebLink()}`,
      "",
    ].join("\n")
  );
}
