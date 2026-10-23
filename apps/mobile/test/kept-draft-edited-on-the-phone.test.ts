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
    expect(keepAct({ phase: "idle", worth, files: 0, armed: false })).toBe("keep");
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
    const effect = SHEET.slice(SHEET.indexOf("const timer = setTimeout(() => {"), SHEET.indexOf("}, DRAFT_AUTOSAVE_MS);"));
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
