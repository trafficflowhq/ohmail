/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { MemoryMirrorStore, type EngineMessage, type EngineMutation, type Folder, type SyncChange } from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { SenderMenu } from "../app/shell/SenderMenu";
import { dispatchScreeningChange, isOwnSubject, planScreeningChange, senderScreening } from "../app/shell/sender-screening";

/**
 * THE SENDER SHEET OFFERS NO SCREENING PRESS ON OUR OWN MAIL (SENDER-SHEET-OFFERED-ON-OUR-OWN-MAIL).
 * On the account's own Sent copy, or a sender among its addresses, the sheet says why in place of the
 * destinations and keeps only the ways onward; a chip naming somebody else on our Sent copy is that
 * person's sheet. A press the server refuses as `own_address` says the same sentence.
 */
const ME = "me@trafficflow.example";
const NOW = "2026-10-06T21:00:00.000Z";
let seq = 0;

function msg(id: string, folder: Folder, from: string, to: string[] = []): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `Note ${id}`,
    from: { name: null, address: from }, to: to.map((address) => ({ name: null, address })), cc: [], date: NOW, folder,
    snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW,
  };
}

async function mirror() {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    msg("sent-1", "Sent" as Folder, "alias@trafficflow.example", ["friend@example.com"]),
    msg("note-1", "INBOX", ME),
    msg("friend-1", "INBOX", "friend@example.com"),
    // A letter claiming our address that its provider failed, held at the gate.
    { ...msg("forged-1", "ohmail/Screener", ME), authVerdict: "fail" as const },
  ].map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW, entity: m })) as SyncChange[]);
  return store;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

async function sheet(messageId: string, own: boolean, locale: "en" | "de" = "en") {
  const store = await mirror();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(NextIntlClientProvider, {
      locale, messages: locale === "de" ? de : en,
      children: React.createElement(SenderMenu, {
        state: { messageId, x: 0, y: 0 } as never, sender: senderScreening(store, messageId)!, own,
        onChoose: () => undefined, onOpenDetail: () => undefined, onClose: () => undefined,
      }),
    }));
  });
  return host;
}

describe("the sender sheet on the account's own mail", () => {
  it("the subject is ours on our Sent copy and from our own address; a chip or a stranger is not", async () => {
    const r = await mirror();
    expect(isOwnSubject(r, "sent-1", undefined, [ME])).toBe(true);
    expect(isOwnSubject(r, "note-1", undefined, [ME])).toBe(true);
    expect(isOwnSubject(r, "sent-1", "friend@example.com", [ME])).toBe(false);
    expect(isOwnSubject(r, "friend-1", undefined, [ME])).toBe(false);
  });

  for (const locale of ["en", "de"] as const) {
    it(`says why in place of the destinations, and keeps the ways onward (${locale})`, async () => {
      const el = await sheet("note-1", true, locale);
      expect(el.querySelectorAll("[data-dest]")).toHaveLength(0);
      expect(el.querySelector(".sm-rule")).toBeNull();
      expect(el.querySelector(".sm-now")!.textContent).toBe((locale === "de" ? de : en).screening.toastOwnAddress);
      expect(el.querySelectorAll(".sm-links .sm-detail")).toHaveLength(2);
    });
  }

  for (const locale of ["en", "de"] as const) {
    it(`on a letter claiming our address that its provider failed, the check is said instead, still with no press (${locale})`, async () => {
      const el = await sheet("forged-1", true, locale);
      expect(el.querySelectorAll("[data-dest]")).toHaveLength(0);
      expect(el.querySelector(".sm-rule")).toBeNull();
      expect(el.querySelector(".sm-now")).toBeNull();
      const words = (locale === "de" ? de : en).screener.senderCheck.failed.replace("{address}", ME);
      expect(el.querySelector('.sm-check[data-reason="failed"]')!.textContent).toBe(words);
    });
  }

  it("somebody else's sheet offers the five destinations (the positive control)", async () => {
    const el = await sheet("friend-1", false);
    expect(el.querySelectorAll("[data-dest]")).toHaveLength(5);
  });

  it("a press the server refuses as own_address says that sentence, any other refusal its own", async () => {
    const r = await mirror();
    const plan = planScreeningChange(senderScreening(r, "friend-1")!, "screened", "sender", true, true);
    const refusing = (code: string) => async (_m: EngineMutation) => ({ status: "rolled_back" as const, error: { code } });
    expect(await dispatchScreeningChange(plan, [], refusing("own_address"))).toBe("toastOwnAddress");
    expect(await dispatchScreeningChange(plan, [], refusing("validation_failed"))).toBe("toastRuleFailed");
  });

  it("a refusal beside moves already made keeps the sentence that says what moved", async () => {
    const r = await mirror();
    const plan = planScreeningChange(senderScreening(r, "friend-1")!, "screened", "sender", true, true);
    const moved = { kind: "move" as const, messageId: "friend-1", folder: "ohmail/Screened" as Folder };
    const mutate = async (m: EngineMutation) => (m.kind === "move"
      ? { status: "confirmed" as const }
      : { status: "rolled_back" as const, error: { code: "own_address" } });
    expect(await dispatchScreeningChange(plan, [moved], mutate)).toBe("toastRuleFailed");
  });
});

describe("the web's own addresses are the server's", () => {
  it("leave out a mailbox the server does not count as own; a row without the field counts", async () => {
    const { ownAddressesOf } = await import("../app/shell/mail-state");
    expect(ownAddressesOf([
      { address: "live@own.invalid", addressIsOwn: true },
      { address: "removed@own.invalid", addressIsOwn: false },
      { address: "older@own.invalid" },
    ])).toEqual(["live@own.invalid", "older@own.invalid"]);
  });
});

describe("the hosted mapper carries the server's own-address answer", () => {
  it("`false` survives the narrowing, and an absent field stays absent", async () => {
    const { toMailboxFacts } = await import("../app/(product)/mailbox/mailbox-facts");
    const row = { id: "mb", address: "removed@own.invalid", status: "disabled", errorCode: null, disabledReason: null } as never;
    expect(toMailboxFacts({ ...(row as object), addressIsOwn: false } as never).addressIsOwn).toBe(false);
    expect("addressIsOwn" in toMailboxFacts(row)).toBe(false);
  });
});
