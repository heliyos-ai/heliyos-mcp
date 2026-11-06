/**
 * Distribution manifests: the Claude Code plugin and marketplace, the
 * portable Agent Plugins files, the Cursor plugin, the MCP registry
 * server.json and glama.json. Schemas are pinned copies in tests/fixtures.
 */
import { describe, expect, it } from "vitest";
import { listToolSpecs } from "../src/index.js";
import { readRepoJson, readRepoText, repoExists, schemaErrors } from "./helpers/repo.js";

const pkg = readRepoJson("package.json");
const PLACEHOLDER = /\$\{([^}]+)\}/g;

/** Every `${...}` placeholder in a JSON value, as the text inside the braces. */
function placeholders(value: unknown): string[] {
  return [...JSON.stringify(value).matchAll(PLACEHOLDER)].map((m) => m[1] as string);
}

describe("Claude Code plugin and marketplace", () => {
  const plugin = readRepoJson(".claude-plugin/plugin.json");
  const marketplace = readRepoJson(".claude-plugin/marketplace.json");
  const mcp = readRepoJson(".mcp.json");

  it("lists the plugin in the marketplace under the manifest's name, sourced from the repo root", () => {
    expect(plugin.name).toBe("heliyos");
    const entries = marketplace.plugins.filter((p: { name: string }) => p.name === plugin.name);
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("./");
    expect(marketplace.name).toMatch(/^[a-z0-9-]+$/);
    expect(marketplace.owner.name).toBeTruthy();
  });

  it("declares a required, sensitive api_key and an optional base_url", () => {
    expect(plugin.userConfig.api_key).toMatchObject({ type: "string", sensitive: true, required: true });
    expect(plugin.userConfig.api_key.title).toBeTruthy();
    expect(plugin.userConfig.api_key.description).toMatch(/Settings/);
    expect(plugin.userConfig.base_url).toMatchObject({ type: "string", default: "https://api-prod.heliyos.ai" });
    expect(plugin.userConfig.base_url.sensitive).not.toBe(true);
  });

  it("runs the npm package over stdio with the key from ${user_config.api_key}", () => {
    const server = mcp.mcpServers.heliyos;
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", pkg.name]);
    expect(server.env.HELIYOS_API_KEY).toBe("${user_config.api_key}");
    expect(server.env.HELIYOS_BASE_URL).toBe("${user_config.base_url}");
  });

  it("only references user_config keys the manifest declares", () => {
    const used = placeholders(mcp).filter((p) => p.startsWith("user_config."));
    expect(used.length).toBeGreaterThan(0);
    for (const ref of used) expect(Object.keys(plugin.userConfig)).toContain(ref.slice("user_config.".length));
  });

  it("never carries a literal API key", () => {
    for (const file of [".mcp.json", "mcp.json", ".claude-plugin/plugin.json", ".cursor-plugin/plugin.json", "server.json"]) {
      expect(readRepoText(file)).not.toMatch(/heliyos_[1-9A-HJ-NP-Za-km-z]{32}/);
    }
  });
});

describe("MCP registry server.json", () => {
  const server = readRepoJson("server.json");

  it("validates against the 2025-12-11 server schema", () => {
    expect(server.$schema).toBe("https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
    expect(schemaErrors("mcp-server.2025-12-11.schema.json", server)).toEqual([]);
  });

  it("matches package.json: name, mcpName, version and repository", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.repository).toEqual({ url: "https://github.com/heliyos-ai/heliyos-mcp", source: "github" });
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({
      registryType: "npm",
      registryBaseUrl: "https://registry.npmjs.org",
      identifier: pkg.name,
      version: pkg.version,
      runtimeHint: "npx",
      transport: { type: "stdio" },
    });
  });

  it("asks for the API key as a required secret and documents the optional variables", () => {
    const env = Object.fromEntries(
      server.packages[0].environmentVariables.map((v: { name: string }) => [v.name, v])
    ) as Record<string, { isSecret?: boolean; isRequired?: boolean; default?: string }>;
    expect(Object.keys(env).sort()).toEqual(["HELIYOS_API_KEY", "HELIYOS_BASE_URL", "HELIYOS_MCP_EXPERIMENTAL"]);
    expect(env.HELIYOS_API_KEY).toMatchObject({ isSecret: true, isRequired: true });
    expect(env.HELIYOS_BASE_URL).toMatchObject({ isRequired: false, default: "https://api-prod.heliyos.ai" });
    expect(env.HELIYOS_MCP_EXPERIMENTAL?.isRequired).toBe(false);
  });

  it("rejects a server.json that breaks the schema (the validator is live)", () => {
    expect(schemaErrors("mcp-server.2025-12-11.schema.json", { ...server, name: "no-slash" })).not.toEqual([]);
    expect(schemaErrors("mcp-server.2025-12-11.schema.json", { ...server, description: "x".repeat(101) })).not.toEqual([]);
  });
});

describe("portable Agent Plugins manifests (plugin.json, mcp.json)", () => {
  const plugin = readRepoJson("plugin.json");
  const mcp = readRepoJson("mcp.json");

  it("validate against the Agent Plugins 1.0.0 schemas", () => {
    expect(schemaErrors("agent-plugins-plugin.1.0.0.schema.json", plugin)).toEqual([]);
    expect(schemaErrors("agent-plugins-mcp.1.0.0.schema.json", mcp)).toEqual([]);
  });

  it("names the same plugin and runs the npm package over stdio without embedding a secret", () => {
    expect(plugin.name).toBe("heliyos");
    expect(mcp.mcpServers.heliyos).toEqual({ type: "stdio", command: "npx", args: ["-y", pkg.name] });
  });
});

describe("Cursor plugin", () => {
  const plugin = readRepoJson(".cursor-plugin/plugin.json");

  it("declares every ${VAR} its MCP config uses as a variable, and the key is required", () => {
    expect(plugin.name).toBe("heliyos");
    const server = plugin.mcpServers.heliyos;
    expect(server.type).toBe("stdio");
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", pkg.name]);
    expect(server.env.HELIYOS_API_KEY).toBe("${HELIYOS_API_KEY}");
    for (const name of placeholders(plugin.mcpServers)) expect(Object.keys(plugin.variables.properties)).toContain(name);
    expect(plugin.variables.type).toBe("object");
    expect(plugin.variables.required).toEqual(["HELIYOS_API_KEY"]);
  });
});

describe("glama.json", () => {
  it("validates against the Glama schema", () => {
    const glama = readRepoJson("glama.json");
    expect(glama.$schema).toBe("https://glama.ai/mcp/schemas/server.json");
    expect(schemaErrors("glama-server.schema.json", glama)).toEqual([]);
    expect(glama.maintainers.length).toBeGreaterThan(0);
  });
});

describe("plugin root layout", () => {
  it("has no top-level bin/ (Claude Code puts it on PATH; claude.ai and Cowork refuse such plugins)", () => {
    expect(repoExists("bin")).toBe(false);
    expect(pkg.bin).toEqual({ "heliyos-mcp": "dist/src/bin/stdio.js" });
    expect(repoExists("src/bin/stdio.ts")).toBe(true);
  });
});

describe("metadata shared across manifests", () => {
  it("every manifest carries the package version", () => {
    for (const file of [".claude-plugin/plugin.json", "plugin.json", ".cursor-plugin/plugin.json"]) {
      expect(readRepoJson(file).version, file).toBe(pkg.version);
    }
  });

  it("has no AI attribution in any manifest, package metadata or workflow", () => {
    const files = [
      "package.json",
      "server.json",
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      ".cursor-plugin/plugin.json",
      "plugin.json",
      "glama.json",
      ".github/workflows/test.yml",
      ".github/workflows/publish-package.yml",
    ];
    for (const file of files) expect(readRepoText(file), file).not.toMatch(/co-authored-by|generated with|anthropic\.com|noreply@/i);
  });
});

describe("skills/heliyos/SKILL.md", () => {
  const skill = repoExists("skills/heliyos/SKILL.md") ? readRepoText("skills/heliyos/SKILL.md") : "";

  it("has name and description frontmatter", () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
    expect(front).toMatch(/^name: heliyos$/m);
    expect(front).toMatch(/^description: .{40,}$/m);
  });

  it("only names tools that exist, and covers each tool family", () => {
    const known = new Set(listToolSpecs({ experimental: true }).map((t) => t.name));
    const named = new Set([...skill.matchAll(/\bheliyos_[a-z_]+\b/g)].map((m) => m[0]));
    for (const name of named) expect(known, name).toContain(name);
    for (const family of ["heliyos_records_lookup", "heliyos_notes_create", "heliyos_tasks_create", "heliyos_signals_list", "heliyos_ask", "heliyos_runs_get"]) {
      expect(named, family).toContain(family);
    }
  });

  it("tells agents to confirm every destructive tool", () => {
    const care = skill.slice(skill.indexOf("## Care"));
    for (const tool of listToolSpecs({ experimental: true })) {
      if (tool.annotations.destructiveHint && tool.name !== "heliyos_ask") expect(care, tool.name).toContain(`\`${tool.name}\``);
    }
  });

  it("has no em dashes", () => {
    expect(skill).not.toContain("\u2014");
  });
});
