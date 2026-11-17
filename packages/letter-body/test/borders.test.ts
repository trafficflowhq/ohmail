import { describe, expect, it } from "vitest";
import { readBorders, readPlanted, type Borders } from "../../../test/support/borders-census.js";

/**
 * The letter's body, read off its bundle: it reaches the product's packages its row names and no
 * file of an app, and none of the web framework's libraries. Its three leaves load without the
 * renderer, so code that draws no letter (sign-out, the desktop's entry, the locale register) never
 * carries it or the sanitizer.
 */
const BORDERS: Borders = {
  folder: "packages/letter-body",
  mayImport: ["@ohmail/client-engine", "@trafficflow/core", "@ohmail/app-logic", "@ohmail/ui", "@ohmail/tokens", "react-dom"],
  neverLibraries: ["next", "next-intl", "use-intl"],
};

describe("the letter's body, read off its bundle", () => {
  it("bundles its own files and reaches nothing its row does not name", async () => {
    const { inputs, refused } = await readBorders(BORDERS);
    expect(inputs).toContain("packages/letter-body/src/MessageBody.tsx");
    expect(refused).toEqual([]);
  });

  it("refuses a file of the web app's shell", async () => {
    const { refused } = await readPlanted(BORDERS, 'export { liveCopy } from "../../../apps/webapp/app/shell/locale";\n');
    expect(refused).toContain("apps/webapp/app/shell/locale.ts");
  });

  it("refuses the web framework's translator", async () => {
    const { refused } = await readPlanted(BORDERS, 'export { createTranslator } from "next-intl";\n');
    expect(refused.some((input) => input.includes("node_modules/next-intl/"))).toBe(true);
  });

  it("keeps its three leaves apart from the renderer and the sanitizer", async () => {
    const leaves = 'export * from "./rendered-links";\nexport * from "./mail-doc-cache";\nexport * from "./words";\n';
    const { inputs } = await readPlanted(BORDERS, leaves);
    expect(inputs).toContain("packages/letter-body/src/words.ts");
    expect(inputs.filter((input) => input.endsWith("/MessageBody.tsx") || input.includes("node_modules/dompurify/"))).toEqual([]);
    const { inputs: door } = await readPlanted(BORDERS, 'export * from "./index";\n');
    expect(door).toContain("packages/letter-body/src/MessageBody.tsx");
  });

  it("carries no stylesheet of the old kit's ground: no base sheet, no token sheet", async () => {
    // The kit and the tokens followed into the bundle, where the row above keeps them outside.
    const followed: Borders = {
      ...BORDERS,
      mayImport: BORDERS.mayImport.filter((name) => name !== "@ohmail/ui" && name !== "@ohmail/tokens"),
    };
    const { inputs } = await readBorders(followed);
    expect(inputs).toContain("packages/letter-body/src/MessageBody.tsx");
    expect(
      inputs.filter((input) => input === "packages/ui/src/base.css" || /^packages\/tokens\/.*\.css$/.test(input)),
    ).toEqual([]);
  });
});
