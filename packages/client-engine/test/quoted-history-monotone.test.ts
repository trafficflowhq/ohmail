/** @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as NEW from "../src/quoted-history.js";
import * as OLD from "./fixtures/quoted-history-0.30.16.js";
import { qhNorm } from "./quoted-history-fixtures.js";
import { qhProbeCases } from "./quoted-history-probes.js";

/**
 * MONOTONE FROM 0.30.16. Every generated probe (`quoted-history-probes.ts`) read by this engine and by
 * 0.30.16's, vendored byte for byte: a `same` case reads exactly as 0.30.16 reads it (the verdict, the
 * history it cuts, what stays visible, the text part alone and held by its html); an `owner` or `cost`
 * case folds at its header block, an owner's text part with it; an `open` case, new Outlook's history read
 * to its end, stays open where 0.30.16 folded it, its answer on screen; wherever 0.30.16 already folds, the
 * reading is 0.30.16's. The text part read alone is 0.30.16's in every case. New Outlook keeps a history open
 * wherever its Windows twin does.
 */
const ORACLE_SHA256 = "422239b896c3741854b135738292e030147e85cb2a85ce87892371896583f097";
/** The cut opens with the header block's first label, or the rule or attribution right above it. */
const AT_HEADER = /^(?:_{10,}\s*)?(?:Am \d.{0,120}?schrieb [^:]*:\s*)?(?:Von|From):/;

type Engine = typeof OLD;

function read(engine: Engine, html: string, subject?: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = doc.body as unknown as OLD.QuotedDomNode;
  const r = engine.quotedHistoryReadingOfHtml(root, engine.quotedDomTree, { subject });
  let history = "";
  if (r.range !== null) {
    const cut = engine.quotedHistoryCut(root, engine.quotedDomTree, r.range);
    history = qhNorm(cut.history.map((n) => (n as unknown as Node).textContent ?? "").join(" "));
    for (const n of cut.history) (n as unknown as ChildNode).remove();
  }
  return { verdict: r.verdict, at: r.range?.at ?? null, history, visible: qhNorm(doc.body.textContent ?? "") };
}

describe("the oracle", () => {
  it("is 0.30.16's engine, byte for byte", () => {
    const bytes = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "quoted-history-0.30.16.ts"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(ORACLE_SHA256);
  });
});

describe("monotone from 0.30.16", () => {
  for (const c of qhProbeCases()) {
    it(`${c.family} ${c.name} [${c.label}]`, () => {
      const lines = c.text?.split("\n");
      const hint = { subject: c.subject };
      if (lines) expect(NEW.quotedHistoryOfText(lines, hint), "the text part alone").toEqual(OLD.quotedHistoryOfText(lines, hint));
      if (c.html === null) return;
      const was = read(OLD, c.html, c.subject);
      const now = read(NEW as Engine, c.html, c.subject);
      if (c.label === "open") {
        expect(was.verdict, "0.30.16 folds it").toBe("trailing");
        expect(now.verdict, "it stays open").toBeNull();
        expect(now.history, "nothing is cut").toBe("");
        if (c.answer) expect(now.visible, "the answer is on screen").toContain(qhNorm(c.answer));
        if (lines) expect(NEW.quotedHistoryOfText(lines, { ...hint, html: now.verdict }), "the text part held by its html").toBeNull();
        return;
      }
      if (c.label === "same" || was.verdict === "trailing") {
        expect(now, "0.30.16's verdict and cut").toEqual(was);
        if (lines) {
          expect(NEW.quotedHistoryOfText(lines, { ...hint, html: now.verdict }), "the text part held by its html")
            .toEqual(OLD.quotedHistoryOfText(lines, { ...hint, html: was.verdict }));
        }
      }
      if (c.label === "same") return;
      expect(now.verdict, "it folds").toBe("trailing");
      expect(now.history, "at the header block").toMatch(AT_HEADER);
      if (lines && c.label === "owner") expect(NEW.quotedHistoryOfText(lines, { ...hint, html: now.verdict }), "its text part folds too").not.toBeNull();
    });
  }
});

describe("new Outlook reads as its Windows twin", () => {
  const cases = qhProbeCases();
  const byName = new Map(cases.map((c) => [`${c.family} ${c.name}`, c]));
  for (const c of cases) {
    if (c.html === null || !c.name.startsWith("132 ")) continue;
    for (const id of ["133", "135"]) {
      const twin = byName.get(`${c.family} ${id} ${c.name.slice(4)}`);
      if (!twin?.html) continue;
      it(`${c.family} ${c.name} [${id}]`, () => {
        if (read(NEW as Engine, twin.html!, twin.subject).verdict !== null) return;
        const now = read(NEW as Engine, c.html!, c.subject);
        expect(now.verdict, `its ${id} twin stays open`).toBeNull();
        if (c.answer) expect(now.visible, "the answer is on screen").toContain(qhNorm(c.answer));
      });
    }
  }
});
