/** Final review group 4 minors: annotations, descriptions and key-shape redaction. */
import { describe, expect, it } from "vitest";
import { listToolSpecs } from "../../src/index.js";
import { redactSecrets } from "../../src/secrets.js";

const spec = (name: string) => {
  const found = listToolSpecs().find((s) => s.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

describe("key-shape redaction", () => {
  it.each([
    "heliyos_IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII",
    "heliyos_llllllllllllllllllllllllllllllll",
    "heliyos_1Il9ABCDEFGHIJKLMNPQRSTUVWXYZabc",
  ])("redacts a key from auth's alphabet (with I and l): %s", (key) => {
    expect(redactSecrets(`token ${key} end`)).toBe("token heliyos_[redacted] end");
  });

  it("leaves 0, O and o shaped strings (outside auth's alphabet) and tool names alone", () => {
    expect(redactSecrets("heliyos_O0OOOOOOOOOOOOOOOOOOOOOOOOOOOOOO")).toContain("O0OO");
    expect(redactSecrets("call heliyos_organization_get")).toBe("call heliyos_organization_get");
  });
});

describe("annotations", () => {
  it("heliyos_labels_update is destructive: values replaces the set and strips removed values", () => {
    expect(spec("heliyos_labels_update").annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
  });

  it("heliyos_tasks_run is destructive like heliyos_ask: it starts a worker run that can act", () => {
    expect(spec("heliyos_tasks_run").annotations).toEqual(spec("heliyos_ask").annotations);
  });
});

describe("heliyos_team_members_invite description", () => {
  it("says a second invite to a pending email fails with CONFLICT", () => {
    const d = spec("heliyos_team_members_invite").description;
    expect(d).not.toContain("sends two");
    expect(d).toContain("CONFLICT");
  });
});
