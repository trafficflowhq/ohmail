/**
 * THE SENT-MAIL REVIEW ON THE PHONE — the web's `seed-review.test.ts` cases over the phone's
 * decisions (`src/ui/seed-review.ts`) and its words, in English and German: the people and the
 * count before anything is written, what the press moves, the filter's disclosed removals, exactly
 * the ticked people posted under a key, the ticks kept through a refusal, a bulk press that reaches
 * only who is shown, and no decision over zero people.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Copy } from "../src/copy";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { seedReviewOf, type SeedReview } from "../src/net/consent";
import {
  actionableOf, bulkOffered, confirmFailureSaid, excludedSaid, initialTicks, nothingToDecide, pressConfirm, setShown,
  shownOf, toggled,
} from "../src/ui/seed-review";

const REVIEW: SeedReview = {
  candidates: [
    { address: "lena@atelier.example", name: "Lena Roth", messages: 12, lastWrittenAt: null, alreadyDecided: false },
    { address: "ben@studio.example", name: null, messages: 3, lastWrittenAt: null, alreadyDecided: false },
    { address: "old@studio.example", name: null, messages: 1, lastWrittenAt: null, alreadyDecided: true },
  ],
  excluded: [
    { address: "no-reply@bank.example", reason: "robot-recipient" },
    { address: "me@own.example", reason: "own-address" },
  ],
  scannedMessages: 582,
  truncated: false,
};

/** A door that records each POST and answers `status` — a 500 with an HTML body, as a dead host does. */
function door(status = 200) {
  const posted: Array<{ body: unknown; key: string | null }> = [];
  let answer = status;
  return {
    posted,
    answer: (s: number) => { answer = s; },
    session: {
      profile: { origin: "http://door.test", apiBase: null },
      fetch: async (_url: string, init?: unknown): Promise<Response> => {
        const i = init as RequestInit;
        posted.push({ body: JSON.parse(String(i.body)), key: new Headers(i.headers).get("Idempotency-Key") });
        return answer === 200
          ? new Response(JSON.stringify({ rulesCreated: 1, contactsCreated: 1 }), { status: 200 })
          : new Response("<html>upstream said no</html>", { status: answer, headers: { "content-type": "text/html" } });
      },
    },
  };
}

afterEach(() => { resetLocaleRegisterForTests(); });

describe("the sent-mail review on the phone", () => {
  it("names the people and the count before writing anything; everyone undecided starts ticked", () => {
    expect(Copy.seedTitle(REVIEW.candidates.length)).toBe("You've written to 3 people.");
    expect([...initialTicks(REVIEW)]).toEqual(["lena@atelier.example", "ben@studio.example"]);
    expect(Copy.seedConfirm(2)).toBe("Let 2 people through");
    setActiveLocale("de");
    expect(Copy.seedTitle(3)).toBe("Du hast 3 Leuten geschrieben.");
    expect(Copy.seedConfirm(1)).toBe("1 Person durchlassen");
  });

  it("says exactly what moves, before the button is pressed", () => {
    expect(Copy.seedWillDo(2)).toContain("waiting in the Screener moves to your Ohbox");
    expect(Copy.seedWillDo(2)).toContain("stays where your mail server has it");
    setActiveLocale("de");
    expect(Copy.seedWillDo(1)).toContain("Was von ihnen im Screener wartet, kommt in deine Ohbox");
  });

  it("discloses what the robot filter removed, and why; a capped scan says so", () => {
    expect(Copy.seedExcludedSummary(REVIEW.excluded.length)).toBe("2 addresses were left out");
    expect(REVIEW.excluded.map((e) => excludedSaid(e.reason))).toEqual(["looks like a machine address", "one of your own addresses"]);
    expect(Copy.seedTruncated(5000)).toContain("5000 most recent sent messages");
    setActiveLocale("de");
    expect(excludedSaid("machine-sent")).toBe("in einer automatischen Antwort von dir gefunden");
  });

  it("drops what the wire did not fully describe", () => {
    const read = seedReviewOf({
      ...REVIEW,
      candidates: [...REVIEW.candidates, { address: 7 }, { address: "x@y.example", messages: "1", alreadyDecided: false }],
      excluded: [...REVIEW.excluded, { address: "z@y.example", reason: "invented" }],
    });
    expect(read).toEqual(REVIEW);
    expect(seedReviewOf({ nope: true })).toBeNull();
  });

  it("posts exactly what is ticked — once, with a key — and never someone already decided", async () => {
    const d = door();
    const ticks = toggled(new Set([...initialTicks(REVIEW), "old@studio.example"]), "ben@studio.example");
    expect(await pressConfirm(d.session, REVIEW, ticks, "press-1")).toBeNull();
    expect(d.posted).toEqual([{ body: { addresses: ["lena@atelier.example"] }, key: "press-1" }]);
  });

  it("keeps every tick when the confirm fails, and sends the same list on the retry under a new key", async () => {
    const d = door(500);
    const ticks = toggled(initialTicks(REVIEW), "ben@studio.example");
    const failed = await pressConfirm(d.session, REVIEW, ticks, "press-1");
    expect(failed).toEqual({ state: "ready", review: REVIEW, error: undefined });
    expect(confirmFailureSaid(undefined)).toContain("Your ticks are still here");
    expect([...ticks]).toEqual(["lena@atelier.example"]);
    d.answer(200);
    expect(await pressConfirm(d.session, REVIEW, ticks, "press-2")).toBeNull();
    expect(d.posted.map((p) => p.body)).toEqual([{ addresses: ["lena@atelier.example"] }, { addresses: ["lena@atelier.example"] }]);
    expect(d.posted[0]!.key).not.toBe(d.posted[1]!.key);
    setActiveLocale("de");
    expect(confirmFailureSaid(undefined)).toContain("Deine Haken sind noch da.");
  });

  it("ticks and unticks everything the search is showing, and nothing it is not", () => {
    expect(bulkOffered(REVIEW)).toBe(true);
    const shown = shownOf(REVIEW, " Studio ");
    expect(shown.map((c) => c.address)).toEqual(["ben@studio.example", "old@studio.example"]);
    const actionable = actionableOf(shown);
    expect(actionable.map((c) => c.address), "a locked row is in the bulk press").toEqual(["ben@studio.example"]);
    const off = setShown(initialTicks(REVIEW), actionable, false);
    expect([...off], "the bulk untick reached past the filter").toEqual(["lena@atelier.example"]);
    expect(Copy.seedConfirm(off.size)).toBe("Let 1 person through");
    expect(setShown(off, actionableOf(shownOf(REVIEW, "")), true).size).toBe(2);
    expect(shownOf(REVIEW, "lena roth").map((c) => c.address)).toEqual(["lena@atelier.example"]);
    expect(Copy.seedDeselectShown(1)).toBe("Untick 1 shown");
    setActiveLocale("de");
    expect(Copy.seedSelectShown(2)).toBe("Alle 2 angezeigten anhaken");
  });

  it("offers no decision over zero people", () => {
    expect(nothingToDecide({ candidates: [], excluded: [], scannedMessages: 0, truncated: false })).toBe(true);
    expect(nothingToDecide({ ...REVIEW, candidates: [REVIEW.candidates[2]!] })).toBe(true);
    expect(nothingToDecide(REVIEW)).toBe(false);
    expect(bulkOffered({ ...REVIEW, candidates: [REVIEW.candidates[0]!, REVIEW.candidates[2]!] })).toBe(false);
    expect(Copy.seedNothingToDecide).toBe("Nobody in your sent mail is waiting for a decision.");
    setActiveLocale("de");
    expect(Copy.seedNothingToDecide).toBe("In deinen gesendeten Mails wartet niemand auf eine Entscheidung.");
  });
});
