/**
 * Normalises a `pnpm ddb:dump` snapshot so two dumps taken after two
 * `pnpm demo:reset` runs can be diffed. Any difference left after this is
 * a reset bug: the reset is supposed to be idempotent, apart from the two
 * things that legitimately differ between runs.
 *
 *   ULIDs       Every event id and consent id is minted fresh. Replaced
 *               with `<ulid>`.
 *   timestamps  Anything the reset stamps with the wall clock. Replaced
 *               with `<timestamp>` — EXCEPT the staged instants
 *               (2026-01-12T10:30:00Z and the seconds after it, see
 *               stage.ts), which are fixed by design and therefore must
 *               match exactly. Masking those too would hide a reset that
 *               drifted the very date the card prints. A caller can name
 *               further instants that are fixed by design (`keepTimestamps`;
 *               the idempotence check passes the fixture file's date).
 *
 * Nothing else is touched. In particular the ledger's eventHash and
 * prevEventHash are left alone: they are functions of the (fixed) staged
 * timestamps and payloads, so they must be identical across resets, and a
 * hash that differs is exactly the kind of bug this exists to catch.
 */

export type Dump = Record<string, Array<Record<string, unknown>>>;

export interface NormaliseStats {
  ulids: number;
  timestamps: number;
}

export interface NormaliseOptions {
  /** Exact timestamps that are deterministic by design and must therefore be compared, not masked. */
  keepTimestamps?: readonly string[];
}

const ULID_RE = /\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b/g;
const ISO_TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
/** 2026-01-12T10:30:00Z plus up to a minute of one-second-apart staged events. */
const STAGED_INSTANT_RE = /^2026-01-12T10:(30:\d{2}|31:00)(?:\.\d+)?Z$/;

function normaliseString(value: string, stats: NormaliseStats, keep: ReadonlySet<string>): string {
  return value
    .replace(ISO_TIMESTAMP_RE, (match) => {
      if (STAGED_INSTANT_RE.test(match) || keep.has(match)) return match;
      stats.timestamps += 1;
      return "<timestamp>";
    })
    .replace(ULID_RE, () => {
      stats.ulids += 1;
      return "<ulid>";
    });
}

function normaliseValue(value: unknown, stats: NormaliseStats, keep: ReadonlySet<string>): unknown {
  if (typeof value === "string") return normaliseString(value, stats, keep);
  if (Array.isArray(value)) return value.map((v) => normaliseValue(v, stats, keep));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normaliseValue(v, stats, keep)]),
    );
  }
  return value;
}

/** Scan order is not a property the reset promises, so rows are ordered by their raw key first. */
function rowKey(item: Record<string, unknown>): string {
  return ["pk", "sk", "serverId", "sessionId"].map((k) => String(item[k] ?? "")).join("\u0000");
}

export function normaliseDump(dump: Dump, options: NormaliseOptions = {}): { dump: Dump; stats: NormaliseStats } {
  const stats: NormaliseStats = { ulids: 0, timestamps: 0 };
  const keep = new Set(options.keepTimestamps ?? []);
  const out: Dump = {};
  for (const table of Object.keys(dump).sort()) {
    const rows = [...(dump[table] ?? [])].sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
    out[table] = rows.map((row) => normaliseValue(row, stats, keep) as Record<string, unknown>);
  }
  return { dump: out, stats };
}

export function normalisedText(dump: Dump, options: NormaliseOptions = {}): { text: string; stats: NormaliseStats } {
  const { dump: normalised, stats } = normaliseDump(dump, options);
  return { text: `${JSON.stringify(normalised, null, 2)}\n`, stats };
}
