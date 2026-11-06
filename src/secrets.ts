/**
 * Redaction for text that may reach a tool result. Only two things are
 * removed: the configured API key(s) (registered by createClient) and any
 * string with the Heliyos API key shape (`heliyos_` + 32 chars from the key
 * alphabet). Tool names such as heliyos_organization_get are left alone.
 */
const registered = new Set<string>();

// auth-mvc generateKey.ts alphabet: 1-9, A-Z and a-z without O and o (I and l are in it).
const KEY_SHAPE = /heliyos_[1-9A-NP-Za-np-z]{32}(?![A-Za-z0-9])/g;

/** Remembers a secret value so redactSecrets removes it from later text. Values shorter than 16 characters are ignored. */
export function registerSecret(value: string): void {
  // Very short values would redact ordinary words; a real key is 40 chars.
  if (value.length >= 16) registered.add(value);
}

/** Replaces every registered secret and anything shaped like a Heliyos API key in `text`. Returns the cleaned text. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of registered) out = out.split(secret).join("[redacted]");
  return out.replace(KEY_SHAPE, "heliyos_[redacted]");
}

// ---------------------------------------------------------------------------
// Credential fields in tool output
//
// Every tool result passes through `redactToolOutput` (tools/define.ts) and
// every resource through `redactCredentials` (resources.ts), so no Nylas or
// OAuth token, grant id, API key or key hash reaches a client even if a
// backend response carries one.
//
// Deliberately narrower than the API's own log redaction: `signature`, `card`,
// `pin`, `session` are real CRM fields and stay. The key list mirrors the one
// the Heliyos API applies to the data it stores.
// ---------------------------------------------------------------------------

/** The text that replaces a credential value in tool output. */
export const REDACTED = "[REDACTED]";

const VISIBLE_KEYS = new Set([
  "totaltokens", "prompttokens", "completiontokens", "maxtokens", "tokencount",
  "secretary",
]);

const SENSITIVE_EXACT = new Set([
  "token", "accesstoken", "refreshtoken", "idtoken", "authtoken", "jwt",
  "apikey", "xapikey", "keyhash", "passwordhash",
  "password", "passwd", "passphrase",
  "secret", "clientsecret", "webhooksecret", "secretkey", "secretaccesskey",
  "privatekey", "encryptionkey", "signingkey",
  "authorization", "cookie", "setcookie", "sessionid",
  "grantid", "composioconnectionid",
]);

const SENSITIVE_SUFFIXES = [
  "token", "secret", "apikey", "password", "privatekey", "keyhash",
  "clientsecret", "accesskey", "grantid",
];

const SENSITIVE_PREFIXES = ["password", "secret"];

const MAX_DEPTH = 32;
// A credential value shorter than this is too likely to be an ordinary word
// to scrub from free text (it is still replaced under its key).
const MIN_SCRUB_LENGTH = 8;

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/** True when an object key names a credential, for example a token, secret or key hash, so its value must not be shown. */
export function isCredentialKey(key: string): boolean {
  const k = normalizeKey(String(key));
  if (!k || VISIBLE_KEYS.has(k)) return false;
  if (SENSITIVE_EXACT.has(k)) return true;
  if (SENSITIVE_SUFFIXES.some((s) => k.endsWith(s))) return true;
  return SENSITIVE_PREFIXES.some((p) => k.startsWith(p));
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * A copy of `value` with every credential value replaced. The input is never
 * mutated. String values found under credential keys are added to `found` so
 * the caller can scrub them from free text too.
 */
export function redactCredentials<T>(value: T, found?: Set<string>, depth = 0): T {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => redactCredentials(v, found, depth + 1)) as unknown as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isCredentialKey(k) && v !== null && v !== undefined && v !== "") {
        if (found && typeof v === "string") found.add(v);
        out[k] = REDACTED;
      } else {
        out[k] = redactCredentials(v, found, depth + 1);
      }
    }
    return out as T;
  }
  return value;
}

// "accessToken": "…"  /  'api_key': '…'  (JSON or JS-ish text a tool embeds).
const QUOTED_PAIR = /(["'])([A-Za-z0-9_.-]{1,64})\1(\s*:\s*)(["'])((?:\\.|(?!\4)[^\\\r\n]){0,4096})\4/g;

/** Scrub credential values out of tool text. */
export function redactCredentialText(text: string, found: Iterable<string> = []): string {
  let out = text.replace(QUOTED_PAIR, (match, q1, key, sep, q2, val) =>
    isCredentialKey(key) && val !== "" ? `${q1}${key}${q1}${sep}${q2}${REDACTED}${q2}` : match
  );
  for (const v of found) {
    if (v.length >= MIN_SCRUB_LENGTH) out = out.split(v).join(REDACTED);
  }
  return redactSecrets(out);
}

/** Apply `fn` to every string in a plain JSON-like value (copy; input untouched). */
function mapStrings(value: unknown, fn: (s: string) => string, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn, depth + 1));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn, depth + 1);
    return out;
  }
  return value;
}

/**
 * The single exit for tool results. Credential keys are replaced first (which
 * also collects their values); then every string, in the text and inside the
 * structured content (e.g. a change summary that quotes a token), is scrubbed
 * of quoted credential pairs and of those collected values.
 */
export function redactToolOutput(text: string, structuredContent: unknown): { text: string; structuredContent: unknown } {
  const found = new Set<string>();
  const keyed = structuredContent === undefined ? undefined : redactCredentials(structuredContent, found);
  const scrub = (s: string) => redactCredentialText(s, found);
  return {
    text: scrub(text),
    structuredContent: keyed === undefined ? undefined : mapStrings(keyed, scrub),
  };
}
