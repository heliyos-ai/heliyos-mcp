/**
 * README contract: the tool table is generated from listToolSpecs() and must
 * stay in sync; install snippets come from scripts/cursor-link.mjs; the copy
 * follows the style rules (no em dashes).
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL } from "../src/config.js";
import { listToolSpecs } from "../src/index.js";
import { readToolSection, renderToolTable } from "../scripts/tool-table.mjs";
import { cursorInstallLink, cursorWebLink, vscodeInstallLink, vscodeWebLink } from "../scripts/cursor-link.mjs";
import { readRepoText } from "./helpers/repo.js";

const readme = readRepoText("README.md");
const pkg = JSON.parse(readRepoText("package.json"));

describe("README tool table", () => {
  const stable = listToolSpecs({ experimental: false });
  const experimental = listToolSpecs({ experimental: true });

  it("is in sync with listToolSpecs() (run `npm run readme:tools` after a build)", () => {
    expect(readToolSection(readme)).toBe(renderToolTable(stable, experimental));
  });

  it("lists every tool exactly once and marks the experimental ones", () => {
    const table = renderToolTable(stable, experimental);
    for (const tool of experimental) {
      expect(table.split(`\`${tool.name}\``).length - 1, tool.name).toBe(1);
    }
    expect(table).toContain(`${stable.length} tools`);
    expect(table).toContain(`${experimental.length - stable.length} more`);
    expect(table.match(/experimental/g)?.length).toBeGreaterThanOrEqual(experimental.length - stable.length);
  });

  it("refuses a tool that no group claims", () => {
    const stray = { ...stable[0]!, name: "heliyos_unknown_thing" };
    expect(() => renderToolTable([...stable, stray], [...experimental, stray])).toThrow(/heliyos_unknown_thing/);
  });
});

describe("README install and configuration", () => {
  it("covers every client", () => {
    for (const heading of ["Claude Code", "Claude Desktop", "Codex", "Cursor", "VS Code", "Antigravity", "Any other client"]) {
      expect(readme).toMatch(new RegExp(`^### ${heading}`, "m"));
    }
    expect(readme).toContain(`claude mcp add --transport stdio --env HELIYOS_API_KEY=`);
    expect(readme).toContain(`npx -y ${pkg.name}`);
    expect(readme).toContain("~/.codex/config.toml");
    expect(readme).toContain("~/.gemini/config/mcp_config.json");
    expect(readme).toContain("claude plugin marketplace add heliyos-ai/heliyos-mcp");
    expect(readme).toContain("claude plugin install heliyos@heliyos");
  });

  it("uses the generated Cursor and VS Code install links", () => {
    expect(readme).toContain(cursorWebLink());
    expect(readme).toContain(cursorInstallLink());
    expect(readme).toContain(vscodeWebLink());
    expect(readme).toContain(vscodeInstallLink());
  });

  it("names the Settings button and the credential store as the product and docs do", () => {
    expect(readme).toContain("Click **New key**");
    expect(readme).toContain("secure credential store");
  });

  it("documents the 120 second tool timeout for every client", () => {
    expect(readme).toContain("tool_timeout_sec = 120");
    expect(readme).toContain("MCP_TOOL_TIMEOUT=120000");
    expect(readme).toMatch(/Cursor[^\n]*timeout/i);
    expect(readme).toMatch(/VS Code[^\n]*timeout/i);
    expect(readme).toMatch(/Antigravity[^\n]*timeout/i);
    expect(readme).toMatch(/429[^\n]*30 s/);
  });

  it("documents API key creation, the env vars and the security notes", () => {
    expect(readme).toContain("Settings → API keys");
    expect(readme).toMatch(/shown once/i);
    expect(readme).toMatch(/one workspace/i);
    for (const name of ["HELIYOS_API_KEY", "HELIYOS_BASE_URL", "HELIYOS_MCP_EXPERIMENTAL"]) {
      expect(readme).toMatch(new RegExp(`^\\| \`${name}\` \\|`, "m"));
    }
    expect(readme).toContain(DEFAULT_BASE_URL);
    expect(readme).toMatch(/60 requests per minute/);
    expect(readme).toMatch(/no telemetry/i);
    expect(readme).toMatch(/^## Troubleshooting/m);
    expect(readme).toMatch(/^## License/m);
  });

  it("only names tools that exist", () => {
    const known = new Set(listToolSpecs({ experimental: true }).map((t) => t.name));
    for (const m of readme.matchAll(/\bheliyos_[a-z_]+\b/g)) expect(known, m[0]).toContain(m[0]);
  });

  it("has no em dashes", () => {
    expect(readme).not.toContain("\u2014");
  });
});
