/**
 * THE FIRST-RUN FLOW'S COPY, JUDGED AGAINST THE CODE.
 *
 * Claims are contracts. The consent screen is the one place in the product where a person is asked
 * to agree to something before it happens, so every sentence on it has to be true of what the
 * mechanism then does — and the specific failure this file exists to prevent is TRUE BY OMISSION.
 * An earlier draft of the consent sentence named four destinations. There are six. Somebody who
 * agreed to that sentence and later found mail in `ohmail/Screened` or `ohmail/Quarantine` was
 * told the truth and not the whole of it, which for a consent screen is the same as being told
 * something false.
 *
 * So the destination pin is built FROM `DESTINATIONS` in the code, never from a list typed here: a
 * seventh folder added tomorrow makes this red until the sentence names it.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DESTINATIONS } from "@trafficflow/core/destinations";

const MESSAGES = path.join(__dirname, "..", "messages");
const read = (lang: "en" | "de"): Record<string, Record<string, string>> =>
  JSON.parse(fs.readFileSync(path.join(MESSAGES, `${lang}.json`), "utf8"));

const EN = read("en");
const DE = read("de");
const ob = (lang: "en" | "de"): Record<string, string> => (lang === "en" ? EN : DE).onboarding;

/**
 * What each organized destination is CALLED in each language.
 *
 * Five of the six come from the catalogue's own `place.*` leaves, which is what makes this a pin
 * rather than a second copy of the copy — rename a pile in `place.*` and the consent sentence has
 * to follow or this goes red. `ohmail/Quarantine` has no `place.*` leaf (the rail shows Spam, and
 * Quarantine is where a spam decision files mail), so its two names are named here, which is the
 * honest version of "this one is not derivable".
 */
const NAME_OF: Record<string, { en: string; de: string }> = {
  INBOX: { en: EN.place.ohbox, de: DE.place.ohbox },
  "ohmail/Screener": { en: EN.place.screener, de: DE.place.screener },
  /* Named directly, Quarantine's own precedent: since the 0.22 folder rename the consent
     sentence names the FOLDER other clients will show (`ohmail/News` — the leaf check below
     pins it), and the pile's `place.reads` word converges on the same string when the UI
     rename (RENAME-021) is in the tree. Deriving from `place.reads` here would couple this
     pin to that lane's landing order for no extra truth. */
  "ohmail/News": { en: "News", de: "News" },
  "ohmail/Receipts": { en: EN.place.receipts, de: DE.place.receipts },
  "ohmail/Screened": { en: EN.place.screened, de: DE.place.screened },
  "ohmail/Quarantine": { en: "Quarantine", de: "Quarantäne" },
};

describe("the consent sentence names every place mail can be put", () => {
  it("covers ALL of DESTINATIONS, in both languages — no destination true by omission", () => {
    // Anti-vacuity first: a `DESTINATIONS` this test failed to import would make the loop below
    // pass over nothing at all.
    expect(DESTINATIONS.length).toBe(6);
    for (const lang of ["en", "de"] as const) {
      const body = ob(lang).consentBody;
      const missing = DESTINATIONS.filter((d) => {
        const name = NAME_OF[d];
        expect(name, `no name recorded for ${d} — a destination was added`).toBeDefined();
        return !body.includes(name![lang]);
      });
      expect(missing, `${lang}: consentBody does not name ${missing.join(", ")}`).toEqual([]);
    }
  });

  it("every destination has a recorded name, so a new folder cannot slip past the loop", () => {
    expect(DESTINATIONS.filter((d) => !NAME_OF[d])).toEqual([]);
  });

  /**
   * ── AND IT NAMES THE FOLDER THE OTHER MAIL CLIENT WILL SHOW ────────────────────────────
   *
   * The case above pins the LABEL, from `place.*`. In English that is the whole story: the pile
   * is called Receipts and the folder is `ohmail/Receipts`. In German the two diverge, and the
   * sentence used to name only the label — so a reader agreed to folders called "Belege",
   * "Aussortiert" and "Quarantäne", and then opened Thunderbird and found `ohmail/Receipts`,
   * `ohmail/Screened` and `ohmail/Quarantine`. The folder names are English constants in
   * `packages/core`, in every locale, because they are names on somebody's mail server.
   *
   * A consent screen is exactly where "true, but not the name you will see" is not good enough.
   * So the sentence carries both, and this holds it to the LEAF as the code writes it — derived
   * from `DESTINATIONS`, not typed, so a renamed folder makes it red.
   */
  it("names the folder as the mailbox will show it, in both languages", () => {
    for (const lang of ["en", "de"] as const) {
      const body = ob(lang).consentBody;
      const missing = DESTINATIONS.filter((d) => d !== "INBOX" && !body.includes(d.split("/")[1]!));
      expect(
        missing,
        `${lang}: consentBody does not name the folder leaf for ${missing.join(", ")} — `
          + "a reader opening another mail client would not recognise what they agreed to",
      ).toEqual([]);
    }
  });

  it("never lists an Ohbox folder as created — the Ohbox is the Inbox (R23-05)", () => {
    // Somebody who opens another mail client looks for what the Done screen said was created.
    // `DESTINATIONS` has no Ohbox folder: that pile IS `INBOX`, so it may be named only as such.
    const created = DESTINATIONS.filter((d) => d !== "INBOX").map((d) => d.split("/")[1]!);
    for (const lang of ["en", "de"] as const) {
      const list = ob(lang).doneWhere.split(" — ")[0]!;
      expect(list, `${lang}: the created-folders row names the Ohbox`).not.toContain(NAME_OF.INBOX![lang]);
      expect(created.filter((leaf) => !list.includes(leaf)), `${lang}: a created folder is missing`).toEqual([]);
    }
    expect(ob("en").consentBody).toContain("The Ohbox is your Inbox");
    expect(ob("de").consentBody).toContain("Die Ohbox ist deine Inbox");
  });

  it("says the folders are ordinary IMAP folders other clients can see", () => {
    // The load-bearing half of the promise: these are real folders in the person's own mailbox,
    // not a private view, which is what makes leaving cost nothing.
    expect(ob("en").consentBody).toMatch(/IMAP/);
    expect(ob("de").consentBody).toMatch(/IMAP/);
  });
});

describe("History is described as a VIEW, because that is what it is", () => {
  it("says older mail STAYS where it is and that nothing in History moves", () => {
    // The mechanism: mail older than the window is not moved anywhere. It stays physically in the
    // Inbox and is LISTED under History. A sentence implying a move would describe a filing this
    // product deliberately does not do — and would make "widen the window later" sound like an
    // undo of something rather than a change of what is asked about.
    const en = ob("en").consentHistory;
    expect(en).toMatch(/stays in the Inbox/i);
    expect(en).toMatch(/History is a view/i);
    expect(en).toMatch(/nothing in it moves/i);
    const de = ob("de").consentHistory;
    expect(de).toMatch(/bleiben in der Inbox/i);
    expect(de).toMatch(/Historie ist eine Ansicht/i);
  });

  it("`windowLater` describes the real mechanism: senders become undecided, a decision moves mail", () => {
    // Widening the window is PRESENTATION. It moves nothing by itself; it puts older senders back
    // into the Screener queue as undecided, and only a decision files that sender's mail. Copy
    // that promised a re-filing pass would be promising a backlog sweep that does not exist.
    expect(ob("en").windowLater).toMatch(/Screener/);
    expect(ob("en").windowLater).toMatch(/undecided/i);
    expect(ob("en").windowLater).toMatch(/a decision moves/i);
    expect(ob("de").windowLater).toMatch(/unentschieden/i);
    expect(ob("de").windowLater).toMatch(/verschiebt/i);
  });
});

describe("no rate is a literal — the number comes from the client's own measurement", () => {
  it("neither catalogue states a messages-per-minute figure", () => {
    // The ETA's rate is measured from the mirror's rolling growth on the device that is importing.
    // A literal in the catalogue would be a speed promised to every person on every connection,
    // and it would be wrong for almost all of them. The placeholder form `{rate, number} messages
    // a minute` is what this permits; a literal rate (`<digits> messages a minute`) is what it forbids.
    const RATE_LITERAL = /\d+\s*(messages|Nachrichten)\s*(a|pro)\s*minute/i;
    for (const [lang, cat] of [["en", EN], ["de", DE]] as const) {
      const offenders: string[] = [];
      for (const [ns, body] of Object.entries(cat)) {
        if (typeof body !== "object" || body === null) continue;
        for (const [k, v] of Object.entries(body)) {
          if (typeof v === "string" && RATE_LITERAL.test(v)) offenders.push(`${ns}.${k}: ${v}`);
        }
      }
      expect(offenders, `${lang} states a literal rate:\n  ${offenders.join("\n  ")}`).toEqual([]);
    }
  });

  it("ANTI-VACUITY: the pattern really does catch a literal rate", () => {
    // A regex that matched nothing would make the sweep above green for ever. This proves the
    // sweep is looking for something findable.
    const RATE_LITERAL = /\d+\s*(messages|Nachrichten)\s*(a|pro)\s*minute/i;
    expect(RATE_LITERAL.test("About 4 minutes left · 210" + " messages a minute")).toBe(true);
    expect(RATE_LITERAL.test("Noch etwa 4 Minuten · 210 Nachrichten pro Minute")).toBe(true);
    // …and that the shipped sentence, which uses a placeholder, is not caught by it.
    expect(RATE_LITERAL.test(ob("en").eta)).toBe(false);
    expect(RATE_LITERAL.test(ob("de").eta)).toBe(false);
  });

  it("the ETA sentence takes its rate as an argument rather than stating one", () => {
    expect(ob("en").eta).toContain("{rate");
    expect(ob("de").eta).toContain("{rate");
  });
});

describe("the success verdict promises exactly what the probe answers", () => {
  it("`probeOk` interpolates the host, the user and the folder count — and nothing else", () => {
    // `POST /mailboxes/probe` answers `{ ok, host, user, folders }`. A sentence naming a fourth
    // fact would be a sentence the endpoint cannot fill, which is how a verdict ends up rendering
    // a raw placeholder at the one moment a person is deciding whether to trust the thing.
    for (const lang of ["en", "de"] as const) {
      // `[A-Za-z]\w*`, not `\w+`: the sentence carries an ICU plural, and its inner branches are
      // themselves braced (`{count, plural, one {1 folder} other {# folders}}`). A looser pattern
      // reads `{1` as an argument named "1" — which it did, first run. An ICU argument name cannot
      // begin with a digit or `#`, so anchoring on a letter picks out exactly the top-level three.
      const args = new Set([...ob(lang).probeOk.matchAll(/\{\s*([A-Za-z]\w*)/g)].map((m) => m[1]!));
      expect([...args].sort()).toEqual(["count", "host", "user"]);
    }
  });

  it("`probeOkDetail` says nothing was read or moved, because nothing was", () => {
    // The test action opens one connection, counts folders and closes. It creates no mailbox,
    // stores no credential and moves no mail — and the person about to type a password is owed
    // that sentence at exactly that moment.
    expect(ob("en").probeOkDetail).toMatch(/Nothing has been read or moved/i);
    expect(ob("de").probeOkDetail).toMatch(/Nichts wurde gelesen oder verschoben/i);
  });

  it("the failure sentences are the mailbox pane's, not a second set", () => {
    // The whole reason the probe route throws `probeRefused`: one taxonomy, one set of sentences.
    // A `probe_*` key appearing under `onboarding` would be the beginning of a second vocabulary
    // for one set of failures.
    const dupes = Object.keys(ob("en")).filter((k) => /^probe_/.test(k));
    expect(dupes, "onboarding must not restate the probe failures").toEqual([]);
    expect(Object.keys(EN.mailboxes).filter((k) => /^probe_/.test(k)).length).toBeGreaterThan(10);
  });
});

describe("the claim screen states what it costs the other install", () => {
  it("`elsewhereChoiceHereWhy` says the other side becomes a READER and keeps its mail", () => {
    // The demotion keeps the loser's mirror, its credentials and its consent; it loses the role
    // and any unspent stamp. Copy that said the other install stops working, or loses its mail,
    // would describe the design this one deliberately replaced.
    expect(ob("en").elsewhereChoiceHereWhy).toMatch(/reader/i);
    expect(ob("en").elsewhereChoiceHereWhy).toMatch(/keeps its copy/i);
    expect(ob("de").elsewhereChoiceHereWhy).toMatch(/Leser/);
    expect(ob("de").elsewhereChoiceHereWhy).toMatch(/behält/i);
  });

  it("and says WHEN — on the next pass, never immediately", () => {
    // The role flips at the worker's gate on its next tick. A sentence promising an immediate
    // handover would be wrong by up to a cycle, on the one screen where somebody is watching.
    expect(ob("en").elsewhereChoiceHereWhy).toMatch(/next pass/i);
    expect(ob("de").elsewhereChoiceHereWhy).toMatch(/nächsten Durchgang/i);
  });

  it("never tells anybody to quit and reopen the app", () => {
    // That instruction was true when the engine only checked its claim at launch. It takes over on
    // its next pass now, so the sentence would ask for something that neither is needed nor helps.
    for (const lang of ["en", "de"] as const) {
      const offenders = Object.entries(ob(lang))
        .filter(([, v]) => /quit and (re)?open|beenden und .* öffnen|neu starten/i.test(v));
      expect(offenders.map(([k]) => k)).toEqual([]);
    }
  });
});

describe("the phone is a reader and says so", () => {
  it("`phoneBannerWhy` says decisions are made where the mailbox is organized", () => {
    // The phone pairs and reads. It takes no Screener decisions, so a banner that implied it could
    // would be offering a verb the door does not have.
    expect(ob("en").phoneBannerWhy).toMatch(/reads the mailbox/i);
    expect(ob("en").phoneBannerWhy).toMatch(/where it is organized/i);
    expect(ob("de").phoneBannerWhy).toMatch(/liest das Postfach/i);
    expect(ob("de").phoneBannerWhy).toMatch(/organisiert/i);
  });
});
