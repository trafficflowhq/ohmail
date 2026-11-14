import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright";
import { PANE_IDS, TRIAGE_PILES, VIEWS } from "../../apps/webapp/app/shell/routing.js";
import { OWN_PATHS } from "../../apps/webapp/routes.mjs";
import { menuOf, wholeMenu } from "./bench/panes.js";
import { fenced, fingerprint, oneAtATime, type Guard } from "./bench/web.js";
import { ACTS } from "./vocabulary/acts.js";
import { format, LANGUAGES, raw, say } from "./vocabulary/catalogue.js";
import { CONTROLS } from "./vocabulary/controls.js";
import { PANES_SEEN } from "./vocabulary/panes.js";
import { PLACES } from "./vocabulary/places.js";
import { fixturesPlanter } from "./vocabulary/world.js";

/**
 * What keeps the journeys from binding to the look again, and the vocabulary from pointing at
 * nothing. Runs on every run, with no build: the rules are about the journeys' own files.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SELF = "guards.test.ts";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") && e.name !== SELF ? [join(dir, e.name)] : []);
}

/** What a journey may never find a thing by, or wait on. */
const REFUSED: Array<[string, RegExp]> = [
  ["a CSS or XPath locator", /\.locator\(/],
  ["a DOM query", /querySelector/],
  ["a test id", /getByTestId|data-testid/],
  ["a sentence written into the journey", /getByText\(\s*["'`]/],
  ["a wait for time", /waitForTimeout/],
  ["a class or id selector", /["'`](?:\.[A-Za-z][\w-]*|#[A-Za-z][\w-]*)["'`]/],
];

describe("the journeys' own rules", () => {
  it("no file under test/journeys finds a control by anything but its role and name, or waits for time", () => {
    const found: string[] = [];
    for (const file of files(HERE)) {
      const text = readFileSync(file, "utf8");
      for (const [what, re] of REFUSED) if (re.test(text)) found.push(`${file.slice(HERE.length)}: ${what}`);
    }
    expect(found).toEqual([]);
  });

  it("every key of the vocabulary is in both catalogues", () => {
    const keys = [
      ...Object.values(CONTROLS).flatMap((c) => (c.key === null ? [] : [c.key])),
      ...Object.values(PLACES).map((p) => p.landmark.key),
    ];
    const missing = LANGUAGES.flatMap((lang) => keys.filter((k) => raw(k, lang) === null).map((k) => `${lang}: ${k}`));
    expect(missing).toEqual([]);
  });

  it("every control inside another names a control or a place the vocabulary has", () => {
    const lost = Object.values(CONTROLS).filter((c) => c.within !== undefined && !(c.within in CONTROLS) && !(c.within in PLACES));
    expect(lost.map((c) => `${c.id} within ${c.within}`)).toEqual([]);
    expect(Object.values(CONTROLS).filter((c) => (c.key === null) !== (c.nameFrom === "none" || c.nameFrom === "visible")).map((c) => c.id)).toEqual([]);
  });

  it("every route of the vocabulary is one the router or the route table knows", () => {
    const unknown: string[] = [];
    for (const place of Object.values(PLACES)) {
      if (!place.route.startsWith("#/")) {
        if (!(OWN_PATHS as readonly string[]).includes(place.route)) unknown.push(place.route);
        continue;
      }
      const [view, sub, more] = place.route.slice(2).split("/");
      const known = more === undefined && (VIEWS as readonly string[]).includes(view!) && (
        sub === undefined
        || (view === "settings" && (PANE_IDS as readonly string[]).includes(sub))
        || (view === "triage" && (TRIAGE_PILES as readonly string[]).includes(sub)));
      if (!known) unknown.push(place.route);
    }
    expect(unknown).toEqual([]);
  });

  it("every Settings section of the router has a place, and the table per setting names no other", () => {
    const places = Object.values(PLACES).filter((p) => p.id.startsWith("settings-")).map((p) => p.route.slice("#/settings/".length));
    expect([...places].sort()).toEqual([...PANE_IDS].sort());
    for (const listed of Object.values(PANES_SEEN)) expect(listed.filter((id) => !(PANE_IDS as readonly string[]).includes(id))).toEqual([]);
  });

  it("every journeys file names what it guards: a title once, and plain keys for the faults", async () => {
    (globalThis as { __journeysNamesOnly?: boolean }).__journeysNamesOnly = true;
    const titles: string[] = [];
    const bad: string[] = [];
    const dir = join(HERE, "journeys");
    const names = readdirSync(dir).filter((n) => n.endsWith(".journeys.test.ts"));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const place = name.replace(".journeys.test.ts", "");
      if (!(place in PLACES)) bad.push(`${name}: no place called ${place}`);
      const mod = await import(pathToFileURL(join(dir, name)).href) as { GUARDS?: Guard[] };
      if (!Array.isArray(mod.GUARDS) || mod.GUARDS.length === 0) {
        bad.push(`${name}: exports no GUARDS`);
        continue;
      }
      for (const g of mod.GUARDS) {
        titles.push(g.title);
        if (g.title.trim() === "" || g.surfaces.length === 0) bad.push(`${name}: ${g.title || "(no title)"} runs nowhere`);
        if (new Set(g.rows).size !== g.rows.length) bad.push(`${name}: ${g.title} names a fault twice`);
        for (const row of g.rows) if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(row)) bad.push(`${name}: ${JSON.stringify(row)} is not a fault's plain key`);
      }
    }
    expect(bad).toEqual([]);
    expect(titles.filter((t, i) => titles.indexOf(t) !== i)).toEqual([]);
    expect(Object.keys(PLACES).filter((p) => !names.includes(`${p}.journeys.test.ts`))).toEqual([]);
  });

  it("a message's arguments are filled, plurals included, and a missing one is refused", () => {
    expect(format("{count, plural, one {Mark the 1 unread message read} other {Mark all # unread messages read}}", { count: 3 })).toBe("Mark all 3 unread messages read");
    expect(format("{count, plural, one {Mark the 1 unread message read} other {Mark all # unread messages read}}", { count: 1 })).toBe("Mark the 1 unread message read");
    expect(format("<b>Demo.</b> Invented mail.")).toBe("Demo. Invented mail.");
    expect(() => format("Type {email} to continue")).toThrow(/needs \{email\}/);
  });

  it("a tree without git is told from another by its files, so a changed tree is built again", () => {
    const tree = (words: string): string => {
      const dir = mkdtempSync(join(tmpdir(), "journeys-tree-"));
      mkdirSync(join(dir, "apps/webapp/app"), { recursive: true });
      mkdirSync(join(dir, "packages/ui/src"), { recursive: true });
      writeFileSync(join(dir, "apps/webapp/app/page.tsx"), "export default 1;\n");
      writeFileSync(join(dir, "packages/ui/src/hold.ts"), words);
      return dir;
    };
    // The same length: a fault planted in a copy can be one digit.
    const [a, b, same] = [tree("export const HOLD = 700;\n"), tree("export const HOLD = 900;\n"), tree("export const HOLD = 700;\n")];
    try {
      expect(fingerprint(a)).not.toBe(fingerprint(b));
      expect(fingerprint(a)).toBe(fingerprint(same));
    } finally {
      for (const dir of [a, b, same]) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("one file builds at a time: a second waits for the first, and a lock a dead run left is taken over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "journeys-lock-"));
    try {
      const first = await oneAtATime(dir);
      let second: (() => void) | null = null;
      const waiting = oneAtATime(dir).then((done) => { second = done; });
      await new Promise((r) => setTimeout(r, 300));
      expect(second, "the second file built beside the first").toBeNull();
      first();
      await waiting;
      // The second holder dies without letting go: its lock names a process that is not there.
      writeFileSync(join(dir, "building"), "2147483646");
      (await oneAtATime(dir))();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the demo's world is read-only: a plant is refused, and a conversation it does not hold is refused", async () => {
    const demo = fixturesPlanter();
    await expect(demo.plant({ conversations: [] })).rejects.toThrow(/read-only/);
    expect(demo.find({ pile: "ohbox", unread: true }).from).not.toBe("");
    expect(() => demo.find({ pile: "receipts", unread: undefined }).from).not.toThrow();
  });

});

/**
 * The bench's two promises, tried on a page of this file's own: a request for another machine is
 * refused and reported, and an error the page throws is reported. No build is needed for either.
 */
describe("the bench holds its promises", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); }, 60_000);
  afterAll(async () => { await browser?.close(); });

  it("refuses and reports a request that leaves the machine", async () => {
    const person = await fenced(browser, { origin: "http://localhost", base: "/", lang: "en" });
    await person.page.setContent('<img src="https://elsewhere.example/pixel.png" alt="">');
    await person.until(async () => person.problems().length > 0, "the fence to report the request");
    expect(person.problems()).toContain("request left the machine: https://elsewhere.example/pixel.png");
    await person.context.close();
  });

  it("reports an error the page throws, and an error it logs", async () => {
    const person = await fenced(browser, { origin: "http://localhost", base: "/", lang: "en" });
    await person.page.setContent("<script>console.error('it broke'); setTimeout(() => { throw new Error('boom'); }, 0);</script>");
    await person.until(async () => person.problems().length > 1, "both errors to be reported");
    expect(person.problems().sort()).toEqual(["console: it broke", "page error: Error: boom"]);
    await person.context.close();
  });

  it("a keyboard act presses the key the control announces, and refuses a control that announces none", async () => {
    const person = await fenced(browser, { origin: "http://localhost", base: "/", lang: "en" });
    await person.page.setContent(`<button aria-keyshortcuts="r">Reply</button><button>Forward</button><output></output>
      <script>addEventListener("keydown", (e) => { document.querySelector("output").textContent = "pressed " + e.key; });</script>`);
    await ACTS.shortcut.web(person.page.getByRole("button", { name: "Reply", exact: true }), person.page);
    await person.page.getByRole("status").getByText("pressed r", { exact: true }).waitFor();
    await expect(ACTS.shortcut.web(person.page.getByRole("button", { name: "Forward", exact: true }), person.page)).rejects.toThrow(/announces no keyboard shortcut/);
    await person.context.close();
  });

  it("typing fills a box once: a box that drops the words fails the act", async () => {
    const person = await fenced(browser, { origin: "http://localhost", base: "/", lang: "en" });
    // The first words typed are dropped, as a box does whose section is drawn a second time.
    await person.page.setContent(`<input aria-label="New tag">
      <script>let first = true; document.querySelector("input").addEventListener("input", (e) => { if (first) { first = false; e.target.value = ""; } });</script>`);
    const box = person.page.getByRole("textbox", { name: "New tag", exact: true });
    await expect(ACTS.type.web(box, person.page, "Kiln notes")).rejects.toThrow(/did not keep "Kiln notes"/);
    await ACTS.type.web(box, person.page, "Kiln notes");
    expect(await box.inputValue()).toBe("Kiln notes");
    await person.context.close();
  });

  it("the Settings menu is whole whatever order its sections stand in", { timeout: 5_000 }, async () => {
    const person = await fenced(browser, { origin: "http://localhost", base: "/", lang: "en" });
    const names = [...menuOf("W-d", "en")].reverse();
    await person.page.setContent(`<main><nav aria-label="${say("settings.navAria", {}, "en")}">${names.map((n) => `<button>${n}</button>`).join("")}</nav></main>`);
    expect(await wholeMenu("W-d", person)).toEqual(menuOf("W-d", "en"));
    await person.context.close();
  });

  it("stays quiet on a page that does neither", async () => {
    const person = await fenced(browser, { origin: "http://localhost", base: "/", lang: "en" });
    await person.page.setContent('<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""><p>fine</p>');
    await person.page.getByRole("paragraph").waitFor();
    expect(person.problems()).toEqual([]);
    await person.context.close();
  });
});
