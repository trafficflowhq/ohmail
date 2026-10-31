/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  DEMO_NOW,
  FixturesAdapter,
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
import { AddressView, archiveRowsBelong, nameFor } from "../app/views/AddressView";
import { addressHref } from "../app/shell/address-view";
import { KeymapProvider } from "../app/shell/keymap";
import { SenderMenu } from "../app/shell/SenderMenu";
import { senderScreening } from "../app/shell/sender-screening";
import { ContactPopover } from "../app/shell/ContactPopover";

/**
 * ═══ THE ADDRESS IS ON EVERY ROW, AND IT IS THE WAY INTO ONE PERSON'S MAIL ═══════════════════
 *
 * What a person meets, rendered and driven — not the selector underneath (`search-address.test.ts`
 * in the client engine) and not the contract (`address-view.test.tsx` beside this file), both of
 * which were green with nothing on screen. The surfaces here:
 *
 *  1. The SEARCH RESULT ROW prints the name on line one and the address on line two; with no name
 *     the address takes line one. The address is a link to `#/address/<addr>`, and pressing it
 *     does NOT open the message; pressing the row's open control does.
 *  2. The ADDRESS VIEW: the header names the person, the toggle narrows and carries the number of
 *     rows each direction would show, the count line states both totals, a sent copy reads "Sent",
 *     and the row's own address is printed rather than linked to the page that is open.
 *  3. The ARCHIVE's caveat: under All the archive's number says "(by sender)"; under To them the
 *     archive slot is the named line and NO archive row is listed — the archive answers `from`,
 *     and its rows are held out of a list titled "To them" by the contract and again by the view,
 *     the same rule at both ends. A refused pass is the one archive state that carries a control,
 *     and pressing it recovers the count.
 *  4. The EMPTY state names the address in the direction's own words.
 *  5. The SCREENING POPOVER offers the view as one row at address scope and not at domain scope;
 *     the reader's CHIP POPOVER offers it as a verb, and the verb navigates.
 *
 * Every case here was red against the tree before this change: no `.hit-addr` existed, no
 * `AddressView` module existed, and neither popover carried the row.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const NOW = new Date("2026-08-04T09:00:00.000Z");
const JONAS = "jonas@lichtgrat.example";

let seq = 0;
function row(over: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Invoice ${over.id}`,
    from: { name: null, address: `${over.id}@example.test` },
    to: [], cc: [], date: "2026-08-04T08:00:00.000Z", folder: "ohmail/News",
    snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
    ...over,
  };
}

function baseAdapter(): EngineAdapter {
  return {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
  };
}

/** An engine over hand-made rows — the two row forms (named, nameless) side by side. */
async function craftedEngine(rows: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(rows.map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  return new OhmailEngine({ adapter: baseAdapter(), store, now: () => NOW });
}

/** One archive-only row, shaped as the wire carries it. */
function archiveRow(id: string, from: string, date: string) {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `archive ${id}`, from: { name: "Jonas Halter", address: from }, to: [], cc: [],
    date, folder: "INBOX" as const, snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none" as const, updatedAt: date,
  };
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  window.location.hash = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  // A fragment navigation jsdom queued during the case lands after it; let it, so the next case's
  // reset of the hash is the last write and not the one that gets overwritten.
  await new Promise((r) => setTimeout(r, 0));
  vi.restoreAllMocks();
});

async function mount(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: NOW,
        children: h(KeymapProvider, { children: node }),
      }),
    );
  });
}

/** Let the archive pass's promise settle — there is no debounce on the address view. */
async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); });
}

const click = async (node: Element | null | undefined): Promise<void> => {
  expect(node, "the control this test drives does not exist").toBeTruthy();
  await act(async () => { (node as HTMLElement).click(); });
};

const byText = (sel: string, text: string): HTMLElement | undefined =>
  [...host!.querySelectorAll<HTMLElement>(sel)].find((n) => (n.textContent ?? "").includes(text));

const text = (): string => host!.textContent ?? "";

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("the search result row — the address is printed, and it is the control", () => {
  const rows = [
    row({ id: "a", from: { name: "Anna Berg", address: "anna@acme.test" }, date: "2026-08-04T08:00:00.000Z" }),
    row({ id: "b", from: { name: null, address: "noreply@bank.test" }, date: "2026-08-04T07:00:00.000Z" }),
  ];

  async function search(onOpen: (hit: unknown) => void = () => {}): Promise<void> {
    const engine = await craftedEngine(rows);
    await mount(h(SearchView, {
      engine, version: 1, now: NOW, query: "invoice", onQuery: () => {}, onOpen: onOpen as never,
    }));
  }

  it("prints the name on line one and the address on line two, linked to the address view", async () => {
    await search();
    const anna = host!.querySelector('[data-hit="a"]')!;
    expect(anna.querySelector(".hit .who")!.textContent).toBe("Anna Berg");
    const under = anna.querySelector<HTMLAnchorElement>(".hit-under a.hit-addr");
    expect(under, "line two is the address, as a link").not.toBeNull();
    expect(under!.textContent).toBe("anna@acme.test");
    expect(under!.getAttribute("href")).toBe(addressHref("anna@acme.test"));
  });

  it("with no name, the address takes line one — and is still the link", async () => {
    await search();
    const bank = host!.querySelector('[data-hit="b"]')!;
    const who = bank.querySelector<HTMLAnchorElement>(".hit .top .who a.hit-addr");
    expect(who, "the address stands in the name's place").not.toBeNull();
    expect(who!.textContent).toBe("noreply@bank.test");
    expect(who!.getAttribute("href")).toBe(addressHref("noreply@bank.test"));
    // No second line — the address is not said twice.
    expect(bank.querySelector(".hit-under")).toBeNull();
  });

  it("pressing the address navigates to `#/address/<addr>` and does NOT open the message", async () => {
    // jsdom performs an anchor's fragment navigation as a QUEUED task, not synchronously (measured:
    // `location.hash` is empty right after `a.click()` and set one macrotask later), so the arrival
    // is read after a tick. Left undrained, that task lands in the NEXT case after its reset — which
    // is how this file once failed on the case below with this case's hash.
    const onOpen = vi.fn();
    await search(onOpen);
    const link = host!.querySelector<HTMLAnchorElement>('[data-hit="a"] a.hit-addr')!;
    expect(link.getAttribute("href")).toBe(addressHref("anna@acme.test"));
    await click(link);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(window.location.hash).toBe(addressHref("anna@acme.test"));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("pressing the row's open control opens exactly that message", async () => {
    const onOpen = vi.fn();
    await search(onOpen);
    await click(host!.querySelector('[data-hit="b"] .hit-open'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect((onOpen.mock.calls[0]![0] as { message: EngineMessage }).message.id).toBe("b");
    expect(window.location.hash).toBe("");
    // And the open control is the row's ONLY button — the address is a link, never a nested
    // button, which is what keeps every `.hit-w button` selector in this directory honest.
    expect(host!.querySelectorAll('[data-hit="b"] button')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("the address view — header, toggle, count line, rows", () => {
  /** The fixture world with one reply sent to Jonas, so "To them" has a row. */
  async function withReply(): Promise<OhmailEngine> {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
    await engine.start();
    const res = await engine.mutate({ kind: "mail_send", inReplyTo: "jonas", body: "The 18th." });
    expect(res.status).toBe("confirmed");
    return engine;
  }

  it("names the person, states the address beside them, and counts each direction on the toggle", async () => {
    const engine = await withReply();
    await mount(h(AddressView, { engine, version: 2, now: DEMO_NOW, address: JONAS, onOpen: () => {} }));
    await settle();

    expect(host!.querySelector(".view-address .vhead h1")!.textContent).toBe("Jonas Halter");
    expect(host!.querySelector(".view-address .vhead .meta")!.textContent).toBe(JONAS);

    const segs = [...host!.querySelectorAll(".addr-bar .seg button")].map((b) => b.textContent);
    expect(segs).toEqual(["All2", "From them1", "To them1"]);
    expect(host!.querySelectorAll("[data-hit]")).toHaveLength(2);
  });

  it("the toggle narrows; a sent copy reads Sent; the row's own address is printed, not linked", async () => {
    const engine = await withReply();
    await mount(h(AddressView, { engine, version: 2, now: DEMO_NOW, address: JONAS, onOpen: () => {} }));
    await settle();

    // The row for Jonas's own message: its address is this view, so it is not a link.
    const jonas = host!.querySelector('[data-hit="jonas"]')!;
    expect(jonas.querySelector(".hit-under .hit-addr")!.tagName).toBe("SPAN");
    expect(jonas.querySelector("a.hit-addr")).toBeNull();

    await click(byText(".addr-bar .seg button", "To them"));
    const rows = [...host!.querySelectorAll("[data-hit]")];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector(".where")!.textContent).toContain("Sent");
    expect(text()).toContain("1 recent");

    await click(byText(".addr-bar .seg button", "From them"));
    const fromRows = [...host!.querySelectorAll("[data-hit]")];
    expect(fromRows).toHaveLength(1);
    expect(fromRows[0]!.getAttribute("data-hit")).toBe("jonas");
    expect(fromRows[0]!.querySelector(".where")!.textContent).not.toContain("Sent");
  });

  it("Escape leaves through onExit", async () => {
    const engine = await withReply();
    const onExit = vi.fn();
    await mount(h(AddressView, { engine, version: 2, now: DEMO_NOW, address: JONAS, onOpen: () => {}, onExit }));
    await settle();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("with no archive behind the client, the count line says so beside the device's number", async () => {
    const engine = await withReply();
    await mount(h(AddressView, { engine, version: 2, now: DEMO_NOW, address: JONAS, onOpen: () => {} }));
    await settle();
    const scope = host!.querySelector(".addr-scope")!;
    expect(scope.textContent).toContain("2 recent");
    expect(scope.textContent).toContain(messages.search.scopeNoArchive);
    // A sentence, not a phrase: it stands on its own line rather than after a separator.
    expect(scope.querySelector(".addr-archive.sentence")).not.toBeNull();
    expect(scope.textContent).not.toContain("showing the first");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("an archive that answers every direction (mail 0154): To them lists its rows, the count plain", () => {
  async function withRecipients(capped = false): Promise<{ engine: OhmailEngine; asked: string[] }> {
    const asked: string[] = [];
    const engine = new OhmailEngine({
      adapter: new FixturesAdapter(),
      now: () => DEMO_NOW,
      serverAddressSearch: async (_address, opts) => {
        const direction = opts.direction ?? "from";
        asked.push(direction);
        const sentTo = { ...archiveRow("to-1", "mila@lichtgrat.example", "2020-02-01T00:00:00.000Z"), to: [{ name: null, address: JONAS }] };
        const items = direction === "from" ? [archiveRow("older-1", JONAS, "2020-01-01T00:00:00.000Z")]
          : direction === "to" ? [sentTo] : [sentTo, archiveRow("older-1", JONAS, "2020-01-01T00:00:00.000Z")];
        if (capped) return { items: items as never, total: 10_000, totalExact: false, direction };
        return { items: items as never, total: direction === "any" ? 9 : direction === "to" ? 4 : 5, direction };
      },
    });
    await engine.start();
    return { engine, asked };
  }

  it("To them: the archive's rows sent to them are listed, and the number carries no caveat", async () => {
    const { engine, asked } = await withRecipients();
    await mount(h(AddressView, { engine, version: 1, now: DEMO_NOW, address: JONAS, onOpen: () => {} }));
    await settle();
    await click(byText(".addr-bar .seg button", "To them"));
    await settle();
    expect(asked).toEqual(["any", "to"]);
    expect([...host!.querySelectorAll("[data-hit]")].map((r) => r.getAttribute("data-hit"))).toEqual(["to-1"]);
    const scope = host!.querySelector(".addr-scope")!;
    expect(scope.textContent).toContain("4 in your whole mailbox");
    expect(scope.textContent).not.toContain("(by sender)");
    expect(scope.querySelector(".gloss-t")).toBeNull();
    expect(text()).not.toContain(messages.search.addressArchiveNoRecipients);
  });

  it("All: the whole mailbox's number is the union, plain", async () => {
    const { engine } = await withRecipients();
    await mount(h(AddressView, { engine, version: 1, now: DEMO_NOW, address: JONAS, onOpen: () => {} }));
    await settle();
    const scope = host!.querySelector(".addr-scope")!;
    expect(scope.textContent).toContain("9 in your whole mailbox");
    expect(scope.textContent).not.toContain("(by sender)");
    expect([...host!.querySelectorAll("[data-hit]")].map((r) => r.getAttribute("data-hit"))).toEqual(["jonas", "to-1", "older-1"]);
  });

  it("past the archive's count cap the number says at least", async () => {
    const { engine } = await withRecipients(true);
    await mount(h(AddressView, { engine, version: 1, now: DEMO_NOW, address: JONAS, onOpen: () => {} }));
    await settle();
    expect(host!.querySelector(".addr-scope")!.textContent).toMatch(/at least 10[,’ ]?000 in your whole mailbox/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

/* A SERVER BEFORE MAIL 0154 answers `from` only (the engine re-asks `from` on its refusal): the
   caveat below is that fallback's, and it stays. */
describe("the archive's half — by sender under All, the named line under To them", () => {
  async function withArchive(): Promise<OhmailEngine> {
    const engine = new OhmailEngine({
      adapter: new FixturesAdapter(),
      now: () => DEMO_NOW,
      serverAddressSearch: async () => ({
        items: [
          archiveRow("jonas", JONAS, "2026-01-01T00:00:00.000Z"),   // held by the device — not appended
          archiveRow("older-1", JONAS, "2020-01-01T00:00:00.000Z"), // the archive's extra
        ] as never,
        total: 7,
        direction: "from",
      }),
    });
    await engine.start();
    return engine;
  }

  it("All: the device's number leads, the whole mailbox's says (by sender), the extra row is a row like any other", async () => {
    const engine = await withArchive();
    await mount(h(AddressView, { engine, version: 1, now: DEMO_NOW, address: JONAS, onOpen: () => {} }));
    await settle();

    const scope = host!.querySelector(".addr-scope")!;
    expect(scope.textContent).toContain("1 recent");
    expect(scope.textContent).toContain("7 in your whole mailbox (by sender)");
    // The archive holds 7 and returned 2 — a page. Said, in Search's own words.
    expect(scope.textContent).toContain("showing the first 2");
    // The caveat's sentence rides a gloss — a real button whose name IS the sentence.
    const gloss = scope.querySelector<HTMLButtonElement>(".gloss-t");
    expect(gloss).not.toBeNull();
    expect(gloss!.getAttribute("aria-label")).toBe(messages.search.addressArchiveBySenderWhy);

    const rows = [...host!.querySelectorAll("[data-hit]")];
    expect(rows.map((r) => r.getAttribute("data-hit"))).toEqual(["jonas", "older-1"]);
    // One list: a row only the store holds carries no mark of where it came from.
    expect(rows[1]!.querySelector(".where")!.textContent).not.toMatch(/archive/i);

    // The toggle counts the rows each direction would show: 1 device + 1 extra under All and
    // From them; the device's zero under To them.
    const segs = [...host!.querySelectorAll(".addr-bar .seg button")].map((b) => b.textContent);
    expect(segs).toEqual(["All2", "From them2", "To them0"]);
  });

  it("To them: the archive slot is the named line, no archive row is listed, the empty state names the address", async () => {
    const engine = await withArchive();
    await mount(h(AddressView, { engine, version: 1, now: DEMO_NOW, address: JONAS, onOpen: () => {} }));
    await settle();
    await click(byText(".addr-bar .seg button", "To them"));

    // THE PROPERTY: the archive's rows are mail this address SENT, and none of them may stand in
    // a list titled "To them". Held back by the contract and by this file's own filter — this
    // case reads the rendered list, which is what a person sees whichever end did it.
    expect(host!.querySelectorAll("[data-hit]")).toHaveLength(0);
    expect(text()).not.toContain("from the archive");

    const empty = host!.querySelector(".empty")!;
    expect(empty.querySelector("b")!.textContent).toBe(`Nothing sent to ${JONAS}.`);
    expect(empty.textContent).toContain("0 recent");
    expect(empty.textContent).toContain("your whole mailbox cannot be searched by recipient yet");
    expect(empty.textContent).not.toContain("in your whole mailbox (by sender)");
    const gloss = empty.querySelector<HTMLButtonElement>(".gloss-t");
    expect(gloss!.getAttribute("aria-label")).toBe(messages.search.addressArchiveNoRecipientsWhy);
  });

  it("From them: the archive covers the direction, so the number is plain", async () => {
    const engine = await withArchive();
    await mount(h(AddressView, { engine, version: 1, now: DEMO_NOW, address: JONAS, onOpen: () => {} }));
    await settle();
    await click(byText(".addr-bar .seg button", "From them"));
    const scope = host!.querySelector(".addr-scope")!;
    expect(scope.textContent).toContain("7 in your whole mailbox");
    expect(scope.textContent).not.toContain("(by sender)");
    expect(scope.querySelector(".gloss-t")).toBeNull();
    expect(host!.querySelectorAll("[data-hit]")).toHaveLength(2);
  });

  it("a refused archive states the failure, offers Try again, and the press recovers the count", async () => {
    // The refusal is the one archive state a reader can act on, so it is the one that carries a
    // control — and a control that did not re-issue the request would read as a dead button
    // beside a sentence about a failure, which is the harder defect to notice.
    let attempt = 0;
    const engine = new OhmailEngine({
      adapter: new FixturesAdapter(),
      now: () => DEMO_NOW,
      serverAddressSearch: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("the archive is down.");
        return {
          items: [archiveRow("older-1", JONAS, "2020-01-01T00:00:00.000Z")] as never,
          total: 7,
          direction: "from" as const,
        };
      },
    });
    await engine.start();
    await mount(h(AddressView, { engine, version: 1, now: DEMO_NOW, address: JONAS, onOpen: () => {} }));
    await settle();

    const scope = () => host!.querySelector(".addr-scope")!;
    // The failure is a SENTENCE on its own line, as it is in Search, beside the device's number.
    expect(scope().textContent).toContain("1 recent");
    expect(scope().textContent).toContain(messages.search.scopeUnanswered);
    expect(scope().querySelector(".addr-archive.sentence")).not.toBeNull();
    // A text button, not a banner: nothing above the list claims the whole view failed.
    expect(host!.querySelector(".addr-scope + * .banner, .banner")).toBeNull();
    const again = byText(".addr-scope button", messages.search.addressRetry);
    expect(again, "the refusal carries Try again").toBeTruthy();

    await click(again);
    await settle();
    expect(attempt).toBe(2);
    // THE COUNT IS BACK, the sentence is gone, and the store's extra row is on screen.
    expect(scope().textContent).toContain("7 in your whole mailbox (by sender)");
    expect(scope().textContent).not.toContain(messages.search.scopeUnanswered);
    expect(byText(".addr-scope button", messages.search.addressRetry)).toBeUndefined();
    expect(host!.querySelectorAll("[data-hit]")).toHaveLength(2);
  });

  it("the rule, by name: archive rows belong under All and under the answered direction only", () => {
    expect(archiveRowsBelong("any", "from")).toBe(true);
    expect(archiveRowsBelong("from", "from")).toBe(true);
    expect(archiveRowsBelong("to", "from")).toBe(false);
    // The day the archive answers `any`, every direction is covered without a change here.
    expect(archiveRowsBelong("to", "any")).toBe(false);
    expect(archiveRowsBelong("any", "any")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

/* ADDRESS-VIEW-WHOLE-MAILBOX-DURING-FIRST-SYNC: during a first sync the archive's number is of the
   mail synced so far, in every direction's words, and the line says the rest is not in yet. */
describe("the archive's half during a first sync says what it counted", () => {
  async function midImport(importing: boolean): Promise<OhmailEngine> {
    const engine = new OhmailEngine({
      adapter: new FixturesAdapter(),
      now: () => DEMO_NOW,
      serverAddressSearch: async () => ({
        items: [archiveRow("jonas", JONAS, "2026-01-01T00:00:00.000Z")] as never,
        total: 7,
        direction: "from",
        ...(importing ? { importing: true as const } : {}),
      }),
    });
    await engine.start();
    return engine;
  }
  const open = async (importing: boolean, toggle?: string) => {
    await mount(h(AddressView, { engine: await midImport(importing), version: 1, now: DEMO_NOW, address: JONAS, onOpen: () => {} }));
    await settle();
    if (toggle) await click(byText(".addr-bar .seg button", toggle));
    return text();
  };

  it("All, From them and To them each say it of the mail synced so far, never of the whole mailbox", async () => {
    const all = await open(true);
    expect(all).toContain("7 in the mail synced so far (by sender)");
    expect(all).toContain(messages.search.syncing);
    expect(all).not.toContain("in your whole mailbox (by sender)");
    const from = await open(true, "From them");
    expect(from).toContain("7 in the mail synced so far");
    expect(from).not.toContain("7 in your whole mailbox");
    expect(from).toContain(messages.search.syncing);
    const to = await open(true, "To them");
    expect(to).toContain("your whole mailbox cannot be searched by recipient yet");
    expect(to).toContain(messages.search.syncing);
  });

  it("the complete-store control: once the first sync is done, the line reads as it always did", async () => {
    const all = await open(false);
    expect(all).toContain("7 in your whole mailbox (by sender)");
    expect(all).not.toContain(messages.search.syncing);
    expect(all).not.toContain("synced so far");
    const from = await open(false, "From them");
    expect(from).toContain("7 in your whole mailbox");
    expect(from).not.toContain(messages.search.syncing);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("the empty state and the name", () => {
  it("an address nobody has written from or to is named, in the header and in the sentence", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
    await engine.start();
    await mount(h(AddressView, {
      engine, version: 1, now: DEMO_NOW, address: "nobody@nowhere.test", onOpen: () => {},
    }));
    await settle();
    expect(host!.querySelector(".vhead h1")!.textContent).toBe("nobody@nowhere.test");
    expect(host!.querySelector(".vhead .meta")).toBeNull();
    expect(host!.querySelector(".empty b")!.textContent).toBe("Nothing from or to nobody@nowhere.test.");
    expect(host!.querySelector(".empty")!.textContent).toContain("0 recent");
  });

  it("nameFor reads the newest row that names the address — on either side of it", () => {
    const hit = (m: EngineMessage) => ({ hit: { message: m, score: 0, matches: [] }, archiveOnly: false });
    const asRecipient = row({ id: "r", from: { name: "Me", address: "me@x.test" }, to: [{ name: "Anna B.", address: "Anna@Acme.test" }] });
    const asSender = row({ id: "s", from: { name: "Anna Berg", address: "anna@acme.test" } });
    const nameless = row({ id: "n", from: { name: null, address: "anna@acme.test" } });
    expect(nameFor([hit(nameless), hit(asSender)], "anna@acme.test")).toBe("Anna Berg");
    // Case folds, as both doors fold it; the recipient's name counts too.
    expect(nameFor([hit(asRecipient)], "anna@acme.test")).toBe("Anna B.");
    expect(nameFor([hit(nameless)], "anna@acme.test")).toBeNull();
    expect(nameFor([], "anna@acme.test")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("the two popovers offer the view", () => {
  it("the screening popover carries the row at address scope, linked, and drops it at domain scope", async () => {
    const list = [
      row({ id: "a", from: { name: "Anna Berg", address: "anna@acme.test" } }),
      row({ id: "b", from: { name: null, address: "bob@acme.test" } }),
    ];
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges(list.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })));
    const sender = senderScreening(store, "a")!;
    await mount(h(SenderMenu, {
      state: { messageId: "a", x: 0, y: 0 },
      sender,
      onChoose: () => {},
      onOpenDetail: () => {},
      onClose: () => {},
    }));

    const link = byText("a.sm-detail", "Everything from and to this address") as HTMLAnchorElement | undefined;
    expect(link, "the row is a link in the ways-onward block").toBeTruthy();
    expect(link!.getAttribute("href")).toBe(addressHref("anna@acme.test"));

    // Domain scope: the view is about one address, so the row goes away rather than lying.
    await click(byText(".sm-scope button", "Everyone at acme.test"));
    expect(byText("a.sm-detail", "Everything from and to this address")).toBeUndefined();
    // The neighbouring ways onward are untouched.
    expect(byText(".sm-detail", "See all")).toBeTruthy();
  });

  it("the chip popover carries the verb, and pressing it navigates", async () => {
    await mount(h(ContactPopover, {
      state: { messageId: "m", address: "anna@acme.test", name: "Anna Berg", x: 0, y: 0 },
      onClose: () => {},
    }));
    const item = byText('[role="menuitem"]', "Everything from and to this address");
    expect(item, "the verb is in the menu").toBeTruthy();
    await click(item);
    expect(window.location.hash).toBe(addressHref("anna@acme.test"));
  });
});
