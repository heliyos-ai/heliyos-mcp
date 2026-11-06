/**
 * Configuration from the environment: the API key, the base URL rules (https only, localhost excepted) and the experimental flag.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const VALID_KEY = "heliyos_ABCDEFGHJKLMNPQRSTUVWXYZabcdef";

describe("loadConfig", () => {
  it("throws a ConfigError telling the user to set HELIYOS_API_KEY when it is missing", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(
      "Set HELIYOS_API_KEY to a Heliyos API key (create one in Settings → API keys)."
    );
  });

  it("treats an empty or whitespace-only key as missing", () => {
    expect(() => loadConfig({ HELIYOS_API_KEY: "" })).toThrow("Set HELIYOS_API_KEY");
    expect(() => loadConfig({ HELIYOS_API_KEY: "   " })).toThrow("Set HELIYOS_API_KEY");
  });

  it("rejects a key without the heliyos_ prefix and never echoes the key", () => {
    const run = () => loadConfig({ HELIYOS_API_KEY: "sk-live-secret-value" });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow("HELIYOS_API_KEY does not look like a Heliyos API key.");
    try {
      run();
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("sk-live-secret-value");
    }
  });

  it("defaults the base URL to https://api-prod.heliyos.ai", () => {
    const config = loadConfig({ HELIYOS_API_KEY: VALID_KEY });
    expect(config).toEqual({
      apiKey: VALID_KEY,
      baseUrl: "https://api-prod.heliyos.ai",
      experimental: false,
    });
  });

  it("trims surrounding whitespace from the key", () => {
    expect(loadConfig({ HELIYOS_API_KEY: `  ${VALID_KEY}\n` }).apiKey).toBe(VALID_KEY);
  });

  it("uses HELIYOS_BASE_URL and strips trailing slashes", () => {
    const config = loadConfig({
      HELIYOS_API_KEY: VALID_KEY,
      HELIYOS_BASE_URL: "https://staging.heliyos.ai//",
    });
    expect(config.baseUrl).toBe("https://staging.heliyos.ai");
  });

  it("allows plain http only for localhost", () => {
    expect(
      loadConfig({ HELIYOS_API_KEY: VALID_KEY, HELIYOS_BASE_URL: "http://localhost:8080/" }).baseUrl
    ).toBe("http://localhost:8080");
    expect(() =>
      loadConfig({ HELIYOS_API_KEY: VALID_KEY, HELIYOS_BASE_URL: "http://api.example.com" })
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ HELIYOS_API_KEY: VALID_KEY, HELIYOS_BASE_URL: "not a url" })
    ).toThrow(ConfigError);
  });

  it("reads HELIYOS_MCP_EXPERIMENTAL as a boolean flag", () => {
    for (const value of ["1", "true", "TRUE", "yes"]) {
      expect(loadConfig({ HELIYOS_API_KEY: VALID_KEY, HELIYOS_MCP_EXPERIMENTAL: value }).experimental).toBe(true);
    }
    for (const value of ["", "0", "false", "no"]) {
      expect(loadConfig({ HELIYOS_API_KEY: VALID_KEY, HELIYOS_MCP_EXPERIMENTAL: value }).experimental).toBe(false);
    }
  });
});
