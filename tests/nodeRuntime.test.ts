/**
 * The Node runtime picker behind bin/stdio.ts: version parsing and comparison,
 * where candidates are looked for, and which one is chosen when the running
 * Node is too old. The probe is injected so no real Node is executed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { candidateNodes, compareVersions, findNewerNode, majorOf, MIN_NODE_MAJOR, versionOf } from "../src/bin/nodeRuntime.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("version helpers", () => {
  it("parses majors and compares numerically", () => {
    expect(majorOf("v20.15.0")).toBe(20);
    expect(majorOf("16.20.2")).toBe(16);
    expect(majorOf("garbage")).toBe(0);
    expect(compareVersions("v23.1.0", "v9.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v20.15.0", "v20.15.0")).toBe(0);
    expect(compareVersions("v20.9.0", "v20.15.0")).toBeLessThan(0);
  });

  it("requires Node 20", () => {
    expect(MIN_NODE_MAJOR).toBe(20);
  });
});

describe("candidateNodes", () => {
  it("finds nvm, fnm, n and PATH installs under a fake home, newest first is not assumed", () => {
    const home = mkdtempSync(join(tmpdir(), "heliyos-node-"));
    temps.push(home);
    const touch = (p: string) => {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "");
    };
    touch(join(home, ".nvm/versions/node/v16.20.2/bin/node"));
    touch(join(home, ".nvm/versions/node/v20.15.0/bin/node"));
    touch(join(home, ".fnm/node-versions/v22.1.0/installation/bin/node"));
    touch(join(home, "custom-path/node"));
    const env = { PATH: join(home, "custom-path"), NVM_DIR: join(home, ".nvm") } as NodeJS.ProcessEnv;
    const found = candidateNodes(env, home);
    expect(found).toContain(join(home, ".nvm/versions/node/v16.20.2/bin/node"));
    expect(found).toContain(join(home, ".nvm/versions/node/v20.15.0/bin/node"));
    expect(found).toContain(join(home, ".fnm/node-versions/v22.1.0/installation/bin/node"));
    expect(found).toContain(join(home, "custom-path/node"));
    expect(new Set(found).size).toBe(found.length);
  });
});

describe("findNewerNode", () => {
  const versions: Record<string, string | undefined> = {
    "/a/v16/node": "v16.20.2",
    "/a/v20/node": "v20.15.0",
    "/a/v23/node": "v23.1.0",
    "/a/broken/node": undefined,
    "/a/v18/node": "v18.19.0",
  };
  const probe = (p: string) => versions[p];

  it("picks the newest candidate that meets the minimum and skips broken ones", () => {
    expect(findNewerNode(Object.keys(versions), 20, probe)).toEqual({ path: "/a/v23/node", version: "v23.1.0" });
  });

  it("returns undefined when nothing qualifies", () => {
    expect(findNewerNode(["/a/v16/node", "/a/v18/node", "/a/broken/node"], 20, probe)).toBeUndefined();
    expect(findNewerNode([], 20, probe)).toBeUndefined();
  });
});

describe("versionOf", () => {
  it("reads the version of the running Node and gives undefined for a non-executable", () => {
    expect(versionOf(process.execPath)).toBe(process.version);
    expect(versionOf("/definitely/not/a/node")).toBeUndefined();
  });
});
