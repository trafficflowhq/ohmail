/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import { MessageRow, ThemeProvider } from "@ohmail/ui";
import { notifiedSenderName, type EngineMessage } from "@ohmail/client-engine";
import { autoLoadsImages } from "../app/shell/remote-images.js";
import { senderCheckFact, senderCheckSentence } from "../app/shell/sender-check.js";
import { personalAt } from "../../../test/support/fixture-credentials.js";

/**
 * THE IDENTITY FACT ON EVERY SURFACE THAT NAMES A SENDER (mail 0148, acceptance 16): the list row's
 * chip, the guided first decision's name, the sentence's two forms, and the one default-read term
 * that keeps a marked message's pictures for a press. Each beside the unmarked control.
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
} as Record<string, string>)[key] ?? key;

/** A sender at the brand's own domain whose provider did not confirm it (`reason: "unverified"`). */
const UNVERIFIED = { reason: "unverified" as const, brand: "PayPal", domainShared: false };

/** The phish's sender: a fixture at a shared provider, whose address anyone can register. */
const PHISH = personalAt("fixture.mila", "gmail.com");

const message = (senderCheck: EngineMessage["senderCheck"]): Pick<EngineMessage, "from" | "senderCheck"> => ({
  from: { name: "PostFinance", address: PHISH }, senderCheck,
});

describe("the identity fact on the web", () => {
  it("the list row draws the chip first, with the sentence as its title and in what the row says", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(React.createElement(ThemeProvider, {
        storageKey: null,
        children: React.createElement(MessageRow, {
          id: "m1", from: "PostFinance", subject: "Bitte bestätigen",
          senderCheckLabel: "Not PostFinance", senderCheckTitle: "This message claims to be from PostFinance, but gmail.com isn't one of PostFinance's addresses.",
        } as never),
      }));
    });
    const chip = host.querySelector(".bdg-check");
    expect(chip?.textContent).toBe("Not PostFinance");
    expect(chip?.getAttribute("title")).toContain("This message claims to be from PostFinance");
    expect(host.querySelector("[aria-description]")?.getAttribute("aria-description")).toContain("This message claims to be from PostFinance");
  });

  it("the chip sits on the sender line after the name, before the address; the subject's line keeps its room", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(React.createElement(ThemeProvider, {
        storageKey: null,
        children: React.createElement(MessageRow, {
          id: "m3", from: "PostFinance", address: "kundendienst@karten-service.test", subject: "Bitte bestätigen", time: "09:12",
          senderCheckLabel: "Not PostFinance", senderCheckTitle: "This message claims to be from PostFinance.",
        } as never),
      }));
    });
    expect(host.querySelector(".row-top > .who + .bdg-check + .addr")?.textContent).toBe("kundendienst@karten-service.test");
    expect(host.querySelector(".row-mid .bdg-check")).toBeNull();
  });

  it("CONTROL: a row with no fact draws no chip", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(React.createElement(ThemeProvider, {
        storageKey: null, children: React.createElement(MessageRow, { id: "m2", from: "Anna", subject: "Hi" } as never),
      }));
    });
    expect(host.querySelector(".bdg-check")).toBeNull();
  });

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

  it("the guided first decision and every one-line name carry the claim with its denial", () => {
    const not = (brand: string) => `Not ${brand}`;
    expect(notifiedSenderName({ ...message({ reason: "impersonation", brand: "PostFinance", domainShared: true }) }, not))
      .toBe("PostFinance (Not PostFinance)");
    expect(notifiedSenderName({ from: { name: "PostFinance", address: personalAt("fixture.reto", "gmail.com") }, checked: { brand: "PostFinance" } }, not))
      .toBe("PostFinance (Not PostFinance)");
    expect(notifiedSenderName({ from: { name: "Anna", address: "a@firma.example" } }, not)).toBe("Anna");
  });

  it("the open message says the sentence under the sender's address; an unmarked one says nothing", async () => {
    process.env.NEXT_PUBLIC_API_BASE ??= "/api";
    const { MessagePane } = await import("../app/shell/MessagePane.js");
    const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
    const open = async (senderCheck: EngineMessage["senderCheck"], reason = "identity") => {
      const m = {
        id: "o1", accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: "Bitte bestätigen",
        from: { name: "PostFinance", address: PHISH }, to: [{ name: null, address: "me@firma.example" }], cc: [],
        date: "2026-10-07T09:00:00.000Z", folder: "ohmail/Screener", snippet: "", unread: true,
        hasAttachments: false, attachmentCount: 0,
        sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
        triage: null, labels: [], remoteContent: "none", updatedAt: "2026-10-07T09:00:00.000Z", senderCheck,
      };
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(React.createElement(NextIntlClientProvider, {
          locale: "en", messages: en, timeZone: "UTC", now: new Date("2026-10-07T12:00:00.000Z"),
          children: React.createElement(MessageChromeProvider as never, {
            value: {
              ownAddresses: [], replyTo: null, replyBody: { text: "", html: "" }, onReplyBody: () => {},
              closeReply: () => {}, sendReply: () => {}, replySendState: () => ({ phase: "idle" }),
              openSenderMenu: () => {}, conversationOf: () => [], hydrateBody: () => {}, hydrateThread: () => {},
              bodyOf: () => ({ text: "", state: "snippet", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
            },
            children: React.createElement(MessagePane as never, {
              message: m, tags: [], now: new Date("2026-10-07T12:00:00.000Z"),
              onAction: () => {}, onAddTag: () => {}, onAttachment: () => {},
            }),
          }),
        }));
      });
      const line = host.querySelector(`.msg-from > .msg-from-check[data-reason="${reason}"]`);
      if (line !== null) expect(line.querySelector("svg"), "the reader's line draws the shield").not.toBeNull();
      return line?.textContent ?? null;
    };
    expect(await open({ reason: "impersonation", brand: "PostFinance", domainShared: true }))
      .toBe("This message claims to be from PostFinance, but anyone can register a gmail.com address.");
    await act(async () => { root!.unmount(); });
    host!.remove();
    expect(await open(null)).toBeNull();
    await act(async () => { root!.unmount(); });
    host!.remove();
    // An unconfirmed sender at the brand's own domain: its own line, and never the claim's.
    expect(await open(UNVERIFIED, "unverified")).toBe("This message says it is from PayPal. Your mail provider did not confirm that.");
    expect(host!.querySelector('.msg-from-check[data-reason="identity"]')).toBeNull();
  });

  it("the sender sheet says the sentence, behind the shield, before any choice; an unmarked sender's says nothing", async () => {
    const { MemoryMirrorStore } = await import("@ohmail/client-engine");
    const { SenderMenu } = await import("../app/shell/SenderMenu.js");
    const { senderScreening } = await import("../app/shell/sender-screening.js");
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
  });

  it("a marked message's pictures wait for a press on an account that loads them on open", () => {
    expect(autoLoadsImages({ auto: true }, { senderCheck: { reason: "impersonation", brand: "UBS", domainShared: true } })).toBe(false);
    expect(autoLoadsImages({ auto: true }, { senderCheck: null })).toBe(true);
    expect(autoLoadsImages({ auto: false }, {})).toBe(false);
    expect(autoLoadsImages(undefined, {})).toBe(false);
  });

  it("an unconfirmed line holds nothing back: the pictures load as the account says", () => {
    expect(autoLoadsImages({ auto: true }, { senderCheck: UNVERIFIED })).toBe(true);
    expect(autoLoadsImages({ auto: false }, { senderCheck: UNVERIFIED })).toBe(false);
  });
});
