/**
 * Where the bundled OpenAPI documents (src/client/openapi/{platform,auth}.json) come from, and
 * whether they still match. The sources are the OpenAPI documents the Heliyos API serves
 * (`/v1/platform/openapi.json` and `/v1/auth/openapi.json`), saved locally and named by the
 * HELIYOS_PLATFORM_OPENAPI and HELIYOS_AUTH_OPENAPI environment variables. When a variable is
 * unset the source is "absent" and every check that needs it skips, so a plain checkout (and CI)
 * tests the bundled copies only.
 *
 * Used by `npm run sync-openapi` (copy), `npm run prepublish:check` (refuse to publish a stale
 * copy) and tests/openapiDrift.test.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SYNC_HINT = "run `npm run sync-openapi && npm run codegen`";
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/**
 * The two source documents for the package at `root`. `from` is the path named by the
 * environment variable, or undefined when it is unset (the source is then "absent").
 */
export function openApiSources(root, env = process.env) {
  return [
    {
      name: "platform",
      from: env.HELIYOS_PLATFORM_OPENAPI || undefined,
      to: resolve(root, "src/client/openapi/platform.json"),
      hint: "set HELIYOS_PLATFORM_OPENAPI to a saved copy of /v1/platform/openapi.json",
    },
    {
      name: "auth",
      from: env.HELIYOS_AUTH_OPENAPI || undefined,
      to: resolve(root, "src/client/openapi/auth.json"),
      hint: "set HELIYOS_AUTH_OPENAPI to a saved copy of /v1/auth/openapi.json",
    },
  ];
}

/** Every operation as "METHOD /path operationId", sorted. */
export function operationKeys(doc) {
  const keys = [];
  for (const [path, item] of Object.entries(doc?.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (op) keys.push(`${method.toUpperCase()} ${path} ${op.operationId ?? "(no operationId)"}`);
    }
  }
  return keys.sort();
}

/**
 * Per source: "absent" (no source document named here), "same" (identical documents) or
 * "drift", with the operations only the source has (`added`) and only the bundled copy has
 * (`removed`).
 */
export function openApiDrift(root, env = process.env) {
  return openApiSources(root, env).map(({ name, from, to }) => {
    if (!from || !existsSync(from)) return { name, from, status: "absent", added: [], removed: [] };
    const builtText = readFileSync(from, "utf8");
    const bundledText = existsSync(to) ? readFileSync(to, "utf8") : "{}";
    const built = operationKeys(JSON.parse(builtText));
    const bundled = operationKeys(JSON.parse(bundledText));
    const added = built.filter((k) => !bundled.includes(k));
    const removed = bundled.filter((k) => !built.includes(k));
    const same = builtText === bundledText || JSON.stringify(JSON.parse(builtText)) === JSON.stringify(JSON.parse(bundledText));
    return { name, from, status: same ? "same" : "drift", added, removed };
  });
}

/** Problems for prepublish: a named source document that exists and differs from the bundled copy. */
export function checkOpenApiSync(root, env = process.env) {
  return openApiDrift(root, env)
    .filter((d) => d.status === "drift")
    .map((d) => {
      const ops = [
        d.added.length ? `${d.added.length} operation(s) only in the source` : "",
        d.removed.length ? `${d.removed.length} operation(s) only in the bundled copy` : "",
      ].filter(Boolean);
      return `${d.name} OpenAPI at ${d.from} differs from src/client/openapi/${d.name}.json` +
        `${ops.length ? ` (${ops.join(", ")})` : " (schemas changed)"}; ${SYNC_HINT}`;
    });
}
