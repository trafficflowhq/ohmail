/**
 * ══ WHAT THE PHONE SAYS ABOUT A MAILBOX NOTHING COULD BE READ FROM ══════════════════════════
 *
 * The engine learned a third answer (`runtimes().connection[…].firstSync`); this is the app half —
 * the ranking, the two sentences, and the two surfaces that render them. Measured against a real
 * server in `apps/sidecar/test/phone-first-sync-unreadable.imap.test.ts`, which is where the state
 * itself is proved; nothing here re-derives it.
 *
 * ── THE TWO THINGS THIS FILE EXISTS FOR ───────────────────────────────────────────────────
 *
 *  1. `null` IS ITS OWN STATE, and so is a spelling this build has never heard of. The engine is a
 *     pre-bundled artifact and may be newer than the app: reading an unknown value as
 *     "nothing could be read" would put that sentence on somebody's screen over an engine that
 *     never claimed it, and reading it as `finished` would hide the state this lane exists for.
 *     Both collapse to "nothing has said", which is silent.
 *  2. THE OHBOX'S EMPTY STATE IS THE SURFACE THAT WAS LYING. Its hint said mail "lands here as it
 *     syncs" for a mailbox where nothing ever had — the same words a genuinely quiet mailbox gets.
 *     One key each, chosen by the verdict, asserted here as a census over the screen so a revert
 *     to a single hint is red rather than silent.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { firstSyncSay, firstSyncSaid } from "../src/state/live";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";

const OHBOX = fileURLToPath(new URL("../app/(tabs)/index.tsx", import.meta.url));
const PANEL = fileURLToPath(new URL("../app/settings.tsx", import.meta.url));

describe("the first-sync verdict", () => {
  it("reads the engine's three answers and nothing else", () => {
    expect(firstSyncSay({ firstSync: "pending" })).toBe("pending");
    expect(firstSyncSay({ firstSync: "finished" })).toBe("finished");
    expect(firstSyncSay({ firstSync: "produced_nothing_readable" })).toBe("nothingReadable");
  });

  it("answers `null` where nothing has said — a paired door, and a door with no cycle yet", () => {
    expect(firstSyncSay(null)).toBeNull();
    expect(firstSyncSay({ firstSync: null })).toBeNull();
  });

  it("answers `null` for a spelling this build does not know, never a guess", () => {
    // The engine is a pre-bundled artifact and can be newer than this app. Neither direction of
    // guessing is acceptable: see the header.
    expect(firstSyncSay({ firstSync: "some_future_state" })).toBeNull();
    expect(firstSyncSay({ firstSync: "" })).toBeNull();
  });
});

describe("the sentence", () => {
  it("is said for a mailbox nothing could be read from, and makes no claim about the link", () => {
    const said = firstSyncSaid("nothingReadable");
    expect(said).toBe(EN.firstSyncNothingReadable);
    expect(said).not.toBeNull();
    /* MEASURED: a server that signs you in and refuses to hand over the mail leaves the engine
       recording a dead connection too, so a sentence claiming the link is up would be false in
       exactly the arm this exists for. The link's own sentence is rendered beside it. */
    expect(said!.toLowerCase()).not.toMatch(/connected|reconnect|verbunden/);
  });

  it("is silent in every other state — the ordinary cases are admitted", () => {
    expect(firstSyncSaid("pending")).toBeNull();
    expect(firstSyncSaid("finished")).toBeNull();
    expect(firstSyncSaid(null)).toBeNull();
  });

  it("is in BOTH catalogues, and the German is not the English", () => {
    expect(EN.firstSyncNothingReadable.length).toBeGreaterThan(0);
    expect(DE.firstSyncNothingReadable.length).toBeGreaterThan(0);
    expect(DE.firstSyncNothingReadable).not.toBe(EN.firstSyncNothingReadable);
    expect(DE.ohboxEmptyNothingReadable).not.toBe(EN.ohboxEmptyNothingReadable);
  });
});

describe("the Ohbox tells `no mail` apart from `nothing readable yet`", () => {
  it("keeps two different hints, and the unreadable one promises no arrival", () => {
    expect(EN.ohboxEmptyNothingReadable).not.toBe(EN.ohboxEmptyHint);
    /* The ordinary hint's claim — mail "lands here as it syncs" — is the promise that was false.
       The other line must not carry it in either language. */
    expect(EN.ohboxEmptyHint).toMatch(/lands here/);
    expect(EN.ohboxEmptyNothingReadable).not.toMatch(/lands here/);
    expect(DE.ohboxEmptyHint).toMatch(/landen hier/);
    expect(DE.ohboxEmptyNothingReadable).not.toMatch(/lande[nt] hier/);
  });

  it("the screen chooses by the engine's verdict — a census, because nothing renders RN here", () => {
    // `test/unsaved-changes.test.ts` measured that this workspace has no React Native renderer, so
    // the choice cannot be driven. It is read off the source instead: both keys present, and the
    // verdict — not a timer, not `reachable` — is what selects between them.
    const src = readFileSync(OHBOX, "utf8");
    expect(src).toContain("Copy.ohboxEmptyNothingReadable");
    expect(src).toContain("Copy.ohboxEmptyHint");
    expect(src).toMatch(/boot\.firstSync\s*===\s*"nothingReadable"/);
  });

  it("the This-phone panel renders the sentence BESIDE the link's, never instead of it", () => {
    const src = readFileSync(PANEL, "utf8");
    expect(src).toMatch(/connectionSaid\(w\.boot\.connection\)/);
    expect(src).toMatch(/firstSyncSaid\(w\.boot\.firstSync\)/);
  });
});
