/**
 * The exact arrays the screens render, plus search and the render manifest.
 *
 * Screens own no list logic: whatever a screen shows, it shows by iterating one
 * of these. That is what makes the NO-COLLAPSE RULE checkable —
 * `renderManifest()` enumerates every mail identity a route puts on screen, at
 * every depth (conversations, held bags), and the suite asserts it covers the
 * fixtures exactly. A "12 more" placeholder would drop identities and fail.
 */
import type { TagId } from "@ohmail/fixtures";
import {
  world,
  type AppState,
  type Held,
  type Mail,
  type PileKind,
  type Place,
  type ScreenerSeg,
} from "./model";

/* --------------------------------------------------------------- the routes */

export type Route =
  | { name: "ohbox" }
  | { name: "reads" }
  | { name: "receipts" }
  | { name: "screener"; seg: ScreenerSeg }
  | { name: "screenerDetail"; seg: ScreenerSeg; id: string }
  | { name: "message"; id: string }
  | { name: "triage" }
  | { name: "tag"; tag: TagId }
  | { name: "search" }
  | { name: "settings" };

/* ------------------------------------------------------------------- ohbox */

/** Ohbox splits new / previously seen. Reading never moves a row between them. */
export const ohboxNew = (s: AppState): Mail[] => s.ohbox.filter((m) => m.unread);
export const ohboxSeen = (s: AppState): Mail[] => s.ohbox.filter((m) => !m.unread);
export const ohboxRows = (s: AppState): Mail[] => [...ohboxNew(s), ...ohboxSeen(s)];
export const ohboxUnread = (s: AppState): number => ohboxNew(s).length;
export const ohboxMeta = (s: AppState): string =>
  `${ohboxUnread(s)} unread of ${s.ohbox.length}`;

/* ------------------------------------------------------------------- reads */

/**
 * Reads renders in stored order with the waterline as a marker, not as a sort
 * key: marking an item seen fades its dot **in place**. A list that resorted
 * under the reader's thumb would be the opposite of a skim stream.
 */
export const readsStream = (s: AppState): Mail[] => s.reads;
export const readsNew = (s: AppState): number => s.reads.filter((m) => m.unread).length;
export const readsMeta = (s: AppState): string => `${readsNew(s)} new`;
/**
 * The waterline renders directly ABOVE this id — the newest issue already seen at the last
 * visit (`WaterlineFixture.newestSeenId`), which itself sits below the line.
 */
export const waterlineAbove = (s: AppState): string | null =>
  s.reads.some((m) => m.id === world.waterline.newestSeenId) ? world.waterline.newestSeenId : null;

/* ---------------------------------------------------------------- receipts */

export interface ReceiptGroup {
  label: string;
  items: Mail[];
}
/** Day groups resolved to real messages. The groups cover every receipt. */
export function receiptGroups(s: AppState): ReceiptGroup[] {
  const byId = new Map(s.receipts.map((m) => [m.id, m]));
  const grouped = s.receiptGroups.map((g) => ({
    label: g.label,
    items: g.ids.map((id) => byId.get(id)).filter((m): m is Mail => !!m),
  }));
  // Anything a group forgot still renders — a receipt is never dropped because
  // its day bucket went missing.
  const seen = new Set(grouped.flatMap((g) => g.items.map((m) => m.id)));
  const orphans = s.receipts.filter((m) => !seen.has(m.id));
  return orphans.length ? [...grouped, { label: "Earlier", items: orphans }] : grouped;
}
export const receiptStream = (s: AppState): Mail[] => receiptGroups(s).flatMap((g) => g.items);
export const receiptsNew = (s: AppState): number => s.receipts.filter((m) => m.unread).length;
export const receiptsMeta = (s: AppState): string => `${receiptsNew(s)} new`;

/* -------------------------------------------------------------- mail lookup */

export function mail(s: AppState, id: string): Mail | undefined {
  return (
    s.ohbox.find((m) => m.id === id) ??
    s.reads.find((m) => m.id === id) ??
    s.receipts.find((m) => m.id === id)
  );
}

export const allMail = (s: AppState): Mail[] => [...s.ohbox, ...s.reads, ...s.receipts];

/** The whole conversation, oldest → newest, every message rendered. */
export function conversation(m: Mail): Held[] {
  return [
    ...m.earlier,
    { id: m.id, subject: m.subject, time: m.time, body: m.body, trackerNote: m.trackerNote, seen: !m.unread },
  ];
}

/**
 * The thread badge. Derived from mail that is actually rendered, so the number
 * on a row can never exceed what tapping it shows. Returns 0 when there is no
 * conversation to show — see the note in `model.ts#toMail`.
 */
export function threadCount(m: Mail): number {
  return m.earlier.length ? m.earlier.length + 1 : 0;
}

export const stream = (s: AppState, place: Place): Mail[] =>
  place === "reads" ? readsStream(s) : place === "receipts" ? receiptStream(s) : ohboxRows(s);

/* ---------------------------------------------------------------- screener */

export const screenerMeta = (s: AppState): string =>
  `${s.waiting.length} first-time sender${s.waiting.length === 1 ? "" : "s"} waiting`;

export function screenerIds(s: AppState, seg: ScreenerSeg): string[] {
  return seg === "waiting"
    ? s.waiting.map((w) => w.id)
    : seg === "screened"
      ? s.screened.map((x) => x.id)
      : s.spam.map((x) => x.id);
}

export function screenerCount(s: AppState, seg: ScreenerSeg): number {
  return screenerIds(s, seg).length;
}

/** The held mail a screener entry previews — **all** of it, always. */
export function heldMail(s: AppState, seg: ScreenerSeg, id: string): Held[] {
  if (seg === "waiting") return s.waiting.find((w) => w.id === id)?.held ?? [];
  if (seg === "screened") return s.screened.find((x) => x.id === id)?.held ?? [];
  return s.spam.find((x) => x.id === id)?.held ?? [];
}

/* ------------------------------------------------------------------ triage */

export const pile = (s: AppState, kind: PileKind) => s.piles.find((p) => p.kind === kind);
export const pileCount = (s: AppState, kind: PileKind) => pile(s, kind)?.items.length ?? 0;
export const triageTotal = (s: AppState) => s.piles.reduce((n, p) => n + p.items.length, 0);
export const triageMeta = (s: AppState): string => {
  const n = triageTotal(s);
  return `${n} item${n === 1 ? "" : "s"}`;
};

/* -------------------------------------------------------------------- tags */

/** A tag groups mail across Ohbox, Reads and Receipts without moving any of it. */
export function taggedMail(s: AppState, tag: TagId): Mail[] {
  const ids = s.tagged[tag] ?? [];
  return allMail(s).filter((m) => ids.includes(m.id));
}

export function tagsOfMessage(s: AppState, id: string): TagId[] {
  return (Object.keys(s.tagged) as TagId[]).filter((t) => s.tagged[t].includes(id));
}

export const tagMeta = (s: AppState, tag: TagId): string => {
  const n = taggedMail(s, tag).length;
  return `${n} message${n === 1 ? "" : "s"} · across every view`;
};

/* ------------------------------------------------------------------ search */

export interface SearchHit {
  id: string;
  who: string;
  where: string;
  subject: string;
  /** Set when the hit came from a typo-tolerant match: the word actually found. */
  fuzzyOf?: string;
  /** Substring of `subject` to highlight, when the match was exact. */
  highlight?: string;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  tookMs: number;
  facets: { title: string; items: { label: string; count?: number }[] }[];
}

const PLACE_LABEL: Record<Place, string> = { ohbox: "Ohbox", reads: "Reads", receipts: "Receipts" };

/**
 * Typo-tolerant search over the demo world.
 *
 * Exact substring first (what the reader typed, found where they expect), then
 * a bounded edit-distance pass over whole words so `invoce` still reaches
 * *Invoice #078*. The distance budget grows with the term because a one-letter
 * slip in a short word is more likely to be a different word entirely:
 * ≤3 chars exact only, ≤6 chars one edit, longer two.
 *
 * There is no index and no network — it is a linear pass over ~31 messages,
 * which is why the reported time is a real measurement and not a fixture.
 */
export function search(s: AppState, query: string): SearchResult {
  const started = now();
  const q = query.trim().toLowerCase();
  const hits: SearchHit[] = [];
  if (q.length) {
    for (const m of allMail(s)) {
      const hit = matchMail(m, q);
      if (hit) hits.push(hit);
    }
  }
  const tookMs = Math.max(1, Math.round(now() - started));
  return { query, hits, tookMs, facets: facetsOf(s, hits) };
}

function matchMail(m: Mail, q: string): SearchHit | null {
  const where = `${PLACE_LABEL[m.place]} · ${m.time}`;
  const base = { id: m.id, who: m.from.name, where, subject: subjectLine(m) };
  const fields = [m.subject, m.from.name, m.from.address, m.body, m.amount ?? ""];

  for (const f of fields) {
    const i = f.toLowerCase().indexOf(q);
    if (i >= 0) {
      const exact = f.slice(i, i + q.length);
      return { ...base, highlight: base.subject.toLowerCase().includes(q) ? exact : undefined };
    }
  }
  const budget = q.length <= 3 ? 0 : q.length <= 6 ? 1 : 2;
  if (budget === 0) return null;
  for (const f of fields) {
    for (const word of f.split(/[^\p{L}\p{N}]+/u)) {
      if (!word || Math.abs(word.length - q.length) > budget) continue;
      if (editDistance(word.toLowerCase(), q) <= budget) return { ...base, fuzzyOf: word };
    }
  }
  return null;
}

function subjectLine(m: Mail): string {
  return m.amount ? `${m.subject} — ${m.amount}` : m.subject;
}

/** Facets are counted off the real hits — never fabricated. */
function facetsOf(s: AppState, hits: SearchHit[]) {
  const bySender = new Map<string, number>();
  const places: string[] = [];
  let hasAttachment = false;
  for (const h of hits) {
    const first = h.who.split(" ")[0];
    bySender.set(first, (bySender.get(first) ?? 0) + 1);
    const place = h.where.split(" ")[0];
    if (!places.includes(place)) places.push(place);
    if (mail(s, h.id)?.attachment) hasAttachment = true;
  }
  const facets: SearchResult["facets"] = [];
  if (bySender.size)
    facets.push({
      title: "From",
      items: [...bySender.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([label, count]) => ({ label, count })),
    });
  if (places.length) facets.push({ title: "Folder", items: places.map((label) => ({ label })) });
  if (hasAttachment) facets.push({ title: "Refine", items: [{ label: "Has attachment" }] });
  return facets;
}

/** Levenshtein, two-row. Small strings only — this runs per word per message. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/* --------------------------------------------------------- render manifest */

/**
 * Every mail identity a route puts on screen, in render order — including the
 * messages behind a thread badge and every message in a held bag.
 *
 * Screens render from the same selectors this reads, so a collapsed list shows
 * up here as missing identities and `test/no-collapse.test.ts` fails.
 */
export function renderManifest(s: AppState, route: Route): string[] {
  switch (route.name) {
    case "ohbox":
      return ohboxRows(s).map((m) => m.id);
    case "reads":
      return readsStream(s).map((m) => m.id);
    case "receipts":
      return receiptStream(s).map((m) => m.id);
    case "screener":
      // The list screen shows senders; their held mail lives one tap deeper.
      return screenerIds(s, route.seg);
    case "screenerDetail":
      return heldMail(s, route.seg, route.id).map((h) => h.id);
    case "message": {
      const m = mail(s, route.id);
      return m ? conversation(m).map((h) => h.id) : [];
    }
    case "triage":
      return s.piles.flatMap((p) => p.items.map((i) => i.id));
    case "tag":
      return taggedMail(s, route.tag).map((m) => m.id);
    case "search":
    case "settings":
      return [];
  }
}

/**
 * Every identity the whole app can reach, across every route and every depth.
 * The no-collapse assertion runs against this: it must be a superset of the
 * fixture corpus, with nothing invented.
 */
export function fullManifest(s: AppState): string[] {
  const segs: ScreenerSeg[] = ["waiting", "screened", "spam"];
  const ids = [
    ...renderManifest(s, { name: "ohbox" }),
    ...renderManifest(s, { name: "reads" }),
    ...renderManifest(s, { name: "receipts" }),
    ...s.ohbox.flatMap((m) => renderManifest(s, { name: "message", id: m.id })),
    ...s.reads.flatMap((m) => renderManifest(s, { name: "message", id: m.id })),
    ...s.receipts.flatMap((m) => renderManifest(s, { name: "message", id: m.id })),
    ...segs.flatMap((seg) => [
      ...renderManifest(s, { name: "screener", seg }),
      ...screenerIds(s, seg).flatMap((id) => renderManifest(s, { name: "screenerDetail", seg, id })),
    ]),
    ...renderManifest(s, { name: "triage" }),
  ];
  return [...new Set(ids)];
}
