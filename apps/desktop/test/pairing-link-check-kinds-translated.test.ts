import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { DEFAULT_LOCALE, fillFrom, setActiveCatalog } from "../../webapp/app/shell/locale";
import { HOST_REFUSAL_KINDS } from "../src/doors.js";
import { sentenceForKind } from "../src/DoorChooser.js";

/**
 * EVERY KIND THE LINK CHECK CAN ANSWER IS A SENTENCE IN BOTH CATALOGUES. `/cloud/probe` names its
 * refusals in `details.kind`, and the card showed the engine's English for every kind it did not
 * map, so a German window read "did not answer in time" in English. The kinds are read out of the
 * probe module and the pin probe with the TypeScript parser, never listed by hand.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");
const HOST = "kestrel";
/** Answered only to a check that names no address, which no pairing card sends. */
const NOT_A_PAIRING_ANSWER = ["origin_required"];

/** `kind: "<lit>"` anywhere, `refuse(msg, "<lit>")`, and `[msg, "<lit>"]` returned from a function. */
function probeKinds(source: string): string[] {
  const sf = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const literals = (node: ts.Expression): string[] => {
    if (ts.isStringLiteral(node)) return [node.text];
    if (ts.isConditionalExpression(node)) return [...literals(node.whenTrue), ...literals(node.whenFalse)];
    return [];
  };
  const walk = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(sf) === "kind") out.push(...literals(node.initializer));
    if (ts.isCallExpression(node) && node.expression.getText(sf) === "refuse" && node.arguments[1]) {
      out.push(...literals(node.arguments[1]));
    }
    if (ts.isReturnStatement(node) && node.expression && ts.isArrayLiteralExpression(node.expression)) {
      const second = node.expression.elements[1];
      if (second) out.push(...literals(second));
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
}

/** The literal members of `code` in the pin probe's refusal arm. */
function pinCodes(source: string): string[] {
  const sf = ts.createSourceFile("pin.ts", source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isPropertySignature(node) && node.name.getText(sf) === "code" && node.type && ts.isUnionTypeNode(node.type)) {
      for (const t of node.type.types) {
        if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) out.push(t.literal.text);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
}

const PROBE = read("apps/sidecar/src/cloud-probe.ts");
/* The handler passes the pin probe's code through, renaming one; the census applies the same rename
   and asserts the line that does it, so the two cannot part. */
const PIN_RENAME = 'kind: seen.code === "pin_changed" ? "pin_mismatch" : seen.code';
const KINDS = [...new Set([
  ...probeKinds(PROBE),
  ...pinCodes(read("apps/sidecar/src/host-pin-probe.ts")).map((c) => (c === "pin_changed" ? "pin_mismatch" : c)),
])].filter((k) => !NOT_A_PAIRING_ANSWER.includes(k)).sort();

afterEach(() => { setActiveCatalog(DEFAULT_LOCALE, null); });

function german(): void {
  const en = JSON.parse(read("apps/webapp/messages/en.json")) as never;
  setActiveCatalog("de", fillFrom(en, JSON.parse(read("apps/webapp/messages/de.json")) as never) as never);
}

describe("the link check's refusals are sentences in both catalogues", () => {
  it("the census reads the probe and the pin probe", () => {
    for (const k of ["cleartext", "no_pin", "pin_mismatch", "needs_setup", "status", "tls_name",
      "tls_validity", "refused", "timeout", "no_certificate", "pair_link_spent"]) {
      expect(KINDS, k).toContain(k);
    }
    expect(PROBE).toContain(PIN_RENAME);
    // The exclusion names something the probe really answers, or it is excluding nothing.
    for (const k of NOT_A_PAIRING_ANSWER) expect(probeKinds(PROBE)).toContain(k);
  });

  it("every kind is one the window knows, with an English sentence", () => {
    expect(KINDS.filter((k) => !(HOST_REFUSAL_KINDS as readonly string[]).includes(k))).toEqual([]);
    expect(KINDS.filter((k) => sentenceForKind(k, HOST) === null)).toEqual([]);
  });

  it("and every one reads German in a German window", () => {
    const english = new Map(KINDS.map((k) => [k, sentenceForKind(k, HOST)]));
    german();
    const untranslated = KINDS.filter((k) => {
      const de = sentenceForKind(k, HOST);
      return de === null || de === english.get(k) || de.includes("desktopDoor.");
    });
    expect(untranslated).toEqual([]);
  });

  it("the readers take the shapes they exist for, driven", () => {
    expect(probeKinds(`const a = { details: { kind: "x_one" } };
      refuse("words", "x_two");
      function f() { return ["message", "x_three"]; }
      const b = { kind: c ? "x_four" : other };
      const d = { code: "not_a_kind" };`).sort()).toEqual(["x_four", "x_one", "x_three", "x_two"]);
    expect(pinCodes(`type T = { ok: false; code: "a" | "b"; message: string } | { ok: true };`)).toEqual(["a", "b"]);
  });
});
