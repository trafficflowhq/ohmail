import { describe, expect, it } from "vitest";
import messages from "../messages/en.json";

/**
 * THE SCREENER NEVER SAYS "BUY".
 *
 * ── WHAT WAS ON SCREEN ───────────────────────────────────────────────────────────────────
 *
 * The suggestion control shipped in the vocabulary of a shop: "Buying suggestions…",
 * "{done} of {total} bought…", "Bought 12 of 40", "Nothing to buy here", "…credits spent",
 * "ohmail buys a suggestion for the first 10 senders". Nine strings, one metaphor, and it is
 * the wrong one — a person pressing this is not making a purchase, they are asking their own
 * mailbox a question against an allowance they have already paid for. A monthly plan's credits
 * are a budget, not a wallet, and copy that says "buy" turns every press into a transaction the
 * reader has to feel careful about. The feature is advice; the noun is a suggestion.
 *
 * ── WHY A GUARD RATHER THAN A CORRECTED FILE ─────────────────────────────────────────────
 *
 * The word came back once already — the strings were rewritten and `autoCost` kept "buys the
 * next few", because a sweep by eye reads the block it is looking at and not the one four keys
 * later. A regex over the whole namespace does not get tired. This is the assertion that
 * survives the next person adding a string in a hurry.
 *
 * ── THE SPEND INVARIANT IS UNTOUCHED, AND THE DOCBLOCKS STILL SAY "BUY" ──────────────────
 *
 * This is a rename in the COPY, and deliberately not in the code that moves money.
 * `screener-suggest.ts` documents a spend rule — "credits are never moved without an action
 * that named the cost first" — and its comments keep the blunt verb precisely because they are
 * about the money and not about the reader. A guard that reached into source comments would be
 * asking the implementation to describe itself in the user's words, which is how an invariant
 * loses the sentence that makes it checkable.
 *
 * ── RED-FIRST ────────────────────────────────────────────────────────────────────────────
 *
 * Watched to fail: restoring `"running": "Buying suggestions…"` in `messages/en.json` turns the
 * first case below red naming `screener.suggest.running`. Watched again with the word buried in
 * `autoCost`, which is the one the manual sweep missed.
 */

/**
 * `\b(buy|…)` with NO trailing boundary, so the inflections are covered by the stems: "buys",
 * "buying", "purchases", "purchased" all match. A trailing `\b` would let "buys" through, which
 * is the exact form the missed string used.
 */
const SHOP_TALK = /\b(buy|bought|buying|purchase)/i;

/** Every string in a namespace, flattened to `dotted.path` → value. */
function flatten(node: unknown, prefix: string, out: Map<string, string>): Map<string, string> {
  if (typeof node === "string") {
    out.set(prefix, node);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

const screener = flatten((messages as Record<string, unknown>).screener, "screener", new Map());

describe("screener copy speaks of suggestions, never of purchases", () => {
  it("has strings to check at all — the flatten must not silently answer an empty set", () => {
    // A guard over zero strings passes for ever. `vitest run <missing-path>` exits 0 and a
    // walk that lost its namespace is the same failure one layer in: green, and about nothing.
    expect(screener.size).toBeGreaterThan(50);
    expect(screener.get("screener.suggest.running")).toBeTypeOf("string");
  });

  it("uses no shop vocabulary anywhere in the namespace", () => {
    const offenders = [...screener].filter(([, v]) => SHOP_TALK.test(v));
    expect(offenders.map(([k, v]) => `${k}: ${v}`)).toEqual([]);
  });

  it("names the suggestion in the strings the control actually renders", () => {
    // Not merely "the bad word is gone" — the replacement has to be the right noun, or an empty
    // string would satisfy the assertion above.
    expect(screener.get("screener.suggest.running")).toBe("Suggesting…");
    expect(screener.get("screener.suggest.progress")).toContain("suggested");
    expect(screener.get("screener.suggest.stoppedAt")).toContain("Suggested");
    expect(screener.get("screener.suggest.doneCount")).toContain("used.");
  });

  it("prices the confirm in senders, so the button says what it will act on", () => {
    // `{n}` is the SERVER's quoted sender count, threaded by `ScreenerView`. A confirm reading
    // only "Suggest" was a button whose scope lived somewhere else on the strip.
    expect(screener.get("screener.suggest.confirm")).toContain("{n");
    expect(screener.get("screener.suggest.confirm")).toContain("Suggest for");
  });

  it("names the destination piles on the apply control, not only a count", () => {
    const applyAll = screener.get("screener.applyAll") ?? "";
    expect(applyAll).toContain("{count}");
    expect(applyAll).toBe("Apply {count}");
    // Every pile the bulk can file into needs a name, or `pileList` renders a raw key path into
    // the button. `spam` is included: it is unreachable from `applyAll` today, but `PILE_KEY` is
    // total over the destination union and a missing entry there is a compile error, not a test.
    for (const key of ["pileOhbox", "pileReads", "pileReceipts", "pileScreened", "pileSpam"]) {
      expect(screener.get(`screener.${key}`), key).toBeTypeOf("string");
    }
    expect(screener.has("screener.pileJoin")).toBe(false);
  });

  it("the auto opt-in names BOTH halves of what the switch authorises", () => {
    /*
     * CLAIMS ARE CONTRACTS. This flag used to authorise exactly one thing — a batch bought when a
     * person opened the Screener — and the consent sentence said so. It now also authorises the
     * server to suggest for senders as their mail ARRIVES, with nobody opening anything, which is
     * spending on a schedule rather than on a visit. A sentence that still described only the
     * visit would be a settings screen understating what it just turned on.
     *
     * Asserted on the CONCEPT, not on a phrasing: the string has to mention arrival AND the
     * already-waiting queue, and the size has to come from `{count}` (the constant the spender
     * slices by) rather than be typed as a digit that outlives it.
     */
    const what = screener.get("screener.suggest.autoWhat") ?? "";
    expect(what, "the arriving half").toMatch(/arrive/i);
    expect(what, "the already-waiting half").toMatch(/waiting/i);
    expect(what, "the size is the constant, never a literal").toContain("{count");
    expect(what).not.toMatch(/\b10\b/);
    // And the settled ON state repeats it, because the confirm is gone by then and the row's
    // description is the only place a person can re-read what is running.
    expect(screener.get("screener.suggest.autoOn") ?? "").toMatch(/arrive/i);
  });

  it("has a sentence for a bulk that is still running", () => {
    // `useScreenerState#applying` publishes the two numbers; this is the sentence they go in.
    const applying = screener.get("screener.applying") ?? "";
    expect(applying).toContain("{done}");
    expect(applying).toContain("{total}");
  });
});
