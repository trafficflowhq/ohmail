/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { pinnedRows } from "./_resurfaced-rows.js";
import { ohboxSurfaceMessages } from "@ohmail/app-logic/reading/ohbox-surface";
import type { EngineMessage } from "@ohmail/client-engine";

/**
 * A ROW THIS LIST SHOWS IS A ROW EVERY VERB CAN REACH — whatever page it came from.
 *
 * Selection resolved against the three LOCAL-MIRROR groups in two places at once: the shell
 * derived the open message from them, the view derived its cursor, its pick set and its keyboard
 * walk from them. A row `Load older` had put on screen answered nothing — no cursor, no open, and
 * a pick the prune effect dropped in the same frame.
 */

/**
 * ONE resolver now, the mirror groups as one source among them, the tail last and the mirror's
 * copy of an id winning. Nothing sorts. And the pane's CLAIMS stay on the three groups — reach
 * and counting are two questions, and the last case here is the one that says so.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The desktop layout: no width query matches, so a click selects and a second click opens. */
function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

interface Row { id: string; unread: boolean; date?: string }
function msg(m: Row): EngineMessage {
  return {
    id: m.id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `subj-${m.id}`, from: { name: `sender-${m.id}`, address: `${m.id}@ex.example` }, to: [], cc: [],
    date: m.date ?? "2026-08-02T09:00:00.000Z", folder: "INBOX", snippet: `snip-${m.id}`,
    unread: m.unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
  } as unknown as EngineMessage;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** Every `onEnterReader` the view made — an OPEN is a statement, and this is where it lands. */
let opened: string[] = [];
/** Every `bulk.run` the view dispatched, as `action → ids`. */
let dispatched: { action: string; ids: string[] }[] = [];

const at = (hour: number): string => `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`;

/** Two rows in the mirror's groups, two fetched from beyond the window. */
const NEW: Row[] = [{ id: "n1", unread: true, date: at(13) }];
const PREV: Row[] = [{ id: "p1", unread: false, date: at(12) }];
const OLDER: Row[] = [
  { id: "o1", unread: false, date: at(11) },
  { id: "o2", unread: false, date: at(10) },
];

async function render(olderRows: Row[] = OLDER): Promise<void> {
  const { OhboxView } = await import("../app/views/OhboxView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const older = {
    available: true, items: olderRows.map(msg), loading: false, error: null,
    exhausted: true, loadMore: () => {},
  };
  function Wrapper(): React.ReactElement {
    const [sel, setSel] = React.useState<string | null>(null);
    return h(OhboxView as never, {
      owed: false,
      demo: false, settled: true,
      older,
      resurfacedRows: pinnedRows([]),
      newForYou: NEW.map(msg),
      previouslySeen: PREV.map(msg),
      replyDone: null,
      threadSubject: () => null,
      tags: [], now: new Date("2026-08-02T09:00:00.000Z"),
      onEnterReader: (id: string) => { opened.push(id); },
      readerId: null, readSetFor: (id: string) => [id],
      onMarkSeen: () => {},
      bulk: {
        run: (action: string, ids: string[]) => { dispatched.push({ action, ids }); return true; },
        tag: () => {},
        screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }),
        screen: () => {},
      },
      doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
      /* THE SHELL'S OWN HALF, as the shell computes it: `ohboxSurfaceMessages` is what decides
         whether a cursor id ever reaches this view at all. Wiring the prop straight through would
         measure the view over a shell that does not exist — the defect lived in BOTH. */
      selectedId: sel === null
        ? null
        : (ohboxSurfaceMessages(
            pinnedRows([]),
            { resurfaced: [], newForYou: NEW.map(msg), previouslySeen: PREV.map(msg) },
            older.items,
          ).find((m) => m.id === sel)?.id ?? null),
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
const click = async (id: string): Promise<void> => {
  const el = host!.querySelector<HTMLElement>(`.row[data-id="${id}"]`);
  expect(el, `no row on screen for ${id}`).toBeTruthy();
  await act(async () => { el!.click(); });
};
const rows = (): string[] =>
  [...host!.querySelectorAll<HTMLElement>(".row[data-id]")].map((r) => r.dataset.id!);
const cursor = (): string | null =>
  host!.querySelector<HTMLElement>(".row[data-id].sel")?.dataset.id ?? null;
const picked = (): string[] =>
  [...host!.querySelectorAll<HTMLElement>(".row[data-id].picked")].map((r) => r.dataset.id!);

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  opened = [];
  dispatched = [];
});

describe("the Ohbox's Older rows are rows like any other", () => {
  it("the fixture puts the fetched rows on screen, below the mirror's own", async () => {
    // Every claim below is about a list that has both kinds in it. A tail that never rendered
    // would make all of them true of a list nobody has.
    setViewport();
    await render();
    expect(rows()).toEqual(["n1", "p1", "o1", "o2"]);
    expect(cursor(), "the Ohbox placed a cursor nobody asked for").toBeNull();
  });

  it("a fetched row takes the cursor, and a second click OPENS it", async () => {
    setViewport();
    await render();

    await click("o1");
    expect(cursor(), "a click on a row from `Load older` moved no cursor — it is on screen and it "
      + "answers nothing, which is the defect").toBe("o1");

    await click("o1");
    expect(opened, "the second click on the selected row is the OPEN, and it never reached the "
      + "shell for a row the three groups do not hold").toEqual(["o1"]);
  });

  it("a fetched row can be PICKED, and the verb acts on it", async () => {
    setViewport();
    await render();

    await click("o2");
    await key("x");
    expect(picked(), "`x` over a fetched row picked nothing — the pick set was pruned against the "
      + "three groups, so the row left the set in the frame it joined it").toEqual(["o2"]);

    await key("U");        // ⇧U — mark what is picked, the one bulk verb the selection always had
    expect(dispatched.map((d) => d.ids)).toEqual([["o2"]]);
  });

  it("a range spans the boundary between the mirror's rows and the fetched ones", async () => {
    // The two sources are ONE list for a verb, or a shift-range across the join silently drops
    // half of what it visibly covered.
    setViewport();
    await render();

    await click("p1");
    await key("x");
    await click("o1");
    await key("x");
    expect(picked()).toEqual(["p1", "o1"]);

    await key("U");
    expect(dispatched[0]!.ids, "the ids dispatch in LIST order, and the fetched row was not in the "
      + "list the order came from").toEqual(["p1", "o1"]);
  });

  it("j and k walk into the tail and back out of it", async () => {
    setViewport();
    await render();

    await key("j"); await key("j"); await key("j");
    expect(cursor(), "the keyboard walk stopped at the end of the mirror's rows").toBe("o1");
    await key("k");
    expect(cursor(), "`k` from a fetched row read the cursor as absent and re-entered at the top")
      .toBe("p1");
  });

  it("a fetched row the list already shows above is not listed a second time", async () => {
    // nearly every fetched row was a row the Ohbox listed above. The shell
    // keeps the store's copies out; this is the view's own belt over what it rendered.
    // MUTATION: render `older.items` in place of `olderShown` and p1 appears twice.
    setViewport();
    await render([PREV[0]!, ...OLDER]);
    expect(rows()).toEqual(["n1", "p1", "o1", "o2"]);
  });

  it("…and the pane's own COUNT does not move, because it is a different question", async () => {
    /* Reach is not counting. "N unread" is a claim about what this Ohbox holds, and the fetched
       rows are a window onto the server — folding them in would make the header state a number
       about mail this pile does not list. The one unread row in the fixture is `n1`; `o1`/`o2`
       are read, so a version that counted them would still read 1 — which is why the assertion
       is the SENTENCE the header renders and not a number that agrees by luck. */
    setViewport();
    await render();
    const meta = host!.querySelector<HTMLElement>(".vhead .meta")?.textContent ?? "";
    expect(meta).toContain("1");
    expect(rows()).toHaveLength(4);
  });
});
