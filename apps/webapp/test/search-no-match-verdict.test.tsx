/** @vitest-environment jsdom */
import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/react";
import { enterSearchRoute, RegisteredSearch, typeSearch } from "./search-registered-fixture";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";

/**
 * A WORD THAT MATCHES NOTHING GETS ITS VERDICT AS SOON AS A WORD THAT MATCHES — on the shipped
 * mount, over a large synthetic mailbox (a Zipf vocabulary with codes in the
 * snippets). The verdict is the store's first page; the device pass runs once per question, before
 * the store's debounce, and its typo tier (an empty exact tier only) costs milliseconds. Real
 * timers: the reading is typed word -> rendered sentence, the freeze cell's own measure.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

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

const SENTENCES = {
  searching: "Searching your whole mailbox…",
  nothing: "Nothing matched",
  unanswered: "Your server did not answer, so these are from the recent mail this device holds.",
} as const;

let host: HTMLDivElement;
let root: Root;
let leaveSearch: () => void;
const text = (): string => host.textContent ?? "";
const verdicts = (): string[] =>
  Object.entries(SENTENCES).filter(([, line]) => text().includes(line)).map(([key]) => key);
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
  root.render(<RegisteredSearch engine={engine} now={NOW} />);
  await within(host).findByRole("textbox", { name: messages.search.aria });
  return { engine, door: { type: (query: string) => typeSearch(host, query) } };
}

/** Typed word -> the first render that holds a whole-mailbox verdict, in ms; the box emptied first. */
async function typedToVerdict(door: { type?: (q: string) => void }, word: string): Promise<number> {
  door.type!("");
  await until(() => !verdicts().length && !rowIds().length);
  const t0 = performance.now();
  door.type!(word);
  await until(() => verdicts().includes("searching"));
  const t1 = await until(() => !verdicts().includes("searching") && (word === NO_MATCH ? verdicts().includes("nothing") : rowIds().length > 0));
  await sleep(LATENCY_MS * 2);
  return t1 - t0;
}

beforeEach(() => {
  window.localStorage.clear();
  leaveSearch = enterSearchRoute();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  root.unmount();
  host.remove();
  leaveSearch();
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
      if (v.includes("searching") && text().includes("Nothing matched")) titleEarly = true;
      const key = v.join("+");
      if (key !== "" && seen[seen.length - 1] !== key) seen.push(key);
    };
    door.type!(NO_MATCH);
    await until(() => seen.includes("searching") && !verdicts().includes("searching"), look);
    await sleep(LATENCY_MS * 3);
    look();
    expect(seen).toEqual(["searching", "nothing"]);
    expect(most).toBe(1);
    expect(titleEarly).toBe(false);
    // Said once: the verdict, never a title beside it,
    // and how far into a long message the search reads.
    expect(text()).not.toContain("Nothing matched.");
    expect(within(host).getAllByText((_, node) => node?.textContent === messages.search.nothingMatched, {
      selector: ".oh-empty-label",
    })).toHaveLength(1);
    expect(text().match(/Nothing matched/g)).toHaveLength(1);
    expect(within(host).queryByText("A long message is searched in its first 65,536 characters.")).toBeNull();
  }, 30_000);

  it("the time on the line is the wait a person had, never the store's own ms (40 here)", async () => {
    const { door } = await mount();
    door.type!(WORD);
    await until(() => verdicts().includes("searching"));
    await until(() => !verdicts().includes("searching") && rowIds().length > 0);
    const timer = within(within(host).getByRole("textbox", { name: messages.search.aria }).parentElement!).getByText(/^\d+ ms$/);
    const said = Number.parseInt(timer.textContent!, 10);
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
    await until(() => within(host).queryByRole("heading", { name: /^Similar/ }) !== null, look);
    const before = rowIds();
    await until(() => seen.includes("searching") && !verdicts().includes("searching"), look);
    await sleep(LATENCY_MS * 3);
    look();
    // Closest words are said as near, never as matched.
    expect(seen).toEqual(["searching"]);
    expect(within(host).getByRole("heading", { name: /^Similar/ })).toBeTruthy();
    expect(text()).not.toContain("with a close word");
    expect(within(host).queryByText("Nothing matched exactly, so these are the closest words.")).toBeNull();
    const after = rowIds();
    const kept = before.filter((id) => after.includes(id));
    expect(kept.length).toBeGreaterThan(0);
    expect(after.slice(0, kept.length)).toEqual(kept);
  }, 30_000);
});
