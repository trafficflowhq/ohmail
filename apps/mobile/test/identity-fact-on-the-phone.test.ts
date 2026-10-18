/**
 * THE IDENTITY FACT ON THE PHONE (mail 0148, acceptance 16): the row says the sentence before every
 * other badge, the copy twins carry both forms in both languages, and the German is du-form. The
 * phone reads the fact off the wire and holds no dictionary of its own.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryMirrorStore, OhmailEngine, type EngineMessage, type SyncChange } from "@ohmail/client-engine";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import type { Mail } from "../src/state/model";
import { liveMessage, liveScreener, presentedOf, type WorldView } from "../src/state/live";
import { rowBadgeFacts } from "../src/ui/row-spoken";
import { EN as en } from "../src/copy.en";
import { DE as de } from "../src/copy.de";

const ROW: Mail = {
  id: "m1", place: "ohbox", from: { name: "PostFinance", address: "kartenservice@freemail.example" },
  subject: "Bitte bestätigen", time: "09:12", body: "", unread: true, earlier: [],
} as unknown as Mail;

describe("the identity fact on the phone", () => {
  it("the row's first spoken fact is the sentence, for the shared-provider form", () => {
    const facts = rowBadgeFacts({ ...ROW, senderCheck: { brand: "PostFinance", domainShared: true, domain: "freemail.example" } });
    expect(facts[0]).toEqual({
      kind: "senderCheck", text: "This message claims to be from PostFinance, but anyone can register a freemail.example address.",
    });
  });

  it("says the address's own domain for an address at no shared provider", () => {
    const facts = rowBadgeFacts({ ...ROW, senderCheck: { brand: "PostFinance", domainShared: false, domain: "karten-service.example" } });
    expect(facts[0]).toEqual({
      kind: "senderCheck",
      text: "This message claims to be from PostFinance, but karten-service.example isn't one of PostFinance's addresses.",
    });
  });

  it("CONTROL: an unmarked row says no such fact", () => {
    expect(rowBadgeFacts(ROW).some((f) => f.kind === "senderCheck")).toBe(false);
  });

  it("the copy twins carry every sentence in both languages, the German addressing the reader as du", () => {
    expect(en.senderCheckChip("UBS")).toBe("Not UBS");
    expect(de.senderCheckChip("UBS")).toBe("Nicht UBS");
    const german = [
      de.senderCheckImpersonation("UBS", "ubs-sicherheit.example"), de.senderCheckImpersonationShared("UBS", "freemail.example"),
      de.screeningScopeShared("freemail.example"), de.rulesSharedProviderInert("freemail.example"),
    ];
    expect(german.filter((t) => /\b(Sie|Ihnen|Ihr|Ihre)\b/.test(t))).toEqual([]);
    expect(/\b(Sie|Ihnen|Ihr|Ihre)\b/.test("Entscheiden Sie pro Adresse.")).toBe(true);
  });
});

/**
 * AN UNCONFIRMED SENDER AT A BRAND'S OWN DOMAIN (`senderCheck.reason = "unverified"` on the wire): the
 * reader and the sender screen say the provider did not confirm it; the row draws no chip and speaks
 * nothing for it, and the pictures are not held, so it rides its own field and never `senderCheck`.
 */
describe("an unconfirmed brand sender on the phone", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const source = (rel: string) => withoutComments(fs.readFileSync(path.join(HERE, "..", rel), "utf8"));
  const view: WorldView = { now: new Date("2026-10-18T10:42:00Z"), zone: "UTC" };
  const date = "2026-10-18T10:30:00.000Z";
  const UNVERIFIED = { reason: "unverified" as const, brand: "PayPal", domainShared: false };
  const letter = (id: string, folder: string): EngineMessage => ({
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: "Your receipt", from: { name: "PayPal", address: "service@paypal.com" },
    to: [], cc: [], date, folder, snippet: "s", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date, senderCheck: UNVERIFIED,
  } as EngineMessage);
  async function mirrorOf(m: EngineMessage): Promise<MemoryMirrorStore> {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([{ type: "message", op: "create", id: m.id, seq: 1, updatedAt: date, entity: m } as SyncChange]);
    return store;
  }

  it("the copy says it in both languages, the German addressing the reader as du", () => {
    expect(en.senderCheckUnverified("PayPal")).toBe("This message says it is from PayPal. Your mail provider did not confirm that.");
    expect(de.senderCheckUnverified("PayPal")).toBe("Diese Nachricht gibt an, von PayPal zu kommen. Dein Mailanbieter hat das nicht bestätigt.");
    expect(/\b(Sie|Ihnen|Ihr|Ihre)\b/.test(de.senderCheckUnverified("PayPal"))).toBe(false);
  });

  it("the row speaks nothing for it: no chip is drawn, so none is said", () => {
    expect(rowBadgeFacts({ ...ROW, senderUnverified: { brand: "PayPal" } }).some((f) => f.kind === "senderCheck")).toBe(false);
  });

  it("the open message carries it as its own fact, never as the claim (the data half)", async () => {
    const store = await mirrorOf(letter("m-u", "INBOX"));
    const engine = new OhmailEngine({
      store, now: () => view.now,
      adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: date }),
        mutate: async () => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => null,
      },
    });
    const m = liveMessage(engine, "m-u", view);
    expect(m?.senderUnverified).toEqual({ brand: "PayPal" });
    expect(m?.senderCheck).toBeUndefined();
  });

  it("the waiting row carries it as its own fact, so the tab draws no chip (the data half)", async () => {
    const rows = liveScreener(presentedOf(await mirrorOf(letter("m-w", "ohmail/Screener")), view.now), view);
    expect(rows.waiting[0]?.unverified).toEqual({ brand: "PayPal" });
    expect(rows.waiting[0]?.checked).toBeUndefined();
  });

  it("the reader and the sender screen draw the sentence behind the shield", () => {
    expect(source("src/ui/MessageReader.tsx")).toMatch(/Copy\.senderCheckUnverified\(m\.senderUnverified\.brand\)/);
    expect(source("src/ui/SenderDetail.tsx")).toMatch(/Copy\.senderCheckUnverified\(row\.unverified\.brand\)/);
  });

  /* A GOVERNMENT'S UMBRELLA DOMAIN: the server names the domain (`admin.ch`), never the first office a
     dictionary lists under it. The phone maps no name of its own, so it must say exactly that one. */
  it("an umbrella domain's line says the domain the server names, in both languages", async () => {
    const BAG = { reason: "unverified" as const, brand: "admin.ch", domainShared: false };
    const bag = (id: string, folder: string): EngineMessage => ({
      ...letter(id, folder), from: { name: null, address: "info@bag.admin.ch" }, senderCheck: BAG,
    });
    expect(en.senderCheckUnverified("admin.ch")).toBe("This message says it is from admin.ch. Your mail provider did not confirm that.");
    expect(de.senderCheckUnverified("admin.ch")).toBe("Diese Nachricht gibt an, von admin.ch zu kommen. Dein Mailanbieter hat das nicht bestätigt.");
    const store = await mirrorOf(bag("m-b", "INBOX"));
    const engine = new OhmailEngine({
      store, now: () => view.now,
      adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: date }),
        mutate: async () => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => null,
      },
    });
    expect(liveMessage(engine, "m-b", view)?.senderUnverified).toEqual({ brand: "admin.ch" });
    const rows = liveScreener(presentedOf(await mirrorOf(bag("m-s", "ohmail/Screener")), view.now), view);
    expect(rows.waiting[0]?.unverified).toEqual({ brand: "admin.ch" });
  });
});
