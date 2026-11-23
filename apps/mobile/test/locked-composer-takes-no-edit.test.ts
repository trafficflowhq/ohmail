import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { editWhileIdle } from "../src/ui/compose-edit";
import type { ComposerPhase } from "../src/ui/send-cancel";

/* @reads: apps/mobile/src/ui/MessageActions.tsx */
const SHEET = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/ui/MessageActions.tsx"), "utf8");

/**
 * REPRESS-OFFLINE-REPLY-SENDS-THE-EARLIER-WORDS (FREEZE-02513, on an APK): a reply pressed offline
 * locks its composer, and `editable={false}` did not stop the test keyboard from committing new words
 * into the field while the queued send carried the first ones. Every composer field's change goes
 * through `editWhileIdle`: driven here for each phase, and the sheet read to prove all four take it.
 */
describe("the locked composer takes no edit", () => {
  for (const phase of ["sending", "queued", "unverified"] as ComposerPhase[]) {
    it(`a change while ${phase} reaches no field`, () => {
      const seen: string[] = [];
      editWhileIdle(phase, (v: string) => seen.push(v))("edited words");
      expect(seen).toEqual([]);
    });
  }

  it("CONTROL: a change while idle reaches the field", () => {
    const seen: string[] = [];
    editWhileIdle("idle", (v: string) => seen.push(v))("edited words");
    expect(seen).toEqual(["edited words"]);
  });

  it("all four of the sheet's text fields take their change through it", () => {
    const tree = ts.createSourceFile("MessageActions.tsx", SHEET, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const fields: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) && ["TextInput", "RecipientInput"].includes(node.tagName.getText(tree))) {
        const props = node.attributes.properties.filter(ts.isJsxAttribute);
        const value = props.find((prop) => prop.name.getText(tree) === "value")?.initializer?.getText(tree);
        const field = /^\{(to|subject|body|sigText)\}$/.exec(value ?? "")?.[1];
        if (field) {
          fields.push(field);
          const change = props.find((prop) => prop.name.getText(tree) === "onChangeText");
          expect(change?.getText(tree), `${field} takes a change outside idle`).toMatch(/^onChangeText=\{editWhileIdle\(phase, /);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(fields.sort(), "a composer field moved out of reach").toEqual(["body", "sigText", "subject", "to"]);
  });
});
