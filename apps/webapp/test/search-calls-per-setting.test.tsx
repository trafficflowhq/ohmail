/** @vitest-environment jsdom */
import type { EngineMessage, MutationOutcome } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type ServerSearchOpts,
  type SyncResponse,
} from "@ohmail/client-engine";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { NONE } from "@ohmail/app/host";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { MailShell } from "./_mail-shell.js";

/**
 * THE CALLS SEARCH MAKES, PER SETTING. One person's visit (typing a word key by key, a pause, Enter, a facet, an
 * order, the next page) over a transport that records every request, on four settings: a store; none; the
 * desktop's lane on; an answer from a paired computer's mirror. The calls are written down: a rebuilt screen
 * makes the same ones (one store request per settled question, the count after the hold, a pressed facet and an
 * order asked at once, the next page by its cursor).
 */
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const NOW = new Date("2026-09-23T12:00:00.000Z");

/*
 * The visit's time is the test's own: the timers are fake, every step's screen work is done (act) before the clock
 * moves, and the clock moves only by the step's own wait. So no host's speed can let a settle fire between two keys.
 */
async function step(ms: number, what: () => void = () => {}): Promise<void> {
  await act(async () => what());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function msg(i: number): EngineMessage {
  return {
    id: `s${i}`, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Kestrel letter ${i}`, from: { name: null, address: "ann@example.test" }, to: [], cc: [],
    date: "2026-09-01T09:00:00.000Z", folder: "INBOX", snippet: "", unread: false, hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

type Setting = "store" | "none" | "lane" | "mirror";
interface Call {
  q: string;
  parts: string | null;
  sort: string | null;
  limit: number | null;
  cursor: string | null;
  filters: string | null;
  /** The desktop's lane named on the request (its id and generation are the walker's own). */
  lane: boolean;
}
let calls: Call[] = [];

async function engineFor(setting: Setting): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  if (setting === "none") {
    const local = msg(0);
    await store.applyChanges([
      { type: "message", op: "create", id: local.id, entity: local, seq: 1, updatedAt: local.updatedAt },
    ]);
  }
  const searchServer = async (q: string, o: ServerSearchOpts) => {
    calls.push({
      q,
      parts: o.parts ?? null,
      sort: o.sort ?? null,
      limit: o.limit ?? null,
      cursor: o.cursor ?? null,
      filters: o.filters ? JSON.stringify(o.filters) : null,
      lane: o.lane !== undefined,
    });
    const from = o.cursor === "c1" ? 30 : 0;
    const mirror = setting === "mirror" ? { answeredFrom: "mirror" as const } : {};
    if (o.parts === "estimate" || o.parts === "summary")
      return {
        items: [], total: 60, totalExact: true, ms: 4, tier: "exact",
        facets: { folder: { INBOX: 60 }, sender: [{ address: "ann@example.test", count: 60 }], hasAttachments: { true: 0, false: 60 }, unread: { true: 0, false: 60 } },
        ...mirror,
      };
    return {
      items: Array.from({ length: 30 }, (_, i) => msg(from + i)), total: 60, totalExact: false, ms: 4, tier: "exact",
      nextCursor: from === 0 ? "c1" : null,
      ...mirror,
    };
  };
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    ...(setting === "none" ? {} : { searchServer }),
  } as unknown as EngineAdapter;
  return new OhmailEngine({ adapter, store, now: () => NOW, ...(setting === "lane" ? { searchSupersede: true } : {}) });
}

/**
 * A PERSON'S VISIT TO SEARCH, by what they can do: type a question, press Enter, press a facet by its name, choose an
 * order by its name, and scroll to the list's end. Drive the registered Search screen through the mail frame.
 */
interface SearchVisit {
  type: (q: string) => void;
  enter: () => void;
  facet: (name: string) => boolean;
  sort: (order: "relevance" | "date_desc" | "date_asc" | "mailbox" | "sender") => void;
  scrollEnd: () => void;
  unmount: () => void;
}

function mountSearchVisit(engine: OhmailEngine, now: Date): SearchVisit {
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as typeof Element.prototype.animate;
  Element.prototype.scrollIntoView ??= () => undefined;
  const previous = window.location.href;
  window.history.replaceState(null, "", "#/search");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  root.render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC" now={now}>
      <ThemeProvider storageKey={null}>
        <MailShell engine={engine} consentTransport={NONE} />
      </ThemeProvider>
    </NextIntlClientProvider>,
  );
  const search = within(host);
  const box = () => search.getByRole("textbox", { name: messages.search.aria });
  return {
    type: (q) => fireEvent.change(box(), { target: { value: q } }),
    enter: () => fireEvent.keyDown(box(), { key: "Enter" }),
    facet: (name) => {
      const button = search.queryByRole("button", { name: messages.search.facetFrom });
      if (!button) return false;
      flushSync(() => fireEvent.click(button));
      const option = within(document.body).getByRole("menuitem", { name: (label) => label.startsWith(name) });
      return fireEvent.click(option);
    },
    sort: (order) => {
      const label = messages.search.sortedBy.split("{order}")[0]!;
      const button = search.getByRole("button", { name: (name) => name.startsWith(label) });
      flushSync(() => fireEvent.click(button));
      fireEvent.click(within(document.body).getByRole("menuitemradio", { name: messages.search[`sort_${order}`] }));
    },
    scrollEnd: () => fireEvent.scroll(host.querySelector(".sr-scroll")!),
    unmount: () => {
      root.unmount();
      host.remove();
      window.history.replaceState(null, "", previous);
    },
  };
}

/** The visit, the same on every setting. */
async function visit(setting: Setting): Promise<Call[]> {
  const engine = await engineFor(setting);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  let v: SearchVisit | undefined;
  try {
    await step(30, () => {
      v = mountSearchVisit(engine, NOW);
    });
    const visit = v!;
    for (const q of ["k", "ke", "kes", "kest", "kestr", "kestre", "kestrel"]) await step(20, () => visit.type(q));
    await step(900);
    await step(200, () => visit.enter());
    await step(200, () => void visit.facet("ann@example.test"));
    await step(200, () => visit.sort("date_desc"));
    await step(200, () => visit.scrollEnd());
    return calls;
  } finally {
    const visit = v;
    if (visit) await act(async () => visit.unmount());
    vi.useRealTimers();
  }
}

beforeEach(() => {
  calls = [];
  window.localStorage.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const page = (o: Partial<Call> = {}): Call => ({ q: "kestrel", parts: "page", sort: "relevance", limit: 50, cursor: null, filters: null, lane: false, ...o });
const count = (o: Partial<Call> = {}): Call => ({ ...page(o), parts: "estimate", sort: null, ...o });
const ANN = JSON.stringify({ sender: "ann@example.test" });
/**
 * The visit's calls with a store: the typed word's page at the debounce and its count after the hold (no prefix is
 * asked); Enter asks both again at once; the facet asks its page and count; the order its page and count; the end of
 * the list the next page by its cursor.
 */
const VISIT = (o: Partial<Call> = {}): Call[] => [
  page(o), count(o),
  page(o), count(o),
  page({ ...o, filters: ANN }), count({ ...o, filters: ANN }),
  page({ ...o, filters: ANN, sort: "date_desc" }), count({ ...o, filters: ANN }),
  page({ ...o, filters: ANN, sort: "date_desc", cursor: "c1" }),
];

describe("the calls per setting", () => {
  it("with a store", async () => {
    expect(await visit("store")).toEqual(EXPECTED.store);
  });
  it("with none: nothing is asked", async () => {
    expect(await visit("none")).toEqual(EXPECTED.none);
  });
  it("with the desktop's lane on: the same calls, each naming its lane", async () => {
    expect(await visit("lane")).toEqual(EXPECTED.lane);
  });
  it("with an answer from a paired computer's mirror: the same calls", async () => {
    expect(await visit("mirror")).toEqual(EXPECTED.mirror);
  });
});

const EXPECTED: Record<Setting, Call[]> = {
  store: VISIT(),
  none: [],
  lane: VISIT({ lane: true }),
  mirror: VISIT(),
};
