import { beforeAll, describe, expect, it } from "vitest";
import { messageBodies } from "@trafficflow/db";
import { eszettForms } from "@trafficflow/db/dialect";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import { SearchService } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * ß AND ss FIND EACH OTHER: `Strassenbahn` found none of the letters spelled
 * `Straßenbahn` and answered closest words instead. Runs in the default project (PGlite, the
 * desktop's store) and the sqlite project (the phone's); the server's twin is
 * `search-eszett-fold.pg.test.ts`. One function, `eszettForms`, gives every store its forms.
 */
const CORPUS: ReadonlyArray<readonly [key: string, subject: string, body: string]> = [
  ["eszett-body", "Fahrplan", "Die Straßenbahn fährt ab Montag später."],
  ["ss-subject", "Strassenbahn Linie 4", "Neue Haltestelle."],
  ["eszett-street", "Umzug", "Neue Adresse: Schloßstraße 9."],
  ["decoy", "A stranger at the door", "Nothing about trams."],
];

describe("the ß/ss fold, on this store", () => {
  let found: (q: string) => Promise<{ tier: string; keys: string[] }>;
  beforeAll(async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx();
    const keyOf = new Map<string, string>();
    for (const [i, [key, subject, body]] of CORPUS.entries()) {
      const id = await seedMessage(db, accountId, mailboxId, {
        subject, from: `s${i}@site.example`, snippet: body, folder: "INBOX",
        date: new Date(Date.parse("2026-09-20T09:00:00Z") - i * 86_400_000),
      });
      await db.insert(messageBodies).values({ messageId: id, accountId, text: body });
      keyOf.set(id, key);
    }
    expect((await searchIndexBackfillPass({ db: db as never, accountId })).marked).toBe(true);
    found = async (q) => {
      const r = await new SearchService().search(ctx, { q, limit: 50 });
      return { tier: r.tier, keys: r.items.map((m) => keyOf.get(m.id)!).sort() };
    };
  }, 60_000);

  it.each([
    ["Strassenbahn", ["eszett-body", "ss-subject"]],
    ["Straßenbahn", ["eszett-body", "ss-subject"]],
    ["strassenb", ["eszett-body", "ss-subject"]],
    ["Schlossstrasse", ["eszett-street"]],
  ] as const)("%s finds both spellings, in the exact tier", async (q, keys) => {
    expect(await found(q)).toEqual({ tier: "exact", keys: [...keys] });
  });

  it("a word with neither reads as before (the positive control)", async () => {
    expect(await found("Fahrplan")).toEqual({ tier: "exact", keys: ["eszett-body"] });
  });
});

describe("eszettForms", () => {
  it("folds ß to ss and reads each ss both ways, the folded form first", () => {
    expect(eszettForms("Straßenbahn")).toEqual(["Strassenbahn", "Straßenbahn"]);
    expect(eszettForms("Strassenbahn")).toEqual(["Strassenbahn", "Straßenbahn"]);
    expect(eszettForms("Schloßstrasse").sort()).toEqual(["Schlossstrasse", "Schlossstraße", "Schloßstrasse", "Schloßstraße"].sort());
  });
  it("leaves a text with neither, and an excluded ss word, as typed", () => {
    expect(eszettForms("tram")).toEqual(["tram"]);
    expect(eszettForms("tram -strasse")).toEqual(["tram -strasse"]);
  });
  it("reads at most three ss both ways", () => {
    expect(eszettForms("ss ss ss ss")).toHaveLength(8);
  });
});
