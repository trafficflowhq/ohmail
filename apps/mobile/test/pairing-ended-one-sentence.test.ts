/**
 * ONE SENTENCE FOR A PAIRING THAT ENDED. Three spellings shipped — the refused token, the swept
 * family, the Servers pane's own line — and one pairing presented from three simulators at once
 * was refused by the server's clone defence, which is the design; what a person read was a
 * different sentence on each device for one cause, and none of them said what to do. Measured on
 * the iPhone 18 Pro and the iPad.
 *
 * What this file holds: every door answers with the same key, the sentence carries its remedy in
 * both languages, the verb beside it is the same word, the CAUSE goes to the log and not to the
 * person — and no fifth spelling can arrive in the deck without this going red.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import { sayRefusal } from "../src/refusal";
import { deathRefusal, isPairEnded, noteSessionDeath } from "../src/net/session-death";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

describe("every door that ends a pairing says the same thing", () => {
  it("both deaths the server can report answer with the one key", () => {
    for (const why of ["refused", "revoked"] as const) {
      expect(deathRefusal(why).say).toBe("pairEnded");
      expect(isPairEnded(deathRefusal(why))).toBe(true);
    }
  });

  it("the credential-less profile refuses with the same key", () => {
    // `connectProfile`'s own arm, read from its source: driving it needs a keystore and a
    // server, and `standalone-adopt.test.ts` does exactly that — what is owed HERE is that the
    // two doors cannot drift apart, which is a question about the key they name.
    const src = fs.readFileSync(path.join(APP, "src", "net", "pairing.ts"), "utf8");
    const keys = [...src.matchAll(/refuse\("(pair[A-Za-z]*End[A-Za-z]*)"\)/g)].map((m) => m[1]);
    expect(keys).toEqual(["pairEnded"]);
  });

  it("the sentence ends in the remedy, in both languages", () => {
    expect(EN.pairEnded).toContain("Pair this phone again.");
    expect(DE.pairEnded).toContain("Koppele dieses Handy erneut.");
    // The verb beside it is one word in each deck, and the two decks are not the same string.
    expect(EN.pairAgain).toBe("Pair again");
    expect(DE.pairAgain).toBe("Erneut koppeln");
  });

  it("the sentence does not carry the cause — the log does", () => {
    const said = sayRefusal(deathRefusal("revoked"));
    for (const leak of ["twice", "token", "zweimal", "Token"]) expect(said).not.toContain(leak);
    const lines: string[] = [];
    noteSessionDeath("revoked", (l) => lines.push(l));
    noteSessionDeath("refused", (l) => lines.push(l));
    expect(lines).toEqual([
      '{"service":"pairing","event":"session_dead","why":"revoked"}',
      '{"service":"pairing","event":"session_dead","why":"refused"}',
    ]);
    // A closed set of two literals, which is why this is one line and not a second logger:
    // nothing a person or a mailbox owns can reach it.
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });
});

/**
 * THE FIFTH SPELLING. The deck is the only place a sentence may live, so a new way of saying
 * this can only arrive as a new key — and it would pass every other test in this repo.
 */
describe("no second way of saying it", () => {
  const rendered = (deck: Record<string, unknown>): [string, string][] => {
    const out: [string, string][] = [];
    for (const [k, v] of Object.entries(deck)) {
      if (typeof v === "string") out.push([k, v]);
      else if (typeof v === "function" && v.length <= 3) {
        try {
          out.push([k, String((v as (...a: unknown[]) => unknown)("«a»", "«b»", "«c»"))]);
        } catch { /* a getter that needs a real shape says nothing about this sentence */ }
      }
    }
    return out;
  };

  it("exactly one English key speaks of a pairing having ended", () => {
    const hits = rendered(EN).filter(([, v]) => /pairing (has )?ended|signed out|signs you out/i.test(v));
    expect(hits.map(([k]) => k)).toEqual(["pairEnded"]);
  });

  it("exactly one German key does", () => {
    const hits = rendered(DE).filter(([, v]) => /Kopplung[^.]*beendet|abgemeldet/i.test(v));
    expect(hits.map(([k]) => k)).toEqual(["pairEnded"]);
  });

  it("the census can find a second one — the positive control", () => {
    const planted = { ...EN, someNewRefusal: "Signed out: this pairing ended somewhere else." };
    const hits = rendered(planted).filter(([, v]) => /pairing (has )?ended|signed out|signs you out/i.test(v));
    expect(hits.map(([k]) => k).sort()).toEqual(["pairEnded", "someNewRefusal"]);
  });
});

/**
 * THE VERB IS IN REACH WHEREVER THE SENTENCE IS. A remedy in a sentence is not a control: a
 * screen reader needs something named to press, and the row's press was the only way back.
 */
describe("the Servers pane offers the verb", () => {
  const file = path.join(APP, "app", "servers.tsx");
  const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  it("two buttons labelled with the one verb, each pushing the scanner", () => {
    const found: string[] = [];
    const visit = (n: ts.Node): void => {
      const open = ts.isJsxSelfClosingElement(n) ? n : ts.isJsxElement(n) ? n.openingElement : null;
      if (open && open.tagName.getText() === "Button") {
        const attrs = open.attributes.properties
          .filter(ts.isJsxAttribute)
          .map((a) => `${a.name.getText()}=${a.initializer?.getText() ?? ""}`)
          .join(" ");
        if (attrs.includes("Copy.pairAgain")) found.push(attrs);
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
    expect(found).toHaveLength(2);
    for (const attrs of found) expect(attrs).toContain('router.push("/scan")');
  });
});
