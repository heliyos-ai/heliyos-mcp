/**
 * Picks a Node.js runtime the server can run on. Clients start the server with
 * `npx`, which uses whatever `node` is first on their PATH; version managers
 * such as nvm often leave an old default there (Node 16 has no global fetch),
 * and the server would die before the MCP handshake with no useful message.
 *
 * `findNewerNode` looks in the places version managers and package managers
 * install Node, verifies each candidate's version, and returns the newest one
 * that meets the minimum. Everything here must run on old Node too, so it uses
 * only long-standing APIs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** The lowest Node.js major the server supports (global fetch, Web Streams). */
export const MIN_NODE_MAJOR = 20;

/** The major version of a `vX.Y.Z` or `X.Y.Z` string, or 0 when unparsable. */
export function majorOf(version: string): number {
  const match = /^v?(\d+)\./.exec(version.trim());
  return match ? Number(match[1]) : 0;
}

/** Compares two `vX.Y.Z` strings numerically; positive when `a` is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const EXE = process.platform === "win32" ? "node.exe" : "node";

/** Directories that may hold one Node install each (`<dir>/<version>/bin/node`). */
function versionManagerRoots(env: NodeJS.ProcessEnv, home: string): Array<{ root: string; bin: string }> {
  const fnmRoots = [
    env.FNM_DIR,
    join(home, ".fnm"),
    join(home, ".local", "share", "fnm"),
    join(home, "Library", "Application Support", "fnm"),
    env.APPDATA ? join(env.APPDATA, "fnm") : undefined,
  ].filter((p): p is string => !!p);
  return [
    // nvm: ~/.nvm/versions/node/v20.15.0/bin/node
    { root: join(env.NVM_DIR || join(home, ".nvm"), "versions", "node"), bin: process.platform === "win32" ? "" : "bin" },
    // nvm-windows: %NVM_HOME%\v20.15.0\node.exe
    ...(env.NVM_HOME ? [{ root: env.NVM_HOME, bin: "" }] : []),
    // fnm: <root>/node-versions/v20.15.0/installation/bin/node
    ...fnmRoots.map((r) => ({ root: join(r, "node-versions"), bin: join("installation", process.platform === "win32" ? "" : "bin") })),
    // n: /usr/local/n/versions/node/20.15.0/bin/node
    { root: join(env.N_PREFIX || "/usr/local", "n", "versions", "node"), bin: "bin" },
    // Volta's shared tool images
    { root: join(env.VOLTA_HOME || join(home, ".volta"), "tools", "image", "node"), bin: process.platform === "win32" ? "" : "bin" },
  ];
}

/** Every `node` executable this machine is likely to have, deduplicated, unverified. */
export function candidateNodes(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const found: string[] = [];
  const add = (p: string) => {
    if (p && !found.includes(p) && existsSync(p)) found.push(p);
  };
  for (const { root, bin } of versionManagerRoots(env, home)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) add(join(root, entry, bin, EXE));
  }
  for (const fixed of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/opt/local/bin", join(home, ".volta", "bin")]) add(join(fixed, EXE));
  for (const dir of (env.PATH || "").split(delimiter)) if (dir) add(join(dir, EXE));
  return found;
}

/** `node -v` of an executable, or undefined when it cannot be run. Bounded to a second. */
export function versionOf(executable: string): string | undefined {
  try {
    const out = execFileSync(executable, ["-v"], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] });
    return /^v\d+\.\d+\.\d+/.test(out.trim()) ? out.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The newest Node at or above `minMajor` among `candidates`, as `{path, version}`,
 * or undefined when none qualifies. `probe` is injectable for tests.
 */
export function findNewerNode(
  candidates: string[],
  minMajor: number = MIN_NODE_MAJOR,
  probe: (executable: string) => string | undefined = versionOf
): { path: string; version: string } | undefined {
  let best: { path: string; version: string } | undefined;
  for (const path of candidates) {
    const version = probe(path);
    if (!version || majorOf(version) < minMajor) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { path, version };
  }
  return best;
}
