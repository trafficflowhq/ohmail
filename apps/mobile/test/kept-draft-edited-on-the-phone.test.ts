/**
 * A DRAFT KEPT FROM A REMOVED MAILBOX, EDITED ON THE PHONE, LOSES NO WORDS.
 *
 * Measured at the base: the sheet's autosave marked the screen saved BEFORE its keep answered, so
 * a refused keep (the removed mailbox's 400) left nothing to keep at the close and the sheet
 * closed without a word; Send then failed from the removed address with no other sender offered.
 *
 * The decisions live in `src/ui/compose-keep.ts` and `src/ui/compose-sender.ts` (no React Native
 * renderer here) and the sheet is READ to prove it takes them. Mutations: mark `saved` before the
 * keep in `autosaveKeep`, or answer the bound mailbox in `composeSenderOf` for a disabled row, and
 * a case below goes red.
 */
/* @reads: apps/mobile/src/ui/MessageActions.tsx */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions } from "../src/state/live";
import { openLetterKeeper } from "../src/compose/letter-keeper";
import { sweepLetters } from "../src/compose/letter-restore";
import { letterDoor } from "../src/compose/letter-store";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";
import { autosaveKeep, keepAct } from "../src/ui/compose-keep";
import { composeSenderOf } from "../src/ui/compose-sender";
import { DE } from "../src/copy.de";
import { EN } from "../src/copy.en";

const SHEET = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/ui/MessageActions.tsx"), "utf8");

describe("the autosave marks the screen saved only once the keep answered kept", () => {
  it("a refused keep leaves the words unsaved, so the close keeps them and can say it failed", async () => {
    const saved = { current: "[\"before\"]" };
    await autosaveKeep(saved, "[\"after\"]", async () => "refused");
    expect(saved.current).toBe("[\"before\"]");
    const worth = saved.current !== "[\"after\"]";
    expect(keepAct({ phase: "idle", worth, filesOver: 0, armed: false })).toBe("keep");
  });

  it("a kept save marks exactly what was on screen when it left", async () => {
    const saved = { current: "[\"before\"]" };
    let answer!: (v: "kept") => void;
    const pending = autosaveKeep(saved, "[\"after\"]", () => new Promise((r) => { answer = r; }));
    expect(saved.current, "marked saved before the keep answered").toBe("[\"before\"]");
    answer("kept");
    await pending;
    expect(saved.current).toBe("[\"after\"]");
  });

  it("the sheet's autosave goes through it and marks nothing itself", () => {
    const effect = SHEET.slice(SHEET.indexOf("quietSave.current = () => {"), SHEET.indexOf("}, DRAFT_AUTOSAVE_MS);"));
    expect(effect).toContain("autosaveKeep(saved, onScreen,");
    expect(SHEET).not.toMatch(/saved\.current = onScreen/);
  });
});

describe("a bound draft whose mailbox cannot send leaves from one that can, and says so", () => {
  const rows = [
    { id: "a", address: "me@a.test", status: "active" },
    { id: "b", address: "me@b.test", status: "disabled" },
  ];

  it("a sendable mailbox is kept as it is", () => {
    expect(composeSenderOf({ bound: "a", fallback: "a", known: true, rows }))
      .toEqual({ sendFrom: "a", substituted: false, was: null });
  });

  it("a disabled mailbox is replaced by the fallback when it can send, naming the old address", () => {
    expect(composeSenderOf({ bound: "b", fallback: "a", known: true, rows }))
      .toEqual({ sendFrom: "a", substituted: true, was: "me@b.test" });
  });

  it("a mailbox no longer listed is replaced by the first that can send, with no address to name", () => {
    expect(composeSenderOf({ bound: "gone", fallback: "b", known: true, rows }))
      .toEqual({ sendFrom: "a", substituted: true, was: null });
  });

  it("the same address on a sendable row is the same identity, taken without a word", () => {
    const same = [...rows, { id: "b2", address: "ME@b.test", status: null }];
    expect(composeSenderOf({ bound: "b", fallback: "a", known: true, rows: same }))
      .toEqual({ sendFrom: "b2", substituted: false, was: null });
  });

  it("an unread roster, or one with nothing that can send, changes nothing", () => {
    expect(composeSenderOf({ bound: "b", fallback: "a", known: false, rows: [] }))
      .toEqual({ sendFrom: "b", substituted: false, was: null });
    expect(composeSenderOf({ bound: "b", fallback: "a", known: true, rows: [rows[1]!] }))
      .toEqual({ sendFrom: "b", substituted: false, was: null });
  });

  it("the sheet sends a new mail from that sender, keeps the row's own, and says the change", () => {
    expect(SHEET).toContain("composeSenderOf({");
    expect(SHEET).toMatch(/w\.actions\.sendNew\(sendFrom,/);
    expect(SHEET).toContain("sender.was !== null ? Copy.composeFromSubstituted(sender.was) : Copy.composeFromSubstitutedUnknown");
    // Keeps name the row's own mailbox (a save is no move), never the substitute.
    expect(SHEET).not.toMatch(/draftKeep\(\{[^}]*mailboxId: sendFrom/);
  });

  it("the sentence exists in both languages, with and without the old address", () => {
    for (const deck of [EN, DE]) {
      expect(deck.composeFromSubstituted("me@b.test")).toContain("me@b.test");
      expect(deck.composeFromSubstitutedUnknown.length).toBeGreaterThan(0);
    }
  });
});

describe("a kept draft's files stay on the phone with it", () => {
  const world = sqlWorld();
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const PDF = Buffer.alloc(64, 3).toString("base64");
  const ROW = { mailboxId: "mb-1", subject: "Plans", to: [{ name: null, address: "peer@fake.test" }], cc: [], bcc: [], status: "draft" };

  async function scene() {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addMessage(dto("m1", { subject: "Welcome" }));
    // d-7 is held: its first send could not be confirmed.
    for (const id of ["d-7", "d-8", "d-9"]) fake.addDraft({ id, ...ROW, body: `Words of ${id}`, ...(id === "d-7" ? { status: "unverified" } : {}) });
    const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };
    const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
    if (boot.kind !== "ready") throw new Error("boot refused");
    await boot.verifyIdentity();
    await boot.engine.start();
    await boot.engine.syncOnce();
    const letters = letterDoor(boot.store);
    const actions = liveActions({ engine: boot.engine, toast: (m) => void sayArg(m), uuid, zone: "UTC", letters });
    /** A letter kept as draft `id` with one file, as a close leaves it. */
    const keptWith = (id: string) => {
      const k = openLetterKeeper({
        door: letters, id: uuid(), newFileId: uuid, draftId: id, savedAs: null,
        words: { mode: "new", messageId: null, mailboxId: "mb-1", to: "peer@fake.test", cc: "", bcc: "", subject: "Plans", body: `Words of ${id}`, envelope: null },
      });
      k.addFile({ filename: "plan.pdf", contentType: "application/pdf", contentBase64: PDF, sizeBytes: 64 });
      k.markKeep();
      k.keepAnswered({ draftId: id, key: null });
      k.release();
    };
    return { fake, boot, letters, actions, keptWith };
  }

  it("reopening brings the files, Send again carries them, and they go once it is sent", async () => {
    const s = await scene();
    s.keptWith("d-7");
    expect(s.letters.filesOf("d-7").map((f) => [f.filename, f.contentBase64])).toEqual([["plan.pdf", PDF]]);
    expect(await s.actions.draftSendAgain("d-7")).toBe("sent");
    expect(s.fake.seen.filter((r) => r.url.startsWith("/drafts/d-7")).map((r) => `${r.method} ${r.url}`))
      .toEqual(["POST /drafts/d-7/send"]);
    const send = s.fake.seen.find((r) => r.method === "POST" && r.url === "/drafts/d-7/send")!;
    expect(JSON.parse(send.body) as { again?: boolean; attachments?: Array<{ filename: string; contentBase64: string }> })
      .toEqual({ again: true, attachments: [{ filename: "plan.pdf", contentType: "application/pdf", contentBase64: PDF }] });
    expect(s.letters.filesOf("d-7")).toEqual([]);
    s.boot.store.close();
    s.fake.server.close();
  }, 30_000);

  it("a draft sent on another device, or discarded here, takes its files with it", async () => {
    const s = await scene();
    s.keptWith("d-8");
    s.keptWith("d-9");
    s.fake.sendElsewhere("d-8");
    await s.boot.engine.syncOnce();
    sweepLetters(s.letters, new Set(), s.actions.draftLeft);
    expect(s.letters.filesOf("d-8")).toEqual([]);
    expect(s.letters.filesOf("d-9"), "a draft still in Drafts lost its files").toHaveLength(1);
    expect(await s.actions.draftDiscard("d-9")).toBe("discarded");
    expect(s.letters.letters()).toEqual([]);
    s.boot.store.close();
    s.fake.server.close();
  }, 30_000);
});
