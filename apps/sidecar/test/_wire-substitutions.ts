/**
 * The wire corpus's substitution mechanics — extracted from `wire-corpus.gen.test.ts` so the slot
 * assignment can be measured without a mail server. The key ALLOWLISTS stay in the recording test:
 * they are the contract ("a new random field is a failing diff"), this file is the machinery.
 *
 * ── IDS: FIRST ENCOUNTER. OPAQUES: FIRST ENCOUNTER. ─────────────────────────────────────────────
 * Ids and message-id headers are numbered by FIRST ENCOUNTER in a deterministic walk (documents in
 * record order, object keys sorted, arrays in index order), never by sorting the raw values: the
 * raws are fresh uuids, so their sort order is random per run and the guard would fail every run.
 * (It did, on the first attempt.)
 *
 * ── DATES: SORTED PER FIELD, AND THE GRID IS KEYED BY FIELD. ────────────────────────────────────
 * Within one field, sorted order is chronological order — the meaning a client reads. ACROSS
 * fields, whether two stamps coincide is TIMING, not meaning, and it used to move the whole grid:
 * slots were assigned over the ONE sorted distinct set of every date in the corpus, so a stamp
 * that sometimes coincides with another field's stamp and sometimes does not changed the DISTINCT
 * COUNT and shifted every later slot by one. Measured at the 0.20.0 freeze, 1 run in 6: `sortAt`'s
 * instant coinciding with a neighbour moved `createdAt` from 00:05 to 00:04 and
 * `organizeConsentedAt` from 00:06 to 00:05 (FREEZE-020, 2026-09-18 22:05Z). Keyed per field, a
 * stamp under one key CANNOT move another key's slots — the placeholder carries the field's band
 * in its hour and the rank in its minute — at the deliberate price that the corpus no longer
 * encodes cross-field equality of two run-minted instants, which was timing wearing the shape of
 * meaning. Within one field, two stamps that collide still share a slot, so a field whose raw
 * values only SOMETIMES coincide still moves its own slots: `sortAt` did, 1 run in 6 after the
 * per-field grid, because it resolves to the IMAP INTERNALDATE, which GreenMail keeps to the
 * second, and three appends usually shared one. The journey now names each append's INTERNALDATE.
 * Stamps the engine mints per run to the millisecond (`createdAt`, `updatedAt`) could collide the
 * same way; none has been seen to, and that is stated here rather than papered over.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface WireKeys {
  idKeys: Set<string>;
  dateKeys: Set<string>;
  idArrayKeys: Set<string>;
  seqKeys: Set<string>;
  cursorKeys: Set<string>;
  opaqueKeys: Set<string>;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Found {
  ids: string[];
  dates: Map<string, Set<string>>;
  seqs: Set<number>;
  opaque: string[];
}

/** Collect every distinct raw value under an allowlisted key; dates grouped by their FIELD. */
function collect(value: Json, keys: WireKeys, into: Found): void {
  const push = (list: string[], v: string): void => { if (!list.includes(v)) list.push(v); };
  if (Array.isArray(value)) {
    for (const v of value) collect(v, keys, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const k of Object.keys(value).sort()) {
    const v = value[k]!;
    if (typeof v === "string" && keys.idKeys.has(k) && UUID_RE.test(v)) push(into.ids, v);
    else if (typeof v === "string" && keys.dateKeys.has(k)) {
      const set = into.dates.get(k) ?? new Set<string>();
      set.add(v);
      into.dates.set(k, set);
    } else if (typeof v === "number" && keys.seqKeys.has(k)) into.seqs.add(v);
    else if (typeof v === "string" && keys.opaqueKeys.has(k)) push(into.opaque, v);
    else if (Array.isArray(v) && keys.idArrayKeys.has(k)) {
      for (const e of v) if (typeof e === "string" && UUID_RE.test(e)) push(into.ids, e);
    }
    collect(v, keys, into);
  }
}

/** A stamp outside the placeholder grid, so collapsing onto it can never collide with a real one. */
export const BOOKKEEPING_STAMP = "2020-01-01T00:00:00.000Z";

/**
 * Flatten the engine's own per-folder bookkeeping stamps BEFORE anything is numbered: `GET
 * /mailboxes` carries one `updatedAt` per `ohmail/*` folder, written microseconds apart in an
 * order nothing promises. Directed by SHAPE (`{folder, hasSyncCursor, updatedAt}`), not by path.
 */
export function settleBookkeeping(value: Json): Json {
  if (Array.isArray(value)) return value.map(settleBookkeeping);
  if (value === null || typeof value !== "object") return value;
  const out: { [k: string]: Json } = {};
  const isFolderState = "folder" in value && "hasSyncCursor" in value;
  for (const [k, v] of Object.entries(value)) {
    out[k] = isFolderState && k === "updatedAt" ? BOOKKEEPING_STAMP : settleBookkeeping(v);
  }
  return out;
}

export interface Substitutions {
  ids: Map<string, string>;
  /** Keyed `JSON.stringify([field, raw])` — the per-field grid described in the header. */
  dates: Map<string, string>;
  seqs: Map<number, number>;
  opaque: Map<string, string>;
  addresses: Map<string, string>;
}

/** Valid v4-shaped uuids, so a normalized id still passes the API's own `ids must be message ids`. */
export function placeholderUUID(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** The field's band in the HOUR, the stamp's chronological rank within the field in the MINUTE. */
export function placeholderDate(fieldIndex: number, rank: number): string {
  return new Date(Date.UTC(2026, 0, 1, fieldIndex, rank, 0)).toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

export function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64url(s: string): string | null {
  try {
    return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function substitutionsFor(docs: Json[], owner: string, keys: WireKeys): Substitutions {
  const found: Found = { ids: [], dates: new Map(), seqs: new Set(), opaque: [] };
  for (const d of docs) collect(d, keys, found);

  const ids = new Map<string, string>();
  found.ids.forEach((raw, i) => ids.set(raw, placeholderUUID(i + 1)));

  const dates = new Map<string, string>();
  [...found.dates.keys()].sort().forEach((field, fieldIndex) => {
    [...found.dates.get(field)!].sort().forEach((raw, rank) => {
      dates.set(JSON.stringify([field, raw]), placeholderDate(fieldIndex, rank));
    });
  });

  const seqs = new Map<number, number>();
  [...found.seqs].sort((a, b) => a - b).forEach((raw, i) => seqs.set(raw, i + 1));

  const opaque = new Map<string, string>();
  found.opaque.forEach((raw, i) => opaque.set(raw, `header-${i + 1}@corpus.test`));

  const addresses = new Map<string, string>([[owner, "reader@corpus.test"]]);
  return { ids, dates, seqs, opaque, addresses };
}

export function substitute(value: Json, s: Substitutions, keys: WireKeys, key?: string): Json {
  if (Array.isArray(value)) {
    if (key !== undefined && keys.idArrayKeys.has(key)) {
      return value.map((v) => (typeof v === "string" ? s.ids.get(v) ?? v : substitute(v, s, keys)));
    }
    return value.map((v) => substitute(v, s, keys));
  }
  if (value !== null && typeof value === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, s, keys, k);
    return out;
  }
  if (typeof value === "number" && key !== undefined && keys.seqKeys.has(key)) {
    return s.seqs.get(value) ?? value;
  }
  if (typeof value !== "string") return value;
  if (key !== undefined && keys.idKeys.has(key)) return s.ids.get(value) ?? value;
  if (key !== undefined && keys.dateKeys.has(key)) return s.dates.get(JSON.stringify([key, value])) ?? value;
  if (key !== undefined && keys.opaqueKeys.has(key)) return s.opaque.get(value) ?? value;
  if (key !== undefined && keys.cursorKeys.has(key)) {
    // `cursor` is an opaque base64url seq (`encodeSeqCursor`), mapped through the SAME seq
    // numbering and re-encoded, so the corpus's cursor is still a real cursor for the seq it names.
    if (value === "0" || value === "") return value;
    const raw = unb64url(value);
    if (raw !== null && /^\d+$/.test(raw)) return b64url(String(s.seqs.get(Number(raw)) ?? Number(raw)));
    return value;
  }
  const whole = s.addresses.get(value);
  if (whole !== undefined) return whole;
  return embedded(value, s);
}

/**
 * Replace values this run ALREADY discovered under an allowlisted key, wherever they are EMBEDDED
 * in a free-form string. Still allowlist-driven: only values found under an enumerated key are
 * substituted, so a NEW random field lands raw in the corpus and fails the next run — a bare uuid
 * regex would have absorbed it silently.
 */
function embedded(value: string, s: Substitutions): string {
  let out = value;
  for (const [raw, placeholder] of s.opaque) out = out.split(raw).join(placeholder);
  for (const [raw, placeholder] of s.addresses) out = out.split(raw).join(placeholder);
  for (const [raw, placeholder] of s.ids) out = out.split(raw).join(placeholder);
  return out;
}

/** Sorted keys throughout, so the committed file is byte-stable and reads as a diff. */
export function canonical(value: Json): string {
  const sortKeys = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === "object") {
      const out: { [k: string]: Json } = {};
      for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]!);
      return out;
    }
    return v;
  };
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}
