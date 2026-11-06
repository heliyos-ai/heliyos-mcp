/**
 * Plain-text renderers for tool results. Every tool returns a readable text
 * block (what the model always sees) next to structuredContent, and the text is
 * kept well under client result caps (Claude Code: 25k tokens).
 */

/** Hard ceiling for one tool result's text block. */
export const MAX_TEXT_CHARS = 20_000;
/** The widest a table cell can be, in characters, before its text is clipped. */
export const MAX_CELL_CHARS = 60;
/** The most rows a rendered table shows. */
export const MAX_TABLE_ROWS = 100;

/** One line of display text for any JSON value. Empty string for null/undefined. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map(formatValue).filter((v) => v !== "").join(", ");
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Select options, relationships and similar wrappers carry a display label.
    for (const key of ["name", "label", "value", "title"]) {
      const v = obj[key];
      if (typeof v === "string" || typeof v === "number") return String(v);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "[unserialisable]";
    }
  }
  return String(value);
}

const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

/** Cuts text to `max` characters, ending with "…" when cut. */
export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * A fixed-width table. `columns` are row keys and double as headers. Cells are
 * flattened to one line and cut at 60 characters; at most 100 rows are shown.
 */
export function renderTable(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: readonly string[],
  maxCell: number = MAX_CELL_CHARS
): string {
  const shown = rows.slice(0, MAX_TABLE_ROWS);
  const cells = shown.map((row) => columns.map((col) => clip(oneLine(formatValue(row[col])), maxCell)));
  const widths = columns.map((col, i) => Math.max(col.length, ...cells.map((r) => r[i]!.length)));
  const line = (values: readonly string[]) =>
    values
      .map((v, i) => (i === values.length - 1 ? v : v.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();

  const out = [line(columns), line(widths.map((w) => "-".repeat(w))), ...cells.map(line)];
  if (rows.length > shown.length) out.push(`… and ${rows.length - shown.length} more`);
  return out.join("\n");
}

/** One way to draw a table: which columns to show and the widest cell allowed. */
export interface TableLayout {
  columns: readonly string[];
  maxCell: number;
}

/**
 * Renders the first layout whose table fits in `budget` characters. List the
 * layouts widest first and end with one that always fits (few, narrow columns),
 * so every row of a page is shown rather than cutting the text mid-page.
 */
export function fitTable(rows: ReadonlyArray<Record<string, unknown>>, layouts: readonly TableLayout[], budget: number): string {
  let table = "";
  for (const layout of layouts) {
    table = renderTable(rows, layout.columns, layout.maxCell);
    if (table.length <= budget) return table;
  }
  return table;
}

/**
 * `key: value` lines. With `fields`, only those keys in that order; otherwise
 * every key. Empty values are skipped so concise output stays short.
 */
export function renderRecord(record: Record<string, unknown>, fields?: readonly string[]): string {
  const keys = fields ?? Object.keys(record);
  return keys
    .map((key) => [key, oneLine(formatValue(record[key]))] as const)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

/**
 * Cuts `text` to at most `max` characters, ending with a note and `hint` that
 * tells the model how to get the rest.
 */
export function truncate(text: string, max: number, hint: string): string {
  if (text.length <= max) return text;
  const note = (omitted: number) => `\n… output truncated (${omitted} more characters). ${hint}`;
  // The note's length depends on the omitted count; size it for the worst case.
  const reserve = note(text.length).length;
  const keep = Math.max(0, max - reserve);
  return `${text.slice(0, keep)}${note(text.length - keep)}`;
}

/** Wording used when whole text blocks are dropped to fit a budget, so the reader knows what was left out. */
export interface BlockFitOptions {
  /** Plural noun for the items, for example "records". */
  items: string;
  /** The structuredContent key that holds every item. */
  key: string;
  /** How to read the omitted items, for example 'Read them with heliyos_notes_get.' */
  readHint: string;
}

/**
 * Whole text blocks (one per item) while they fit in `budget`. If some do not,
 * the text names exactly which items it omits (they are all in
 * structuredContent), so a list never silently skips items before next_cursor.
 */
export function fitBlocks(
  blocks: readonly string[],
  ids: readonly string[],
  budget: number,
  options: BlockFitOptions
): string {
  const all = blocks.join("\n\n");
  if (all.length <= budget) return all;

  const omittedNote = (shown: number) =>
    `Text shows ${shown} of the ${blocks.length} ${options.items} on this page; all ${blocks.length} are in ` +
    `structuredContent.${options.key}. Not shown here: ${ids.slice(shown).join(", ")}. ${options.readHint} ` +
    "next_cursor continues after the whole page.";
  // Reserve room for the note at its longest (only one item shown).
  const room = budget - omittedNote(1).length - 2;
  const shown: string[] = [];
  let used = 0;
  for (const block of blocks) {
    const cost = block.length + (shown.length ? 2 : 0);
    if (shown.length > 0 && used + cost > room) break;
    shown.push(block);
    used += cost;
  }
  return `${shown.join("\n\n")}\n\n${omittedNote(shown.length)}`;
}
