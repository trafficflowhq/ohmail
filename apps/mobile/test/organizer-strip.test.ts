/**
 * THE OHBOX'S ORGANIZER STRIP — what the list says about this phone's claim, and where it says
 * nothing. The strip is the Settings card's own derivation (`claimHere`) worded with the card's
 * own label and note; these cases hold which arms draw and which verb they carry.
 */
import { describe, expect, it, vi } from "vitest";

import { DECKS } from "../src/copy";
import { DE } from "../src/copy.de";
import { EN } from "../src/copy.en";
import { answerGapLetters, readMailboxes } from "../src/net/mailboxes";
import { CLAIM_LAPSES_AFTER_MINUTES } from "../src/engine/standalone-door";
import { gapOffersOf, organizerStripOf } from "../src/ui/organizer-strip";
import { claimHere } from "../src/ui/standalone-form";

const facts = { stoppedHere: false, late: false, os: "android" } as const;
const here = (over: Partial<Parameters<typeof claimHere>[0]> = {}) => ({
  organizing: false, releaseRequestedAt: null, heldBy: null, ...over,
});

describe("the Ohbox strip follows the Settings card's claim", () => {
  it("HANDED BACK: the card's label and note, and no verb — the next foreground takes it again", () => {
    const strip = organizerStripOf(claimHere(here(), "idle", true), facts);
    expect(strip).toEqual({
      label: EN.phoneStateHandedBack, note: EN.phoneStateHandedBackWhy, late: null, start: false,
    });
  });

  it("HANDED BACK, LATE: the late hand-back is said beside it", () => {
    const strip = organizerStripOf(claimHere(here(), "idle", true), { ...facts, late: true });
    expect(strip?.label).toBe(EN.phoneStateHandedBack);
    expect(strip?.late).toBe(EN.organizerHandBackLate(CLAIM_LAPSES_AFTER_MINUTES));
  });

  it("FREE WITH A CONSENT ON RECORD (a stop here, or a refused press): the offer, with Settings' start verb", () => {
    const strip = organizerStripOf(claimHere(here(), "idle", false), { ...facts, stoppedHere: true });
    expect(strip).toEqual({ label: EN.phoneFreeOffer, note: null, late: null, start: true });
    expect(EN.phoneFreeOffer).toBe("Nothing organizes this mailbox now. Organize it from this phone while ohmail is running on it?");
  });

  /* THE OFFER, AGAINST THE PLATFORM LINES THE SAME DECK SHIPS (the send-later sentence's shape). One
     sentence covers both phones, so it may not borrow the iPhone's "while ohmail is open": Android
     keeps organizing behind its notification after ohmail leaves the screen. */
  it("THE OFFER is in both decks and says nothing the platform lines make false", () => {
    const en = DECKS.en.phoneFreeOffer;
    const de = DECKS.de.phoneFreeOffer;
    expect(de, "the German deck carries the English sentence").not.toBe(en);
    expect(DECKS.en.phoneStandaloneL1Ios, "the iOS line no longer says what this guard is derived from")
      .toContain("while ohmail is open");
    expect(en, "the offer claims the iOS rule on every platform").not.toContain("while ohmail is open");
    expect(DECKS.de.phoneStandaloneL1Ios, "the German iOS line moved").toContain("solange ohmail geöffnet");
    expect(de, "the German offer claims the iOS rule").not.toMatch(/solange ohmail (offen|geöffnet)/);
  });

  it("FREE WITH NO CONSENT ON RECORD draws nothing — nobody is invited to start what they never started", () => {
    expect(organizerStripOf(claimHere(here(), "idle", false), facts)).toBeNull();
  });

  it("a start in flight keeps its word and offers no second press", () => {
    const strip = organizerStripOf(claimHere(here(), "starting", false), { ...facts, stoppedHere: true });
    expect(strip).toMatchObject({ label: EN.phoneStateStarting, start: false });
  });

  it("HELD ELSEWHERE: the holder is named, with the reader's sentence", () => {
    const strip = organizerStripOf(claimHere(here({
      heldBy: { name: "Mila's laptop", standDownReason: "organized_elsewhere:local", holderState: "held" },
    })), facts);
    expect(strip).toEqual({
      label: EN.phoneStateReader("Mila's laptop"), note: EN.phoneStateReaderWhy("Mila's laptop"),
      late: null, start: false,
    });
    const unnamed = organizerStripOf(claimHere(here({
      heldBy: { name: "", standDownReason: "organized_elsewhere:mobile", holderState: null },
    })), facts);
    expect(unnamed?.note).toBe(EN.phoneStateReaderWhyUnnamedPhone);
  });

  it("A STOP NOT YET HONOURED is said; our own claim otherwise draws nothing", () => {
    const pending = organizerStripOf(claimHere(here({
      organizing: true, releaseRequestedAt: "2026-09-26T20:00:00.000Z",
    })), facts);
    expect(pending).toMatchObject({ label: EN.phoneStateStopPending, note: EN.phoneStateStopPendingWhy });
    expect(organizerStripOf(claimHere(here({ organizing: true })), facts)).toBeNull();
    /* `ours` outranks a hand-back flag that has not been cleared yet: the gate claimed. */
    expect(organizerStripOf(claimHere(here({ organizing: true }), "idle", true), facts)).toBeNull();
  });

  it("NOT READ YET draws nothing", () => {
    expect(organizerStripOf(claimHere(here({ organizing: null })), facts)).toBeNull();
  });
});

describe("the gap offer on the list (mail 0151)", () => {
  const row = (o: { role: "organizer" | "reader" | null; gap?: number | null }) => ({
    id: `mb-${o.role}-${o.gap}`, address: "me@example.test", organizerRole: o.role, gapLetters: o.gap,
  });
  it("offers a positive count on a mailbox this phone organizes, and nothing else", () => {
    expect(gapOffersOf([row({ role: "organizer", gap: 3 })]))
      .toEqual([{ id: "mb-organizer-3", address: "me@example.test", count: 3, strangers: 0 }]);
    expect(gapOffersOf([
      row({ role: "reader", gap: 3 }), row({ role: null, gap: 3 }),
      row({ role: "organizer", gap: 0 }), row({ role: "organizer", gap: null }), row({ role: "organizer" }),
    ])).toEqual([]);
  });
  it("says the count and asks, in both decks", () => {
    expect(EN.gapLetters(2, "a@b.test")).toBe("2 letters arrived in a@b.test while no device was organizing it. File them by your rules?");
    expect(EN.gapLetters(1, "a@b.test")).toContain("File it by your rules?");
  });
});

describe("the gap offer's strangers on the phone (mail 0158)", () => {
  const session = (rows: unknown[], sent: unknown[] = []) => ({
    profile: { origin: "https://srv.test", accountId: "a" },
    fetch: vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body !== undefined) sent.push(JSON.parse(String(init.body)));
      return { status: init?.method === "POST" ? 202 : 200, json: async () => ({ items: rows }) } as unknown as Response;
    }),
  }) as never;

  it("reads a strangers-only offer, whose rules' count is 0, and keeps both counts", async () => {
    const rows = await readMailboxes(session([
      { id: "m1", address: "a@own.test", organizerRole: "organizer", gapLetters: 0, gapStrangers: 2 },
      { id: "m2", address: "b@own.test", organizerRole: "organizer", gapLetters: 1 },
      { id: "m3", address: "c@own.test", organizerRole: "organizer", gapLetters: -1, gapStrangers: "2" },
    ]));
    expect(rows!.map((r) => [r.gapLetters, r.gapStrangers])).toEqual([[0, 2], [1, undefined], [undefined, undefined]]);
    expect(gapOffersOf(rows!)).toEqual([
      { id: "m1", address: "a@own.test", count: 0, strangers: 2 },
      { id: "m2", address: "b@own.test", count: 1, strangers: 0 },
    ]);
  });

  it("offers strangers beside the rules' letters, and nothing for an empty pair", () => {
    const at = (gapLetters: number | null, gapStrangers?: number | null) =>
      ({ id: `m-${gapLetters}-${gapStrangers}`, address: "me@example.test", organizerRole: "organizer", gapLetters, gapStrangers });
    expect(gapOffersOf([at(0, 3), at(2, 1), at(0, 0), at(null, 2)]).map((o) => [o.count, o.strangers])).toEqual([[0, 3], [2, 1]]);
  });

  it("the press carries the stranger count", async () => {
    const sent: unknown[] = [];
    expect(await answerGapLetters(session([], sent), "m1", { file: true, count: 0, strangers: 2 })).toBe("pressed");
    expect(sent).toEqual([{ file: true, count: 0, strangers: 2 }]);
  });

  it("names the Screener for strangers, never the rules, in both decks", () => {
    expect(EN.gapStrangers(2, "a@b.test")).toBe(
      "2 letters from senders you have not decided about arrived in a@b.test while no device was organizing it. Put them in the Screener?");
    expect(EN.gapStrangers(1, "a@b.test")).not.toMatch(/rules/);
    expect(EN.gapBoth(1, 2, "a@b.test")).toMatch(/^1 letter for your rules and 2 from senders you have not decided about arrived in a@b\.test/);
    expect(DE.gapStrangers(1, "a@b.test")).toContain("In den Screener legen?");
    expect(DE.gapBoth(2, 1, "a@b.test")).toMatch(/^2 Mails für deine Regeln und 1 von einem Absender, über den du nie entschieden hast,/);
    expect(typeof EN.gapScreen).toBe("string");
    expect(typeof DE.gapScreen).toBe("string");
  });
});
