/** @vitest-environment jsdom */
import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { SearchView } from "../app/views/SearchView";
import { KeymapProvider } from "../../../test/support/keymap-provider";

/**
 * A WORD THAT MATCHES NOTHING GETS ITS VERDICT AS SOON AS A WORD THAT MATCHES — on the shipped
 * mount, over account A's shape (synthetic rows at its size, a Zipf vocabulary with codes in the
 * snippets). The verdict is the store's first page; the device pass runs once per question, before
 * the store's debounce, and its typo tier (an empty exact tier only) costs milliseconds. Real
 * timers: the reading is typed word -> rendered sentence, the freeze cell's own measure.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
const h = React.createElement;

const NOW = new Date("2026-09-25T12:00:00.000Z");
const ROWS = 3666;
const LATENCY_MS = 150;
/** `ARCHIVE_DEBOUNCE_MS` in the view: the store is asked this long after the last keystroke. */
const DEBOUNCE_MS = 250;
const NO_MATCH = "zqxwbrimmo";

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function corpus(): EngineMessage[] {
  const r = rng(7);
  const SY = ["ka", "re", "mo", "ti", "lan", "ber", "sch", "ung", "ver", "ein", "pro", "con", "tion", "ment", "ster",
    "ach", "ig", "or", "al", "en", "er", "st", "nu", "pa", "vi", "do", "gra", "fe", "ho", "lu"];
  const word = () => {
    let w = "";
    for (let i = 0, n = 2 + Math.floor(r() * 3); i < n; i++) w += SY[Math.floor(r() * SY.length)];
    return w;
  };
  const vocab: string[] = [];
  const seen = new Set<string>();
  while (vocab.length < 6000) {
    const w = word();
    if (!seen.has(w)) { seen.add(w); vocab.push(w); }
  }
  const cdf: number[] = [];
  let acc = 0;
  for (let i = 0; i < vocab.length; i++) { acc += 1 / (i + 1); cdf.push(acc); }
  const pick = () => {
    const x = r() * acc;
    let lo = 0, hi = vocab.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m]! < x) lo = m + 1; else hi = m; }
    return vocab[lo]!;
  };
  const code = () => Math.floor(r() * 36 ** 8).toString(36) + Math.floor(r() * 1e6);
  const senders = Array.from({ length: 400 }, () => ({ name: `${word()} ${word()}`, address: `${word()}@${word()}.example` }));
  const out: EngineMessage[] = [];
  for (let i = 0; i < ROWS; i++) {
    let snippet = "";
    while (snippet.length < 200) snippet += `${pick()} `;
    for (let u = 0; u < 3; u++) snippet = `${code()} ${snippet}`;
    out.push({
      id: `m${i}`, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
      subject: Array.from({ length: 4 + Math.floor(r() * 6) }, pick).join(" ") + (r() < 0.5 ? ` #${code()}` : ""),
      from: senders[Math.floor(r() * senders.length)]!, to: [], cc: [],
      date: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(), folder: "INBOX",
      snippet: snippet.slice(0, 200), unread: false, hasAttachments: false, attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
    });
  }
  return out;
}

const words = (m: EngineMessage): string[] => `${m.subject} ${m.snippet}`.toLowerCase().split(/[^\p{L}\p{N}]+/u);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A store that answers after {@link LATENCY_MS}: `word`'s rows exact, `typo`'s the same rows as Similar. */
async function engineOver(rows: EngineMessage[], word: string, typo: string): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges(rows.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })));
  const hits = rows.filter((m) => words(m).includes(word));
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    searchServer: async (q: string, opts: { parts?: string; limit?: number }) => {
      await sleep(LATENCY_MS);
      const found = q === word || q === typo ? hits : [];
      const page = opts.parts === "estimate" || opts.parts === "summary" ? [] : found.slice(0, opts.limit ?? 50);
      return { items: page, total: found.length, totalExact: true, ms: 40, tier: q === typo ? "similar" : "exact" };
    },
  } as unknown as EngineAdapter;
  return new OhmailEngine({ adapter, store, now: () => NOW });
}

/** `SearchViewLive`'s wiring: the query in the parent, the mirror's version and the index revision subscribed. */
function Live({ engine, door }: { engine: OhmailEngine; door: { type?: (q: string) => void } }) {
  const [query, setQuery] = React.useState("");
  door.type = setQuery;
  const subscribe = React.useCallback((cb: () => void) => engine.subscribe(cb), [engine]);
  const version = React.useSyncExternalStore(subscribe, () => engine.read().version(), () => 0);
  const indexRev = React.useSyncExternalStore(subscribe, () => engine.searchIndexRevision(), () => 0);
  return h(SearchView, { engine, version, indexRev, now: NOW, query, onQuery: setQuery, onOpen: () => {} });
}

const SENTENCES = {
  searching: "Searching your whole mailbox…",
  matched: /Searched your whole mailbox — [\d,]+ matched/,
  near: /Searched your whole mailbox — [\d,]+ with a close word/,
  nothing: "Searched your whole mailbox — nothing matched",
  unanswered: "Your server did not answer — showing the recent mail this device holds.",
} as const;

let host: HTMLDivElement;
let root: Root;
const text = (): string => host.textContent ?? "";
const verdicts = (): string[] =>
  Object.entries(SENTENCES).filter(([, s]) => (typeof s === "string" ? text().includes(s) : s.test(text()))).map(([k]) => k);
const rowIds = (): string[] => [...host.querySelectorAll("[data-hit]")].map((n) => n.getAttribute("data-hit") ?? "");

/** Resolves at the first DOM state `pred` accepts; `each` sees every state on the way. */
function until(pred: () => boolean, each?: () => void): Promise<number> {
  return new Promise((resolve) => {
    each?.();
    if (pred()) { resolve(performance.now()); return; }
    const obs = new MutationObserver(() => {
      each?.();
      if (pred()) { obs.disconnect(); resolve(performance.now()); }
    });
    obs.observe(host, { childList: true, subtree: true, characterData: true });
  });
}

const rows = corpus();
/** A word in a handful of messages (one page holds them all), and the same word with one inner letter changed. */
const WORD = (() => {
  const count = new Map<string, number>();
  for (const m of rows) for (const w of new Set(words(m))) count.set(w, (count.get(w) ?? 0) + 1);
  return [...count.entries()].find(([w, n]) => w.length >= 8 && /^\p{L}+$/u.test(w) && n >= 5 && n <= 30)![0];
})();
const TYPO = `${WORD.slice(0, 3)}q${WORD.slice(4)}`;

async function mount(): Promise<{ engine: OhmailEngine; door: { type?: (q: string) => void } }> {
  const engine = await engineOver(rows, WORD, TYPO);
  await engine.warmSearchIndex();
  const door: { type?: (q: string) => void } = {};
  root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children: h(KeymapProvider, { children: h(Live, { engine, door }) }) }));
  await until(() => door.type !== undefined && host.querySelector(".search-box input") !== null);
  return { engine, door };
}

/** Typed word -> the first render that holds a whole-mailbox verdict, in ms; the box emptied first. */
async function typedToVerdict(door: { type?: (q: string) => void }, word: string): Promise<number> {
  door.type!("");
  await until(() => !text().includes("Searched your whole mailbox — "));
  const t0 = performance.now();
  door.type!(word);
  const t1 = await until(() => text().includes("Searched your whole mailbox — "));
  await sleep(LATENCY_MS * 2);
  return t1 - t0;
}

beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  root.unmount();
  host.remove();
});

describe("the no-match verdict is not held behind the device pass (a large mailbox)", () => {
  it("renders within 1.3x of a matching word's, and the client's own part stays under 250 ms", async () => {
    const { engine, door } = await mount();
    expect(engine.search(WORD).items.length).toBeGreaterThan(0);
    expect(engine.search(NO_MATCH).items).toEqual([]);
    const match: number[] = [];
    const none: number[] = [];
    for (let i = 0; i < 2; i++) {
      match.push(await typedToVerdict(door, WORD));
      none.push(await typedToVerdict(door, NO_MATCH));
    }
    const m = Math.min(...match);
    const n = Math.min(...none);
    expect(n).toBeLessThanOrEqual(1.3 * m);
    expect(m - DEBOUNCE_MS - LATENCY_MS).toBeLessThan(250);
    expect(n - DEBOUNCE_MS - LATENCY_MS).toBeLessThan(250);
  }, 30_000);

  it("a no-match word flips its verdict once, and 'Nothing matched.' waits for the answer", async () => {
    const { door } = await mount();
    const seen: string[] = [];
    let titleEarly = false;
    let most = 0;
    const look = () => {
      const v = verdicts();
      most = Math.max(most, v.length);
      if (v.includes("searching") && text().includes("Nothing matched.")) titleEarly = true;
      const key = v.join("+");
      if (key !== "" && seen[seen.length - 1] !== key) seen.push(key);
    };
    door.type!(NO_MATCH);
    await until(() => verdicts().includes("nothing"), look);
    await sleep(LATENCY_MS * 3);
    look();
    expect(seen).toEqual(["searching", "nothing"]);
    expect(most).toBe(1);
    expect(titleEarly).toBe(false);
    // Said once: the verdict, never a title beside it,
    // and how far into a long message the search reads.
    expect(text()).not.toContain("Nothing matched.");
    expect(text().match(/nothing matched/gi)?.length).toBe(1);
    expect(host.querySelector('[data-testid="search-depth"]')?.textContent).toBe("A long message is searched in its first 65,536 characters.");
  }, 30_000);

  it("the time on the line is the wait a person had, never the store's own ms (40 here)", async () => {
    const { door } = await mount();
    door.type!(WORD);
    await until(() => /matched · \d+ ms/.test(text()));
    const said = Number(/matched · (\d+) ms/.exec(text())![1]);
    expect(said).toBeGreaterThanOrEqual(LATENCY_MS);
    expect(said).not.toBe(40);
  }, 30_000);

  it("a typo's Similar rows keep their heading and their places when the store's page lands", async () => {
    const { engine, door } = await mount();
    const device = engine.search(TYPO);
    expect(device.items).toEqual([]);
    expect(device.similar.length).toBeGreaterThan(0);
    const seen: string[] = [];
    const look = () => {
      const key = verdicts().join("+");
      if (key !== "" && seen[seen.length - 1] !== key) seen.push(key);
    };
    door.type!(TYPO);
    await until(() => host.querySelector('[data-similar="head"]') !== null, look);
    const before = rowIds();
    await until(() => verdicts().includes("near"), look);
    await sleep(LATENCY_MS * 3);
    look();
    // Closest words are said as near, never as matched.
    expect(seen).toEqual(["searching", "near"]);
    expect(host.querySelector('[data-similar="head"]')?.textContent).toContain("Nothing matched exactly, so these are the closest words.");
    const after = rowIds();
    const kept = before.filter((id) => after.includes(id));
    expect(kept.length).toBeGreaterThan(0);
    expect(after.slice(0, kept.length)).toEqual(kept);
  }, 30_000);
});
