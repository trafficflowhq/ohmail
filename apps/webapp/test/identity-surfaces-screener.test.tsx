/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import { notifiedSenderName } from "@ohmail/client-engine";
import { senderCheckFact, senderCheckSentence } from "../app/shell/sender-check.js";
import { personalAt } from "../../../test/support/fixture-credentials.js";

/**
 * THE IDENTITY FACT AT THE SCREENER (mail 0148, acceptance 16): the sentence's forms off the wire, the guided first
 * decision's name, and the sender sheet's line. MOVED, as they stood, out of `identity-surfaces.test.tsx` (share
 * reader-1, the switch's older tests): their place, the Screener, is not mounted yet; each waits for its mount
 * (`mount-screener`), which re-points them at the Screener's own parts (`packages/app/src/screener/sender/`).
 */
(globalThis as unknown as { React: unknown }).React = React;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

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

  it("the guided first decision and every one-line name carry the claim with its denial", () => {
    const not = (brand: string) => `Not ${brand}`;
    expect(notifiedSenderName({ ...message({ reason: "impersonation", brand: "PostFinance", domainShared: true }) }, not))
      .toBe("PostFinance (Not PostFinance)");
    expect(notifiedSenderName({ from: { name: "PostFinance", address: personalAt("fixture.reto", "gmail.com") }, checked: { brand: "PostFinance" } }, not))
      .toBe("PostFinance (Not PostFinance)");
    expect(notifiedSenderName({ from: { name: "Anna", address: "a@firma.example" } }, not)).toBe("Anna");
  });

  it("the sender sheet says the sentence, behind the shield, before any choice; an unmarked sender's says nothing", async () => {
    const { MemoryMirrorStore } = await import("@ohmail/client-engine");
    const { SenderMenu } = await import("../app/shell/SenderMenu.js");
    const { senderScreening } = await import("@ohmail/app-logic/press/sender-screening");
    const base = {
      accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: "Bitte bestätigen", to: [], cc: [],
      date: "2026-10-07T09:00:00.000Z", folder: "ohmail/Screener", snippet: "", unread: true, hasAttachments: false,
      attachmentCount: 0, sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none", updatedAt: "2026-10-07T09:00:00.000Z",
    };
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
      { id: "x2", from: { name: "PayPal", address: "alerts@paypal.com" }, senderCheck: UNVERIFIED, date: "2026-10-07T10:00:00.000Z" },
      // A contact's address, one letter its provider failed and one it did not.
      { id: "f1", from: { name: "Accountant", address: "accountant@smallfirm.example" }, senderCheck: null, authVerdict: "fail" },
      { id: "f2", from: { name: "Accountant", address: "accountant@smallfirm.example" }, senderCheck: null, folder: "INBOX" },
    ].map((m, i) => ({ type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: base.updatedAt, entity: { ...base, ...m } })) as never);
    const sheet = async (id: string, reason = "identity") => {
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(React.createElement(NextIntlClientProvider, {
          locale: "en", messages: en, children: React.createElement(SenderMenu as never, {
            state: { messageId: id, x: 0, y: 0 }, sender: senderScreening(store, id)!,
            onChoose: () => {}, onOpenDetail: () => {}, onClose: () => {},
          }),
        }));
      });
      const line = host.querySelector(`.sm-check[data-reason="${reason}"]`);
      return line === null ? null : { text: line.textContent, shield: line.querySelector("svg") !== null };
    };
    expect(await sheet("p1")).toEqual({ text: "This message claims to be from PostFinance, but anyone can register a gmail.com address.", shield: true });
    await act(async () => { root!.unmount(); });
    host!.remove();
    expect(await sheet("a1")).toBeNull();
    await act(async () => { root!.unmount(); });
    host!.remove();
    expect(await sheet("u1", "unverified")).toEqual({ text: "This message says it is from PayPal. Your mail provider did not confirm that.", shield: true });
    await act(async () => { root!.unmount(); });
    host!.remove();
    expect(await sheet("x2")).toEqual({ text: "This message claims to be from PostFinance, but paypal.com isn't one of PostFinance's addresses.", shield: true });
    expect(host!.querySelector('.sm-check[data-reason="unverified"]')).toBeNull();
    await act(async () => { root!.unmount(); });
    host!.remove();
    // Opened on the failed letter, the sheet says that check; opened on the other letter, nothing.
    expect(await sheet("f1", "failed")).toEqual({
      text: "Your mail provider checked whether this message is from accountant@smallfirm.example, and the check failed.", shield: true,
    });
    await act(async () => { root!.unmount(); });
    host!.remove();
    expect(await sheet("f2", "failed")).toBeNull();
    expect(host!.querySelector(".sm-check")).toBeNull();
  });
});
