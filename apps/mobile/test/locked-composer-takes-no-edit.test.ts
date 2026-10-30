import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
    const inputs = SHEET.split(/<(?:TextInput|RecipientInput)\b/).slice(1).map((chunk) => chunk.slice(0, chunk.indexOf("/>")));
    const fields = inputs.filter((i) => /value=\{(to|subject|body|sigText)\}/.test(i));
    expect(fields.map((f) => /value=\{(\w+)\}/.exec(f)![1]).sort(), "a composer field moved out of reach").toEqual(["body", "sigText", "subject", "to"]);
    for (const f of fields) expect(f, "a composer field takes a change outside idle").toContain("onChangeText={editWhileIdle(phase, ");
  });
});
