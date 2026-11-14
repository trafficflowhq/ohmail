import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sliceOfDeclaration } from "./source-anchor";

/**
 * A BULK TAG WRITES ASSIGNMENTS ONLY. MOVED word for word (share ohbox-2) from `tags-admin.test.ts`, whose other cases
 * draw today's Settings view: this census read the shell's `bulkToggleTag`, which moved out of today's shell into the
 * press's own file that every list place's verbs call (`packages/app-logic/src/press/list-verbs.ts`); it is re-pointed
 * there by path, its expectation untouched.
 */
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("bulk tag-assign writes assignments only", () => {
  it("the bulk-tag verb fans out tag_assign and never promotes a rule", () => {
    // A bulk tag over a selection is `bulkToggleTag` — the whole path. It must dispatch
    // `tag_assign` per message and nothing that writes a rule: "always tag this sender" is an
    // explicit rule the user makes, never inferred from a bulk act. Same standard
    // `planBulkScreening` states when it passes `makeRule: false`. Read from the function body so
    // an added rule/decide dispatch inside it trips this. The mutation-level proof is in
    // `packages/client-engine/test/tag-crud-wire.test.ts`; this pins the shell caller too.
    const verbs = read("../../../packages/app-logic/src/press/tag-verbs.ts");
    const block = sliceOfDeclaration(verbs, "bulkToggleTag");
    expect(block).toMatch(/kind: "tag_assign"/);
    expect(block).not.toMatch(/kind: "rule_create"/);
    expect(block).not.toMatch(/kind: "screener_decide"/);
  });
});
