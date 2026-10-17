import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTranslator } from "next-intl";
import {
  DEFAULT_LOCALE, LOCALES, fillFrom, isAppLocale, normalizeLocale,
} from "../app/shell/locale";

/**
 * THE CATALOGUE PARITY GUARD — the one that keeps the translation honest after this slice.
 *
 * Everything else about German is a runtime fallback: `fillFrom` merges `de` over `en`, so a key
 * German is missing renders the English sentence rather than the dotted KEY that `use-intl` would
 * otherwise print. That is the right runtime behaviour and it is exactly why a guard is needed —
 * the failure it hides is SILENT. A slice that adds `screener.newThing` to `en.json` and forgets
 * `de.json` ships an English sentence into a German interface, passes every test, and is found by a
 * German-speaking user weeks later.
 *
 * So the assertion is EQUALITY of key sets, and the failure message NAMES THE KEYS. A guard that
 * says "the catalogues differ" makes somebody diff two 100 KB files; a guard that says
 * `de.json is missing: screener.newThing` is a to-do.
 *
 * ── WHAT ELSE IS CHECKED, AND WHY EACH ONE IS A REAL FAILURE ──────────────────────────────────
 *
 *  · ICU ARGUMENTS. A German sentence that drops `{count}` compiles and renders a sentence with a
 *    number missing from it. `intl-messageformat` (the same compiler `t()` uses) reports the
 *    arguments each message requires, so the two catalogues are compared on that rather than on a
 *    regex over braces — a regex cannot tell an argument from the body of a plural branch, and
 *    German plural branches are full sentences.
 *  · RICH-TEXT TAGS. `<k>`, `<o>`, `<b>` and `<kbd>` are callbacks the component supplies. A
 *    translation that drops one loses the emphasis the design depends on; one that INVENTS a tag
 *    renders it as literal text, because there is no callback for it.
 *  · EVERY MESSAGE COMPILES. An unbalanced brace in a hand-written translation is a runtime throw
 *    inside a render, which in the mail client is a blank view behind the error boundary.
 *  · THE TWO SENTENCES THAT MUST NOT BE TRANSLATED — the language names. See the case.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES = path.join(HERE, "..", "messages");

type Tree = Record<string, unknown>;

function read(locale: string): Tree {
  return JSON.parse(fs.readFileSync(path.join(MESSAGES, `${locale}.json`), "utf8")) as Tree;
}

function leaves(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      for (const [ik, iv] of leaves(v as Tree, `${prefix}${k}.`)) out.set(ik, iv);
    } else {
      out.set(`${prefix}${k}`, String(v));
    }
  }
  return out;
}

/** The plural/select branch keywords. A `{` preceded by one of these opens a BODY, not an argument. */
const BRANCH_KEY = /(?:=\d+|zero|one|two|few|many|other|true|false)\s*$/;

/**
 * THE ICU ARGUMENTS A MESSAGE REQUIRES.
 *
 * Written here rather than taken from `@formatjs/icu-messageformat-parser`, which is a transitive
 * dependency of the intl package and not one this app declares — a test that reaches for an
 * undeclared package fails on a clean install rather than on a real defect.
 *
 * ── THE ONE AMBIGUITY, AND HOW IT IS RESOLVED ──────────────────────────────────────────────────
 *
 * `{count}` (a simple argument) and `one {sender}` (a plural branch whose whole body is one word)
 * are the same three characters to a scanner. They are told apart by what comes BEFORE the brace: a
 * branch body's `{` always follows a branch keyword. `screener.suggest.autoWhat` is the real message
 * this matters for — `{count, plural, one {sender} other {# senders}}` — and without the guard its
 * English side reads as requiring an argument named `sender`, which no caller passes and no
 * translation could preserve.
 */
function icuArgs(message: string): string[] {
  const names = new Set<string>();
  for (let i = 0; i < message.length; i++) {
    if (message[i] !== "{") continue;
    if (BRANCH_KEY.test(message.slice(Math.max(0, i - 8), i))) continue;
    const rest = message.slice(i + 1);
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(,|\})/.exec(rest);
    if (m) names.add(m[1]!);
  }
  return [...names].sort();
}

/** Balanced braces — an unbalanced translation throws inside a render, behind the error boundary. */
function bracesBalanced(message: string): boolean {
  let depth = 0;
  for (const ch of message) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

const TAG = /<\/?([A-Za-z][A-Za-z0-9]*)>/g;
const tagsOf = (s: string): string[] => [...s.matchAll(TAG)].map((m) => m[1]!).sort();

describe("the message catalogues", () => {
  it("LOCALES is a closed set, English is its default, and every member has a file", () => {
    expect([...LOCALES]).toEqual(["en", "de"]);
    expect(DEFAULT_LOCALE).toBe("en");
    expect(LOCALES).toContain(DEFAULT_LOCALE);
    for (const locale of LOCALES) {
      const file = path.join(MESSAGES, `${locale}.json`);
      expect(fs.existsSync(file), `messages/${locale}.json is missing`).toBe(true);
      // …and it is a real catalogue rather than an empty placeholder somebody added to pass this.
      expect(Object.keys(read(locale)).length).toBeGreaterThan(50);
    }
    // Nothing else in `messages/` — a stray file there becomes a lazy chunk in the web bundle and
    // is filtered into the desktop binary by `shellMessagesOnly`, both silently.
    const onDisk = fs.readdirSync(MESSAGES).filter((f) => f.endsWith(".json")).sort();
    expect(onDisk).toEqual([...LOCALES].map((l) => `${l}.json`).sort());
  });

  it("de.json and en.json have IDENTICAL key sets", () => {
    const en = leaves(read("en"));
    const de = leaves(read("de"));

    // A literal floor, so a run where the reader silently found nothing cannot pass.
    expect(en.size).toBeGreaterThan(1400);

    const missing = [...en.keys()].filter((k) => !de.has(k)).sort();
    const extra = [...de.keys()].filter((k) => !en.has(k)).sort();

    expect(missing, `de.json is MISSING these keys — they will render in English:\n  ${missing.join("\n  ")}`)
      .toEqual([]);
    expect(extra, `de.json has keys en.json does not — nothing reads them:\n  ${extra.join("\n  ")}`)
      .toEqual([]);
    expect(de.size).toBe(en.size);
  });

  it("every German message needs exactly the arguments the English one needs", () => {
    const en = leaves(read("en"));
    const de = leaves(read("de"));
    const argMismatch: string[] = [];
    const broken: string[] = [];

    for (const [key, german] of de) {
      const english = en.get(key);
      if (english === undefined) continue;
      if (!bracesBalanced(german)) {
        broken.push(`${key}: unbalanced braces`);
        continue;
      }
      const wanted = icuArgs(english);
      const got = icuArgs(german);
      if (wanted.join(",") !== got.join(",")) {
        argMismatch.push(`${key}: en needs [${wanted.join(", ")}], de needs [${got.join(", ")}]`);
      }
    }

    expect(broken, `these messages are malformed:\n  ${broken.join("\n  ")}`).toEqual([]);
    expect(argMismatch, `argument drift — a missing one renders a sentence with a hole in it:\n  ${argMismatch.join("\n  ")}`)
      .toEqual([]);
  });

  it("every German message with a plural actually FORMATS, in German, for one and for many", () => {
    // The arguments check above is static. This one runs the real compiler over every plural
    // message — the shape most likely to be hand-mangled — and asserts both German plural
    // categories produce a non-empty string with the number in it. A `de` message that kept an
    // English plural keyword, or lost a branch, throws or renders empty here rather than on screen.
    const de = read("de");
    const t = createTranslator({ locale: "de", messages: de as never });
    const flat = leaves(de);
    let checked = 0;
    for (const [key, message] of flat) {
      if (!message.includes(", plural,")) continue;
      /* Rich-text messages take TAG CALLBACKS, not values, and `t()` has no way to accept one — the
         component calls `t.rich`. Their tags are checked by the case below instead; formatting them
         here would only be asserting that `t()` refuses them, which it should. */
      if (TAG.test(message)) { TAG.lastIndex = 0; continue; }
      TAG.lastIndex = 0;
      const args = icuArgs(message);
      const values: Record<string, unknown> = {};
      for (const a of args) values[a] = 1;
      for (const n of [1, 7]) {
        for (const a of args) values[a] = n;
        const out = t(key as never, values as never);
        expect(String(out).length, `${key} rendered empty for n=${n}`).toBeGreaterThan(0);
        expect(String(out), `${key} rendered a raw key for n=${n}`).not.toBe(key);
      }
      checked++;
    }
    // Not vacuous: the catalogue really does carry plurals.
    expect(checked).toBeGreaterThan(40);
  });

  it("rich-text tags survive translation exactly — a dropped <k> loses the emphasis", () => {
    const en = leaves(read("en"));
    const de = leaves(read("de"));
    const drift: string[] = [];
    for (const [key, german] of de) {
      const english = en.get(key);
      if (english === undefined) continue;
      const wanted = tagsOf(english);
      const got = tagsOf(german);
      if (wanted.join(",") !== got.join(",")) {
        drift.push(`${key}: en has [${wanted.join(", ")}], de has [${got.join(", ")}]`);
      }
    }
    expect(drift, `tag drift — an invented tag renders as literal text:\n  ${drift.join("\n  ")}`)
      .toEqual([]);
  });

  it("the language names are NOT translated — each is its own language's word", () => {
    // The one place both catalogues hold identical strings on purpose. A German reader looking for
    // their language scans for "Deutsch"; translating the labels into the language somebody cannot
    // read is the one thing a language selector must not do.
    for (const locale of LOCALES) {
      const names = leaves(read(locale));
      expect(names.get("settings.languageName.en")).toBe("English");
      expect(names.get("settings.languageName.de")).toBe("Deutsch");
    }
  });

  /**
   * THE AWAY NOTICE'S TWO SELECTS AGREE WITH EACH OTHER — every combination, both languages.
   *
   * The sentence is one ICU message with a `select` for the audience and a `select` for the
   * rate, interpolated into one line. That shape has a specific failure the argument checks
   * above cannot see: an arm that is grammatical on its own and ungrammatical in combination.
   * It shipped exactly once, in English — the verb sat in the RATE arm, where it cannot know
   * which subject precedes it, so "everyone who writes gets a reply" was right and "people
   * you've let in gets a reply" was wrong, and no test read the composed sentence.
   *
   * So every one of the eight combinations is rendered through the real formatter and the
   * SUBJECT-VERB PAIR is asserted, not merely that something non-empty came out. Moving the
   * verb back into the rate arm turns four of these red.
   */
  it("the away notice composes grammatically in every audience × scope × rate combination", () => {
    const AUDIENCES = ["everyone", "screened_in"] as const;
    const THROTTLES = ["always", "per_message", "per_day", "per_week"] as const;
    /**
     * THE SCOPE IS THE THIRD DIMENSION (mail 0096), and adding it is what makes the verb's
     * placement worth re-asserting: the scope clause sits BETWEEN the subject and the verb in
     * English, so the verb can no longer live in the audience arm either. It has its own
     * `select` on the same argument, which is legal ICU and the only shape that keeps agreement
     * while a relative clause comes in between.
     *
     * IT IS AN ARGUMENT NOW, NOT A `select` (mail 0101). Four answerable piles are sixteen
     * subsets, so the clause names them: the component joins the per-pile phrases with
     * `Intl.ListFormat` and passes one string. This guard therefore asks the CATALOGUE's
     * question — does the sentence compose around that string, in order, in both languages —
     * and the joining is the component's own case (`away-notice.test.tsx`). Both tables below
     * are LITERAL for that reason: an expectation built by the same list formatter would agree
     * with the component about a shared mistake.
     *
     * An EMPTY scope is deliberately NOT swept here: it has no true wording inside this
     * sentence — see `noticeNone`, asserted separately below.
     */
    const SCOPES = ["ohbox", "reads", "ohbox_reads", "all_four"] as const;
    /** What the component passes as `piles`, per language — the joined pile phrases. */
    const PILES_ARG: Record<string, Record<string, string>> = {
      en: {
        ohbox: "in Ohbox",
        reads: "in News",
        ohbox_reads: "in Ohbox or in News",
        all_four: "in Ohbox, in News, in Receipts, or in the Screener",
      },
      de: {
        ohbox: "in der Ohbox",
        reads: "in News",
        ohbox_reads: "in der Ohbox oder in News",
        all_four: "in der Ohbox, in News, in Belegen oder im Screener",
      },
    };
    /** The scope clause each one must produce, per language. */
    const SCOPE: Record<string, Record<string, string>> = {
      en: {
        ohbox: "whose mail lands in Ohbox",
        reads: "whose mail lands in News",
        ohbox_reads: "whose mail lands in Ohbox or in News",
        all_four: "whose mail lands in Ohbox, in News, in Receipts, or in the Screener",
      },
      de: {
        ohbox: "deren Mails in der Ohbox landen",
        reads: "deren Mails in News landen",
        ohbox_reads: "deren Mails in der Ohbox oder in News landen",
        all_four: "deren Mails in der Ohbox, in News, in Belegen oder im Screener landen",
      },
    };
    /**
     * The SUBJECT each audience must produce, and the verb that must follow the scope clause.
     * English inflects (a collective singular against a plural); German uses the plural for both
     * and carries its verb at the head of the rate arm, which it always has.
     */
    const SUBJECT: Record<string, Record<string, string>> = {
      en: { everyone: "everyone who writes", screened_in: "people you've let in" },
      de: {
        everyone: "alle, die schreiben",
        screened_in: "Leute, die du reingelassen hast",
      },
    };
    const VERB: Record<string, Record<string, { must: string; mustNot: string }>> = {
      en: {
        everyone: { must: "gets", mustNot: "get " },
        screened_in: { must: "get", mustNot: "gets" },
      },
      // German does not inflect between these two subjects, so the pair is the same both ways —
      // and `bekommt` is still the disagreement worth refusing, because it is what a translator
      // reaching for a singular would write.
      de: {
        everyone: { must: "bekommen", mustNot: "bekommt" },
        screened_in: { must: "bekommen", mustNot: "bekommt" },
      },
    };
    /** The rate half has to survive the composition too — an arm silently falling through to
     *  `other` would describe a responder answering seven times less often than it does. */
    const RATE: Record<string, Record<string, string>> = {
      en: {
        always: "a reply to every message",
        per_message: "one reply, until you change the text",
        per_day: "a reply at most once a day",
        per_week: "a reply at most once a week",
      },
      de: {
        always: "auf jede Nachricht eine Antwort",
        per_message: "eine Antwort, bis du den Text änderst",
        per_day: "höchstens einmal am Tag eine Antwort",
        per_week: "höchstens einmal pro Woche eine Antwort",
      },
    };
    let checked = 0;
    for (const locale of ["en", "de"] as const) {
      const t = createTranslator({ locale, messages: read(locale) as never, namespace: "away" });
      for (const audience of AUDIENCES) {
        for (const scope of SCOPES) {
          for (const throttle of THROTTLES) {
            const out = String(t("notice" as never, {
              audience, throttle, piles: PILES_ARG[locale]![scope]!,
            } as never));
            const where = `${locale} audience=${audience} scope=${scope} throttle=${throttle}: "${out}"`;
            // No unresolved arm, no leftover template.
            expect(out, `${where} — an arm did not resolve`).not.toContain("{");
            expect(out, `${where} — an arm did not resolve`).not.toContain("}");
            const subject = SUBJECT[locale]![audience]!;
            const clause = SCOPE[locale]![scope]!;
            const verb = VERB[locale]![audience]!;
            expect(out, `${where} — the subject was lost`).toContain(subject);
            expect(out, `${where} — the scope clause was lost`).toContain(clause);
            /* THE WHOLE SPINE, IN ORDER: subject, then the scope clause, then the verb.
               Three independent `toContain`s are exactly what a mangled composition satisfies —
               the defect this block exists for shipped as a sentence whose parts were all
               present — so the ORDER is asserted by position.
               By position and not by a concatenation, because the JOINER is the languages'
               own business: English runs the relative clause straight on ("people you've let
               in whose mail lands in Ohbox get"), German fences it with commas ("alle, die
               schreiben, deren Mails in der Ohbox landen, bekommen"). Pinning either one's
               punctuation here would make this guard refuse the other language's grammar. */
            const atSubject = out.indexOf(subject);
            const atClause = out.indexOf(clause);
            const atVerb = out.indexOf(verb.must, atClause + clause.length);
            expect(atSubject, `${where} — the subject is missing`).toBeGreaterThanOrEqual(0);
            expect(atClause, `${where} — the scope clause does not follow the subject`)
              .toBeGreaterThan(atSubject);
            expect(atVerb, `${where} — the verb does not follow the scope clause`)
              .toBeGreaterThan(atClause);
            /* …and the WRONG verb does not sit in that slot. Punctuation-tolerant for the reason
               above; this is the "people you've let in gets" disagreement, which is what put the
               verb in an arm that can see its subject in the first place. */
            expect(out, `${where} — "${verb.mustNot}" follows the scope clause`)
              .not.toMatch(new RegExp(
                `${clause.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[,\\s]+${verb.mustNot.trim()}\\b`,
              ));
            expect(out, `${where} — the rate half was lost in composition`)
              .toContain(RATE[locale]![throttle]!);
            checked += 1;
          }
        }
      }
    }
    // 2 audiences × 4 scopes × 4 rates per language, or this loop stopped meaning anything.
    expect(checked, "the combination sweep did not run").toBe(64);
  });

  /**
   * THE EMPTY SCOPE'S OWN SENTENCE. A responder that is on with no pile selected is reachable
   * (the column's CHECK is containment, and unticking every box means exactly this), and no
   * wording inside the sentence above is true of it: naming a pile claims replies are going out,
   * and an empty clause claims it more quietly. So it is a separate key, and it must exist in
   * both catalogues, say nothing is sent, and name no pile.
   */
  it("a responder answering NO pile has its own sentence, in both languages", () => {
    for (const locale of ["en", "de"] as const) {
      const t = createTranslator({ locale, messages: read(locale) as never, namespace: "away" });
      const out = String(t("noticeNone" as never));
      expect(out, `${locale}: noticeNone did not resolve`).not.toContain("{");
      expect(out.length, `${locale}: noticeNone is empty`).toBeGreaterThan(20);
      for (const pile of ["Ohbox", "News"]) {
        expect(out, `${locale}: noticeNone names ${pile}, which is not being answered`)
          .not.toContain(pile);
      }
    }
  });

  it("the German catalogue is actually German — not a copy of the English one", () => {
    // ANTI-VACUITY. A `de.json` that were `cp en.json` would satisfy every case above. This asserts
    // the two genuinely differ across the surface, and names three sentences a reader sees first.
    const en = leaves(read("en"));
    const de = leaves(read("de"));
    const identical = [...de].filter(([k, v]) => en.get(k) === v);
    // Some keys SHOULD be identical: brand names, the language names, ICU-free glyphs, addresses.
    // The floor is that the overwhelming majority are not.
    expect(identical.length / de.size).toBeLessThan(0.25);
    expect(de.get("rail.ohbox")).toBe("Ohbox");
    expect(de.get("rail.settings")).toBe("Einstellungen");
    expect(de.get("settings.language")).toBe("Sprache");
  });
});

/**
 * THE GLOSSARY GUARD — one view, one German name, everywhere that view is written.
 *
 * The parity guard above proves every key EXISTS in German. It says nothing about whether the
 * German for a view is the SAME word in the rail, in a toast, on a search-hit badge and in the
 * marketing sentence that mentions it. That drift is silent — each sentence reads fine on its own,
 * and only a reader moving between two screens sees the product call one pile two things.
 *
 * ── WHY THE RETIRED TERMS ARE A SUBSTRING SWEEP OF THE WHOLE FILE ──────────────────────────────
 *
 * Renaming a view is not renaming a key. The view now called `News` was `Lesestoff` in nine leaves that ARE the view
 * name and in eight sentences that merely mention it — "Schau im Lesestoff", "der Lesestoff hat
 * eine Wasserlinie", "Ohbox, Lesestoff, Belege". A check over anchor keys passes with all eight
 * left behind, which is a half-renamed interface. So the retired words are asserted absent from the
 * raw file: the only form of the assertion that covers a sentence nobody thought to list.
 */
describe("the German glossary", () => {
  /** Each retired term and why it went. None of these may appear ANYWHERE in `de.json` again. */
  const RETIRED: Array<[string, string]> = [
    ["Lesestoff", "the pile keeps its English name — News, in every language; the folder behind it is ohmail/Reads"],
    ["Lektüre", "a stray German rendering of the News pile (postureWhy carried it) — the name is News everywhere"],
    ["Wiedervorlage", 'office-registry German for a plain thing; the pile is "Wieder auftauchen"'],
    ["wieder vorlegen", "the verb of the same retired term — the menu header and the shortcut carried it"],
    ["Schon gesehen", 'chatty for a section header sitting between "Neu" and "Älter"; it is "Gesehen"'],
  ];

  it("no retired term survives anywhere in the catalogue — not in a label, not in a sentence", () => {
    const raw = fs.readFileSync(path.join(MESSAGES, "de.json"), "utf8");
    const survivors = RETIRED.filter(([term]) => raw.includes(term)).map(([term, why]) => `${term} — ${why}`);
    expect(survivors, `retired glossary terms are back in de.json:\n  ${survivors.join("\n  ")}`).toEqual([]);
    // ANTI-VACUITY: a `de.json` this reader failed to open would also contain none of them.
    for (const replacement of ["News", "Wieder auftauchen", "Gesehen"]) {
      expect(raw, `${replacement} is missing — did the reader open the right file?`).toContain(replacement);
    }
  });

  /**
   * The English head term → the one German name for it. Read as: wherever a message IS exactly this
   * English view name, the German message must be exactly this word.
   */
  const GLOSSARY: Record<string, string> = {
    News: "News",
    Receipts: "Belege",
    "Screened out": "Aussortiert",
    Screened: "Aussortiert",
    "Answer Later": "Später antworten",
    Parked: "Geparkt",
    Resurface: "Wieder auftauchen",
    History: "Historie",
    "Reply Run": "Antwortrunde",
    Earlier: "Gesehen",
  };

  /**
   * THE ONE EXCEPTION — and the keys in it are not view names.
   *
   * `inplace.illusFolder*` label the folders in the "your own server" illustration: the literal
   * IMAP folder names a reader would see in Thunderbird. They stay English in every language for
   * the same reason `ohmail/Screener` beside them does — that is what is on the server.
   */
  const NOT_A_VIEW_NAME = new Set([
    "inplace.illusFolderB", "inplace.illusFolderC", "inplace.illusFolderD",
  ]);

  it("every message that IS a view name carries that view's one German name", () => {
    const en = leaves(read("en"));
    const de = leaves(read("de"));
    const drift: string[] = [];
    let checked = 0;
    for (const [key, english] of en) {
      if (NOT_A_VIEW_NAME.has(key)) continue;
      const wanted = GLOSSARY[english.trim()];
      if (wanted === undefined) continue;
      checked++;
      if (de.get(key) !== wanted) {
        drift.push(`${key}: "${english}" must be "${wanted}", is "${de.get(key)}"`);
      }
    }
    expect(drift, `the glossary is not being followed:\n  ${drift.join("\n  ")}`).toEqual([]);
    // A scan that matched nothing at all would otherwise be green.
    expect(checked).toBeGreaterThan(30);
  });

  it("the names that stay ENGLISH stay English, and the ones that do not, do not", () => {
    const de = leaves(read("de"));
    // `Ohbox` and `Screener` are what the product IS — a reader told about "the Screener" in a
    // review has to find that word in their own interface. `Spam` and `Triage` are the same word in
    // both languages. `News` is here because the pile keeps its English name in German too — the
    // word already reads natively; the IMAP folder behind the pile stays `ohmail/Reads`.
    expect(de.get("rail.ohbox")).toBe("Ohbox");
    expect(de.get("rail.screener")).toBe("Screener");
    expect(de.get("place.spam")).toBe("Spam");
    expect(de.get("triage.title")).toBe("Triage");
    expect(de.get("place.reads")).toBe("News");
    // …and the ones that have an ordinary German word use it.
    expect(de.get("place.receipts")).toBe("Belege");
    expect(de.get("place.screened")).toBe("Aussortiert");
  });

  it('History is NOT "Verlauf" — the catalogue already spends that word on a mail thread', () => {
    // `Verlauf` is the obvious German for a History view, and it is taken: `ohbox.threadMeta`,
    // `reply.conversationAria`, `reply.conversationCount` and four more use it for a CONVERSATION.
    // (`Archiv` is gone from Search since ARCHIVE-024: the scope is "dein ganzes Postfach".) A rail item reading "Verlauf" beside a
    // message badge reading "Verlauf (4)" would put one word on two different things, so History
    // stays "Historie" — the stiffer word, chosen because the plainer one is not free.
    const de = leaves(read("de"));
    expect(de.get("rail.history")).toBe("Historie");
    expect(de.get("ohbox.threadMeta")).toContain("Verlauf");
    expect(de.get("reply.conversationAria")).toBe("Verlauf");
    expect(de.get("search.scopeWholeSearching")).toContain("ganzes Postfach");
  });
});

describe("fillFrom — the runtime fallback behind the guard above", () => {
  it("takes German where it has a leaf and English everywhere else, at every depth", () => {
    const base = { a: "en-a", nested: { b: "en-b", c: "en-c" } };
    const over = { nested: { b: "de-b" } };
    expect(fillFrom(base, over)).toEqual({ a: "en-a", nested: { b: "de-b", c: "en-c" } });
  });

  it("a SHALLOW merge would have dropped `nested.c` — this is why the merge is deep", () => {
    const base = { nested: { b: "en-b", c: "en-c" } };
    const over = { nested: { b: "de-b" } };
    expect({ ...base, ...over }).toEqual({ nested: { b: "de-b" } });
    expect(fillFrom(base, over)).toEqual({ nested: { b: "de-b", c: "en-c" } });
  });

  it("an EMPTY German string is treated as absent — an unfilled placeholder must not blank a sentence", () => {
    expect(fillFrom({ a: "en-a" }, { a: "" })).toEqual({ a: "en-a" });
  });

  it("NEVER renders a raw key: a missing German key resolves to the English sentence", () => {
    const en = read("en");
    const merged = fillFrom(en, { settings: { language: "Sprache" } }) as Tree;
    const t = createTranslator({ locale: "de", messages: merged as never, namespace: "settings" });
    expect(t("language")).toBe("Sprache");
    // `theme` has no German leaf in this deliberately gap-ridden overlay.
    expect(t("theme")).toBe("Theme");
    expect(t("theme")).not.toContain("settings.theme");
  });
});

describe("normalizeLocale", () => {
  it("reduces a regional tag to its catalogue — a Swiss reader asking for de-CH gets German", () => {
    expect(normalizeLocale("de-CH")).toBe("de");
    expect(normalizeLocale("de_DE")).toBe("de");
    expect(normalizeLocale("DE")).toBe("de");
    expect(normalizeLocale("en-GB")).toBe("en");
  });

  it("answers null — not the default — for anything it does not recognise", () => {
    // The distinction is load-bearing: `null` means "nobody has said", which leaves a device's own
    // remembered language alone. Returning `en` here would make an account with no preference
    // silently reset a German browser to English on every boot.
    expect(normalizeLocale("fr")).toBeNull();
    expect(normalizeLocale("")).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
    expect(normalizeLocale("de-nonsense-but-de")).toBe("de");
  });

  it("isAppLocale refuses a near-miss rather than coercing it", () => {
    expect(isAppLocale("de")).toBe(true);
    expect(isAppLocale("de-CH")).toBe(false);
    expect(isAppLocale("")).toBe(false);
    expect(isAppLocale(7)).toBe(false);
  });
});
