/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { pinnedRows } from "./_resurfaced-rows.js";
import type { EngineMessage } from "@ohmail/client-engine";

/**
 * j AND k ARE ONE GESTURE IN TWO DIRECTIONS.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * The Ohbox rests with NO cursor: the reading column stays at rest until somebody chooses a
 * message, rather than opening the newest unread on nobody's behalf. So the keys are how a
 * reader ENTERS the list, not only how they move inside it — and only one of the two could do
 * it. `j` landed on the first row when nothing was selected; `k` was declared inert in exactly
 * that state, so on a freshly opened Ohbox `j` walked and `k` did nothing whatsoever. Measured
 * against the shipped build: press `j`, then `k`, and the cursor stays where `j` put it.
 *
 * ── WHY THE EXISTING COVERAGE DID NOT SEE IT ────────────────────────────────────────────
 *
 * `ohbox-thread-grouping.test.tsx` walks j/j/j/k and asserts the fold is never a keyboard
 * stop. Every one of its presses happens with the cursor already ON a row, because its first
 * `j` put it there — so it exercises the two keys only where they were already symmetric and
 * cannot reach the boundary where they were not. That is the whole shape of this defect: the
 * entry move is a fourth case, and a walk that starts by entering can never test it.
 *
 * ── WHAT IS ASSERTED ────────────────────────────────────────────────────────────────────
 *
 *   1. `k` ENTERS, from the other end. With nothing selected it lands on the LAST row, which
 *      is what makes it the inverse of `j` rather than a second copy of it.
 *   2. `j` then `k` returns to the row it left, over a list that is grouped (a conversation
 *      folded to one row) and session-placed (a resurfaced pin above "New", read history
 *      below it) — so the round trip is measured against the rows as RENDERED, not against
 *      the message array they were built from.
 *   3. `k` on the first row keeps the cursor there. The way in must not double as a way to
 *      lose the cursor: a reader at the top pressing `k` once more has asked for nothing.
 *
 * The fixture is asserted before it is used. A grouped list that failed to fold, or a session
 * order that placed the rows differently, would make every claim below true of a list nobody
 * has.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The desktop layout: no width query matches, so a click selects rather than opens. */
function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

interface Row { id: string; unread: boolean; threadId?: string | null; date?: string }
function msg(m: Row): EngineMessage {
  return {
    id: m.id, accountId: "a", mailboxId: "mb", threadId: m.threadId ?? null, messageIdHeader: null,
    subject: `subj-${m.id}`, from: { name: `sender-${m.id}`, address: `${m.id}@ex.example` }, to: [], cc: [],
    date: m.date ?? "2026-08-02T09:00:00.000Z", folder: "INBOX", snippet: `snip-${m.id}`,
    unread: m.unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
  } as unknown as EngineMessage;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

interface Props { resurfaced?: Row[]; newForYou: Row[]; previouslySeen?: Row[] }

async function render(props: Props): Promise<void> {
  const { OhboxView } = await import("../app/views/OhboxView.js");
  const { KeymapProvider } = await import("@ohmail/app/keys");
  function Wrapper(): React.ReactElement {
    const [sel, setSel] = React.useState<string | null>(null);
    return h(OhboxView as never, {
    owed: false,
      demo: false, settled: true,
      older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
      resurfacedRows: pinnedRows((props.resurfaced ?? []).map(msg)),
      newForYou: props.newForYou.map(msg),
      previouslySeen: (props.previouslySeen ?? []).map(msg),
      replyDone: null,
      threadSubject: (threadId: string) => (threadId === "T" ? "Webshop" : threadId === "P" ? "Invoices" : null),
      tags: [], now: new Date("2026-08-02T09:00:00.000Z"),
      onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id],
      onMarkSeen: () => {},
      bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
      doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
      selectedId: sel,
      onSelect: (id: string) => setSel(id),
    } as never);
  }
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
    children: h(KeymapProvider as never, { children: h(Wrapper) } as never),
  });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(el); });
}

const key = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
};

/** Every row on screen, top to bottom — the order j/k are supposed to walk. */
const rows = (): string[] =>
  [...host!.querySelectorAll<HTMLElement>(".row[data-id]")].map((r) => r.dataset.id!);

/** The row the cursor is standing on, or `null` for a list nobody has entered. */
const cursor = (): string | null =>
  host!.querySelector<HTMLElement>(".row[data-id].sel")?.dataset.id ?? null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

const at = (hour: number): string => `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`;

/**
 * A resurfaced pin, a folded conversation and a plain row in "New", and a folded conversation
 * and a plain row in "Earlier" — every kind of row the Ohbox builds, in one list.
 */
const WORLD: Props = {
  resurfaced: [{ id: "res", unread: false, threadId: null, date: at(14) }],
  newForYou: [
    { id: "n2", unread: true, threadId: "T", date: at(13) },
    { id: "n1", unread: true, threadId: "T", date: at(12) },
    { id: "solo", unread: true, threadId: null, date: at(11) },
  ],
  previouslySeen: [
    { id: "p2", unread: false, threadId: "P", date: at(10) },
    { id: "p1", unread: false, threadId: "P", date: at(9) },
    { id: "old", unread: false, threadId: null, date: at(8) },
  ],
};

/** Four rows from six messages: the two conversations are folded, per section. */
const ROWS = ["res", "n2", "solo", "p2", "old"];

describe("the Ohbox cursor keys are inverses over the rows as rendered", () => {
  it("the fixture is the grouped, session-placed list every claim below is about", async () => {
    setViewport();
    await render(WORLD);
    expect(rows(), "the fold or the session placement did not produce the list under test")
      .toEqual(ROWS);
    expect(cursor(), "the Ohbox placed a cursor nobody asked for — the entry cases are moot")
      .toBeNull();
  });

  it("`k` enters the list from the BOTTOM, the way `j` enters it from the top", async () => {
    setViewport();
    await render(WORLD);

    await key("k");
    expect(cursor(), "`k` did nothing on a list nobody has entered — it is the way in from the " +
      "other end, and a key presented beside `j` that does nothing is a key nobody can learn")
      .toBe(ROWS[ROWS.length - 1]);

    // …and it keeps walking upward from there, so the entry is a first step and not a jump to
    // a place the key cannot continue from.
    await key("k");
    expect(cursor(), "`k` entered and then stopped").toBe(ROWS[ROWS.length - 2]);
  });

  it("`j` still enters from the TOP — the entry ends are not the same end", async () => {
    setViewport();
    await render(WORLD);
    await key("j");
    expect(cursor(), "`j` no longer enters at the first row").toBe(ROWS[0]);
  });

  it("`j` then `k` returns the cursor to the row it left, from every row that has one above", async () => {
    setViewport();
    await render(WORLD);

    // Walk in and back out at every position, rather than at one: the defect this file exists
    // for lived at a boundary, and a single sample is how a boundary gets missed twice.
    await key("j");
    for (let i = 0; i < ROWS.length - 1; i++) {
      const origin = cursor();
      expect(origin, `lost the cursor before step ${i}`).toBe(ROWS[i]);
      await key("j");
      expect(cursor(), "`j` did not advance").toBe(ROWS[i + 1]);
      await key("k");
      expect(cursor(), "`k` did not return the cursor to the row `j` left").toBe(origin);
      await key("j");
    }
  });

  it("`k` on the first row keeps the cursor there — the way in is not a way to lose it", async () => {
    setViewport();
    await render(WORLD);
    await key("j");
    expect(cursor()).toBe(ROWS[0]);
    await key("k");
    expect(cursor(), "`k` at the top of the list cleared the cursor or wrapped to the bottom")
      .toBe(ROWS[0]);
  });
});
