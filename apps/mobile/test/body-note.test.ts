import { describe, expect, it } from "vitest";
import { Copy } from "../src/copy";
import { MemoryMirrorStore, OhmailEngine, isJunkHuskLeaving, type EngineMessage, type SyncChange } from "@ohmail/client-engine";
import { junkLeaving, mailboxStatusOf, withheldNote } from "../src/ui/body-note";
import { liveBody } from "../src/state/live";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DE } from "../src/copy.de";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * THE PHONE'S WITHHELD SENTENCE, PER MARKER (FIX-023). It said the storage space was full over
 * every withheld body — a spam verdict's husk included — and, like the web reader, it named the
 * verdict for a message the person had already moved out of Junk. The rule is the engine's
 * (`isJunkHuskLeaving`) read off the row's physical folder; the sentences are the web reader's.
 */
const row = (folder: string, bodyWithheld: "storage_cap" | "junk_filed" | "expunged" | "too_large") => ({
  bodyState: "withheld" as const, bodyWithheld,
  // What the state layer computes (`live.ts#toMail`), through the engine's own decision.
  ...(isJunkHuskLeaving({ state: "withheld", withheld: bodyWithheld }, folder) ? { bodyJunkLeaving: true as const } : {}),
});

describe("the phone's withheld note", () => {
  it("a verdict's husk in the spam pile names the verdict", () => {
    expect(withheldNote(row("ohmail/Quarantine", "junk_filed"), false, null)).toBe(Copy.liveBodyWithheldJunk);
    expect(junkLeaving(row("ohmail/Quarantine", "junk_filed"))).toBe(false);
  });

  it("moved out of Junk it is loading, then the bounded failure — never the verdict", () => {
    const moved = row("INBOX", "junk_filed");
    expect(junkLeaving(moved)).toBe(true);
    expect(withheldNote(moved, false, null)).toBe(Copy.liveBodyJunkLoading);
    expect(withheldNote(moved, true, null)).toBe(Copy.liveBodyFailed);
  });

  it("each other marker keeps its own sentence — the storage cap's is no longer said for them", () => {
    expect(withheldNote(row("INBOX", "expunged"), false, null)).toBe(Copy.liveBodyWithheldExpunged);
    expect(withheldNote(row("INBOX", "storage_cap"), false, null)).toBe(Copy.liveBodyWithheld);
    expect(Copy.liveBodyWithheld).toContain("storage space");
    expect(Copy.liveBodyWithheld).toContain("When there is room again, ohmail fetches this text back from your mail server.");
    expect(Copy.liveBodyWithheldJunk).not.toContain("storage space");
  });

  it("emptied for space in a mailbox ohmail no longer reads, the text does not come back", () => {
    const capped = row("INBOX", "storage_cap");
    expect(withheldNote(capped, false, "disabled")).toBe(Copy.liveBodyWithheldRemoved);
    expect(Copy.liveBodyWithheldRemoved).toContain("storage space");
    expect(Copy.liveBodyWithheldRemoved).toContain("ohmail no longer reads this mailbox, so this text does not come back here.");
    expect(DE.liveBodyWithheldRemoved).toContain("ohmail liest dieses Postfach nicht mehr, darum kommt dieser Text hier nicht zurück.");
    for (const status of ["connected", "error", null]) expect(withheldNote(capped, false, status)).toBe(Copy.liveBodyWithheld);
    expect(withheldNote(row("INBOX", "expunged"), false, "disabled")).toBe(Copy.liveBodyWithheldExpunged);
  });

  it("the sender sheet reads the letter's mailbox through its body", async () => {
    const at = "2026-10-25T09:00:00.000Z";
    const store = new MemoryMirrorStore();
    await store.load();
    const m = {
      id: "m1", accountId: "acct", mailboxId: "mb_gone", threadId: null, messageIdHeader: null, subject: "Old",
      from: { name: null, address: "a@sender.test" }, to: [], cc: [], date: at, folder: "INBOX", snippet: "old",
      unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [],
      remoteContent: "none", updatedAt: at,
    } as unknown as EngineMessage;
    await store.applyChanges([{ type: "message", op: "create", id: "m1", seq: 1, updatedAt: at, entity: m } as SyncChange]);
    const engine = new OhmailEngine({
      store, now: () => new Date(at),
      adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: at }),
        mutate: async () => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => ({
          text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header" as const, unsubscribeUrl: null,
          withheld: "storage_cap" as const,
        }),
      },
    });
    await engine.hydrateBody("m1");
    const h = { id: "m1", ...liveBody(engine, "m1")! };
    const rows = [{ id: "mb_1", status: "connected" }, { id: "mb_gone", status: "disabled" }];
    expect(withheldNote(h, true, mailboxStatusOf(rows, h.mailboxId))).toBe(Copy.liveBodyWithheldRemoved);
    expect(mailboxStatusOf(rows, "mb_other")).toBeNull();
    expect(mailboxStatusOf(rows, undefined)).toBeNull();
  });

  it("a message over the download ceiling says the web reader's sentence, in both languages", () => {
    // The web test ties that sentence to the ceiling's constant; this ties the phone to the web.
    const web = (locale: string): Record<string, string> => (JSON.parse(fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../webapp/messages", `${locale}.json`), "utf8",
    )) as { body: Record<string, string> }).body;
    expect(withheldNote(row("INBOX", "too_large"), false, null)).toBe(Copy.liveBodyWithheldTooLarge);
    expect(Copy.liveBodyWithheldTooLarge).toBe(web("en").withheldTooLarge);
    expect(DE.liveBodyWithheldTooLarge).toBe(web("de").withheldTooLarge);
  });
});

/**
 * EVERY SURFACE TAKES ITS WITHHELD SENTENCE FROM `withheldNote`. The sender sheet and the Reads card
 * picked one themselves and said the storage cap's reason over a spam verdict's husk and an expunged
 * message. A census of the source (comments blanked): only the note's own module names a sentence.
 */
describe("no surface picks a withheld sentence itself", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const walk = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir)).flatMap((f) => {
    const rel = path.join(dir, f);
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) return walk(rel);
    return /\.tsx?$/.test(f) ? [rel] : [];
  });
  const sources = [...walk("src"), ...walk("app")]
    .filter((f) => !/^src\/copy(\.[a-z]+)?\.ts$/.test(f) && f !== "src/ui/body-note.ts");

  it("names no withheld sentence outside body-note.ts, and every surface that draws one calls it", () => {
    const naming = sources.filter((f) => /Copy\.liveBodyWithheld/.test(withoutComments(fs.readFileSync(path.join(ROOT, f), "utf8"))));
    expect(naming).toEqual([]);
    const drawing = sources.filter((f) => /bodyState === "withheld"/.test(withoutComments(fs.readFileSync(path.join(ROOT, f), "utf8"))));
    expect(drawing.length).toBeGreaterThan(0);
    for (const f of drawing) expect(fs.readFileSync(path.join(ROOT, f), "utf8"), f).toMatch(/withheldNote\(/);
  });
});
