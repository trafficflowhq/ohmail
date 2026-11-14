import { describe, expect, it } from "vitest";
import {
  readBorders,
  readFolder,
  readPlanted,
  sourceFolders,
  type Borders,
} from "../../../test/support/borders-census.js";

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

  it("keeps the connect form to itself: no file of the pane's or the first run's folder, no other feature and no app file", async () => {
    const reach = async (planted: string) => (await readPlanted(BORDERS, planted)).inputs.filter(outsideTheForm);
    const form = 'export * from "./mailboxes/connect/index.js";\nexport * from "./mailboxes/connect/from-thrown.js";\n';
    expect(await reach(form)).toEqual([]);
    expect(await reach(`${form}export { firstRunStage } from "./mailboxes/first-run/index.js";\n`))
      .toContain("packages/app/src/mailboxes/first-run/stage.tsx");
    expect(await reach(`${form}export { MailboxesPane } from "./mailboxes/index.js";\n`))
      .toContain("packages/app/src/mailboxes/pane/MailboxesPane.tsx");
    expect(await reach(`${form}export { VIEWS } from "../../../apps/webapp/app/shell/routing";\n`))
      .toContain("apps/webapp/app/shell/routing.ts");
    // The pane and the first run mount the form; the form's folder stays the only one of the three they share.
    const firstRun = (await readPlanted(BORDERS, 'export * from "./mailboxes/first-run/index.js";\n')).inputs;
    expect(firstRun.filter((input) => input.startsWith("packages/app/src/mailboxes/pane/"))).toEqual([]);
    const pane = (await readPlanted(BORDERS, 'export * from "./mailboxes/index.js";\n')).inputs;
    expect(pane.filter((input) => input.startsWith("packages/app/src/mailboxes/first-run/"))).toEqual([]);
  });
});

/** What the connect form may reach of the product: its own folder, the host contract (not a shell's browser door) and the text reader. */
function outsideTheForm(input: string): boolean {
  if (input.includes("node_modules/") || input === "<stdin>") return false;
  if (input.startsWith("packages/app/src/host/browser/")) return true;
  return !["packages/app/src/mailboxes/connect/", "packages/app/src/host/", "packages/app/src/text/"].some((own) => input.startsWith(own));
}

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

/**
 * THE MAIL PRODUCT'S ENTRY (`src/mail`) is a shell's alone: it composes what the mail places read, so nothing it
 * composes may reach back into it, and it reads its host through the frame, never through a file of an app.
 */
describe("the mail entry", () => {
  const ofMail = (inputs: readonly string[]) =>
    inputs.filter((input) => input.startsWith("packages/app/src/mail/"));

  it("the frame reaches no file of it", async () => {
    expect(ofMail((await readPlanted(BORDERS, 'export * from "./frame/index.js";\n')).inputs)).toEqual([]);
    expect(ofMail((await readFolder(BORDERS, "frame")).inputs)).toEqual([]);
    const beside = await readPlanted(
      BORDERS,
      'export * from "./frame/index.js";\nexport * from "./mail/index.js";\n',
    );
    expect(ofMail(beside.inputs)).toContain("packages/app/src/mail/MailGround.tsx");
  });

  it("no place's folder, and no other folder of the package, reaches it", async () => {
    const others = sourceFolders(BORDERS).filter((folder) => folder !== "mail");
    expect(others).toEqual(expect.arrayContaining(["frame", "host", "ohbox", "reader"]));
    for (const folder of others) {
      const reached = ofMail((await readFolder(BORDERS, folder)).inputs);
      expect(reached, `src/${folder} reaches the mail entry`).toEqual([]);
    }
  });

  it("it reaches no file of an app", async () => {
    const door = await readPlanted(BORDERS, 'export * from "./mail/index.js";\n');
    expect(door.inputs).toContain("packages/app/src/mail/MailGround.tsx");
    expect(door.inputs).toContain("packages/app/src/mail/places.ts");
    const whole = await readFolder(BORDERS, "mail");
    for (const { inputs, refused } of [door, whole]) {
      expect(inputs.filter((input) => input.startsWith("apps/"))).toEqual([]);
      expect(refused).toEqual([]);
    }
  });
});

describe("write's three entries", () => {
  const editorEngine = (input: string) => input.includes("node_modules/@tiptap/") || input.includes("node_modules/prosemirror-");
  it("the door loads no editor engine and nothing of the letter's body; neither does the plain entry", async () => {
    for (const entry of ["./write/index.js", "./write/plain/index.js"]) {
      const { inputs, refused } = await readPlanted(BORDERS, `export * from "${entry}";\n`);
      expect(refused, entry).toEqual([]);
      expect(inputs.filter(editorEngine), entry).toEqual([]);
      expect(inputs.filter((input) => input.startsWith("packages/letter-body/")), entry).toEqual([]);
    }
    expect((await readPlanted(BORDERS, 'export * from "./write/index.js";\n')).inputs).toContain(
      "packages/app/src/write/entry.tsx",
    );
  });

  it("the editor's entry is the one that loads the editor engine, and it too reaches nothing of the body", async () => {
    const { inputs, refused } = await readPlanted(BORDERS, 'export * from "./write/editor/index.js";\n');
    expect(refused).toEqual([]);
    expect(inputs.filter(editorEngine)).not.toEqual([]);
    expect(inputs).toContain("packages/app/src/write/editor/schema.ts");
    expect(inputs.filter((input) => input.startsWith("packages/letter-body/"))).toEqual([]);
  });

  it("the frame reaches no file of write", async () => {
    const { inputs } = await readPlanted(BORDERS, 'export * from "./frame/index.js";\n');
    expect(inputs.filter((input) => input.startsWith("packages/app/src/write/"))).toEqual([]);
    const planted = await readPlanted(BORDERS, 'export * from "./frame/index.js";\nexport * from "./write/index.js";\n');
    expect(planted.inputs.filter((input) => input.startsWith("packages/app/src/write/"))).not.toEqual([]);
  });
});

/** What the frame may reach of the product: its own folder, the host contract (not a shell's browser door) and the text reader. */
function outsideTheFrame(input: string): boolean {
  if (input.includes("node_modules/") || input === "<stdin>") return false;
  if (input.startsWith("packages/app/src/host/browser/")) return true;
  return !["packages/app/src/frame/", "packages/app/src/host/", "packages/app/src/text/"].some((own) => input.startsWith(own));
}
