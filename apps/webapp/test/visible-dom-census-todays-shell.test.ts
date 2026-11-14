import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** These source checks cover the legacy shell. The companion census continues to check the active frame and shared application logic. */
const APP = join(__dirname, "..", "app");

describe("the shell's document queries skip hidden piles", () => {
  it("the census bites: the queries it moved are still spelled the way it reads", () => {
    for (const [file, needle] of [
      ["shell/shell-keys.tsx", 'queryVisible<HTMLButtonElement>(".abar-delete .abar-danger")'],
      ["shell/message-verbs.ts", 'queryVisible<HTMLButtonElement>(".abar-delete .abar-danger")'],
      ["shell/cursor-placer.ts", "queryVisible<HTMLElement>(`${host.scope} :is(.row, .oh-row)"],
      ["shell/message-verbs.ts", "return queryVisible<HTMLElement>(`${scope} :is(.row, [role=option])"],
    ] as const) {
      expect(readFileSync(join(APP, file), "utf8"), `${file} no longer asks queryVisible`).toContain(needle);
    }
  });
});
