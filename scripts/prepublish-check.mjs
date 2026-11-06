#!/usr/bin/env node
/**
 * Refuses to publish a package that is not ready for the public registry:
 *   - README.md, LICENSE and server.json exist
 *   - publishConfig.access is "public"
 *   - `files` ships dist and every manifest
 *   - every `bin` entry points into dist, and there is no top-level bin/
 *     (Claude Code puts a plugin's bin/ on PATH; claude.ai and Cowork refuse it)
 *   - server.json names this package and server (mcpName) and every
 *     versioned manifest, and src/version.ts, carry the package.json version
 *   - where HELIYOS_PLATFORM_OPENAPI / HELIYOS_AUTH_OPENAPI name source documents, the bundled
 *     src/client/openapi copies match them (scripts/openapi-sources.mjs)
 *
 * Runs in `prepublishOnly` and in CI: `npm run prepublish:check`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkOpenApiSync, openApiDrift } from "./openapi-sources.mjs";
import { readVersions } from "./set-version.mjs";

const REQUIRED_FILES = ["README.md", "LICENSE", "server.json"];

/** What `files` in package.json must list: the build and every manifest. */
export const SHIPPED = [
  "dist",
  "server.json",
  ".claude-plugin",
  ".cursor-plugin",
  ".mcp.json",
  "plugin.json",
  "mcp.json",
  "skills",
];

/** Returns the problems found in the package at `root`; empty means ready. */
export function checkPackage(root) {
  const problems = [];
  const read = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));

  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(root, file))) problems.push(`${file} is missing`);
  }

  const pkg = read("package.json");
  if (pkg.publishConfig?.access !== "public") {
    problems.push(`publishConfig.access must be "public" (found ${JSON.stringify(pkg.publishConfig?.access)})`);
  }
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  for (const entry of SHIPPED) {
    if (!files.includes(entry)) problems.push(`files must include "${entry}"`);
  }

  for (const [name, target] of Object.entries(pkg.bin ?? {})) {
    if (typeof target !== "string" || !target.startsWith("dist/")) {
      problems.push(`bin ${name} must point into dist/ (found ${JSON.stringify(target)})`);
    }
  }
  if (existsSync(join(root, "bin"))) {
    problems.push("a top-level bin/ directory must not exist: the plugin root is the repo root (keep entry points in src/bin)");
  }

  if (existsSync(join(root, "server.json"))) {
    const server = read("server.json");
    if (server.name !== pkg.mcpName) {
      problems.push(`server.json name ${server.name} does not match package.json mcpName ${pkg.mcpName}`);
    }
    for (const [i, entry] of (server.packages ?? []).entries()) {
      if (entry.identifier !== pkg.name) {
        problems.push(`server.json packages[${i}].identifier ${entry.identifier} does not match ${pkg.name}`);
      }
    }
  }

  for (const { file, field, version } of readVersions(root)) {
    if (version !== pkg.version) {
      problems.push(`${file} ${field} is ${version}, but package.json version is ${pkg.version}`);
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const problems = [...checkPackage(root), ...checkOpenApiSync(root)];
  for (const d of openApiDrift(root).filter((x) => x.status === "absent")) {
    process.stdout.write(`prepublish check: ${d.name} OpenAPI sync not checked, ${d.from} is absent\n`);
  }
  if (problems.length > 0) {
    process.stderr.write(`prepublish check failed:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("prepublish check passed\n");
}
