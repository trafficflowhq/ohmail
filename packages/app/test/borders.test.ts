import { describe, expect, it } from "vitest";
import { readBorders, readPlanted, type Borders } from "../../../test/support/borders-census.js";

/**
 * What this package may reach, held on its bundle: the kit, the tokens and the behaviour. Of the
 * client engine it takes types alone, so nothing of the engine may be built in.
 */
const BORDERS: Borders = {
  folder: "packages/app",
  mayImport: ["@ohmail/ui", "@ohmail/tokens", "@ohmail/app-logic"],
};

describe("app's borders, read off its bundle", () => {
  it("bundles its own files and reaches nothing its row does not name", async () => {
    const { inputs, refused } = await readBorders(BORDERS);
    expect(inputs).toContain("packages/app/src/host/panes.ts");
    expect(refused).toEqual([]);
  });

  it("refuses a value of the client engine", async () => {
    const { refused } = await readPlanted(BORDERS, 'export { createEngine } from "@ohmail/client-engine";\n');
    expect(refused.some((input) => input.startsWith("packages/client-engine/src/"))).toBe(true);
  });

  it("refuses a file of the web app", async () => {
    const { refused } = await readPlanted(BORDERS, 'export { VIEWS } from "../../../apps/webapp/app/shell/routing";\n');
    expect(refused).toContain("apps/webapp/app/shell/routing.ts");
  });
});
