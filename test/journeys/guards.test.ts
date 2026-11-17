import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "@playwright/test";
import { PLACE_IDS, type PlaceId as FramePlaceId } from "@ohmail/app/frame/contract";
import { fragmentOf, PANES, routeOf } from "@ohmail/app/frame/route";
import { OWN_PATHS } from "../../apps/webapp/routes.mjs";
import { menuOf, wholeMenu } from "./bench/panes.js";
import { layoutPlan } from "../../packages/app/src/frame/layout-plan.js";
import { fenced, VIEWPORTS } from "./bench/dom-playwright.js";
import { benchOf, sizeOf, SIZES, WORDS, type Setting } from "./bench/seam.js";
import { runsOn, STANDING } from "./bench/standing/index.js";
import { AT_SIZE } from "./bench/standing/sizes.js";
import { DEFAULT_AUTH_CONFIG } from "@trafficflow/services";
import { baked, readHandover } from "./bench/far-end.js";
import { Authenticator, codeAt, STEP_MS } from "./bench/totp.js";
import { fingerprint, oneAtATime, type Guard } from "./bench/web.js";
import { ACTS } from "./vocabulary/acts.js";
import { format, LANGUAGES, raw, say } from "./vocabulary/catalogue.js";
import { ALL_CONTROLS, twice } from "./vocabulary/index.js";
import { MIRRORS } from "./vocabulary/surfaces.js";
import { PANES_SEEN } from "./vocabulary/panes.js";
import { PANE_PLACES, paneIdOf, PLACES } from "./vocabulary/places.js";
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

/** The frame's places no journey reaches yet, each with its reason. A place leaves this list when its first journey arrives. */
const NOT_YET_A_PLACE: Partial<Record<FramePlaceId, string>> = {
  tags: "a tag's list is reached through the rail by the tag's own name; its journey comes with the tags' seat",
  folder: "a folder's list is reached by the folder's id; its journey comes with the folders' seat",
  address: "a correspondent's letters are reached from a letter; its journey comes with the reader's seat",
  parked: "the set-aside pile is reached through the rail; its journey comes with the later piles' seat",
  resurface: "the resurfacing pile is reached through the rail; its journey comes with the later piles' seat",
};

/**
 * What a journey may never reach for: the window behind the seam, which only some benches have, the driver that
 * holds it, or what `see` found. A journey names only the modules that speak the seam's words: anything else it
 * imports could hand it a browser's page by another name.
 */
const A_JOURNEY_IMPORTS = [/^bench\/(?:seam|journey|web|panes|totp)$/, /^vocabulary\/[\w-]+$/, /^vitest$/, /^node:/];
const REACHED_BY_BRACKETS = new Set(["page", "context", "find", "located"]);

/** The file's code with its comments gone and each string literal replaced by its index in `strings`. */
function codeOf(text: string): { code: string; strings: string[] } {
  const strings: string[] = [];
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (m) => {
    if (m.startsWith("/")) return " ";
    strings.push(m.slice(1, -1));
    return `"${strings.length - 1}"`;
  });
  return { code, strings };
}

/** Where a journey file at `file` reaches past the seam, each with what it reached for. */
function pastTheSeam(file: string, text: string): string[] {
  const { code, strings } = codeOf(text);
  const found: string[] = [];
  const moduleOf = (spec: string): string => spec.startsWith(".")
    ? relative(HERE, resolve(dirname(file), spec)).split("\\").join("/").replace(/\.(?:js|ts)$/, "")
    : spec;
  for (const m of code.matchAll(/\b(?:from|import|require)\s*\(?\s*"(\d+)"/g)) {
    const name = moduleOf(strings[Number(m[1])]!);
    if (!A_JOURNEY_IMPORTS.some((re) => re.test(name))) found.push(`a module that is not the seam's: ${name}`);
  }
  if (/\b(?:import|require)\s*\(\s*(?!"\d+")/.test(code)) found.push("a module named by a computed value");
  for (const m of code.matchAll(/\b(?:import|export)\s+(?:type\s+)?\*\s*(?:as\s+[\w$]+\s+)?from\s*"(\d+)"/g)) {
    const name = moduleOf(strings[Number(m[1])]!);
    if (name.startsWith("bench/")) found.push(`every name of a bench module at once: ${name}`);
  }
  for (const m of code.matchAll(/\[\s*"(\d+)"\s*\]/g)) {
    const name = strings[Number(m[1])]!;
    if (REACHED_BY_BRACKETS.has(name)) found.push(`a driver's member by brackets: ${name}`);
  }
  // As a name in code: a member, a binding, a field taken apart in any braces, a parameter's included.
  for (const m of code.matchAll(/\b(?:page|context|located)\b/g)) found.push(`a window's page or context, or the driver's finder: ${m[0]}`);
  if (/(?:[(=,]|return)\s*await\s+[\w$.!]+\.see\(|\.see\([^;]*?\)\s*\.then\(/.test(code)) found.push("what `see` found");
  return [...new Set(found)];
}

describe("the journeys' own rules", () => {
  it("no file under test/journeys finds a control by anything but its role and name, or waits for time", () => {
    const found: string[] = [];
    for (const file of files(HERE)) {
      const text = readFileSync(file, "utf8");
      for (const [what, re] of REFUSED) if (re.test(text)) found.push(`${file.slice(HERE.length)}: ${what}`);
    }
    expect(found).toEqual([]);
  });

  it("no journey reaches past the seam: to a browser's page or context, to the driver, or to what `see` found", () => {
    const found = files(join(HERE, "journeys")).flatMap((file) =>
      pastTheSeam(file, readFileSync(file, "utf8")).map((what) => `${file.slice(HERE.length)}: ${what}`));
    expect(found).toEqual([]);
  });

  it("the seam's rule reads a reach however it is spelled, and passes a journey that keeps to the seam", () => {
    const at = join(HERE, "journeys", "x.journeys.test.ts");
    const kept = `import { describe } from "vitest";\nimport { readFileSync } from "node:fs";\nimport { journeysOf, type Guard } from "../bench/web.js";\nimport type { Person } from "../bench/seam.js";\nimport { say } from "../vocabulary/catalogue.js";\nconst t = "the sign-in page, in context";\nconst row = world.find({ pile: "ohbox" });\nawait person.see("reply");`;
    expect(pastTheSeam(at, kept)).toEqual([]);
    const reaches: Array<[string, string]> = [
      [`import * as web from "../bench/web.js";`, "every name of a bench module at once: bench/web"],
      [`type D = import("../bench/dom-playwright.js").PlaywrightPerson;`, "a module that is not the seam's: bench/dom-playwright"],
      [`export { fenced } from "../bench/dom-playwright.js";`, "a module that is not the seam's: bench/dom-playwright"],
      [`import { chromium } from "@playwright/test";`, "a module that is not the seam's: @playwright/test"],
      [`const m = await import(name);`, "a module named by a computed value"],
      [`await (person as any)["page"].goto("/");`, "a driver's member by brackets: page"],
      [`await driver['located']("list-history");`, "a driver's member by brackets: located"],
      ["await driver[`find`](\"reply\");", "a driver's member by brackets: find"],
      [`const tab = async ({ context }: Driver) => 1;`, "a window's page or context, or the driver's finder: context"],
      [`function f({ a, page }: X) {}`, "a window's page or context, or the driver's finder: page"],
      [`await person?.page.reload();`, "a window's page or context, or the driver's finder: page"],
      [`const seen = await person.see("reply");`, "what `see` found"],
    ];
    for (const [line, what] of reaches) expect(pastTheSeam(at, line), line).toContain(what);
  });

  it("every key of the vocabulary is in both catalogues", () => {
    const keys = [
      ...Object.values(ALL_CONTROLS).flatMap((c) => (c.key === null ? [] : [c.key])),
      ...Object.values(PLACES).map((p) => p.landmark.key),
    ];
    const missing = LANGUAGES.flatMap((lang) => keys.filter((k) => raw(k, lang) === null).map((k) => `${lang}: ${k}`));
    expect(missing).toEqual([]);
  });

  it("every control inside another names a control or a place the vocabulary has", () => {
    const lost = Object.values(ALL_CONTROLS).filter((c) => c.within !== undefined && !(c.within in ALL_CONTROLS) && !(c.within in PLACES));
    expect(lost.map((c) => `${c.id} within ${c.within}`)).toEqual([]);
    expect(Object.values(ALL_CONTROLS).filter((c) => (c.key === null) !== (c.nameFrom === "none" || c.nameFrom === "visible")).map((c) => c.id)).toEqual([]);
  });

  it("every place of the vocabulary is an address the frame reads back as it is written, or a door of the route table", () => {
    const unknown: string[] = [];
    for (const place of Object.values(PLACES)) {
      if (place.route.startsWith("#/")) {
        if (fragmentOf(routeOf(place.route)) !== place.route) unknown.push(`${place.id}: ${place.route} reads back as ${fragmentOf(routeOf(place.route))}`);
      } else if (!(OWN_PATHS as readonly string[]).includes(place.route)) {
        unknown.push(`${place.id}: ${place.route} is no door of the route table`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("a Settings place is the frame's Settings at that section", () => {
    const wrong = PANE_PLACES.flatMap((id) => {
      const route = routeOf(PLACES[id].route);
      return route.place === "settings" && route.sub === paneIdOf(id) ? [] : [`${id}: ${route.place}/${route.sub ?? "-"}`];
    });
    expect(wrong).toEqual([]);
  });

  it("the vocabulary's Settings sections are the frame's, and the table per setting names no other", () => {
    expect(PANE_PLACES.map(paneIdOf).sort()).toEqual([...PANES].sort());
    for (const listed of Object.values(PANES_SEEN)) expect(listed.filter((id) => !PANES.has(id))).toEqual([]);
  });

  it("every place of the frame is reached by a place of the vocabulary, or says why not yet", () => {
    const reached = new Set(Object.values(PLACES).filter((p) => p.route.startsWith("#/")).map((p) => routeOf(p.route).place));
    expect(PLACE_IDS.filter((id) => !reached.has(id) && !(id in NOT_YET_A_PLACE))).toEqual([]);
    // The list only shrinks: a place the vocabulary reaches leaves it.
    expect(Object.keys(NOT_YET_A_PLACE).filter((id) => reached.has(id as FramePlaceId) || !(PLACE_IDS as readonly string[]).includes(id))).toEqual([]);
  });

  it("every journeys file names what it guards: a title once, and plain keys for the faults", async () => {
    (globalThis as { __journeysNamesOnly?: boolean }).__journeysNamesOnly = true;
    const titles: string[] = [];
    const all: Guard[] = [];
    const bad: string[] = [];
    const dir = join(HERE, "journeys");
    const names = readdirSync(dir).filter((n) => n.endsWith(".journeys.test.ts"));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      // `<place>.journeys.test.ts`, or `<place>.<set>.journeys.test.ts` for a set of the place's journeys.
      const [place = "", set, ...more] = name.replace(".journeys.test.ts", "").split(".");
      if (!(place in PLACES)) bad.push(`${name}: no place called ${place}`);
      if (more.length > 0 || (set !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(set))) bad.push(`${name}: not <place>[.<set>].journeys.test.ts`);
      const mod = await import(pathToFileURL(join(dir, name)).href) as { GUARDS?: Guard[] };
      if (!Array.isArray(mod.GUARDS) || mod.GUARDS.length === 0) {
        bad.push(`${name}: exports no GUARDS`);
        continue;
      }
      for (const g of mod.GUARDS) {
        titles.push(g.title);
        all.push(g);
        if (g.title.trim() === "" || g.surfaces.length === 0) bad.push(`${name}: ${g.title || "(no title)"} runs nowhere`);
        if (new Set(g.rows).size !== g.rows.length) bad.push(`${name}: ${g.title} names a fault twice`);
        for (const row of g.rows) if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(row)) bad.push(`${name}: ${JSON.stringify(row)} is not a fault's plain key`);
      }
    }
    expect(bad).toEqual([]);
    expect(titles.filter((t, i) => titles.indexOf(t) !== i)).toEqual([]);
    // A standing or size list names journeys that exist, and a standing one only journeys of the setting its bench mirrors.
    const guards = new Map(all.map((g) => [g.title, g]));
    for (const { id, setting } of Object.values(WORDS)) {
      if (id === "web") continue;
      for (const title of STANDING[id]) {
        const g = guards.get(title);
        if (!g) bad.push(`standing/${id}: no journey called ${JSON.stringify(title)}`);
        else if (!g.surfaces.includes(MIRRORS[setting]!)) bad.push(`standing/${id}: ${JSON.stringify(title)} is not a journey of ${MIRRORS[setting]}`);
      }
    }
    // Every journey the stack runs makes an account, and the stack's door allows a bounded number from one address in a window.
    const onStack = all.filter((g) => runsOn(g, { id: "stack", setting: "W-i", size: "expanded" }));
    if (onStack.length > DEFAULT_AUTH_CONFIG.maxRegistrationsPerWindow - 4) bad.push(`the stack runs ${onStack.length} journeys, more than the registration window leaves it`);
    for (const [size, listed] of Object.entries(AT_SIZE)) for (const title of listed) if (!guards.has(title)) bad.push(`sizes/${size}: no journey called ${JSON.stringify(title)}`);
    expect(bad).toEqual([]);
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

  it("TF_JOURNEYS names a bench or nothing, and a size is named or expanded: any other word is refused", () => {
    expect(benchOf({})).toBeNull();
    expect(benchOf({ TF_JOURNEYS: "host" })).toBeNull();
    expect(benchOf({ TF_JOURNEYS: "selfhost" })).toEqual({ id: "web", setting: "W-s", word: "selfhost" });
    expect(benchOf({ TF_JOURNEYS: "stack" })).toEqual({ id: "stack", setting: "W-i", word: "stack" });
    expect(benchOf({ TF_JOURNEYS: "android" })).toEqual({ id: "android", setting: "P-p", word: "android" });
    expect(() => benchOf({ TF_JOURNEYS: "phone" })).toThrow(/must be one of/);
    expect(() => benchOf({ TF_JOURNEYS: "toString" })).toThrow(/must be one of/);
    expect(sizeOf({})).toBe("expanded");
    expect(sizeOf({ TF_JOURNEYS_SIZE: "compact" })).toBe("compact");
    expect(() => sizeOf({ TF_JOURNEYS_SIZE: "tiny" })).toThrow(/must be one of/);
  });

  it("every bench but the web's names a setting that mirrors another, or its standing list could never run", () => {
    expect(Object.values(WORDS).filter((w) => w.id !== "web" && MIRRORS[w.setting] === undefined).map((w) => `${w.id}: ${w.setting}`)).toEqual([]);
  });

  it("a journey runs where its guard says, or where its bench mirrors that setting and stands it, and below expanded only when listed", () => {
    const own = { title: "own", surfaces: ["W-i"] as Setting[] };
    const theirs = { title: STANDING.stack[0]!, surfaces: ["W-s"] as Setting[] };
    const unlisted = { title: "not on the stack's list", surfaces: ["W-s"] as Setting[] };
    const at = { id: "stack", setting: "W-i", size: "expanded" } as const;
    expect([own, theirs, unlisted].map((g) => runsOn(g, at))).toEqual([true, true, false]);
    expect(runsOn(unlisted, { id: "web", setting: "W-s", size: "expanded" })).toBe(true);
    expect(runsOn(unlisted, { id: "web", setting: "W-s", size: "compact" })).toBe(false);
    expect(runsOn(theirs, { id: "web", setting: "W-m", size: "expanded" })).toBe(false);
  });

  it("each size's window falls in the frame's own size class, and medium still stands two columns", () => {
    const plan = (size: (typeof SIZES)[number]) => layoutPlan({ ...VIEWPORTS[size], pointer: size === "expanded" ? "fine" : "coarse", posture: "flat", reducedMotion: false });
    expect(SIZES.map((size) => plan(size).size)).toEqual(SIZES);
    expect(SIZES.map((size) => plan(size).columns)).toEqual([2, 2, 1]);
  });

  it("an authenticator gives RFC 6238's codes, and never one for a time step it already gave", async () => {
    const key = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // RFC 6238's SHA-1 key, "12345678901234567890"
    expect(codeAt(key, 1)).toBe("287082");
    expect(codeAt(key, 37037036)).toBe("081804");
    let now = 59_000;
    const waited: number[] = [];
    const app = new Authenticator(key, () => now, async (ms) => { waited.push(ms); now += ms; });
    const steps = [await app.code(), await app.code(), await app.code()];
    expect(steps).toEqual([codeAt(key, 1), codeAt(key, 2), codeAt(key, 3)]);
    expect(waited.length).toBe(1);
    expect(Math.floor(now / STEP_MS)).toBe(2);
  });

  it("the stack's handover is refused off this machine's loopback, and the server's cookies are read as it set them", () => {
    const dir = mkdtempSync(join(tmpdir(), "journeys-handover-"));
    const write = (origin: string): string => {
      const file = join(dir, `${origin.length}.json`);
      writeFileSync(file, JSON.stringify({ origin, invites: ["x"], compose: ["docker", "compose"], commit: "c".repeat(40), mail: {}, envFile: "" }));
      return file;
    };
    try {
      expect(readHandover(write("http://localhost:3080")).origin).toBe("http://localhost:3080");
      expect(() => readHandover(write("https://mail.example.com"))).toThrow(/loopback/);
      expect(() => readHandover(undefined)).toThrow(/TF_JOURNEYS_STACK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(baked(["tf_refresh=r1; Path=/auth/refresh; HttpOnly; Secure; SameSite=Strict; Max-Age=60", "tf_resume=1; Path=/; HttpOnly; SameSite=Lax"])).toEqual([
      { name: "tf_refresh", value: "r1", path: "/auth/refresh", httpOnly: true, secure: true, sameSite: "Strict" },
      { name: "tf_resume", value: "1", path: "/", httpOnly: true, secure: false, sameSite: "Lax" },
    ]);
  });

  it("the vocabulary refuses a control named in two files", () => {
    expect(twice({ reply: 1, forward: 1 }, { "login-code": 1 })).toEqual([]);
    expect(twice({ reply: 1, forward: 1 }, { reply: 1 })).toEqual(["reply"]);
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

  it("lets through the one foreign name a bench resolves to this machine, and still refuses every other", async () => {
    const person = await fenced(browser, { origin: "http://localhost", base: "/", lang: "en", allow: ["ohmail-elsewhere.test"] });
    await person.page.setContent('<img src="http://ohmail-elsewhere.test/pixel.png" alt=""><img src="https://elsewhere.example/pixel.png" alt="">');
    await person.until(async () => person.requests().length > 1, "both requests to be asked");
    expect(person.problems()).toContain("request left the machine: https://elsewhere.example/pixel.png");
    expect(person.problems()).not.toContain("request left the machine: http://ohmail-elsewhere.test/pixel.png");
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
    await expect(ACTS.type.web(box, person.page, "Kiln notes")).rejects.toThrow(/did not keep what was typed: it holds 0 of the 10 characters/);
    await ACTS.type.web(box, person.page, "Kiln notes");
    expect(await box.inputValue()).toBe("Kiln notes");
    await person.context.close();
  });

  it("a failing act names no credential: not a hash past the app's routes, not the words typed", async () => {
    // An invite's link carries its token after the hash, 43 characters; a journey types a password it minted.
    const handed = randomBytes(32).toString("base64url");
    const typed = "kiln-glaze-ember-47";
    const server: Server = createServer((_ask, answer) => {
      answer.writeHead(200, { "content-type": "text/html" });
      answer.end(`<!doctype html><title>join</title><main><input aria-label="${say("join.passwordLabel", {}, "en")}" maxlength="4"></main>`);
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const person = await fenced(browser, { origin, base: "/", lang: "en" });
    try {
      const told = (p: Promise<unknown>): Promise<string> => p.then(() => "no error", (e: unknown) => String(e));
      await person.page.goto(`${origin}/join/invite#${handed}`);
      const unseen = await told(person.see("join-email", {}, 300));
      expect(unseen).toContain("never saw join-email on /join/invite#…");
      expect(unseen).not.toContain(handed);
      const dropped = await told(person.act("type", "join-password", { value: typed }));
      expect(dropped).toContain("it holds 4 of the 19 characters");
      expect(dropped).not.toContain(typed);
      expect(dropped).not.toContain(typed.slice(0, 4));
      // A route of the app's own stays readable: it says where the journey stood.
      await person.page.goto(`${origin}/app#/settings/general`);
      expect(await told(person.see("join-email", {}, 300))).toContain("never saw join-email on /app#/settings/general");
      // A link that cannot be opened: the browser's own error names the address, and the token is cut off.
      const shut = createServer();
      await new Promise<void>((ok) => shut.listen(0, "127.0.0.1", ok));
      const closed = (shut.address() as AddressInfo).port;
      await new Promise((ok) => shut.close(ok));
      const lost = await told(person.follow(`http://127.0.0.1:${closed}/join/invite#${handed}`));
      expect(lost).toContain("following /join/invite#… failed");
      expect(lost).not.toContain(handed);
    } finally {
      await person.context.close();
      server.close();
    }
  });

  it("the Settings menu is whole whatever order its sections stand in", { timeout: 5_000 }, async () => {
    const person = await fenced(browser, { origin: "http://localhost", base: "/", lang: "en" });
    const names = [...menuOf("W-d", "en")].reverse();
    await person.page.setContent(`<main><nav aria-label="${say("settings.navAria", {}, "en")}">${names.map((n) => `<button>${n}</button>`).join("")}</nav></main>`);
    expect(await wholeMenu("W-d", person)).toEqual(menuOf("W-d", "en"));
    await person.context.close();
  });

  it("seeing a control hands a journey nothing to reach past the seam with", async () => {
    const person = await fenced(browser, { origin: "http://localhost", base: "/", lang: "en" });
    await person.page.setContent(`<button>${say("login.totpVerify", {}, "en")}</button>`);
    expect(await person.see("login-code-verify")).toBeUndefined();
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
