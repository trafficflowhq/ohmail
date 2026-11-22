/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Frame } from "@ohmail/app/frame";
import { MailGround, mailPlaces, mailReader } from "@ohmail/app/mail";
import { TextProvider } from "@ohmail/app/text";
import { letterBody } from "../../../packages/app/src/reader/body/index.js";
import { LIST_WORDS } from "../../../packages/app/test/places/list-seat.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import { stubDom, unmountAll } from "./_draft-shell";
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";
import messages from "../messages/en.json";
import {
  ACCOUNT, ISO, installScreeningWeb, mountScreeningWeb, syncScreeningWeb, teardownScreeningWeb, tick,
} from "./fixtures/screening-web";
import { RegisteredSearch, enterSearchRoute, findSearchField, typeSearch } from "./search-registered-fixture";

/**
 * Search contact links, the Address archive and the screening popover.
 * Cases for the archive use the registered Address place where it preserves the behavior.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const addressHref = (address: string) => "#/address/" + encodeURIComponent(address);

const NOW = new Date("2026-08-04T09:00:00.000Z");
const JONAS = "jonas@lichtgrat.example";

function row(over: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: ACCOUNT, mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Invoice ${over.id}`,
    from: { name: null, address: `${over.id}@example.test` },
    to: [], cc: [], date: "2026-08-04T08:00:00.000Z", folder: "ohmail/News",
    snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
    ...over,
  };
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
  await unmountAll();
  vi.restoreAllMocks();
});

async function mountAddress(engine: OhmailEngine, address = JONAS): Promise<void> {
  await act(async () => root!.render(null));
  stubDom();
  const app = fakeHost({
    engine,
    service: "self",
    scope: "address-render-test",
    places: mailPlaces(),
    above: MailGround,
    reader: mailReader({ body: letterBody, look: "none" }),
    window: fakeWindow("desktop"),
    address: fakeAddress(addressHref(address)),
  });
  await act(async () => root!.render(
    <TextProvider locale="en" messages={LIST_WORDS} timeZone="UTC" now={DEMO_NOW}>
      <Frame host={app.host} />
    </TextProvider>,
  ));
  await settle();
}

async function chooseDirection(name: "From" | "To"): Promise<void> {
  const directions = within(host!).getByRole("group", { name: "Direction" });
  await click(within(directions).getByRole("button", { name: new RegExp(name === "From" ? "^From them " : "^To them ") }));
  await settle();
}

function addressRows(name: "Both" | "From" | "To"): HTMLElement[] {
  const directions = { Both: "All", From: "From them", To: "To them" };
  return within(within(host!).getByRole("listbox", { name: directions[name] })).getAllByRole("option");
}

/** Let the archive pass's promise settle — there is no debounce on the address view. */
async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); });
}

const click = async (node: Element | null | undefined): Promise<void> => {
  expect(node, "the control this test drives does not exist").toBeTruthy();
  await act(async () => { (node as HTMLElement).click(); });
};

const text = (): string => host!.textContent ?? "";

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("the search result row — the address is printed, and it is the control", () => {
  const anna = "anna@acme.test";
  const bank = "noreply@bank.test";
  const rows = [
    row({ id: "a", subject: "Invoice a", folder: "INBOX", unread: false, from: { name: "Anna Berg", address: anna } }),
    row({ id: "b", subject: "Invoice b", folder: "INBOX", unread: false, from: { name: null, address: bank } }),
  ];

  let restoreRoute: (() => void) | undefined;
  afterEach(() => {
    cleanup();
    restoreRoute?.();
    restoreRoute = undefined;
  });

  async function results() {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges(rows.map((entity, index) => ({
      type: "message", op: "create", id: entity.id, seq: index + 1, updatedAt: entity.updatedAt, entity,
    })));
    const provisional = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        sync: provisional.sync.bind(provisional),
        mutate: provisional.mutate.bind(provisional),
        fetchBody: provisional.fetchBody.bind(provisional),
        withdrawSend: provisional.withdrawSend.bind(provisional),
        searchServer: async () => ({ items: rows, total: rows.length, totalExact: true, ms: 4, tier: "exact" }),
      },
      store,
    });
    restoreRoute = enterSearchRoute();
    const { container } = render(<RegisteredSearch engine={engine} now={NOW} />);
    await findSearchField(container);
    await act(async () => { typeSearch(container, "invoice"); });
    await within(container).findByRole("list", { name: "Search" });
  }

  const hit = (id: string) => screen.getAllByRole("listitem").find((item) => item.dataset.hit === id)!;

  it("prints the name on line one and the address on line two, linked to the address view", async () => {
    await results();
    const result = hit("a");
    const name = within(result).getByText("Anna Berg");
    const link = within(result).queryByRole("link", { name: anna });
    expect(link, "line two is the address, as a link").not.toBeNull();
    const who = name.closest(".oh-row-who");
    expect(who?.nextElementSibling).toBe(link);
    expect(link!.getAttribute("href")).toBe(addressHref(anna));
  });

  it("with no name, the address takes line one — and is still the link", async () => {
    await results();
    const result = hit("b");
    expect(within(result).getAllByText(bank, { exact: true })).toHaveLength(1);
    const link = within(result).queryByRole("link", { name: bank });
    expect(link, "the address stands in the name's place").not.toBeNull();
    expect(result.querySelector(".oh-row-who")?.contains(link)).toBe(true);
    expect(link!.getAttribute("href")).toBe(addressHref(bank));
  });

  it("pressing the address navigates to `#/address/<addr>` and does NOT open the message", async () => {
    await results();
    const link = within(hit("a")).queryByRole("link", { name: anna });
    expect(link?.getAttribute("href")).toBe(addressHref(anna));
    await click(link);
    expect(window.location.hash).toBe("#/search");
    expect(screen.queryByRole("region", { name: messages.reader.pane })).toBeNull();
    const card = screen.getByRole("dialog", {
      name: messages.message.contactAria.replace("{who}", "Anna Berg"),
    });
    await click(within(card).getByRole("menuitem", { name: messages.message.addressOpen }));
    expect(window.location.hash).toBe(`${addressHref(anna)}/m/a`);
    expect(await screen.findByRole("heading", { name: "Anna Berg" })).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("the address view — header, toggle, count line, rows", () => {
  /** The fixture world with one reply sent to Jonas, so "To" has a row. */
  async function withReply(): Promise<OhmailEngine> {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
    await engine.start();
    const res = await engine.mutate({ kind: "mail_send", inReplyTo: "jonas", body: "The 18th." });
    expect(res.status).toBe("confirmed");
    return engine;
  }

  it("the toggle narrows; a sent copy reads Sent; the row's own address is printed, not linked", async () => {
    const engine = await withReply();
    await mountAddress(engine);

    const jonas = addressRows("Both").find((row) => row.getAttribute("data-id") === "jonas")!;
    const printed = jonas.querySelector(".oh-row-address")!;
    expect(printed.tagName).toBe("SPAN");
    expect(printed.textContent).toBe(JONAS);
    expect(jonas.querySelector("a.oh-row-address")).toBeNull();
    expect(within(jonas).queryByRole("link", { name: JONAS })).toBeNull();

    await chooseDirection("To");
    const rows = addressRows("To");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector(".oh-where")!.textContent).toContain("Sent");
    expect(text()).not.toContain("1 recent");

    await chooseDirection("From");
    const fromRows = addressRows("From");
    expect(fromRows).toHaveLength(1);
    expect(fromRows[0]!.getAttribute("data-id")).toBe("jonas");
    expect(fromRows[0]!.querySelector(".oh-where")!.textContent).not.toContain("Sent");
  });

  it("with no archive behind the client, the count line says so beside the device's number", async () => {
    const engine = await withReply();
    await mountAddress(engine);
    expect(addressRows("Both")).toHaveLength(2);
    expect(text()).not.toContain("2 recent");
    expect(text()).not.toContain("Search covers the sample mailbox.");
    expect(text()).not.toContain("showing the first");
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
    await mountAddress(engine);
    await chooseDirection("To");
    expect(asked).toEqual(["any", "to"]);
    expect(addressRows("To").map((r) => r.getAttribute("data-id"))).toEqual(["to-1"]);
    expect(text()).not.toContain("in your whole mailbox");
    expect(within(host!).queryByRole("button", { name: messages.search.addressArchiveBySenderWhy })).toBeNull();
    expect(text()).not.toContain(messages.search.addressArchiveBySenderWhy);
    expect(text()).not.toContain(messages.search.addressArchiveNoRecipientsWhy);
  });

  it("All: the whole mailbox's number is the union, plain", async () => {
    const { engine } = await withRecipients();
    await mountAddress(engine);
    expect(text()).not.toContain("in your whole mailbox");
    expect(addressRows("Both").map((r) => r.getAttribute("data-id"))).toEqual(["jonas", "to-1", "older-1"]);
  });

  it("past the archive's count cap the number says at least", async () => {
    const { engine } = await withRecipients(true);
    await mountAddress(engine);
    expect(text()).not.toContain("in your whole mailbox");
    expect(text()).toContain("showing the first");
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
    await mountAddress(engine);

    expect(text()).not.toContain("1 recent");
    expect(text()).not.toContain("7 in your whole mailbox");
    const shown = within(host!).getByText("showing the first 2");
    const caveat = within(host!).getByText(messages.search.addressArchiveBySenderWhy, { exact: true });
    expect(caveat.closest("p")).not.toBe(shown.closest("p"));

    const rows = addressRows("Both");
    expect(rows.map((r) => r.getAttribute("data-id"))).toEqual(["jonas", "older-1"]);
    // One list: a row only the store holds carries no mark of where it came from.
    expect(rows[1]!.querySelector(".oh-where")!.textContent).not.toMatch(/archive/i);

    // The toggle counts the rows each direction would show: 1 device + 1 extra under All and
    // From them; the device's zero under To them.
    const directions = within(host!).getByRole("group", { name: "Direction" });
    const segs = within(directions).getAllByRole("button").map((button) => button.textContent);
    expect(segs).toEqual(["All 2", "From them 2", "To them 0"]);
  });

  it("To them: the archive slot is the named line, no archive row is listed, the empty state names the address", async () => {
    const engine = await withArchive();
    await mountAddress(engine);
    await chooseDirection("To");

    // THE PROPERTY: the archive's rows are mail this address SENT, and none of them may stand in
    // a list titled "To". Held back by the contract and by this file's own filter — this
    // case reads the rendered list, which is what a person sees whichever end did it.
    expect(within(host!).queryAllByRole("option")).toHaveLength(0);
    expect(text()).not.toContain("from the archive");

    const empty = within(host!).getByText((_, el) =>
      el?.tagName === "P" && el.textContent === `Nothing sent to ${JONAS}`);
    expect(empty.textContent).toBe(`Nothing sent to ${JONAS}`);
    expect(text()).not.toContain("0 recent");
    expect(text()).not.toContain("your whole mailbox cannot be searched by recipient yet");
    expect(within(host!).getByText(messages.search.addressArchiveNoRecipientsWhy, { exact: true })).toBeTruthy();
  });

  it("From them: the archive covers the direction, so the number is plain", async () => {
    const engine = await withArchive();
    await mountAddress(engine);
    await chooseDirection("From");
    expect(text()).not.toContain("in your whole mailbox");
    expect(within(host!).queryByRole("button", { name: messages.search.addressArchiveBySenderWhy })).toBeNull();
    expect(text()).not.toContain(messages.search.addressArchiveBySenderWhy);
    expect(addressRows("From")).toHaveLength(2);
  });

  it("a refused archive states the failure, offers Try again, and the press recovers the count", async () => {
    // The refusal is the one archive state a reader can act on, so it is the one that carries a
    // control — and a control that did not re-issue the request would read as a dead button
    // beside a sentence about a failure, which is the harder defect to notice.
    async function archiveThatRefusesOnce() {
      let attempts = 0;
      const engine = new OhmailEngine({
        adapter: new FixturesAdapter(),
        now: () => DEMO_NOW,
        serverAddressSearch: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("the archive is down.");
          return {
            items: [archiveRow("older-1", JONAS, "2020-01-01T00:00:00.000Z")] as never,
            total: 7,
            direction: "from" as const,
          };
        },
      });
      await engine.start();
      return { engine, attempts: () => attempts };
    }

    const legacy = await archiveThatRefusesOnce();
    await mountAddress(legacy.engine);
    const legacyScope = within(host!).getByText(messages.address.archive.unanswered, { exact: true }).closest("p")!;
    expect(legacyScope.textContent).not.toContain("1 recent");
    expect(legacyScope.textContent).toContain(messages.address.archive.unanswered);
    expect(within(host!).queryByText(messages.address.archive.unanswered, { exact: true })).not.toBeNull();

    const { engine, attempts } = await archiveThatRefusesOnce();
    await mountAddress(engine);
    const scope = within(host!);
    const failure = scope.getByText(messages.address.archive.unanswered, { exact: true }).closest("p")!;
    expect(failure.textContent).not.toContain("1 recent");
    expect(failure.textContent).toContain(messages.address.archive.unanswered);
    expect(scope.queryByRole("alert")).toBeNull();
    expect(host!.querySelector(".banner")).toBeNull();
    const retry = scope.getByRole("button", { name: messages.search.addressRetry });
    expect(retry.closest(".oh-listline")).toBe(failure.closest(".oh-listline"));
    expect(attempts()).toBe(1);

    await click(retry);
    await settle();
    expect(attempts()).toBe(2);
    expect(scope.getByText(messages.search.addressArchiveBySenderWhy)).toBeTruthy();
    expect(scope.queryByText(messages.address.archive.unanswered, { exact: false })).toBeNull();
    expect(scope.queryByRole("button", { name: messages.search.addressRetry })).toBeNull();
    expect(addressRows("Both")).toHaveLength(2);
  });

  it("the rule, by name: archive rows belong under All and under the answered direction only", async () => {
    async function openArchive(answered: "from" | "any") {
      const engine = new OhmailEngine({
        adapter: new FixturesAdapter(),
        now: () => DEMO_NOW,
        serverAddressSearch: async () => ({
          items: [archiveRow("older-1", JONAS, "2020-01-01T00:00:00.000Z")],
          total: 1,
          direction: answered,
        }),
      });
      await engine.start();
      await mountAddress(engine);
    }
    const hasArchiveRow = () => within(host!).queryByRole("option", { name: /archive older-1/ }) !== null;

    await openArchive("from");
    expect(hasArchiveRow()).toBe(true);
    await chooseDirection("From");
    expect(hasArchiveRow()).toBe(true);
    await chooseDirection("To");
    expect(hasArchiveRow()).toBe(false);

    await openArchive("any");
    expect(hasArchiveRow()).toBe(true);
    await chooseDirection("To");
    expect(hasArchiveRow()).toBe(false);
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
  const open = async (importing: boolean, toggle?: "From" | "To") => {
    await mountAddress(await midImport(importing));
    if (toggle) await chooseDirection(toggle);
    return text();
  };

  it("All, From them and To them each say it of the mail synced so far, never of the whole mailbox", async () => {
    const all = await open(true);
    expect(all).not.toContain("7 in ");
    expect(all).toContain(messages.address.archive.importing);
    expect(all).not.toContain("in your whole mailbox (by sender)");
    const from = await open(true, "From");
    expect(from).not.toContain("7 in ");
    expect(from).not.toContain("7 in your whole mailbox");
    expect(from).toContain(messages.address.archive.importing);
    const to = await open(true, "To");
    expect(to).toContain(messages.search.addressArchiveNoRecipientsWhy);
    expect(to).not.toContain(messages.address.archive.importing);
  });

  it("the complete-store control: once the first sync is done, the line reads as it always did", async () => {
    const all = await open(false);
    expect(all).not.toContain("7 in ");
    expect(all).not.toContain(messages.address.archive.importing);
    expect(all).not.toContain("synced so far");
    const from = await open(false, "From");
    expect(from).not.toContain("7 in ");
    expect(from).not.toContain(messages.address.archive.importing);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("the empty state and the name", () => {
  it("an address nobody has written from or to is named, in the header and in the sentence", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
    await engine.start();
    await mountAddress(engine, "nobody@nowhere.test");
    expect(host!.querySelector(".oh-listhead h1")!.textContent).toBe("nobody@nowhere.test");
    expect(host!.querySelector(".oh-listhead-meta")).toBeNull();
    expect(host!.querySelector(".oh-empty-label")!.textContent).toBe("Nothing from or to nobody@nowhere.test");
    expect(text()).not.toContain("0 recent");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("the two popovers offer the view", () => {
  it("the screening popover carries the row at address scope, linked, and drops it at domain scope", async () => {
    const list = [
      row({ id: "a", folder: "INBOX", from: { name: "Anna Berg", address: "anna@acme.test" } }),
      row({ id: "b", folder: "INBOX", from: { name: null, address: "bob@acme.test" } }),
    ];
    installScreeningWeb("#/ohbox/m/a", (path, query, method) => {
      if (method === "GET" && path === "/api/mailboxes") {
        return Response.json({ items: [{
          id: "mb", address: ["reader", "example.test"].join("@"), status: "connected",
          createdAt: ISO, lastSyncAt: ISO, initialImportCompletedAt: ISO,
          organizerRole: "organizer", organizerChecked: true, organizeConsentedAt: ISO,
        }] });
      }
      if (method === "GET" && path === "/api/sync" && query.get("types") !== "rule") {
        return syncScreeningWeb(list.map((message, index) => ({
          type: "message", op: "create", seq: index + 1, id: message.id,
          updatedAt: message.updatedAt, entity: message,
        })), list.length);
      }
      return undefined;
    });

    try {
      const shell = within(await mountScreeningWeb());
      await tick(4000);
      await click(shell.getByRole("button", { name: /^Anna Berg / }));
      const address = list[0]!.from.address;
      const dialog = screen.getByRole("dialog", { name: messages.screening.aria.replace("{sender}", address) });
      const sheet = within(dialog);
      const allMail = messages.message.contactAllMail;
      expect(sheet.queryByRole("menuitem", { name: allMail }), "the row is in the ways-onward block").toBeTruthy();

      // The neighboring way onward stays available when the scope changes.
      await click(sheet.getByRole("radio", { name: /^Everyone at acme\.test/ }));
      expect(sheet.queryByRole("menuitem", { name: allMail })).toBeNull();
      expect(sheet.getByRole("button", { name: /^See all/ })).toBeTruthy();

      // Back at address scope the row leads to the address view.
      await click(sheet.getByRole("radio", { name: /^This address/ }));
      await click(sheet.getByRole("menuitem", { name: allMail }));
      expect(window.location.hash).toBe(`${addressHref(address)}/m/a`);
    } finally {
      await teardownScreeningWeb();
    }
  });
});
