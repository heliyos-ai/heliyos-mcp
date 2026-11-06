#!/usr/bin/env node
/**
 * Copies the Heliyos API's OpenAPI documents into src/client/openapi/{platform,auth}.json,
 * from the files named by HELIYOS_PLATFORM_OPENAPI and HELIYOS_AUTH_OPENAPI (saved copies of
 * `/v1/platform/openapi.json` and `/v1/auth/openapi.json`). Run it when the API changes, then
 * `npm run codegen` to regenerate the typed client from the new copies.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openApiSources } from "./openapi-sources.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = openApiSources(root);

const missing = sources.filter((s) => !existsSync(s.from));
if (missing.length > 0) {
  for (const s of missing) {
    console.error(`sync-openapi: no ${s.name} OpenAPI document${s.from ? ` at ${s.from}` : ""} (${s.hint}).`);
  }
  process.exit(1);
}

const outDir = resolve(root, "src/client/openapi");
mkdirSync(outDir, { recursive: true });

for (const s of sources) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(s.from, "utf8"));
  } catch (err) {
    console.error(`sync-openapi: ${s.from} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (typeof doc.openapi !== "string" || typeof doc.paths !== "object" || doc.paths === null) {
    console.error(`sync-openapi: ${s.from} is not an OpenAPI 3 document (missing "openapi" or "paths").`);
    process.exit(1);
  }
  copyFileSync(s.from, s.to);
  console.log(`sync-openapi: ${s.name} (${Object.keys(doc.paths).length} paths) -> ${s.to}`);
}
