import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * ═══ THE JUNK RESCUE CLAIMS A COMMAND, NEVER A MOVE ═══════════════════════════════════════
 *
 * The product rule is that the API never opens IMAP to apply organization. 0.19.1 recorded the
 * rescue as that rule's one open instance and held the SURFACE to the truth instead: the move was
 * synchronous there, so "Out of Junk" was earned and every other outcome had to say what it really
 * was. 0.19.2 closed the rule — the press records a `junk_rescues` row and the organizer moves the
 * message — so the claim that must now hold is the stronger one: NO sentence on this path may say
 * the move has happened, because when the answer comes back it has not.
 *
 * The guard reads both halves from the tree — the route's refusal vocabulary from the server's
 * source, the rendered keys from the client's own branch — so a NEW outcome or a MISSING sentence
 * fails by name rather than by a count nobody can place.
 *
 * Mutations watched red (2026-09-17), each restored from a pristine copy and proved by `cmp`:
 *  · the client's allowed branch pointed at `junkRescueQueued` ⇒ the key set loses
 *    `junkRescueQueuedAllowed` and this file names it;
 *  · `en.json`'s `junkRescueQueued` reworded to the retired "Out of Junk …" ⇒ the move-claim
 *    case names it;
 *  · a second `ServiceError` code added to `rescueJunk` ⇒ the outcome set names it as unsentenced.
 */

const REPO = `${process.cwd().replace(/\/$/, "")}/`;
const ROUTE = `${REPO}packages/api/src/junk-window.ts`;
const CLIENT = `${REPO}packages/app-logic/src/screener/junk-window.ts`;
const LETTER = `${REPO}packages/app/src/screener/held/JunkLetter.tsx`;

/**
 * The rescue's own body, bounded by the next top-level `export` after it — never the whole
 * file, whose other routes raise refusals of their own that this surface never renders.
 */
function rescueBody(): string {
  const src = readFileSync(ROUTE, "utf8");
  const start = src.indexOf("export async function rescueJunk");
  expect(start, "rescueJunk is not in the route's source under that name").toBeGreaterThan(-1);
  const end = src.indexOf("\nexport ", start + 1);
  expect(end, "no top-level export follows rescueJunk — the bound would be the whole file")
    .toBeGreaterThan(start);
  return src.slice(start, end);
}

/** Every refusal code the rescue can answer with, read from its own `ServiceError` sites. */
function refusalCodes(): string[] {
  return [...new Set(
    [...rescueBody().matchAll(/new ServiceError\(\s*"([a-z_]+)"/g)].map((m) => m[1]!),
  )].sort();
}

/**
 * Every rescue sentence the surface renders, read from its own `t("…")` literals — the HOOK,
 * which toasts what a press answered, and the held letter, which renders what a standing row is
 * waiting for. Both, because the refused state is a row's badge and never a toast: reading the
 * hook alone would report `junkRescueRefused` as a sentence nothing renders.
 */
function renderedKeys(): string[] {
  const src = [CLIENT, LETTER].map((f) => readFileSync(f, "utf8")).join("\n");
  return [...new Set(
    [...src.matchAll(/"(junkRescue[A-Za-z]*|junkRescued[A-Za-z]*)"/g)].map((m) => m[1]!),
  )].sort();
}

const catalogue = (lang: "en" | "de"): Record<string, string> =>
  (JSON.parse(readFileSync(`${REPO}apps/webapp/messages/${lang}.json`, "utf8")) as
    { screener: Record<string, string> }).screener;

/**
 * THE FOUR SENTENCES AND WHAT EACH ONE IS ABOUT. Two are what a PRESS answered, two are what a
 * ROW is waiting for — the distinction is the whole design: a press now records a command, so
 * the outcome a person cares about arrives later, on the row, and not in the toast.
 */
const PRESS_SENTENCES = {
  /** The command is recorded — the plain verb and the "and allow this sender" verb. */
  queued: { plain: "junkRescueQueued", allowed: "junkRescueQueuedAllowed" },
} as const;

/**
 * ONE failure sentence, and its singularity is the claim: the allow and the command commit in one
 * transaction, so "the rules changed but the move did not" is unrepresentable and the two
 * sentences that used to describe it (`junkRescueFailedAllowed`, `junkRescueGoneAllowed`) are
 * retired with it.
 */
const PRESS_FAILED = "junkRescueFailed";

/** What a STANDING row says: the mail server would not take the move after the ladder ran out. */
const ROW_REFUSED = "junkRescueRefused";

/** Leaving a refused message in Junk: the press, what it answered, and its failure. None is a move. */
const CLEAR = { press: "junkRescueDismiss", done: "junkRescueDismissed", failed: "junkRescueDismissFailed" } as const;

/** Sentences RETIRED when the move left the API. None may come back without this list changing. */
const RETIRED = [
  "junkRescued", "junkRescuedAllowed",
  "junkRescueGone", "junkRescueGoneAllowed",
  "junkRescueFailedAllowed",
] as const;

/** The clause that CLAIMED THE MOVE HAD HAPPENED, in each catalogue. Nothing may carry it now. */
const MOVE_HAPPENED = { en: "Out of Junk", de: "Raus aus Junk" } as const;

const ALL_KEYS = [
  ...Object.values(PRESS_SENTENCES).flatMap((s) => [s.plain, s.allowed]),
  PRESS_FAILED, ROW_REFUSED, ...Object.values(CLEAR),
].sort();

describe("the junk rescue's outcomes and its sentences", () => {
  it("every refusal the route can answer has a sentence — a new one is named", () => {
    // `no_junk_folder` is the defensive 404: a mailbox with no \Junk shows no rows to rescue,
    // and it renders through the client's catch-all, which claims nothing about a move.
    const CATCH_ALL = ["no_junk_folder"];
    const sentenced = Object.keys(PRESS_SENTENCES);
    const unsentenced = refusalCodes().filter(
      (c) => !sentenced.includes(c) && !CATCH_ALL.includes(c),
    );
    expect(unsentenced, `these rescue outcomes render no sentence: ${unsentenced.join(", ")}`)
      .toEqual([]);
  });

  it("the surface renders exactly its sentences, and no sentence is missing", () => {
    const rendered = renderedKeys();
    const missing = ALL_KEYS.filter((k) => !rendered.includes(k));
    const extra = rendered.filter((k) => !ALL_KEYS.includes(k));
    expect(missing, `the surface renders no sentence for: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `the surface renders sentences no outcome produces: ${extra.join(", ")}`)
      .toEqual([]);
  });

  it.each(["en", "de"] as const)("%s states every one, and NONE claims the move happened", (lang) => {
    const copy = catalogue(lang);
    for (const key of ALL_KEYS) {
      const text = copy[key];
      expect(text, `${lang}.json has no ${key}`).toBeTruthy();
      // The rule that replaces 0.19.1's: the API records a command and moves nothing, so the
      // present tense is earned by no answer on this path at all.
      expect(text!.includes(MOVE_HAPPENED[lang]), `${lang} ${key} claims the move happened`)
        .toBe(false);
    }
  });

  it.each(["en", "de"] as const)("%s has RETIRED every sentence the synchronous move needed", (lang) => {
    const copy = catalogue(lang);
    const survivors = RETIRED.filter((k) => copy[k] !== undefined);
    expect(survivors, `${lang}.json still carries retired rescue copy: ${survivors.join(", ")}`)
      .toEqual([]);
  });

  it.each(["en", "de"] as const)("%s says the command is not done yet, and names the allow once", (lang) => {
    const copy = catalogue(lang);
    // A queued command must read as a PROMISE rather than a report, or the surface is back to
    // claiming a move — this is the positive half of the case above, which only refuses.
    const future = lang === "en" ? /will be moved/i : /wird .* verschoben/i;
    for (const key of [PRESS_SENTENCES.queued.plain, PRESS_SENTENCES.queued.allowed]) {
      expect(future.test(copy[key]!), `${lang} ${key} does not say the move is still to come`)
        .toBe(true);
    }
    // And the second verb's own half is stated, because the allow is real the moment it commits.
    const namesAllow = lang === "en" ? /allowed from now on/i : /zugelassen/i;
    expect(namesAllow.test(copy[PRESS_SENTENCES.queued.allowed]!),
      `${lang} ${PRESS_SENTENCES.queued.allowed} does not name the standing allow`).toBe(true);
    expect(namesAllow.test(copy[PRESS_SENTENCES.queued.plain]!),
      `${lang} ${PRESS_SENTENCES.queued.plain} names an allow the plain verb never wrote`).toBe(false);
  });
});
