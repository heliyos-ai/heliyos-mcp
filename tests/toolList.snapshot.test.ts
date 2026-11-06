/**
 * The tool list is a public contract (names, titles, annotations, input keys).
 * It is stored in tests/__snapshots__/tools.json (and tools.experimental.json
 * for HELIYOS_MCP_EXPERIMENTAL=1) and only changes deliberately:
 *   UPDATE_TOOL_SNAPSHOT=1 npm test -- tests/toolList.snapshot.test.ts
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listToolSpecs } from "../src/index.js";
import { closeAll, connect } from "./helpers/mcp.js";
import { afterEach } from "vitest";

const SNAPSHOT = fileURLToPath(new URL("./__snapshots__/tools.json", import.meta.url));
const EXPERIMENTAL_SNAPSHOT = fileURLToPath(new URL("./__snapshots__/tools.experimental.json", import.meta.url));

function expectSnapshot(file: string, specs: unknown) {
  const current = `${JSON.stringify(specs, null, 2)}\n`;
  if (process.env.UPDATE_TOOL_SNAPSHOT === "1") writeFileSync(file, current);
  expect(existsSync(file), `${file} is missing; run with UPDATE_TOOL_SNAPSHOT=1`).toBe(true);
  expect(current, "tool list changed; review and run with UPDATE_TOOL_SNAPSHOT=1").toBe(readFileSync(file, "utf8"));
}

afterEach(closeAll);

describe("tool list snapshot", () => {
  const specs = listToolSpecs({ experimental: false });

  const experimentalSpecs = listToolSpecs({ experimental: true });

  it("matches the committed snapshot", () => {
    expectSnapshot(SNAPSHOT, specs);
  });

  it("matches the committed experimental snapshot, which only adds tools", () => {
    expectSnapshot(EXPERIMENTAL_SNAPSHOT, experimentalSpecs);
    const stable = specs.map((s) => s.name);
    expect(experimentalSpecs.map((s) => s.name).filter((n) => stable.includes(n))).toEqual(stable);
  });

  it("follows the naming and annotation rules", () => {
    for (const spec of experimentalSpecs) {
      expect(spec.name).toMatch(/^heliyos_[a-z0-9_]+$/);
      expect(spec.name.length).toBeLessThanOrEqual(64);
      expect(spec.title.length).toBeGreaterThan(0);
      expect(Object.keys(spec.annotations).sort()).toEqual([
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
        "readOnlyHint",
      ]);
      expect(spec.annotations.openWorldHint).toBe(false);
    }
    expect(new Set(experimentalSpecs.map((s) => s.name)).size).toBe(experimentalSpecs.length);
  });

  it("matches what tools/list serves, in the same order", async () => {
    const unused = async () => {
      throw new Error("unexpected call");
    };
    const client = await connect({ get: unused, post: unused, put: unused, patch: unused, delete: unused, putPresigned: unused });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(specs.map((s) => s.name));
    for (const tool of tools) {
      const spec = specs.find((s) => s.name === tool.name)!;
      expect(tool.title).toBe(spec.title);
      expect(tool.annotations).toEqual(spec.annotations);
      expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(spec.inputKeys);
    }
  });
});
