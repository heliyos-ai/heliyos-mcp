/**
 * Read-only helpers for tests that check files at the repository root
 * (manifests, README, workflows).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export const repoPath = (file: string): string => join(ROOT, file);

export const repoExists = (file: string): boolean => existsSync(repoPath(file));

export const readRepoText = (file: string): string => readFileSync(repoPath(file), "utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const readRepoJson = (file: string): any => JSON.parse(readRepoText(file));

//  ajv-formats is CommonJS; under NodeNext its default import is the module object.
const addFormats = ((addFormatsPlugin as unknown as { default?: unknown }).default ?? addFormatsPlugin) as (
  ajv: Ajv | Ajv2020
) => void;

/** Validates `data` against a JSON Schema stored in tests/fixtures/schemas. Returns readable errors. */
export function schemaErrors(schemaFile: string, data: unknown): string[] {
  const schema = readRepoJson(`tests/fixtures/schemas/${schemaFile}`);
  const draft2020 = String(schema.$schema ?? "").includes("2020-12");
  const ajv = draft2020 ? new Ajv2020({ allErrors: true, strict: false }) : new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (validate(data)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
}
