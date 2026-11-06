#!/usr/bin/env node
/**
 * One version for the package and every file that carries it.
 *
 *   node scripts/set-version.mjs 0.2.0
 *
 * Writes the version into every JSON field in VERSION_FIELDS and regenerates
 * src/version.ts (the same output `npm run codegen` produces), then prints
 * the paths it wrote, one per line, so the publish workflow commits exactly
 * those files. scripts/prepublish-check.mjs uses readVersions() to refuse a
 * mismatch.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { versionModule } from "./codegen.mjs";

/** Where each JSON file keeps a version. A path segment of "*" means every array item. */
export const VERSION_FIELDS = [
  { file: "package.json", paths: [["version"]] },
  { file: "package-lock.json", paths: [["version"], ["packages", "", "version"]] },
  { file: "server.json", paths: [["version"], ["packages", "*", "version"]] },
  { file: ".claude-plugin/plugin.json", paths: [["version"]] },
  { file: "plugin.json", paths: [["version"]] },
  { file: ".cursor-plugin/plugin.json", paths: [["version"]] },
];

/** The generated TypeScript module that carries the version (for the User-Agent). */
export const VERSION_MODULE = "src/version.ts";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

/** Every concrete location under `path`, as [label, parent object, key]. */
function locate(json, path, label = "") {
  const [head, ...rest] = path;
  if (json === null || typeof json !== "object") return [];
  const keys = head === "*" ? (Array.isArray(json) ? json.map((_, i) => i) : []) : [head];
  return keys.flatMap((key) => {
    const name = typeof key === "number" ? `${label}[${key}]` : label ? `${label}.${key}` : key;
    if (rest.length === 0) return key in json ? [[name, json, key]] : [];
    return locate(json[key], rest, name);
  });
}

/** Reads every version in the repo at `root`. Missing files are skipped (the check reports them). */
export function readVersions(root) {
  const fromJson = VERSION_FIELDS.flatMap(({ file, paths }) => {
    const path = join(root, file);
    if (!existsSync(path)) return [];
    const json = JSON.parse(readFileSync(path, "utf8"));
    return paths.flatMap((p) => locate(json, p).map(([field, parent, key]) => ({ file, field, version: parent[key] })));
  });
  const modulePath = join(root, VERSION_MODULE);
  if (!existsSync(modulePath)) return fromJson;
  const match = /PACKAGE_VERSION = "([^"]*)"/.exec(readFileSync(modulePath, "utf8"));
  return [...fromJson, { file: VERSION_MODULE, field: "PACKAGE_VERSION", version: match?.[1] }];
}

/** Writes `version` into every versioned file under `root`. Returns the paths it wrote. */
export function setVersion(root, version) {
  if (!SEMVER.test(version)) throw new Error(`"${version}" is not a plain semver version such as 1.2.3`);
  const written = [];
  for (const { file, paths } of VERSION_FIELDS) {
    const path = join(root, file);
    if (!existsSync(path)) throw new Error(`${file} is missing`);
    const json = JSON.parse(readFileSync(path, "utf8"));
    for (const p of paths) for (const [, parent, key] of locate(json, p)) parent[key] = version;
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
    written.push(file);
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  writeFileSync(join(root, VERSION_MODULE), versionModule(pkg));
  written.push(VERSION_MODULE);
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) {
    process.stderr.write("usage: node scripts/set-version.mjs <version>\n");
    process.exit(1);
  }
  try {
    const written = setVersion(fileURLToPath(new URL("..", import.meta.url)), version);
    process.stdout.write(`${written.join("\n")}\n`);
  } catch (err) {
    process.stderr.write(`set-version: ${err.message}\n`);
    process.exit(1);
  }
}
