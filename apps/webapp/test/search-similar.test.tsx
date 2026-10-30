/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type EngineMessage,
  type MutationOutcome,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { SearchView } from "../app/views/SearchView";
import { KeymapProvider } from "../app/shell/keymap";

/**
 * THE RENDERED HALF OF THE TIER RULE — "Similar" is a heading, not an adjective on a row.
 *
 * The service tests and the engine's ranking table prove each door orders its own answer. What
 * only a rendered test can see is the COMPOSITION: this view merges two doors, each of which
 * decided its own tier without knowing about the other, and the reader looks at the join.
 *
 * The case that matters most here is the third one. A thin local mirror plus a full archive is
 * the ordinary state of a Cloud account, and in it the local index legitimately has nothing
 * exact while the archive has real matches. A build that rendered each door's guesses whenever
 * THAT door had no matches would put the local guesses on screen first — they arrive first,
 * with no round trip — and the archive's real answers below them. That is the interleaving the
 * whole change exists to remove, rebuilt one layer up, and every per-door assertion would still
 * be green.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-04T12:00:00.000Z");
let seq = 0;

function msg(id: string, subject: string, from = "someone@example.test"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject, from: { name: null, address: from },
    to: [], cc: [], date: "2026-08-01T09:00:00.000Z", folder: "ohmail/News",
    snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

function baseAdapter(over: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    ...over,
  };
}

async function engineWith(rows: EngineMessage[], over: Partial<EngineAdapter> = {}): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    rows.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  return new OhmailEngine({ adapter: baseAdapter(over), store, now: () => NOW });
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(engine: OhmailEngine, query: string): Promise<void> {
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(KeymapProvider, {
          children: h(SearchView, {
            engine, version: 1, now: NOW, query,
            onQuery: () => {}, onOpen: () => {},
          }),
        }),
      }),
    );
  });
}

/** Past the 250 ms archive debounce, plus the microtasks its promise resolves through. */
async function settleArchive(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 320));
  });
}

const subjects = (): string[] => [...host.querySelectorAll(".hit .subj")].map((n) => n.textContent ?? "");
const similarSubjects = (): string[] =>
  [...host.querySelectorAll('[data-similar="hit"] .subj')].map((n) => n.textContent ?? "");
const heading = (): string | null =>
  host.querySelector('[data-similar="head"]')?.textContent?.trim() ?? null;

const CORPUS = [
  msg("invoice", "Invoice 078 for the workshop", "billing@erdton.example"),
  msg("studio", "Notes from the studio", "ben@lichtgrat.example"),
];

/* The device stores (desktop, phone) have no typo arm: a one-letter typo of a word in the mailbox
   finds nothing there, so the box does not promise typos. */
describe("the search box promises only what every store does", () => {
  it("says Search everything, and no typo tolerance, in en and de", async () => {
    const de = (await import("../messages/de.json")).default as typeof messages;
    await render(await engineWith(CORPUS), "");
    const box = host.querySelector<HTMLInputElement>("input[aria-label='Search']");
    expect(box?.placeholder).toBe("Search everything");
    expect(de.search.placeholder).toBe("Alles durchsuchen");
  });
});

describe("the Similar section", () => {
  /* The store answers as a real one does: the rows it matched, in the tier it matched them in —
     under ARCHIVE-024 its page REPLACES the device's first paint, so an empty fake would be a
     store that lost the mail. */
  it("is absent when the query has an exact answer", async () => {
    const engine = await engineWith(CORPUS, {
      searchServer: async () => ({ items: [CORPUS[0]], total: 1, tier: "exact" as const }),
    } as unknown as Partial<EngineAdapter>);
    await render(engine, "invoice");
    await settleArchive();

    expect(subjects()).toEqual(["Invoice 078 for the workshop"]);
    expect(heading()).toBeNull();
    expect(similarSubjects()).toEqual([]);
  });

  it("appears, labelled, when nothing matched exactly — and the rows sit under it", async () => {
    const engine = await engineWith(CORPUS, {
      searchServer: async () => ({ items: [CORPUS[0]], total: 1, tier: "similar" as const }),
    } as unknown as Partial<EngineAdapter>);
    await render(engine, "invoce");
    await settleArchive();

    // A part-shaped query: the head also says where a part inside a word is looked for (search-part-reach.test.tsx).
    expect(heading()).toBe(`Similar Nothing matched exactly, so these are the closest words. ${messages.search.partReach}`);
    expect(similarSubjects()[0]).toContain("Invoice 078");
    // Everything on screen is under the heading — there is no exact row to be above it.
    expect(subjects()).toEqual(similarSubjects());
  });

  it("THE COMPOSITION: the archive's exact hits suppress the LOCAL guesses", async () => {
    // The device holds nothing that matches `invoce` literally, so its own answer is a guess.
    // The archive answers with a real match. The merged exact tier is therefore non-empty, and
    // the local guesses must not be rendered at all — not below the match, not above it.
    const fromArchive = msg("archive-hit", "Invoce Ltd — annual statement", "post@invoce.example");
    const engine = await engineWith(CORPUS, {
      searchServer: async () => ({ items: [fromArchive], total: 1, tier: "exact" as const }),
    } as unknown as Partial<EngineAdapter>);
    await render(engine, "invoce");
    await settleArchive();

    expect(heading()).toBeNull();
    expect(similarSubjects()).toEqual([]);
    expect(subjects()).toEqual(["Invoce Ltd — annual statement"]);
    // The local guess for the same query — the invoice — is nowhere on screen.
    expect(subjects().join(" ")).not.toContain("Invoice 078");
  });

  it("the count under the box counts what is on screen, in either tier", async () => {
    const engine = await engineWith(CORPUS, {
      searchServer: async () => ({ items: [CORPUS[0]], total: 1, tier: "similar" as const }),
    } as unknown as Partial<EngineAdapter>);
    await render(engine, "invoce");
    await settleArchive();
    /* The bare count line yields to the verdict when the verdict carries the count, so the
       count on screen is the verdict's "N with a close word" (near, never matched), and it is the rows on screen. */
    expect(host.querySelector(".results-head.num")).toBeNull();
    expect(host.textContent).toContain(`— ${similarSubjects().length} with a close word`);
  });

  it("the keyboard cursor walks INTO the Similar rows", async () => {
    const kiln = msg("invoice2", "Invoice 079 for the kiln", "billing@erdton.example");
    const engine = await engineWith(
      [...CORPUS, kiln],
      { searchServer: async () => ({ items: [CORPUS[0], kiln], total: 2, tier: "similar" as const }) } as unknown as Partial<EngineAdapter>,
    );
    await render(engine, "invoce");
    await settleArchive();

    const rows = [...host.querySelectorAll("[data-hit]")];
    expect(rows.length).toBeGreaterThan(1);
    // The cursor starts on the first row…
    expect(rows[0]!.getAttribute("aria-current")).toBe("true");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    const after = [...host.querySelectorAll("[data-hit]")];
    // …and steps to the second, which is a Similar row — the heading is not a stop.
    expect(after[1]!.getAttribute("aria-current")).toBe("true");
    expect(after[1]!.getAttribute("data-similar")).toBe("hit");
  });
});
