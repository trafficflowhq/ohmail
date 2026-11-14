import { describe, expect, it } from "vitest";
import { toStopped, toSkips } from "@ohmail/app-logic/screener/screener-suggest";
import messages from "../messages/en.json";
import de from "../messages/de.json";

/**
 * ═══ A SENDER A STOPPED RUN NEVER REACHED SAYS WHY, NOT "YET" ═════════════════════════════
 *
 * ── WHAT WAS ON SCREEN, MEASURED (managed plane, 2026-09-10, read-only) ───────────────────
 *
 * A run that stops on the spend gate returns suggestions for the senders it reached and
 * NOTHING for the rest, so every unreached row fell back to `screener.noSuggestion` —
 * "No suggestion yet for this sender." On an account whose subscription had been canceled for
 * seventeen days, most of its waiting senders showed that sentence: a promise the account
 * cannot keep, with the real fact ("AI is switched off for this account") arriving only as a
 * one-off toast under the batch that discovered it.
 *
 * The per-row vocabulary already existed — `screener.aiSkip.*`, rendered off
 * `suggestion.noAnswer` — and `toSkips` already used it for the senders the SERVER named. What
 * was missing is the senders it did not name because it stopped before reaching them.
 *
 * ── WHY THE ASKED LIST AND NOT "EVERY WAITING SENDER" ─────────────────────────────────────
 *
 * A stop is a fact about the ACCOUNT, so the temptation is to paint every row. The buy list is
 * what this run actually asked about; a sender outside it was never a question, and answering
 * for them would be this client stating a refusal nobody has tested against that sender's mail.
 *
 * ── MUTATIONS WATCHED (each restored, `cmp`-proven) ───────────────────────────────────────
 *
 *  · `if (!res.stopped) return [];` → `return [];`  ⇒ both stop cases RED.
 *  · drop the `answered` filter                      ⇒ "a sender the run DID answer" RED.
 *  · lower-case comparison removed                   ⇒ "case does not matter" RED.
 */

const ASKED = ["a@x.test", "b@x.test", "c@x.test"];

describe("toStopped — the senders a stopped run never reached", () => {
  it("names the reason on every sender the run did not answer for", () => {
    const rows = toStopped(ASKED, {
      suggestions: [{ sender: "a@x.test" }], skipped: [], stopped: "spend_unavailable",
    });
    expect(rows.map((r) => r.address)).toEqual(["b@x.test", "c@x.test"]);
    expect(rows[0]!.suggestion.noAnswer).toBe("spend_unavailable");
    // No destination is claimed and no confidence is invented: nothing was asked.
    expect(rows[0]!.suggestion.dest).toBe("screener");
    expect(rows[0]!.suggestion.confidence).toBe(0);
  });

  it("carries an empty-balance stop under its own reason", () => {
    const rows = toStopped(ASKED, { suggestions: [], skipped: [], stopped: "out_of_credits" });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.suggestion.noAnswer))).toEqual(new Set(["out_of_credits"]));
  });

  it("a sender the run DID answer for keeps that answer", () => {
    const rows = toStopped(ASKED, {
      suggestions: [{ sender: "a@x.test" }],
      skipped: [{ sender: "b@x.test" }],
      stopped: "out_of_credits",
    });
    expect(rows.map((r) => r.address)).toEqual(["c@x.test"]);
  });

  it("says NOTHING when the run completed — the positive control", () => {
    expect(toStopped(ASKED, { suggestions: [], skipped: [] })).toEqual([]);
  });

  it("case does not matter — the server may echo an address in any case", () => {
    const rows = toStopped(["A@X.test"], {
      suggestions: [{ sender: "a@x.test" }], skipped: [], stopped: "out_of_credits",
    });
    expect(rows).toEqual([]);
  });

  it("every reason it can emit has a sentence in the catalogue", () => {
    const copy = (messages as { screener: { aiSkip: Record<string, string> } }).screener.aiSkip;
    // `over_quote` joined the union with the confirmed-quote ceiling: a run can now stop because
    // it reached the number somebody pressed, and a row with no answer and no reason is the
    // state this file exists to refuse.
    for (const reason of ["out_of_credits", "over_quote", "spend_unavailable"] as const) {
      const [row] = toStopped(["a@x.test"], { suggestions: [], skipped: [], stopped: reason });
      expect(copy[row!.suggestion.noAnswer!], reason).toBeTruthy();
    }
    // And the sentence a NAMED skip renders is the same catalogue — one vocabulary, two producers.
    const [skip] = toSkips([{ sender: "a@x.test", reason: "model_unavailable" }]);
    expect(copy[skip!.suggestion.noAnswer!]).toBeTruthy();
  });
});

/**
 * A DECLINED SENDER SAYS SO, in both catalogues and on both surfaces (the chip and the row note).
 * The server's `model_declined` reached a row with no sentence: `t()` printed the key. Not
 * `model_unavailable`'s copy either — that one promises a free retry a refusal will not keep.
 */
describe("toSkips — a sender the model declined", () => {
  it("carries `model_declined` and both catalogues say it, without the retry promise", () => {
    const [skip] = toSkips([{ sender: "a@x.test", reason: "model_declined" }]);
    expect(skip!.suggestion.noAnswer).toBe("model_declined");
    type Catalogue = { screener: { aiSkip: Record<string, string>; aiSkipRow: Record<string, string> } };
    for (const [name, cat] of [["en", messages], ["de", de]] as const) {
      const { aiSkip, aiSkipRow } = (cat as Catalogue).screener;
      for (const sentence of [aiSkip.model_declined, aiSkipRow.model_declined]) {
        expect(sentence, name).toBeTruthy();
        expect(sentence, name).not.toBe(aiSkip.model_unavailable);
        expect(sentence, name).not.toMatch(/costs nothing|kostet nichts/);
      }
    }
  });
});
