import { describe, expect, it } from "vitest";
import { readBorders, readPlanted, type Borders } from "../../../test/support/borders-census.js";

/**
 * What this package may reach, held on its bundle: the client engine and the core, and nothing
 * else of the product. No app, no component kit, no tokens, no web framework, no markup, no styles.
 */
const BORDERS: Borders = {
  folder: "packages/app-logic",
  mayImport: ["@ohmail/client-engine", "@trafficflow/core"],
  neverLibraries: ["next", "next-intl", "use-intl"],
  neverEndings: [".css", ".tsx"],
};

describe("app-logic's borders, read off its bundle", () => {
  it("bundles its own files and reaches nothing its row does not name", async () => {
    const { inputs, refused } = await readBorders(BORDERS);
    expect(inputs).toContain("packages/app-logic/src/geometry/ui-zoom.ts");
    expect(refused).toEqual([]);
  });

  it("refuses the component kit", async () => {
    const { refused } = await readPlanted(BORDERS, 'import { cssRect } from "@ohmail/ui";\nexport const planted = cssRect;\n');
    expect(refused.some((input) => input.startsWith("packages/ui/src/"))).toBe(true);
  });

  it("refuses a file of the web app", async () => {
    const { refused } = await readPlanted(BORDERS, 'export { VIEWS } from "../../../apps/webapp/app/shell/routing";\n');
    expect(refused).toContain("apps/webapp/app/shell/routing.ts");
  });

  it("refuses the web shell's text package", async () => {
    const { refused } = await readPlanted(BORDERS, 'export { createTranslator } from "next-intl";\n');
    expect(refused.some((input) => input.includes("node_modules/"))).toBe(true);
  });
});
