/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import en from "../messages/en.json";
import { senderCheckFact, senderCheckSentence } from "../app/screening/sender-check.js";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import { ISO, act, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
});
afterEach(teardownShellEnv);

const words = (key: string, v: Record<string, string> = {}): string => ({
  "senderCheck.impersonation": `This message claims to be from ${v.brand}, but ${v.domain} isn't one of ${v.brand}'s addresses.`,
  "senderCheck.impersonationShared": `This message claims to be from ${v.brand}, but anyone can register a ${v.domain} address.`,
  "senderCheck.unverified": `This message says it is from ${v.brand}. Your mail provider did not confirm that.`,
  "senderCheck.failed": `Your mail provider checked whether this message is from ${v.address}, and the check failed.`,
} as Record<string, string>)[key] ?? key;

/** A sender at the brand's own domain whose provider did not confirm it (`reason: "unverified"`). */
const UNVERIFIED = { reason: "unverified" as const, brand: "PayPal", domainShared: false };

/** The phish's sender: a fixture at a shared provider, whose address anyone can register. */
const PHISH = personalAt("fixture.mila", "gmail.com");

const message = (senderCheck: EngineMessage["senderCheck"]): Pick<EngineMessage, "from" | "senderCheck"> => ({
  from: { name: "PostFinance", address: PHISH }, senderCheck,
});

describe("the identity fact on the web", () => {
  it("the sentence reads the fact off the wire, and the shared-provider form names the domain", () => {
    const shared = senderCheckFact(message({ reason: "impersonation", brand: "PostFinance", domainShared: true }));
    expect(senderCheckSentence(words, shared!)).toBe("This message claims to be from PostFinance, but anyone can register a gmail.com address.");
    const own = senderCheckFact(message({ reason: "impersonation", brand: "PostFinance", domainShared: false }));
    expect(senderCheckSentence(words, own!)).toBe("This message claims to be from PostFinance, but gmail.com isn't one of PostFinance's addresses.");
    expect(senderCheckFact(message(null))).toBeNull();
    expect(senderCheckFact(message(undefined))).toBeNull();
  });

  it("an unconfirmed sender at a brand's own domain reads as unconfirmed, never as a claim", () => {
    const f = senderCheckFact({ from: { name: "PayPal", address: "service@paypal.com" }, senderCheck: UNVERIFIED });
    expect(f).toMatchObject({ reason: "unverified", brand: "PayPal", domain: "paypal.com" });
    expect(senderCheckSentence(words, f!)).toBe("This message says it is from PayPal. Your mail provider did not confirm that.");
  });

  it("a letter its provider failed reads as failed, before any claim its name makes", () => {
    const contact = { from: { name: "Accountant", address: "accountant@smallfirm.example" }, senderCheck: null };
    const f = senderCheckFact({ ...contact, authVerdict: "fail" });
    expect(f).toMatchObject({ reason: "failed", address: "accountant@smallfirm.example" });
    expect(senderCheckSentence(words, f!)).toBe(
      "Your mail provider checked whether this message is from accountant@smallfirm.example, and the check failed.");
    expect(senderCheckFact({ ...message({ reason: "impersonation", brand: "PostFinance", domainShared: true }), authVerdict: "fail" })?.reason)
      .toBe("failed");
    // A verdict the gate does not screen on says nothing new.
    expect(senderCheckFact({ ...contact, authVerdict: "unavailable" })).toBeNull();
    expect(senderCheckFact({ ...contact, authVerdict: "pass" })).toBeNull();
  });

  it("the sender sheet says the sentence, behind the shield, before any choice; an unmarked sender's says nothing", async () => {
    const base = {
      accountId: "acct_live_1", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: "Confirmation", to: [], cc: [],
      date: "2026-08-04T09:00:00.000Z", folder: "ohmail/Screener", snippet: "", unread: true, hasAttachments: false,
      attachmentCount: 0, sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-04T09:00:00.000Z",
    };
    const accountant = personalAt("fixture.accountant", "smallfirm.example");
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([
      { id: "p1", from: { name: "PostFinance", address: PHISH },
        senderCheck: { reason: "impersonation", brand: "PostFinance", domainShared: true } },
      { id: "a1", from: { name: "Anna", address: "anna@firma.example" }, senderCheck: null },
      { id: "u1", from: { name: "PayPal", address: "service@paypal.com" }, senderCheck: UNVERIFIED },
      // One address, two letters: a claim, and a NEWER unconfirmed line. The claim is what the sheet says.
      { id: "x1", from: { name: "PostFinance", address: "alerts@paypal.com" },
        senderCheck: { reason: "impersonation", brand: "PostFinance", domainShared: false } },
      { id: "x2", from: { name: "PayPal", address: "alerts@paypal.com" }, senderCheck: UNVERIFIED, date: "2026-08-04T10:00:00.000Z" },
      // A contact's address, one letter its provider failed and one it did not.
      { id: "f1", from: { name: "Accountant", address: accountant }, senderCheck: null, authVerdict: "fail" },
      { id: "f2", from: { name: "Accountant", address: accountant }, senderCheck: null, folder: "INBOX" },
    ].map((m, i) => ({ type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: base.updatedAt, entity: { ...base, ...m } })) as never);
    await store.applyChanges([{
      type: "rule", op: "create", id: "known-contact", seq: 8, updatedAt: ISO,
      entity: {
        id: "known-contact", kind: "sender", match: accountant, destination: "INBOX", priority: 0,
        provenance: "seeded-from-sent", enabled: true,
        stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
      },
    }]);
    const engine = new OhmailEngine({
      store,
      adapter: {
        sync: async () => ({
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: store.getCursor(), hasMore: false, serverTime: ISO,
        }),
        mutate: async () => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" }),
        fetchBody: async () => null,
        screenerWaiting: async () => ({
          nextCursor: null, total: 4, inFlight: [],
          items: ["p1", "a1", "u1", "x2"].map((id) => {
            const letter = store.get<EngineMessage>("message", id)!;
            return {
              messageId: id, address: letter.from.address, name: letter.from.name,
              receivedAt: letter.date!, subject: letter.subject, snippet: letter.snippet, mailboxId: letter.mailboxId,
            };
          }),
        }),
      },
    });
    window.location.hash = "#/screener";
    const host = await mountShell([mailbox({
      id: "mb", organizerRole: "organizer", organizeConsentedAt: ISO, lastSyncAt: ISO,
    })], { engine, suggestWire: "none", junkWire: "none" });
    await tick(50);
    const preview = () => within(within(host).getByRole("region", { name: "Reading" }));
    async function choose(id: string) {
      const row = within(host).getAllByRole("option").find((option) => option.dataset.id === id);
      expect(row, "the selected letter or sender is listed").toBeTruthy();
      await act(async () => { row!.click(); });
      await tick(0);
    }
    async function sheet(id: string) {
      await choose(id);
      const article = preview().getAllByRole("article").find((element) => element.id.endsWith(`-${id}`))!;
      const from = within(article).getAllByRole("button").find((control) => control.getAttribute("aria-haspopup") === "dialog")!;
      await act(async () => { from.click(); });
      await tick(0);
      return within(document.body).getByRole("dialog", { name: en.screener.place.keyCard });
    }
    async function close() {
      await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      await tick(0);
    }
    function check(card: HTMLElement, sentence: string) {
      const notice = within(card).queryByRole("note");
      expect.soft(notice?.textContent).toBe(sentence);
      expect.soft(notice?.querySelector("svg")).toBeTruthy();
      const firstChoice = within(card).getByRole("radiogroup", { name: en.screener.place.goesLabel });
      expect.soft(notice && (notice.compareDocumentPosition(firstChoice) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
    }

    check(await sheet("p1"), "This message claims to be from PostFinance, but anyone can register a gmail.com address.");
    await close();
    expect.soft(within(await sheet("a1")).queryByRole("note")).toBeNull();
    await close();
    check(await sheet("u1"), "This message says it is from PayPal. Your mail provider did not confirm that.");
    await close();
    const mixed = await sheet("x2");
    check(mixed, "This message claims to be from PostFinance, but paypal.com isn't one of PostFinance's addresses.");
    expect.soft(within(mixed).queryByText("This message says it is from PayPal. Your mail provider did not confirm that.")).toBeNull();
    await close();

    await choose("f1");
    expect(preview().getByText(`Your mail provider checked whether this message is from ${accountant}, and the check failed.`)).toBeTruthy();
    const failed = preview().getByRole("article");
    const from = within(failed).getByRole("button", { name: /^Accountant/ });
    await act(async () => { from.click(); });
    await tick(0);
    const card = within(document.body).getByRole("dialog", { name: en.screener.place.keyCard });
    const failedNotice = within(card).getByRole("note");
    expect(failedNotice.textContent).toBe(`Your mail provider checked whether this message is from ${accountant}, and the check failed.`);
    expect(failedNotice.querySelector("svg")).toBeTruthy();
    await close();
    await goTo("ohbox");
    await choose("f2");
    const usual = preview().getByRole("button", { name: /^Accountant/ });
    await act(async () => { usual.click(); });
    await tick(0);
    const usualCard = within(document.body).getByRole("dialog", { name: "Options for Accountant" });
    expect(within(usualCard).queryByRole("note")).toBeNull();
  });
});
