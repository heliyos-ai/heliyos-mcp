/**
 * The bundled OpenAPI documents (src/client/openapi) must match the documents the Heliyos API
 * serves, because the generated client validates every request body before it is sent. The live
 * comparison runs only where HELIYOS_PLATFORM_OPENAPI and HELIYOS_AUTH_OPENAPI name saved copies;
 * elsewhere it skips and says so.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkOpenApiSync, openApiDrift, operationKeys } from "../scripts/openapi-sources.mjs";
import { ROOT } from "./helpers/repo.js";

const SYNC_HINT = "run `npm run sync-openapi && npm run codegen`";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const doc = (paths: Record<string, Record<string, { operationId: string }>>) => ({ openapi: "3.1.0", info: {}, paths });

/**
 * A fake package root with bundled copies, plus the env that names each source document
 * written under <ws>/sources (only for the sources given in `built`).
 */
function workspace(
  bundled: { platform: object; auth: object },
  built: { platform?: object; auth?: object }
): { root: string; env: Record<string, string> } {
  const ws = mkdtempSync(join(tmpdir(), "heliyos-mcp-drift-"));
  temps.push(ws);
  const root = join(ws, "package");
  mkdirSync(join(root, "src/client/openapi"), { recursive: true });
  writeFileSync(join(root, "src/client/openapi/platform.json"), JSON.stringify(bundled.platform));
  writeFileSync(join(root, "src/client/openapi/auth.json"), JSON.stringify(bundled.auth));
  const env: Record<string, string> = {};
  for (const [name, content] of Object.entries(built)) {
    if (!content) continue;
    mkdirSync(join(ws, "sources"), { recursive: true });
    const file = join(ws, `sources/${name}.json`);
    writeFileSync(file, JSON.stringify(content));
    env[name === "platform" ? "HELIYOS_PLATFORM_OPENAPI" : "HELIYOS_AUTH_OPENAPI"] = file;
  }
  return { root, env };
}

const base = doc({ "/v1/platform/tasks": { get: { operationId: "listTasks" } } });
const auth = doc({ "/v1/auth/health": { get: { operationId: "getHealth" } } });

describe("openApiDrift", () => {
  it("lists operations as METHOD path operationId", () => {
    expect(operationKeys(doc({ "/a": { get: { operationId: "getA" }, post: { operationId: "postA" } } }))).toEqual([
      "GET /a getA",
      "POST /a postA",
    ]);
  });

  it("reports a source that is not named as absent", () => {
    const { root, env } = workspace({ platform: base, auth }, {});
    expect(openApiDrift(root, env).map((d) => d.status)).toEqual(["absent", "absent"]);
    expect(checkOpenApiSync(root, env)).toEqual([]);
  });

  it("reports a named source file that does not exist as absent", () => {
    const { root } = workspace({ platform: base, auth }, {});
    const env = { HELIYOS_PLATFORM_OPENAPI: join(root, "nowhere.json") };
    expect(openApiDrift(root, env)[0]!.status).toBe("absent");
  });

  it("reports added and removed operations and a content change", () => {
    const built = doc({
      "/v1/platform/tasks": { get: { operationId: "listTasksV2" } },
      "/v1/platform/agency/organizations": { get: { operationId: "listAgencyOrganizations" } },
    });
    const { root, env } = workspace({ platform: base, auth }, { platform: built, auth });
    const [platform, authDrift] = openApiDrift(root, env);
    expect(platform).toMatchObject({
      name: "platform",
      status: "drift",
      added: ["GET /v1/platform/agency/organizations listAgencyOrganizations", "GET /v1/platform/tasks listTasksV2"],
      removed: ["GET /v1/platform/tasks listTasks"],
    });
    expect(authDrift!.status).toBe("same");
    const problems = checkOpenApiSync(root, env).join("\n");
    expect(problems).toMatch(/platform OpenAPI .* differs/);
    expect(problems).toContain(SYNC_HINT);
  });

  it("reports a schema-only change as drift with no operation differences", () => {
    const built = doc({ "/v1/platform/tasks": { get: { operationId: "listTasks", summary: "changed" } as never } });
    const { root, env } = workspace({ platform: base, auth }, { platform: built, auth });
    expect(openApiDrift(root, env)[0]).toMatchObject({ status: "drift", added: [], removed: [] });
  });
});

describe("bundled OpenAPI vs the named source documents", () => {
  const drift = openApiDrift(ROOT, process.env);
  for (const d of drift) {
    it.skipIf(d.status === "absent")(
      `${d.name} matches ${d.from ?? "(no source named)"}${d.status === "absent" ? " (skipped: no source document named)" : ""}`,
      () => {
        expect({ added: d.added, removed: d.removed }, `${d.name} operations drifted; ${SYNC_HINT}`).toEqual({
          added: [],
          removed: [],
        });
        expect(d.status, `${d.name} schemas drifted; ${SYNC_HINT}`).toBe("same");
      }
    );
  }
  it("says when a source is absent", () => {
    for (const d of drift.filter((x) => x.status === "absent")) {
      console.warn(`openapi drift: ${d.name} skipped, no source document named (set HELIYOS_${d.name.toUpperCase()}_OPENAPI to check)`);
    }
    expect(drift.map((d) => d.name)).toEqual(["platform", "auth"]);
  });
});

