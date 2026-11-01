import { beforeAll, describe, expect, it } from "vitest";
import { messageBodies } from "@trafficflow/db";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import { SearchService } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * A PUNCTUATED QUERY IS ANSWERED ALIKE ON BOTH STORES: this file runs in the default project
 * (Postgres, as PGlite) and in the sqlite project (the device store), and every expected set below
 * is what Postgres answers — so a green on both is the parity. Watched red at the base on the
 * device store for `o'brien's`, the stopwords, `NOT`, `--fixture` and a hyphen beside a stopword.
 */
const CORPUS: ReadonlyArray<readonly [key: string, subject: string, body: string]> = [
  ["hyph", "Your ohmail-fixture report", "Attached."], ["spaced", "The ohmail fixture list", "Attached."],
  ["joined", "ohmailfixture notes", "Attached."], ["bodyhyph", "Weekly", "The sign-in code is below."],
  ["bodysplit", "Weekly two", "Your sign in code is below."], ["signin", "signin code", "Here."],
  ["onetime", "A one-time passcode", "Use it once."], ["email", "Your e-mail address", "Confirm it."],
  ["coop", "The co-op meeting", "Agenda."], ["coopspaced", "co op notes", "Agenda."],
  ["obrien", "Letter from O'Brien", "Regards."], ["obriens", "OBrien visit", "Regards."],
  ["dont", "Don't forget", "Tomorrow."], ["ver", "Release notes", "Release 3.14 is out."],
  ["nodejs", "node.js upgrade", "Done."], ["andor", "Terms and/or conditions", "Read them."],
  ["path", "Docs", "See docs/setup for details."], ["near", "NEAR the station", "Meet there."],
  ["not", "Status", "NOT delivered yet."], ["addr", "Contact", "Write to desk@site.example today."],
  ["time", "Agenda", "The 10:30 meeting moved."], ["report", "Quarterly report attached", "Figures."],
  ["signed", "Please sign here", "Thanks."], ["overview", "Slides", "The project overview is attached."],
  ["decoy", "Holiday plans", "See you soon."],
];

/** Query → the keys Postgres answers in the exact tier; `[]` is no exact match on this corpus. */
const POSTGRES: ReadonlyArray<readonly [q: string, keys: readonly string[]]> = [
  ["ohmail-fixture", ["hyph", "spaced"]], ["sign-in code", ["bodyhyph", "bodysplit", "signin"]],
  ["sign-in", ["bodyhyph", "bodysplit", "signed", "signin"]], ["one-time", ["onetime"]], ["e-mail", ["email"]],
  ["the-report", ["hyph", "report"]], ["O'Brien", ["obrien"]], ["o'brien's", ["obrien"]], ["don't", ["dont"]],
  ["it's", []], ["3.14", ["ver"]], ["node.js", ["nodejs"]], ["desk@site.example", ["addr"]], ["and/or", ["andor"]],
  ["docs/setup", ["path"]], ["10:30", ["time"]], ["30:10", ["time"]], ["-fixture code(sign)", ["bodyhyph", "bodysplit", "signin"]], ["report:quarterly", ["report"]], ["NEAR", ["near"]],
  ["NEAR(station)", ["near"]], ["AND", ["andor"]], ["NOT", ["coopspaced", "joined", "ver"]],
  ["NOT delivered", ["not"]], ["the report", ["hyph", "report"]], ["report of the", ["hyph", "report"]],
  // An excluded word only leaves letters out: `-the` is a stopword and leaves out none.
  ["ohmail -the", ["hyph", "joined", "spaced"]], ["--fixture", ["hyph", "spaced"]], ["-fixture ohmail", ["joined"]],
  ["fixture*", ["hyph", "spaced"]], ["+fixture", ["hyph", "spaced"]], ["over", ["overview"]], ["C++", []], ["***", []],
];

/**
 * THE ONE DIFFERENCE, bounded: the device index reads no punctuation, so where the server's word
 * arms keep a hyphenated compound whole (quoted, OR, or no part of four letters) the device also
 * finds the same words written apart. Its answer holds the server's and adds only those.
 */
const SPACED: ReadonlyArray<readonly [q: string, keys: readonly string[], spaced: readonly string[]]> = [
  ['"ohmail-fixture"', ["hyph"], ["spaced"]], ['"sign-in"', ["bodyhyph"], ["bodysplit"]], ["co-op", ["coop"], ["coopspaced"]], ["and-or", [], ["andor"]],
  ["ohmail-fixture OR node.js", ["hyph", "nodejs"], ["spaced"]],
  ["sign-in OR co-op", ["bodyhyph", "coop"], ["bodysplit", "coopspaced"]],
];

describe.each([
  ["with the search documents built", true],
  ["before the documents are built (the rows' own columns)", false],
])("a punctuated query answers what Postgres answers — %s", (_label, built) => {
  let answer: (q: string) => Promise<{ tier: string; keys: string[] }>;
  beforeAll(async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const keyOf = new Map<string, string>();
    for (const [i, [key, subject, body]] of CORPUS.entries()) {
      const id = await seedMessage(db, accountId, mailboxId, {
        subject, from: `s${i}@site.example`, snippet: body, folder: "INBOX",
        date: new Date(Date.parse("2026-07-20T09:00:00Z") - i * 86_400_000),
      });
      await db.insert(messageBodies).values({ messageId: id, text: body });
      keyOf.set(id, key);
    }
    if (built) expect((await searchIndexBackfillPass({ db: db as never, accountId })).marked).toBe(true);
    answer = async (q) => {
      const r = await new SearchService().search(ctx, { q, limit: 50 });
      return { tier: r.tier, keys: r.items.map((m) => keyOf.get(m.id)!).sort() };
    };
  }, 60_000);

  it(`${POSTGRES.length} punctuated queries: the same exact-tier answer as Postgres`, async () => {
    const wrong: Array<{ q: string; got: string[]; want: string[] }> = [];
    for (const [q, keys] of POSTGRES) {
      const got = await answer(q);
      const have = got.tier === "exact" ? got.keys : [];
      const want = [...keys].sort();
      if (have.join() !== want.join()) wrong.push({ q, got: have, want });
    }
    expect(wrong).toEqual([]);
  });

  it("a hyphenated compound the server keeps whole: the server's answer, plus only the words written apart", async () => {
    for (const [q, keys, spaced] of SPACED) {
      const got = new Set((await answer(q)).keys);
      expect({ q, missing: keys.filter((k) => !got.has(k)) }).toEqual({ q, missing: [] });
      const allowed = new Set([...keys, ...spaced]);
      expect({ q, extra: [...got].filter((k) => !allowed.has(k)) }).toEqual({ q, extra: [] });
    }
  });
});

/**
 * A HYPHENATED QUERY OVER MAIL THAT SPELLS IT APART stays in the exact tier: the server's word
 * arms read `sign-in` as its compound, so before the part-word arm a mailbox holding only `sign in
 * code` answered it with the closest-words pass — the end-to-end reading of a slow page. Both stores.
 */
describe("a hyphenated query over mail that writes the words apart", () => {
  it("answers in the exact tier, never the closest-words pass", async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const ids: string[] = [];
    for (const [i, [subject, body]] of [["Verify", "Your sign in code is 482913."], ["Login", "Use this one time passcode."]].entries()) {
      const id = await seedMessage(db, accountId, mailboxId, { subject, from: `s${i}@site.example`, snippet: body, folder: "INBOX" });
      await db.insert(messageBodies).values({ messageId: id, text: body });
      ids.push(id);
    }
    for (const [q, at] of [["sign-in code", 0], ["one-time", 1], ["one-time passcode", 1]] as const) {
      const r = await new SearchService().search(ctx, { q, limit: 50 });
      expect({ q, tier: r.tier, found: r.items.some((m) => m.id === ids[at]) }).toEqual({ q, tier: "exact", found: true });
    }
  });
});
