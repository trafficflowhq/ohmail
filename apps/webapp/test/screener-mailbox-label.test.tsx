/** @vitest-environment jsdom */
import type { EngineMessage, Folder } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import { mailboxLabelResolver, type MailboxLabelFact } from "../app/shell/mailbox-label";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * A SCREENER ROW SAYS WHICH OF YOUR ADDRESSES THE STRANGER WROTE TO.
 *
 * The Junk pane in the same view has always been per-mailbox;
 * this queue could not answer the question at all. The resolver is the shell's own
 * `mailboxLabelResolver` — the one the Reads view already takes — driven here rather than a
 * `() => "Work"` stub, so the `> 1` gate inside it is part of what is measured: a mount that
 * brought its own resolver would measure the test's function, not the product's.
 *
 * The needles are RENDERED output — the badge's text and the sheet's sentence — never a prop or
 * a source string.
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const NOW = new Date("2026-08-02T12:00:00.000Z");
let seq = 0;

/** TWO MAILBOXES WHOSE ADDRESSES DIFFER — a fixture where they agree measures alignment. */
const WORK = { id: "mbx-work", address: "work@fixture.example", displayName: "Work" };
const HOME = { id: "mbx-home", address: "home@fixture.example", displayName: null };
const TWO: MailboxLabelFact[] = [WORK, HOME];

function held(id: string, from: string, mailboxId: string, hour: number, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId, threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

async function engineWith(mail: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(mail.map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    },
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

const MAIL: EngineMessage[] = [
  held("m1", "one@stranger.example", WORK.id, 9),
  held("m2", "two@stranger.example", HOME.id, 8),
];

/** Mount the real Screener over the real state hook, with the real resolver over `facts`. */
async function mount(facts: MailboxLabelFact[] | null, select?: boolean): Promise<void> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../../../test/support/keymap-provider");
  const engine = await engineWith(MAIL);
  const resolve = mailboxLabelResolver(facts);

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const state = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText());
    const [sel, setSel] = React.useState<Record<string, string | null>>({
      waiting: select ? "m1" : null, screened: null, spam: null,
    });
    return h(ScreenerView, {
      owed: false,
      state,
      segment: "waiting", settled: true, selection: sel as never,
      onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
      mailboxLabelOf: resolve,
    } as never);
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, {
        storageKey: null,
        children: h(KeymapProvider, { children: h(Probe) }),
      }),
    }));
  });
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
  await settleFirstPaint();
}

/** The delivery badges the list really rendered, by their text. */
function badges(): string[] {
  return [...host!.querySelectorAll(".row .badge")]
    .map((b) => (b.textContent ?? "").trim())
    .filter((t) => t === "Work" || t === HOME.address);
}

describe("the Screener list names the mailbox a stranger wrote to", () => {
  it("draws each row's own mailbox, and they differ", async () => {
    await mount(TWO);
    const drawn = badges();
    expect(drawn).toHaveLength(2);
    // The mailbox's label where it has one, the bare address where it has none — the fallback the
    // "me" chip already keeps, and the reason the fixture gives only one of them a display name.
    expect(new Set(drawn)).toEqual(new Set(["Work", HOME.address]));
  });

  it("the badge carries the whole sentence, from the namespace that owns it", async () => {
    await mount(TWO);
    const titled = [...host!.querySelectorAll(".row .badge")]
      .map((b) => b.getAttribute("title"))
      .filter((t): t is string => t !== null && t.startsWith("Delivered to "));
    expect(titled).toContain("Delivered to Work");
    expect(titled).toContain(`Delivered to ${HOME.address}`);
  });

  /**
   * THE `> 1` GATE, WHICH LIVES IN THE RESOLVER. One mailbox is no question, so the answer is
   * silence — and `null` facts (the demo, a surface with no `GET /mailboxes`) is the same
   * silence. Two arms, because they reach the resolver by different routes.
   */
  it("says nothing on a one-mailbox account", async () => {
    await mount([WORK]);
    expect(badges()).toEqual([]);
  });

  it("says nothing where the mailboxes cannot be named at all", async () => {
    await mount(null);
    expect(badges()).toEqual([]);
  });

  it("the sheet states it too, above the mail the decision is about", async () => {
    await mount(TWO, true);
    const captions = [...host!.querySelectorAll(".scn-mails .scn-caption")]
      .map((c) => (c.textContent ?? "").trim());
    expect(captions).toContain("Delivered to Work");
  });
});
