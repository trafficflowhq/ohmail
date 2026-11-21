/**
 * The new design and the old one meet only at the frame's seam.
 *
 * Both stylesheets declare `--ink`, `--focus`, `--r-pill` and more with different values, so a
 * page that loads both is recoloured by whichever comes last, and nothing fails. Until today's views
 * are rebuilt they stand inside the new frame on the three hosts, and there the two seam sheets
 * (`packages/app/scripts/seam-tokens.mjs`) declare each design's meaning again under its own root.
 * Three fences:
 *
 *  - who may import `@ohmail/tokens/design*`: the list below. A rebuilt screen adds its entry here,
 *    by name, in the change that rebuilds it.
 *  - who may reach both an old stylesheet and a new one through its imports, however far: the hosts'
 *    entries that mount today's views in the frame, and the adapter between the two, by name. The
 *    list only falls: a rebuilt view leaves it, nothing joins it.
 *  - every page or window among them reaches both seam sheets.
 *  - the doors on the web, by name: a door's route reaches the old stylesheets through its ceremony alone, and
 *    every door's page reaches the frame's seam sheet.
 *
 * And until the workspace has a tool for import borders: what the new folders may import.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Who imports the design's subpaths, and how. `type` is erased before anything runs. */
const MAY_IMPORT: Record<string, "type" | "value"> = {
  "packages/ui/src/motion/motion.ts": "type",
  "packages/ui/src/base/index.ts": "value",
  "packages/ui/src/base/tokens.ts": "value",
  "packages/letter-body/src/link-ask.ts": "value",
};

const OLD_SHEET = /^@ohmail\/tokens\/(tokens|faces|ohmarchy)\.css$|^packages\/tokens\/src\/(tokens|faces|ohmarchy)\.css$/;
const NEW_SHEET = /^@ohmail\/tokens\/design(\.css$|\/.+\.css$)|^packages\/tokens\/src\/design\/.+\.css$/;
const DESIGN = /^@ohmail\/tokens\/design(\.css)?($|\/)/;

/** The pages and windows that mount today's views inside the frame: where a browser starts loading both. */
const SEAM_ROOTS = [
  "apps/desktop/src/main.tsx",
  "apps/paired-page/src/main.tsx",
  "apps/webapp/app/(product)/demo/page.tsx",
  "apps/webapp/app/(product)/mailbox/page.tsx",
];
/** Who reaches the old stylesheets and the new: the roots, the shells they mount, and the adapter that feeds the frame. */
const MAY_MEET = [
  "apps/desktop/src/DesktopFrame.tsx",
  "apps/desktop/src/DesktopGate.tsx",
  "apps/desktop/src/main.tsx",
  "apps/paired-page/src/HostGate.tsx",
  "apps/paired-page/src/main.tsx",
];

/**
 * THE DOORS ON THE WEB (ruled 2026-11-16 with task `doors`). A door's page is the new design. Its route stands the
 * page over the door's ceremony, which is today's code and reaches the old component package's entry through today's
 * session helpers. The product's layout loads today's sheets on every document whatever a route imports, so a door
 * stands on a stage of its own: an `.oh-root` that loads the frame's seam sheet. Held below: a route reaches the old
 * stylesheets through its ceremony alone, so nothing of today's design is drawn in a door but the parts DRAWN names;
 * and every door's page reaches the frame's seam sheet. A route and its page leave when the old package's entry no
 * longer loads the old sheets (task `removals`); a drawn part leaves with the task that rebuilds it. Nothing joins but
 * a new door, by name.
 */
const PRODUCT = "apps/webapp/app/(product)";
const DOOR_ROUTES = [
  "account/delete/DeleteAccountRoute.tsx",
  "approve/ApproveClosed.tsx",
  "approve/ApproveRoute.tsx",
  "authorize-desktop/AuthorizeDesktopRoute.tsx",
  "join/JoinRoute.tsx",
  "join/invite/InviteRoute.tsx",
  "link-desktop/LinkDesktopRoute.tsx",
  "login/SignInRoute.tsx",
  "mailbox/StepUp.tsx",
  "mailbox/WallRoute.tsx",
  "resume/ResumeRoute.tsx",
  "setup/SetupRoute.tsx",
  "subscribed/SubscribedRoute.tsx",
  "verify-email/VerifyRoute.tsx",
].map((file) => `${PRODUCT}/${file}`);
/** The doors' pages that reach both through their route. The wall's page is the mailbox's, a root above. */
const DOOR_PAGES = ["account/delete", "approve", "authorize-desktop", "join", "join/invite", "link-desktop", "login", "resume", "setup", "subscribed", "verify-email"]
  .map((door) => `${PRODUCT}/${door}/page.tsx`);
/** A door's ceremony: its own hook, the web's step-up door, and the step-up dialog's mount over it. */
const CEREMONY = /\/use-[a-z-]+-door\.ts$|\/mailbox\/(web-step-up\.ts|StepUp\.tsx)$/;
/** No door draws a part that reaches the old stylesheets. */
const DRAWN: Record<string, string[]> = {};
/** The frame sheet is required. The retired adapter sheet must never be reintroduced by a host. */
const SEAM_SHEETS = [/^packages\/app\/src\/frame\/seam\.generated\.css$/, /^apps\/webapp\/app\/shell\/today-tokens\.generated\.css$/];

type Files = Map<string, string>;
const IMPORT = /(\b(?:import|export)\s+type\b[^"';]*?from\s*|\bfrom\s+|\bimport\s*\(?\s*|@import\s+(?:url\()?\s*|\brequire\(\s*)["']([^"']+)["']/g;
const TYPE_ONLY = /^(?:import|export)\s+type\b/;
const importsOf = (text: string) => [...text.matchAll(IMPORT)].map((m) => ({ specifier: m[2], typeOnly: TYPE_ONLY.test(m[1]!) }));

/** The file of `files` a specifier names from `from`, or the specifier itself when it names none. */
function target(files: Files, from: string, specifier: string): string {
  const tries = (base: string) => [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  if (specifier.startsWith(".")) return tries(normalize(join(dirname(from), specifier))).find((p) => files.has(p)) ?? specifier;
  const [, name, sub] = /^(@[^/]+\/[^/]+)(?:\/(.+))?$/.exec(specifier) ?? [];
  const manifest = [...files.keys()].find((p) => p.endsWith("/package.json") && JSON.parse(files.get(p)!).name === name);
  if (!manifest) return specifier;
  const entry = JSON.parse(files.get(manifest)!).exports?.[sub ? `./${sub}` : "."];
  const path = typeof entry === "string" ? entry : (entry?.["ohmail-source"] ?? entry?.default);
  return path ? normalize(join(dirname(manifest), path)) : specifier;
}

/** Every file whose imports lead, however far, to a file or specifier `sheet` names. */
function reaching(files: Files, sheet: RegExp): Set<string> {
  const importers = new Map<string, string[]>();
  for (const [file, text] of files) {
    if (file.endsWith(".json")) continue;
    for (const { specifier, typeOnly } of importsOf(text)) {
      if (typeOnly) continue;
      for (const to of new Set([specifier, target(files, file, specifier)])) importers.set(to, [...(importers.get(to) ?? []), file]);
    }
  }
  const seen = new Set<string>();
  const queue = [...importers.keys()].filter((to) => sheet.test(to));
  for (let to = queue.pop(); to !== undefined; to = queue.pop()) {
    for (const file of importers.get(to) ?? []) if (!seen.has(file)) queue.push((seen.add(file), file));
  }
  return seen;
}

/** Every file whose imports lead to an old stylesheet and to a new one. */
function reachBoth(files: Files): string[] {
  const old = reaching(files, OLD_SHEET);
  return [...reaching(files, NEW_SHEET)].filter((file) => old.has(file)).sort();
}

/** What a door's route imports, beyond its ceremony, that leads to an old stylesheet: empty for a route that draws nothing of today's. */
function drawnBy(files: Files): Record<string, string[]> {
  const old = reaching(files, OLD_SHEET);
  const drawn = (route: string) =>
    [...new Set(importsOf(files.get(route)!).filter(({ typeOnly }) => !typeOnly).map(({ specifier }) => target(files, route, specifier)))]
      .filter((to) => old.has(to) && !CEREMONY.test(to))
      .sort();
  return Object.fromEntries(DOOR_ROUTES.map((route) => [route, drawn(route)] as const).filter(([, parts]) => parts.length));
}

/** `[file, how]` for every import of a design subpath outside the tokens package. */
function designImports(files: Files): Map<string, "type" | "value"> {
  const out = new Map<string, "type" | "value">();
  for (const [file, text] of files) {
    if (file.startsWith("packages/tokens/") || file.endsWith(".json")) continue;
    for (const { specifier, typeOnly } of importsOf(text)) {
      if (DESIGN.test(specifier) && (!typeOnly || !out.has(file))) out.set(file, typeOnly ? "type" : "value");
    }
  }
  return out;
}

const SKIP = new Set(["node_modules", "dist", "test", "target", "gen", "android", "ios", "build", "out", "coverage"]);
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    if (SKIP.has(entry) || entry.startsWith(".")) return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(tsx?|mts|mjs|jsx?|css)$/.test(entry) || entry === "package.json" ? [path] : [];
  });
const tree: Files = new Map(["apps", "packages"].flatMap((dir) => walk(join(root, dir))).map((p) => [relative(root, p), readFileSync(p, "utf8")]));

const planted = (extra: Record<string, string>): Files => new Map([...tree, ...Object.entries(extra)]);

describe("who imports the new design", () => {
  it("only the files listed, each the way it is listed", () => {
    expect(tree.size).toBeGreaterThan(1500);
    expect(Object.fromEntries(designImports(tree))).toEqual(MAY_IMPORT);
  });

  it("an import anywhere else is found, whatever its form", () => {
    const files = planted({
      "apps/webapp/app/planted.tsx": 'import "@ohmail/tokens/design.css";\n',
      "apps/desktop/src/planted.ts": 'import { design } from "@ohmail/tokens/design";\n',
      "packages/ui/src/planted.css": '@import "@ohmail/tokens/design/motion.css";\n',
      "apps/mobile/src/planted.ts": 'const t = await import("@ohmail/tokens/design/tokens.json");\n',
    });
    expect([...designImports(files).keys()].filter((file) => file.includes("planted")).sort()).toEqual([
      "apps/desktop/src/planted.ts", "apps/mobile/src/planted.ts", "apps/webapp/app/planted.tsx", "packages/ui/src/planted.css",
    ]);
  });
});

describe("the old stylesheets and the new meet only where listed", () => {
  const unlisted = (files: Files) => reachBoth(files).filter((file) => !MAY_MEET.includes(file));
  const withPlantedView = (file: string) => [...unlisted(tree), file].sort();

  it("in the tree as it is: the listed modules, each of them, and no other", () => expect(reachBoth(tree)).toEqual(MAY_MEET));

  it("a module that is not listed is found: the old ones are reached through the component package's entry", () => {
    const files = planted({ "apps/webapp/app/planted-shell.tsx": 'import "@ohmail/tokens/design.css";\nimport "./planted-view";\n', "apps/webapp/app/planted-view.tsx": 'import { Button } from "@ohmail/ui";\n' });
    expect(unlisted(files)).toEqual(withPlantedView("apps/webapp/app/planted-shell.tsx"));
  });

  it("a part of the new design inside one of today's views is found", () => {
    const files = planted({ "apps/webapp/app/shell/planted-view.tsx": 'import { Row } from "@ohmail/ui";\nimport { Button } from "@ohmail/ui/base";\n' });
    expect(unlisted(files)).toEqual(withPlantedView("apps/webapp/app/shell/planted-view.tsx"));
  });

  it("a type alone joins nothing", () => {
    const files = planted({
      "apps/webapp/app/planted-shell.tsx": [
        'import "@ohmail/tokens/design.css";',
        'import type { ButtonProps } from "@ohmail/ui";',
        'export type { ButtonProps } from "@ohmail/ui";',
      ].join("\n"),
    });
    expect(reachBoth(files)).toEqual(reachBoth(tree));
  });

  it("a listed module that reaches the new design no longer is found, so the list falls", () => {
    const file = "apps/desktop/src/DesktopFrame.tsx";
    const files = planted({ [file]: "export {};\n" });
    const both = reachBoth(files);
    expect(MAY_MEET.filter((file) => !both.includes(file))).toContain(file);
  });
});

describe("where they meet, the seam is loaded", () => {
  const without = (files: Files) =>
    SEAM_SHEETS.map((sheet) => {
      const reached = reaching(files, sheet);
      return SEAM_ROOTS.filter((root) => !reached.has(root));
    });

  it("every mail page and window loads the frame sheet and leaves the retired adapter sheet out", () => {
    expect(without(tree)).toEqual([[], SEAM_ROOTS]);
  });

  it("detects a retired adapter sheet reintroduced by the actual frame", () => {
    const frame = "packages/app/src/frame/Frame.tsx";
    const retired = "apps/webapp/app/shell/today-tokens.generated.css";
    const files = planted({
      [retired]: ".today { --float: red; }",
      [frame]: `${tree.get(frame)!}\nimport "../../../../${retired}";\n`,
    });
    expect(without(files)[1]).toEqual([]);
  });

  it("Frame imports the seam directly and reachability fails only when both Frame and DoorStage drop it", () => {
    const frame = "packages/app/src/frame/Frame.tsx";
    const door = "packages/app/src/doors/stage/DoorStage.tsx";
    const frameSource = tree.get(frame)!;
    const seamImport = /^\s*import\s+["']\.\/seam\.generated\.css["'];?[ \t]*$/m;
    expect(withoutComments(frameSource)).toMatch(seamImport);
    const frameless = frameSource.replace(seamImport, "");
    const doorless = tree.get(door)!.replace('import "../../frame/seam.generated.css";', "");
    expect(frameless).not.toBe(tree.get(frame));
    expect(doorless).not.toBe(tree.get(door));
    expect(without(planted({ [frame]: frameless }))).toEqual([[], SEAM_ROOTS]);
    expect(without(planted({ [frame]: frameless, [door]: doorless }))).toEqual([SEAM_ROOTS, SEAM_ROOTS]);
  });
});

describe("a door on the web", () => {
  const STAGE = "packages/app/src/doors/stage/DoorStage.tsx";
  const stands = [...DOOR_PAGES, `${PRODUCT}/not-found.tsx`];
  const unseamed = (files: Files) => {
    const reached = reaching(files, SEAM_SHEETS[0]);
    return stands.filter((page) => !reached.has(page));
  };

  it("reaches the old stylesheets through its ceremony alone, but for the parts of today's design it is listed to draw", () => {
    expect(drawnBy(tree)).toEqual(DRAWN);
  });

  it("a part of today's design drawn in a door is found", () => {
    const route = `${PRODUCT}/login/SignInRoute.tsx`;
    const files = planted({ [route]: `${tree.get(route)!}\nimport { Button } from "@ohmail/ui";\n` });
    expect(drawnBy(files)).toEqual({ ...DRAWN, [route]: ["packages/ui/src/index.ts"] });
  });

  it("every door's page stands on a stage that loads the frame's seam sheet, and none loads today's: no door draws today's form", () => {
    expect(unseamed(tree)).toEqual([]);
    const todays = reaching(tree, SEAM_SHEETS[1]);
    expect(DOOR_PAGES.filter((page) => todays.has(page))).toEqual([]);
  });

  it("door pages lose the seam stylesheet when both the stage and frame drop it", () => {
    // The shared Frame can also supply the sheet through the mounted doors' imports.
    const frame = "packages/app/src/frame/Frame.tsx";
    const withoutFrameSheet = tree.get(frame)!.replace('import "./seam.generated.css";', "");
    expect(withoutFrameSheet).not.toBe(tree.get(frame));
    expect(unseamed(planted({ [frame]: withoutFrameSheet }))).toEqual([]);
    const files = planted({
      [frame]: withoutFrameSheet,
      [STAGE]: tree.get(STAGE)!.replace('import "../../frame/seam.generated.css";', ""),
    });
    expect(tree.get(STAGE)).not.toBe(files.get(STAGE));
    expect(unseamed(files)).toEqual(stands);
  });
});

/** Every file `from` reaches through its imports, however far, types left out. */
function reachedFrom(files: Files, from: string): Set<string> {
  const seen = new Set<string>([from]);
  const queue = [from];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const { specifier, typeOnly } of importsOf(files.get(file) ?? "")) {
      if (typeOnly) continue;
      const to = target(files, file, specifier);
      if (!seen.has(to)) queue.push((seen.add(to), to));
    }
  }
  return seen;
}

describe("the reader's letter, on a page of the new design", () => {
  const ENTRY = "packages/app/src/reader/body/index.ts";
  const oldSheets = (files: Files) => [...reachedFrom(files, ENTRY)].filter((to) => OLD_SHEET.test(to) || to === "packages/ui/src/base.css");

  it("its body's entry reaches no stylesheet of the old kit's ground", () => {
    expect(reachedFrom(tree, ENTRY)).toContain("packages/letter-body/src/MessageBody.tsx");
    expect(oldSheets(tree)).toEqual([]);
  });

  it("the old kit's main entry, imported by the body, is found", () => {
    const files = planted({ "packages/letter-body/src/BlockNotice.tsx": `${tree.get("packages/letter-body/src/BlockNotice.tsx")}\nimport { Button } from "@ohmail/ui";\n` });
    expect(oldSheets(files)).toContain("packages/ui/src/base.css");
  });
});

describe("what the new folders import", () => {
  const borders: [folder: string, allowed: RegExp][] = [
    ["packages/tokens/src/design/", /^\.{1,2}\//],
    ["packages/tokens/scripts/", /^\.{1,2}\/|^node:/],
    ["packages/tokens/omarchy/design-slots.ts", /^\.\//],
    ["packages/ui/src/icons/", /^\.\/|^react(\/jsx-runtime)?$/],
    ["packages/ui/src/motion/", /^\.\/|^\.\.\/ui-zoom\.js$|^react$|^@ohmail\/tokens(\/design)?$/],
    ["packages/ui/src/base/", /^\.{1,2}\/|^react(\/jsx-runtime)?$|^@ohmail\/tokens\/design(\.css|\/motion\.css|\/fonts\.css)?$/],
    ["packages/ui/src/mail/", /^\.{1,2}\/|^react(\/jsx-runtime)?$/],
    ["packages/ui/src/calendar/", /^\.{1,2}\/|^react(\/jsx-runtime)?$/],
  ];
  const outside = (files: Files) =>
    [...files].flatMap(([file, text]) => {
      const border = borders.find(([folder]) => file.startsWith(folder));
      if (!border || file.endsWith(".json")) return [];
      return importsOf(text).filter(({ specifier }) => !border[1].test(specifier)).map(({ specifier }) => `${file}: ${specifier}`);
    });

  it("nothing beyond their own package, React and the tokens", () => {
    expect(outside(tree)).toEqual([]);
    expect(JSON.parse(tree.get("packages/tokens/package.json")!).dependencies).toEqual({});
  });

  it("an import of the engine is found", () => {
    const files = planted({ "packages/ui/src/motion/planted.ts": 'import { engine } from "@ohmail/client-engine";\n' });
    expect(outside(files).sort()).toEqual([
      ...outside(tree),
      "packages/ui/src/motion/planted.ts: @ohmail/client-engine",
    ].sort());
  });
});
