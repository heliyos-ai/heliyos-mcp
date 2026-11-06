/**
 * Runtime configuration from environment variables.
 *
 *   HELIYOS_API_KEY           required, an organization API key (`heliyos_...`)
 *   HELIYOS_BASE_URL          optional, defaults to https://api-prod.heliyos.ai
 *   HELIYOS_MCP_EXPERIMENTAL  optional, "1"/"true"/"yes" enables experimental tools
 *
 * Error messages never include the key itself.
 */

/** The Heliyos API address used when no other base URL is configured. */
export const DEFAULT_BASE_URL = "https://api-prod.heliyos.ai";
const API_KEY_PREFIX = "heliyos_";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** The settings the server runs with: the API key, the API base URL and whether experimental tools are on. */
export interface Config {
  apiKey: string;
  baseUrl: string;
  experimental: boolean;
}

/** A configuration problem the user can fix; its message is safe to print. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

type Env = Record<string, string | undefined>;

/**
 * Reads and validates the configuration from environment variables (`env` defaults to the process environment).
 * Returns a Config, or throws a ConfigError that never includes the API key.
 */
export function loadConfig(env: Env = process.env): Config {
  const apiKey = (env.HELIYOS_API_KEY ?? "").trim();
  if (apiKey.length === 0) {
    throw new ConfigError("Set HELIYOS_API_KEY to a Heliyos API key (create one in Settings → API keys).");
  }
  if (!apiKey.startsWith(API_KEY_PREFIX)) {
    throw new ConfigError("HELIYOS_API_KEY does not look like a Heliyos API key.");
  }

  return {
    apiKey,
    baseUrl: parseBaseUrl(env.HELIYOS_BASE_URL),
    experimental: TRUTHY.has((env.HELIYOS_MCP_EXPERIMENTAL ?? "").trim().toLowerCase()),
  };
}

/**
 * Validates HELIYOS_BASE_URL. https is required so the key never travels in
 * clear text; plain http is allowed only for local development hosts.
 */
function parseBaseUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (value.length === 0) return DEFAULT_BASE_URL;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("HELIYOS_BASE_URL must be an absolute URL such as https://api-prod.heliyos.ai.");
  }
  const isLocal = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new ConfigError("HELIYOS_BASE_URL must use https (plain http is only allowed for localhost).");
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new ConfigError("HELIYOS_BASE_URL must not contain credentials, a query string or a fragment.");
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}
