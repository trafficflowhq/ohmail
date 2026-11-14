import { describe, expect, it } from "vitest";
import { readBorders, readPlanted, type Borders } from "../../../test/support/borders-census.js";

/**
 * What this package may reach, held on its bundle: the kit, the tokens and the behaviour. Of the
 * client engine it takes types alone, so nothing of the engine may be built in.
 */
const BORDERS: Borders = {
  folder: "packages/app",
  mayImport: ["@ohmail/ui", "@ohmail/tokens", "@ohmail/app-logic", "@ohmail/letter-body"],
  /* No page of this package is a Next page: a link is the kit's plain anchor, which the browser follows as a
     document load (a way out of a door may cross into the website's zone), never the framework's link. */
  neverLibraries: ["next"],
};
/** The same package with nothing of the product outside its bundle: what a part reaches of every other package shows. */
const WHOLE: Borders = { folder: "packages/app", mayImport: ["@ohmail/ui", "@ohmail/tokens"] };

describe("app's borders, read off its bundle", () => {
  it("bundles its own files and reaches nothing its row does not name", async () => {
    const { inputs, refused } = await readBorders(BORDERS);
    expect(inputs).toContain("packages/app/src/host/panes.ts");
    expect(inputs).toContain("packages/app/src/keys/KeymapProvider.tsx");
    expect(inputs).toContain("packages/app/src/mail-state/MailStateProvider.tsx");
    expect(refused).toEqual([]);
  });

  it("refuses a value of the client engine", async () => {
    const { refused } = await readPlanted(BORDERS, 'export { createEngine } from "@ohmail/client-engine";\n');
    expect(refused.some((input) => input.startsWith("packages/client-engine/src/"))).toBe(true);
  });

  it("refuses the framework's link", async () => {
    const { refused } = await readPlanted(BORDERS, 'export { default as Link } from "next/link";\n');
    expect(refused.some((input) => input.includes("node_modules/next/"))).toBe(true);
  });

  it("refuses a file of the web app", async () => {
    const { refused } = await readPlanted(BORDERS, 'export { VIEWS } from "../../../apps/webapp/app/shell/routing";\n');
    expect(refused).toContain("apps/webapp/app/shell/routing.ts");
  });

  it("keeps the frame to itself: no shell's browser door, no place's folder and no app file", async () => {
    const reach = async (planted: string) => (await readPlanted(BORDERS, planted)).inputs.filter(outsideTheFrame);
    expect(await reach('export * from "./frame/index.js";\n')).toEqual([]);
    expect(await reach('export * from "./frame/index.js";\nexport { VIEWS } from "../../../apps/webapp/app/shell/routing";\n'))
      .toContain("apps/webapp/app/shell/routing.ts");
    expect(await reach('export * from "./frame/index.js";\nexport { panesOf } from "./host/panes.js";\n')).toEqual([]);
  });
});

describe("the reader's two entries", () => {
  it("the frame reaches no file of the reader", async () => {
    const { inputs } = await readPlanted(BORDERS, 'export * from "./frame/index.js";\n');
    expect(inputs.filter((input) => input.startsWith("packages/app/src/reader/"))).toEqual([]);
  });

  it("the reader's door never loads the letter's renderer; its body entry does", async () => {
    const door = (await readPlanted(WHOLE, 'export * from "./reader/index.js";\n')).inputs;
    expect(door).toContain("packages/app/src/reader/Reader.tsx");
    expect(door.filter((input) => input.startsWith("packages/letter-body/"))).toEqual([]);
    expect(door.some((input) => input.includes("node_modules/dompurify/"))).toBe(false);
    const body = (await readPlanted(WHOLE, 'export * from "./reader/body/index.js";\n')).inputs;
    expect(body).toContain("packages/letter-body/src/MessageBody.tsx");
  });

  it("the reader reads no list's own model: nothing of the Ohbox's behaviour or its folder", async () => {
    const reach = async (planted: string) =>
      (await readPlanted(WHOLE, planted)).inputs.filter((input) => input.startsWith("packages/app-logic/src/ohbox/") || input.startsWith("packages/app/src/ohbox/"));
    expect(await reach('export * from "./reader/index.js";\n')).toEqual([]);
    expect(await reach('export * from "./reader/index.js";\nexport * from "@ohmail/app-logic/ohbox";\n')).not.toEqual([]);
  });
});

/** What the frame may reach of the product: its own folder, the host contract (not a shell's browser door) and the text reader. */
function outsideTheFrame(input: string): boolean {
  if (input.includes("node_modules/") || input === "<stdin>") return false;
  if (input.startsWith("packages/app/src/host/browser/")) return true;
  return !["packages/app/src/frame/", "packages/app/src/host/", "packages/app/src/text/"].some((own) => input.startsWith(own));
}
