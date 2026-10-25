import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import de from "../messages/de.json";
import en from "../messages/en.json";

/**
 * ═══ A FOLDER IS NOT A PLACE ══════════════════════════════════════════════════════════════════
 *
 * `ohbox.toastMoved` read "Nach {place} verschoben." German's *nach* is the DIRECTIONAL
 * preposition for going to a place — nach Berlin, nach Hause — and it takes a bare noun with no
 * article. A mail folder is not a place: it is "der Ordner Rechnungen", and putting a folder name
 * where a city name goes makes the sentence read as though the reader were being sent somewhere.
 *
 * The repair is not a different preposition; every directional one makes the same demand. It is
 * removing the grammatical relationship — "Verschoben: {place}." A colon governs nothing, so it
 * is right for every folder name there is, articles and all.
 *
 * ══ WHY THIS CENSUS IS NARROW, MEASURED ═══════════════════════════════════════════════════════
 *
 * The obvious generalisation — "no interpolation immediately after a case-governing preposition"
 * — was written, run over the whole catalogue, and produced **123 hits**. Reading them showed the
 * rule is wrong about German rather than right about the catalogue:
 *
 *   · `{done} von {total}` — "3 von 12". Correct.
 *   · `An seit {when}` — "on since 14:00". Correct.
 *   · `für {email}`, `unter {origin}`, `bei {domain}` — an address, a URL, a hostname. All
 *     invariant tokens that decline for nobody. Correct.
 *   · `in {minutes, plural, …}` — a number. Correct.
 *
 * A preposition governs case on a NOUN PHRASE. An email address, a timestamp, a count and a
 * hostname have no case to govern, so they are grammatical after any preposition at all. **Of the
 * 123, 115 were correct German**, and rewriting them to satisfy the rule would have damaged the
 * copy in order to make a guard go green — which is the same defect as weakening an assertion to
 * make it pass, pointed at the product instead of the test.
 *
 * What was actually broken was narrower and real: a DIRECTIONAL preposition in front of a
 * user-named FOLDER. That is eight strings, and they are fixed. This census is that rule, so it
 * fails on the defect and stays quiet about correct German.
 *
 * ══ THE ASSERTION IS THE RENDERED SENTENCE ════════════════════════════════════════════════════
 *
 * Asserting the raw catalogue entry would pass on a string that no longer compiles as an ICU
 * message — a stray brace, a renamed argument — and the toast would then render its own source
 * text at somebody. The exact-output tests format through the real translator.
 */

const PLACE = "Rechnungen";

/** The directional prepositions. Each wants a bare place-noun, which a folder name is not. */
const DIRECTIONAL = ["nach", "zu", "zur", "zum", "ins"];

/**
 * DESTINATION ARGUMENTS, DERIVED FROM THE ENGLISH — not a list kept by hand.
 *
 * The first cut of this census listed them: `place`, `dest`, `folder`, `target`. It omitted
 * `name`, and `rail.folderRenaming` — "Being renamed to {name} on your mail server…" — kept the
 * defect the broad rule had caught. A hand-maintained list is the failure this lane has now
 * closed twice elsewhere, and I reintroduced it here.
 *
 * So the set comes from the English catalogue, which already says which arguments are places to
 * put something: every argument English writes after "to", "into" or "in". That is derived from
 * the same source the translation is made from, and a new destination argument joins it by being
 * used, not by being remembered.
 *
 * Two narrowings, both on a principle rather than a list of exceptions.
 *
 * The preposition alone is not enough: English puts plenty of non-nouns after it — "Up to {size}
 * total", "Goes to {host}" — and a quantity or a hostname declines in German no more than it does
 * in English. So the message must ALSO carry a verb of PUTTING SOMETHING SOMEWHERE. That is the
 * construction whose German equivalent takes a case, and it is what "moved to", "files into" and
 * "being renamed to" have in common while "up to" and "goes to" do not.
 *
 * And it is crossed with the DIRECTIONAL list below rather than used alone, because the defect
 * needs both halves: a German directional preposition AND an argument English treats as somewhere
 * mail is put.
 */
// A putting word right after a possessive or determiner is a noun ("your own files"), not the verb.
const PUTTING = /(?<!\b(?:own|your|the|its|their|my|our|these|those)\s)\b(mov(e|es|ed|ing)|fil(e|es|ed|ing)|renam(e|es|ed|ing)|sort(s|ed|ing)?|put|deliver(s|ed)?|releas(e|es|ed))\b/i;

function destinationArgs(catalogue: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (!PUTTING.test(node)) return;
      for (const m of node.matchAll(/\b(?:to|into|in)\s+\{(\w+)\}/g)) out.add(m[1]!);
      return;
    }
    if (node && typeof node === "object") for (const v of Object.values(node)) visit(v);
  };
  visit(catalogue);
  return out;
}

const FOLDER_ARGS = [...destinationArgs(en)];

const DIRECTIONAL_AT_FOLDER = new RegExp(
  `(^|[\\s(„"’‘>—-])(${DIRECTIONAL.join("|")})\\s+\\{(${FOLDER_ARGS.join("|")})[},]`,
  "iu",
);

const t = createTranslator({ locale: "de", messages: de as Record<string, unknown> });
const tEn = createTranslator({ locale: "en", messages: en as Record<string, unknown> });

/** Every string in the catalogue, with its dotted key. */
function entries(node: unknown, path = "", out: [string, string][] = []): [string, string][] {
  if (typeof node === "string") { out.push([path, node]); return out; }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      entries(v, path ? `${path}.${k}` : k, out);
    }
  }
  return out;
}

const ALL = entries(de);

/**
 * THE SUBJECT IS A KEY WITH A CALLER. This read `ohbox.toastMoved` — the single row's old
 * "Moved to {place}." — which lost its last caller when the press started speaking from the
 * Screener's own answer, and a guard whose subject nothing renders is a guard about a string.
 * `ohbox.toastBulkMovedSenders` is the selection's Move saying the same thing, dispatched from
 * `onBulkAction`; its German names the place first, behind a dash, which governs no case either.
 */
describe("the moved toast names the folder without declining it", () => {
  const ARGS = { place: PLACE, senders: 1, count: 1 };

  it("names the folder behind a dash — which governs no case", () => {
    expect(t("ohbox.toastBulkMovedSenders", ARGS))
      .toBe(`${PLACE} — Mails von 1 Absender landen ab jetzt dort, 1 Nachricht verschoben.`);
  });

  it("the English string is untouched — only the German had the case problem", () => {
    expect(tEn("ohbox.toastBulkMovedSenders", ARGS))
      .toBe(`Mail from 1 sender now goes to ${PLACE} — 1 message moved.`);
  });
});

describe("no German string sends the reader to a folder as though it were a place", () => {
  it("reads the catalogue at all", () => {
    // Anti-vacuity: a renamed file or a changed shape would make the census below pass over nothing.
    expect(ALL.length, "the catalogue walk found almost no strings").toBeGreaterThan(1500);
    expect(ALL.some(([k]) => k === "ohbox.toastBulkMovedSenders")).toBe(true);
  });

  it("reads a quantity after 'to' as no folder, and a real filing verb still as one", () => {
    expect([...destinationArgs({ a: "Up to {size} of your own files" })]).toEqual([]);
    expect([...destinationArgs({ a: "The rule files it into {folder}" })]).toEqual(["folder"]);
  });

  it("no directional preposition stands in front of a folder name", () => {
    const offenders = ALL
      .filter(([, v]) => DIRECTIONAL_AT_FOLDER.test(v))
      .map(([k, v]) => `${k}: ${v.slice(0, 90)}`);
    expect(
      offenders,
      "a directional preposition wants a bare place-noun and a folder is not one. Name the folder "
        + "after a colon or a dash instead — that governs no case and is right for every folder.",
    ).toEqual([]);
  });
});
