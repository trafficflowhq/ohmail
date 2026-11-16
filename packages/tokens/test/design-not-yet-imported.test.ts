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

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Who imports the design's subpaths, and how. `type` is erased before anything runs. */
const MAY_IMPORT: Record<string, "type" | "value"> = {
  "packages/ui/src/motion/motion.ts": "type",
  "packages/ui/src/base/index.ts": "value",
  "packages/ui/src/base/tokens.ts": "value",
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
const FRAME_MEETS = [
  ...SEAM_ROOTS,
  "apps/desktop/src/DesktopFrame.tsx",
  "apps/desktop/src/DesktopGate.tsx",
  "apps/paired-page/src/HostGate.tsx",
  "apps/webapp/app/(product)/demo/DemoShell.tsx",
  "apps/webapp/app/(product)/mailbox/CloudShell.tsx",
  "apps/webapp/app/shell/AppShell.tsx",
  "apps/webapp/app/shell/TodaysOhbox.tsx",
  "apps/webapp/app/shell/shell-open-state.ts",
  "apps/webapp/app/shell/todays-feeds.tsx",
  "apps/webapp/app/shell/todays-places.ts",
  "apps/webapp/app/shell/todays-reasons.ts",
  "apps/webapp/app/shell/todays-supplies.ts",
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
/** The parts of today's design a door's route draws, each with the task that rebuilds it. */
const DRAWN: Record<string, string[]> = {
  // `mailboxes`: the join's mailbox step is today's form, stood in the stage behind `.today` and today's seam sheet.
  [`${PRODUCT}/join/JoinRoute.tsx`]: [`${PRODUCT}/join/MailboxStep.tsx`],
  // `account`: the wall's password change is today's Settings pane, drawn in place of the wall with today's button and date.
  [`${PRODUCT}/mailbox/WallRoute.tsx`]: [`${PRODUCT}/mailbox/PasswordSection.tsx`, "apps/webapp/app/shell/format.ts", "packages/ui/src/index.ts"],
};
/**
 * The doors' modules that still reach both designs. Every door's route and page stays in the lists above, which the
 * two guards below walk; of them only these still reach the old stylesheets since the sending module left the old
 * shell. This list only falls, nothing joins it: a name leaves with the task that ends its reach, the ones DRAWN names
 * (`mailboxes`, `account`) and `removals`.
 */
const DOOR_MEETS = [
  `${PRODUCT}/account/delete/DeleteAccountRoute.tsx`,
  `${PRODUCT}/account/delete/page.tsx`,
  `${PRODUCT}/join/JoinRoute.tsx`,
  `${PRODUCT}/join/page.tsx`,
  `${PRODUCT}/mailbox/WallRoute.tsx`,
];
const MAY_MEET = [...FRAME_MEETS, ...DOOR_MEETS].sort();
/** The two seam sheets: the frame's meanings under `.oh-root`, today's under `.today`. */
const SEAM_SHEETS = [/^packages\/app\/src\/frame\/seam\.generated\.css$/, /^apps\/webapp\/app\/shell\/today-tokens\.generated\.css$/];

type Files = Map<string, string>;
const IMPORT = /(import\s+type\s[^"';]*?from\s*|\bfrom\s+|\bimport\s*\(?\s*|@import\s+(?:url\()?\s*|\brequire\(\s*)["']([^"']+)["']/g;
const importsOf = (text: string) => [...text.matchAll(IMPORT)].map((m) => ({ specifier: m[2], typeOnly: m[1].startsWith("import type") }));

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
function designImports(files: Files): [string, "type" | "value"][] {
  const out: [string, "type" | "value"][] = [];
  for (const [file, text] of files) {
    if (file.startsWith("packages/tokens/") || file.endsWith(".json")) continue;
    for (const { specifier, typeOnly } of importsOf(text)) if (DESIGN.test(specifier)) out.push([file, typeOnly ? "type" : "value"]);
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
    expect(designImports(files).map(([file]) => file).filter((file) => file.includes("planted")).sort()).toEqual([
      "apps/desktop/src/planted.ts", "apps/mobile/src/planted.ts", "apps/webapp/app/planted.tsx", "packages/ui/src/planted.css",
    ]);
  });
});

describe("the old stylesheets and the new meet only where listed", () => {
  const unlisted = (files: Files) => reachBoth(files).filter((file) => !MAY_MEET.includes(file));

  it("in the tree as it is: the listed modules, each of them, and no other", () => expect(reachBoth(tree)).toEqual(MAY_MEET));

  it("a module that is not listed is found: the old ones are reached through the component package's entry", () => {
    const files = planted({ "apps/webapp/app/planted-shell.tsx": 'import "@ohmail/tokens/design.css";\nimport "./planted-view";\n', "apps/webapp/app/planted-view.tsx": 'import { Button } from "@ohmail/ui";\n' });
    expect(unlisted(files)).toEqual(["apps/webapp/app/planted-shell.tsx"]);
  });

  it("a part of the new design inside one of today's views is found", () => {
    const files = planted({ "apps/webapp/app/shell/planted-view.tsx": 'import { Row } from "@ohmail/ui";\nimport { Button } from "@ohmail/ui/base";\n' });
    expect(unlisted(files)).toEqual(["apps/webapp/app/shell/planted-view.tsx"]);
  });

  it("a type alone joins nothing", () => {
    const files = planted({ "apps/webapp/app/planted-shell.tsx": 'import "@ohmail/tokens/design.css";\nimport type { ButtonProps } from "@ohmail/ui";\n' });
    expect(unlisted(files)).toEqual([]);
  });

  it("a listed module that reaches the new design no longer is found, so the list falls", () => {
    const files = planted({ "apps/webapp/app/shell/todays-reasons.ts": "export {};\n" });
    const both = reachBoth(files);
    expect(MAY_MEET.filter((file) => !both.includes(file))).toContain("apps/webapp/app/shell/todays-reasons.ts");
  });
});

describe("where they meet, the seam is loaded", () => {
  const without = (files: Files) =>
    SEAM_SHEETS.map((sheet) => {
      const reached = reaching(files, sheet);
      return SEAM_ROOTS.filter((root) => !reached.has(root));
    });

  it("every page and window that mounts today's views in the frame reaches both seam sheets", () => {
    expect(without(tree)).toEqual([[], []]);
  });

  it("a shell that stops loading today's seam sheet is found on every root", () => {
    const shell = "apps/webapp/app/shell/TodaysFrame.tsx";
    const files = planted({ [shell]: tree.get(shell)!.replace('import "./today-tokens.generated.css";', "") });
    expect(without(files)).toEqual([[], SEAM_ROOTS]);
  });

  it("a frame that stops loading its own is found on every root but the mailbox's, where the wall's stage loads it too", () => {
    const frame = "packages/app/src/frame/Frame.tsx";
    const files = planted({ [frame]: tree.get(frame)!.replace('import "./seam.generated.css";', "") });
    expect(without(files)).toEqual([SEAM_ROOTS.filter((root) => root !== `${PRODUCT}/mailbox/page.tsx`), []]);
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

  it("every door's page stands on a stage that loads the frame's seam sheet, and the join's, which draws today's form, today's too", () => {
    expect(unseamed(tree)).toEqual([]);
    expect(reaching(tree, SEAM_SHEETS[1]).has(`${PRODUCT}/join/page.tsx`)).toBe(true);
  });

  it("a stage that stops loading the frame's seam sheet is found on every door's page", () => {
    const files = planted({ [STAGE]: tree.get(STAGE)!.replace('import "../../frame/seam.generated.css";', "") });
    expect(tree.get(STAGE)).not.toBe(files.get(STAGE));
    expect(unseamed(files)).toEqual(stands);
  });
});

describe("what the new folders import", () => {
  const borders: [folder: string, allowed: RegExp][] = [
    ["packages/tokens/src/design/", /^\.{1,2}\//],
    ["packages/tokens/scripts/", /^\.{1,2}\/|^node:/],
    ["packages/tokens/omarchy/design-slots.ts", /^\.\//],
    ["packages/ui/src/icons/", /^\.\/|^react(\/jsx-runtime)?$/],
    ["packages/ui/src/motion/", /^\.\/|^\.\.\/ui-zoom\.js$|^react$|^@ohmail\/tokens(\/design)?$/],
    ["packages/ui/src/base/", /^\.{1,2}\/|^react(\/jsx-runtime)?$|^@ohmail\/tokens\/design(\.css|\/motion\.css)?$/],
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
    expect(outside(files)).toEqual(["packages/ui/src/motion/planted.ts: @ohmail/client-engine"]);
  });
});
