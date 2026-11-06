/**
 * Release guardrails: `npm run prepublish:check`, `scripts/set-version.mjs`
 * and the two GitHub workflows.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPackage } from "../scripts/prepublish-check.mjs";
import { readVersions, setVersion } from "../scripts/set-version.mjs";
import { ROOT, readRepoJson, readRepoText } from "./helpers/repo.js";

const RELEASE_FILES = [
  "package.json",
  "package-lock.json",
  "server.json",
  "README.md",
  "LICENSE",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/plugin.json",
  ".mcp.json",
  "plugin.json",
  "mcp.json",
  "skills/heliyos/SKILL.md",
  "src/version.ts",
];

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway copy of the files the release scripts read. */
function copyRepo(extra: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "heliyos-mcp-release-"));
  temps.push(dir);
  for (const file of [...RELEASE_FILES, ...extra]) cpSync(join(ROOT, file), join(dir, file), { recursive: true });
  return dir;
}

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=release-test", "-c", "user.email=release-test@example.invalid", ...args], {
    cwd: dir,
    encoding: "utf8",
  });

function editJson(dir: string, file: string, edit: (json: any) => void): void {
  const path = join(dir, file);
  const json = JSON.parse(readFileSync(path, "utf8"));
  edit(json);
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

describe("prepublish check", () => {
  it("passes on the repository", () => {
    expect(checkPackage(ROOT)).toEqual([]);
  });

  it.each([
    ["LICENSE", /LICENSE is missing/],
    ["README.md", /README\.md is missing/],
    ["server.json", /server\.json is missing/],
  ])("fails when %s is missing", (file, message) => {
    const dir = copyRepo();
    rmSync(join(dir, file));
    expect(checkPackage(dir).join("\n")).toMatch(message);
  });

  it("fails unless publishConfig.access is public", () => {
    const dir = copyRepo();
    editJson(dir, "package.json", (p) => (p.publishConfig.access = "restricted"));
    expect(checkPackage(dir).join("\n")).toMatch(/publishConfig\.access must be "public"/);
  });

  it("fails when `files` leaves out dist or a manifest", () => {
    const dir = copyRepo();
    editJson(dir, "package.json", (p) => (p.files = p.files.filter((f: string) => f !== "dist" && f !== "server.json")));
    const problems = checkPackage(dir).join("\n");
    expect(problems).toMatch(/files must include "dist"/);
    expect(problems).toMatch(/files must include "server\.json"/);
  });

  it("fails when server.json or a plugin manifest carries another version", () => {
    const dir = copyRepo();
    editJson(dir, "server.json", (s) => (s.packages[0].version = "9.9.9"));
    editJson(dir, ".claude-plugin/plugin.json", (p) => (p.version = "0.0.1"));
    const problems = checkPackage(dir).join("\n");
    expect(problems).toMatch(/server\.json packages\[0\]\.version is 9\.9\.9/);
    expect(problems).toMatch(/\.claude-plugin\/plugin\.json version is 0\.0\.1/);
  });

  it("fails when src/version.ts carries another version", () => {
    const dir = copyRepo();
    const file = join(dir, "src/version.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace(/PACKAGE_VERSION = "[^"]*"/, 'PACKAGE_VERSION = "0.0.9"'));
    expect(checkPackage(dir).join("\n")).toMatch(/src\/version\.ts PACKAGE_VERSION is 0\.0\.9/);
  });

  it("fails on a top-level bin/ directory or a bin entry outside dist", () => {
    const dir = copyRepo();
    mkdirSync(join(dir, "bin"));
    editJson(dir, "package.json", (p) => (p.bin = { "heliyos-mcp": "bin/stdio.js" }));
    const problems = checkPackage(dir).join("\n");
    expect(problems).toMatch(/top-level bin\/ directory must not exist/);
    expect(problems).toMatch(/bin heliyos-mcp must point into dist\//);
  });

  it("fails when server.json names another server or package than package.json", () => {
    const dir = copyRepo();
    editJson(dir, "server.json", (s) => {
      s.name = "ai.heliyos/other";
      s.packages[0].identifier = "@heliyos/other";
    });
    const problems = checkPackage(dir).join("\n");
    expect(problems).toMatch(/server\.json name .* mcpName/);
    expect(problems).toMatch(/identifier .* @heliyos\/heliyos-mcp/);
  });
});

describe("set-version", () => {
  it("bumps every versioned file together, and the check still passes", () => {
    const dir = copyRepo();
    setVersion(dir, "1.2.3");
    expect(new Set(readVersions(dir).map((v) => v.version))).toEqual(new Set(["1.2.3"]));
    expect(checkPackage(dir)).toEqual([]);
  });

  it("rewrites nothing when the version is unchanged (no formatting churn)", () => {
    const dir = copyRepo();
    const before = RELEASE_FILES.map((f) => readFileSync(join(dir, f), "utf8"));
    setVersion(dir, readRepoJson("package.json").version);
    expect(RELEASE_FILES.map((f) => readFileSync(join(dir, f), "utf8"))).toEqual(before);
  });

  it("a bump committed with exactly the files it prints leaves a clean tree after codegen", () => {
    // codegen reads the tool sources to decide which operations to emit.
    const dir = copyRepo(["scripts", "src/client/openapi", "src/client/generated.ts", "src/tools", "src/resources.ts"]);
    git(dir, "init", "--quiet");
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "base");
    const printed = execFileSync(process.execPath, ["scripts/set-version.mjs", "1.2.3"], { cwd: dir, encoding: "utf8" })
      .trim()
      .split("\n");
    expect(printed).toContain("src/version.ts");
    git(dir, "add", "--", ...printed);
    git(dir, "commit", "--quiet", "-m", "Bump version to 1.2.3 [skip ci]");
    expect(git(dir, "status", "--porcelain")).toBe("");
    execFileSync(process.execPath, ["scripts/codegen.mjs"], { cwd: dir, encoding: "utf8" });
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(dir, "src/version.ts"), "utf8")).toContain('PACKAGE_VERSION = "1.2.3"');
  });

  it("rejects a version that is not plain semver", () => {
    const dir = copyRepo();
    for (const bad of ["^1.2.3", "latest", "1.2", "v1.2.3"]) expect(() => setVersion(dir, bad)).toThrow(/semver/);
  });

  it("covers package.json, the lockfile, server.json and every plugin manifest", () => {
    const files = new Set(readVersions(ROOT).map((v) => v.file));
    expect([...files].sort()).toEqual(
      [
        ".claude-plugin/plugin.json",
        ".cursor-plugin/plugin.json",
        "package-lock.json",
        "package.json",
        "plugin.json",
        "server.json",
        "src/version.ts",
      ].sort()
    );
  });
});

describe("GitHub workflows", () => {
  const publish = readRepoText(".github/workflows/publish-package.yml");
  const test = readRepoText(".github/workflows/test.yml");

  it("test.yml installs, checks codegen drift, typechecks, tests, builds and validates the plugin", () => {
    for (const step of [
      "npm ci",
      "npm run codegen",
      "git diff --exit-code",
      "npm run typecheck",
      "npm test",
      "npm run build",
      "npm run prepublish:check",
      "plugin validate . --strict",
    ]) {
      expect(test, step).toContain(step);
    }
  });

  it("publish-package.yml publishes publicly with provenance through OIDC, then to the MCP registry", () => {
    expect(publish).toContain("id-token: write");
    expect(publish).toMatch(/ACCESS" != "public"/);
    expect(publish).toContain("npm publish --access public --provenance");
    expect(publish).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN/);
    expect(publish).toContain("node scripts/set-version.mjs");
    expect(publish).toContain("npm run prepublish:check");
    expect(publish.indexOf("npm publish --access public")).toBeLessThan(publish.indexOf("mcp-publisher publish"));
  });

  it("publish-package.yml runs no dependency install scripts and restores no cache in the job that holds id-token", () => {
    expect(publish).toContain("npm ci --ignore-scripts");
    expect(publish).not.toMatch(/^\s*run: npm ci\s*$/m);
    expect(publish).not.toContain("actions/cache");
  });

  it("commits every file the bump writes, with [skip ci], and guards against a bump loop", () => {
    expect(publish).toContain('node scripts/set-version.mjs "$NEW_VERSION" > "$RUNNER_TEMP/version-files.txt"');
    expect(publish).toContain('xargs git add -- < "$RUNNER_TEMP/version-files.txt"');
    expect(publish).toContain('git commit -m "Bump version to $NEW_VERSION [skip ci]"');
    expect(publish.indexOf("git status --porcelain")).toBeLessThan(publish.indexOf("git push origin main"));
    expect(publish).toContain("!contains(github.event.head_commit.message, '[skip ci]')");
    expect(publish).toContain("!startsWith(github.event.head_commit.message, 'Bump version to ')");
    expect(publish).toContain("github.actor != 'github-actions[bot]'");
  });

  it("pins every action to a commit SHA and npm to an exact version", () => {
    for (const workflow of [publish, test]) {
      const uses = [...workflow.matchAll(/uses: (\S+)(.*)/g)];
      expect(uses.length).toBeGreaterThan(0);
      for (const [, ref, comment] of uses) {
        expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        expect(comment).toMatch(/# v\d+\.\d+\.\d+/);
      }
    }
    expect(publish).toMatch(/npm install -g npm@\d+\.\d+\.\d+\n/);
  });

  it("pins and verifies the mcp-publisher binary and logs in with the heliyos.ai DNS key", () => {
    expect(publish).toMatch(/MCP_PUBLISHER_VERSION: v\d+\.\d+\.\d+\n/);
    expect(publish).toMatch(/MCP_PUBLISHER_SHA256: [0-9a-f]{64}\n/);
    expect(publish).toContain("releases/download/${MCP_PUBLISHER_VERSION}/mcp-publisher_linux_amd64.tar.gz");
    expect(publish).not.toContain("releases/latest");
    expect(publish).toMatch(/sha256sum -c/);
    expect(publish).toContain("login dns --domain heliyos.ai");
    expect(publish).toContain("secrets.MCP_PRIVATE_KEY");
  });

  it("uses the package metadata the workflow asserts on", () => {
    const pkg = readRepoJson("package.json");
    expect(pkg.publishConfig.access).toBe("public");
    expect(pkg.name.startsWith("@heliyos/")).toBe(true);
    expect(pkg.scripts.prepublishOnly).toContain("npm run prepublish:check");
  });
});
