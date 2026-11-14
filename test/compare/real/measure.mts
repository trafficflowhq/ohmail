/**
 * THE REAL-APP MEASURE: each subject's place on the REAL web entry against the same state of the design reference,
 * element by element, value by value, at the eight looks (README.md). One command, from the repository's root:
 *
 *   REAL_MEASURE_STUDIO=<the studio's checkout> node --import tsx test/compare/real/measure.mts
 *     [--state matched|calendar] [--ref <tag or commit>] [--subjects frame,ohbox] [--looks 1440-paper-light,390-paper-dark] [--out <dir>]
 *
 * Without a reference it says so in one line and ends SKIPPED (exit 0). Otherwise it writes into `--out`
 * (`build/real-measure/`): rows.tsv (every difference, with the task that removes it or UNDECLARED), gone.tsv,
 * undeclared.json (the rows not declared yet, in `declared.json`'s form) and the readings of each look; prints the
 * counts; and ends GREEN (exit 0) or RED (exit 1). The reference is read as the comparison reads it (`../studio.mjs`):
 * the simulation's folder at one commit, unpacked and served on loopback, never a running copy. That commit is the
 * one pinned in `reference.json`, the one the declared list was read against. `--ref` or `REAL_MEASURE_REF` may name
 * it by a tag or commit; one that resolves to another commit prints so in one line and ends RED: not a verdict.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { asDeclared, differ, isPhone, lookParams, LOOKS, verdict, type Declared, type Element, type Look, type Readings, type Row } from "./rows.js";
import { contentInsets, mailChanges, readWorld, type World } from "./matched.js";
import { SUBJECTS, TODAY_WORDS, taggedRail, type PageName, type Subject } from "./subjects.js";

const ROOT = process.cwd();
const HERE = resolve(ROOT, "test/compare/real");
const say = (line: string): void => void process.stdout.write(`${line}\n`);

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i] ?? "";
    const value = argv[i + 1];
    if (!name.startsWith("--") || value === undefined) throw new Error(`real-measure: expected --name value pairs, read ${name}`);
    out[name.slice(2)] = value;
  }
  return out;
}

const a = args(process.argv.slice(2));
const withCalendar = a.state === "calendar";
const matched = a.state === "matched" || withCalendar;
const tags = a.tags ?? (withCalendar ? "initial" : "expanded");
if (!["expanded", "collapsed", "initial"].includes(tags) || (a.tags && !matched)) {
  throw new Error("--tags takes expanded, collapsed or initial in the matched state");
}
if (a.state && !matched) throw new Error("The optional --state must be matched or calendar");
const studio = a.studio ?? process.env.REAL_MEASURE_STUDIO ?? "";
if (!studio) {
  /* As the comparison does: COMPARE_REQUIRE_REFERENCE=1 turns the skip into a failure. */
  const required = process.env.COMPARE_REQUIRE_REFERENCE === "1";
  say(`real-measure: ${required ? "RED" : "SKIPPED"}: no design reference given (REAL_MEASURE_STUDIO=<the studio's checkout>, or --studio)`);
  process.exit(required ? 1 : 0);
}

const pick = <T extends { name?: string; id?: string }>(all: readonly T[], list: string | undefined, what: string): T[] => {
  if (!list) return [...all];
  return list.split(",").map((n) => {
    const found = all.find((x) => (x.name ?? x.id) === n);
    if (!found) throw new Error(`real-measure: no ${what} named ${n}`);
    return found;
  });
};
const subjects = pick(SUBJECTS, a.subjects ?? (withCalendar ? "reader" : undefined), "subject").map((subject) => {
  if (!matched) return subject;
  const calendarParam = withCalendar ? "" : "&cal=0";
  const tagsParam = tags === "initial" || subject.id === "frame-web" ? "" : "&tagsopen=1";
  return {
    ...subject,
    page: "web" as const,
    reference: subject.reference + calendarParam + tagsParam,
    desk: withCalendar && subject.id === "reader" ? [...subject.desk, ...TODAY_WORDS] : subject.desk,
  };
});
const looks = pick(LOOKS, a.looks, "look");
const out = resolve(ROOT, a.out ?? (withCalendar ? "build/real-measure-calendar" : matched ? "build/real-measure-matched" : "build/real-measure"));
const tolerance = JSON.parse(readFileSync(resolve(ROOT, "test/compare/tolerance.json"), "utf8")) as {
  box: number;
  settle: { quietMs: number; withinMs: number };
};
/* The reference the declared list was read against, pinned in the tree; it moves only together with declared.json. */
const pin = (JSON.parse(readFileSync(join(HERE, "reference.json"), "utf8")) as { studioCommit: string }).studioCommit;
const named = a.ref ?? process.env.REAL_MEASURE_REF;
const declared = JSON.parse(readFileSync(join(HERE, "declared.json"), "utf8")) as Declared[];

const { addressOf, commitOf, extractSimulator, serveLoopback } = await import("../studio.mjs");
/* One commit for the whole run, whatever the studio's head does meanwhile: the pin unless a tag or commit is named. */
const commit = commitOf(studio, named ?? pin);
if (commit !== pin) {
  /* The list holds the app against the pin only: against another reference its rows say nothing. */
  say(`real-measure: reference ${commit} is not the pinned ${pin}: not a verdict`);
  process.exit(1);
}

const { chromium } = await import("@playwright/test");
const { build } = await import("esbuild");
const { launch } = await import("../render.mjs");
const { keyOf } = await import("../registry.mjs");
const { facesDeclared, markElement, readElement } = await import("./page.mjs");
type Page = import("@playwright/test").Page;
type Browser = import("@playwright/test").Browser;

/** The real entries, bundled as the frame's browser tests bundle the demo's page. */
const PAGES: Record<PageName, { entry: string; path: string }> = {
  demo: { entry: "apps/webapp/test/frame/demo-page/entry.tsx", path: "/demo" },
  web: { entry: "apps/webapp/test/frame/web-page/entry.tsx", path: "/" },
};
const APP_ORIGIN = "https://app.real-measure.test";
const FEEDBACK_TOOL = /\/feedback\.js$/;

async function bundle(page: PageName, into: string): Promise<{ js: string; css: string }> {
  await build({
    entryPoints: [join(ROOT, PAGES[page].entry)],
    bundle: true, format: "iife", platform: "browser", target: ["es2020"], jsx: "automatic", outdir: into, entryNames: page,
    alias: { "next-intl": join(ROOT, "apps/webapp/test/editor-feel/intl-shim.mjs") },
    loader: { ".json": "json", ".css": "css", ".woff2": "dataurl", ".woff": "dataurl", ".svg": "dataurl", ".png": "dataurl", ".webp": "dataurl" },
    banner: { js: "window.process = window.process || { env: {} };" },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE": page === "web" ? JSON.stringify("/api") : "undefined" },
    logLevel: "warning",
  });
  return { js: readFileSync(join(into, `${page}.js`), "utf8"), css: readFileSync(join(into, `${page}.css`), "utf8") };
}

async function context(browser: Browser, look: Look) {
  const phone = isPhone(look);
  return browser.newContext({
    viewport: { width: look.width, height: look.height }, deviceScaleFactor: 1, colorScheme: look.scheme,
    hasTouch: phone, isMobile: phone, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC",
  });
}

const ACCOUNT = "measure-account";
const SIGNED_MAILBOX = "measure-mailbox";
const READY_AT = "2026-11-17T09:00:00.000Z";

function mailbox(id: string, address: string) {
  return {
    id, address, provider: "imap", status: "connected",
    organizerRole: "organizer", organizedBy: null, organizerState: null,
    organizerEventAt: null, organizerEventSeenAt: null, organizeConsentedAt: READY_AT,
    lastSyncAt: READY_AT, initialImportCompletedAt: READY_AT, createdAt: READY_AT,
    errorCode: null, disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  };
}

/** The signed-in web subjects' local API, including the selected mailbox's saved signature. */
const WEB_READS: Record<string, object> = {
  "/api/hello": { features: { pairing: false, draftReply: true } },
  "/api/mailboxes": { items: [
    mailbox(SIGNED_MAILBOX, "writer@example.invalid"),
    mailbox("measure-second-mailbox", "workshop@example.invalid"),
  ] },
  "/api/consent": {
    seedConfirmedAt: READY_AT, screeningResetAt: null, dormancyDays: 60,
    counts: { decidedSenders: 0, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
    signatures: { [SIGNED_MAILBOX]: "Avery Reed\nWorkshop correspondence" },
  },
  "/api/sync": {
    changes: { creates: [], updates: [], moves: [], deletes: [] },
    cursor: "c1", hasMore: false, serverTime: READY_AT,
  },
  "/api/billing/subscription": { plan: "solo", status: "active", aiEnabled: true },
  "/api/account/ai": { enabled: true, draftReply: true },
  "/api/organizer-requests": { items: [] },
};

/** The product at the subject's place, in the look's face and scheme as a person's device stores them. */
async function openApp(browser: Browser, look: Look, s: Subject, page$: { js: string; css: string }, world?: World): Promise<Page> {
  const ctx = await context(browser, look);
  await ctx.addInitScript(([face, scheme]) => {
    try {
      localStorage.setItem("ohmail.face", face);
      localStorage.setItem("ohmail.theme", scheme);
    } catch {
      /* A page without storage draws its defaults, and the readings say so. */
    }
  }, [look.face, look.scheme]);
  if (s.page === "web") {
    await ctx.addCookies([
      { name: "tf_owner", value: ACCOUNT, url: APP_ORIGIN },
      { name: "tf_resume", value: "1", url: APP_ORIGIN },
    ]);
  }
  const responses: Record<string, object> = world ? {
    ...WEB_READS,
    ...(world.calendar && { "/api/hello": { product: "ohmail", flavor: "selfhost", needsSetup: false, features: { staging: false, ai: false, pairing: false, calendar: true } } }),
    "/api/mailboxes": { items: world.mailboxes.map((m, index) => ({
      ...mailbox(m.id, m.address), displayName: index === 0 ? world.account.displayName : null,
      createdAt: new Date(Date.parse(world.now) + index).toISOString(),
    })) },
    "/api/screener": {
      items: world.waiting.map((w) => ({ messageId: w.id, sender: w.from, mailboxId: world.mailboxes[0]?.id, subject: w.subject, date: world.now })),
      total: world.waiting.length, nextCursor: null, pendingDecisions: [],
    },
    "/api/consent": { ...WEB_READS["/api/consent"], signatures: Object.fromEntries(world.mailboxes.map((m) => [m.id, m.signature ?? ""])) },
    "/api/sync": mailChanges(world, ACCOUNT),
  } : WEB_READS;
  const page = await ctx.newPage();
  if (world?.calendar) await page.clock.setFixedTime(new Date(world.calendar.now));
  await page.route(`${APP_ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (s.page === "web" && path === "/api/auth/session") {
      return route.fulfill({ json: { scope: "full", user: {
        accountId: ACCOUNT, userId: "measure-user", displayName: world?.account.displayName ?? "Fictional reader",
        email: world?.account.signIn ?? "reader@example.invalid", emailVerified: true,
        twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
      } } });
    }
    if (s.page === "web") {
      if (path === "/auth/refresh") return route.fulfill({ status: 204 });
      if (route.request().method() === "GET" && Object.hasOwn(responses, path)) {
        return route.fulfill({ json: responses[path] });
      }
    }
    if (path.startsWith("/api/")) return route.fulfill({ status: 404, json: {} });
    if (path.endsWith(".js")) return route.fulfill({ contentType: "application/javascript", body: page$.js });
    if (path.endsWith(".css")) return route.fulfill({ contentType: "text/css", body: page$.css });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
        <link rel="stylesheet" href="/page.css"></head><body class="mo-canvas app-body today">
        <div id="app" style="display:contents"></div><script src="/page.js"></script></body></html>`,
    });
  });
  await page.goto(`${APP_ORIGIN}${PAGES[s.page].path}${s.route}`);
  if (world && s.id !== "frame-web") {
    const offer = page.getByRole("status").filter({ has: page.getByText("Get ohmail for desktop", { exact: true }) });
    await offer.getByRole("button", { name: "Dismiss", exact: true }).click();
  }
  if (world && s.id !== "frame-web" && tags !== "initial" && !isPhone(look)) {
    const fold = page.locator("nav.oh-rail").getByRole("button", { name: "Tags", exact: true });
    if (await fold.getAttribute("aria-expanded") !== "true") await fold.click();
    if (tags === "collapsed") await fold.click();
    // Revisit with the choice the person just saved. The initial state makes no such press.
    await page.reload();
    await page.locator("nav.oh-rail").getByRole("button", {
      name: "Tags", expanded: tags === "expanded", exact: true,
    }).waitFor();
  }
  if (s.page === "demo") {
    /* The demo's own ribbon: the product's pages have none. Dismissed as a person dismisses it. */
    await page.locator(".demo-ribbon button").first().click({ timeout: 5000 }).catch(() => undefined);
  }
  return page;
}

/** The reference's same state at the look: its registry key with the look's own parameters, drawn bare. */
async function openReference(browser: Browser, look: Look, s: Subject, base: string): Promise<Page> {
  const ctx = await context(browser, look);
  await ctx.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (FEEDBACK_TOOL.test(u.pathname)) return route.abort();
    if (u.origin + "/" === base || ["data:", "blob:", "about:"].includes(u.protocol)) return route.continue();
    return route.abort();
  });
  const page = await ctx.newPage();
  await page.goto(addressOf(base, keyOf([s.reference, ...lookParams(look)].join("&"))), { waitUntil: "load" });
  /* The reference marks its body once it has drawn the state without its own frame; until then nothing is read. */
  await page.waitForFunction(() => document.body?.dataset.bare === "1", undefined, { timeout: 30_000 }).catch(async () => {
    await ctx.close();
    throw new Error(`the reference did not draw ${s.reference} bare`);
  });
  if (matched && s.id !== "frame-web" && tags === "collapsed" && !isPhone(look)) {
    await page.locator("#rail .rscroll").getByRole("button", { name: "Tags", expanded: true, exact: true }).click();
    if (s.route === "#/ohbox") await page.locator("#reader").click({ position: { x: 4, y: 4 } });
  }
  return page;
}

/** Every element's values on one side, the face its words were drawn in among them; a finder that threw goes to `threw`. */
async function readSide(page: Page, elements: readonly Element[], side: "app" | "reference", threw: Set<string>): Promise<Readings> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const readings: Readings = {};
  for (const [i, el] of elements.entries()) {
    const mark = `e${i}`;
    const finder = matched && side === "app" ? el.matchedApp ?? el.app : el[side];
    const found = await page.evaluate(markElement, [finder, mark] as [string | null, string]);
    if (found === "threw") threw.add(`finder of ${el.name} threw on the ${side}`);
    if (found !== true) {
      readings[el.name] = null;
      continue;
    }
    const reading = await page.evaluate(readElement, [mark, el.kind] as [string, "box" | "text" | "icon"]);
    if (reading && matched && el.contentChild) {
      reading.padding = await page.evaluate(contentInsets, [mark, side === "app" ? el.contentChild : null] as [string, string | null]);
    }
    if (reading && el.kind === "text") {
      const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[data-real-measure="${mark}"]` });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      reading.face = fonts.map((f) => `${f.familyName} (${f.isCustomFont ? "web font" : "system"})`).join(" + ") || "(no glyphs)";
    }
    readings[el.name] = reading;
  }
  await cdp.detach();
  return readings;
}

/** Reads until two readings `quietMs` apart are the same: a page that is still arriving is not measured. */
async function readStill(page: Page, elements: readonly Element[], side: "app" | "reference", threw: Set<string>): Promise<{ readings: Readings; still: boolean }> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const deadline = Date.now() + tolerance.settle.withinMs;
  let before = await readSide(page, elements, side, threw);
  for (;;) {
    await page.waitForTimeout(tolerance.settle.quietMs);
    const after = await readSide(page, elements, side, threw);
    if (JSON.stringify(after) === JSON.stringify(before)) return { readings: after, still: true };
    if (Date.now() > deadline) return { readings: after, still: false };
    before = after;
  }
}

const work = mkdtempSync(join(tmpdir(), "real-measure-"));
const rows: Row[] = [];
const measured: { subject: string; look: string }[] = [];
const faults: string[] = [];
const neither = new Map<string, Set<string>>();
try {
  const served = extractSimulator(studio, commit, mkdtempSync(join(work, "reference-")));
  const server = await serveLoopback(served);
  const browser = await launch(chromium);
  const pages = new Map<PageName, { js: string; css: string }>();
  for (const s of subjects) if (!pages.has(s.page)) pages.set(s.page, await bundle(s.page, mkdtempSync(join(work, "page-"))));
  mkdirSync(join(out, "readings"), { recursive: true });
  try {
    for (const look of looks) {
      const here = subjects.filter((s) => (s.looks ?? LOOKS.map((l) => l.name)).includes(look.name));
      /* Subjects drawn on the same entry, place and reference state are read from one pair of pages. */
      const groups = new Map<string, Subject[]>();
      for (const s of here) groups.set(JSON.stringify([s.page, s.route, s.reference]), [...(groups.get(JSON.stringify([s.page, s.route, s.reference])) ?? []), s]);
      const saved: Record<string, unknown> = {};
      for (const group of groups.values()) {
        const first = group[0]!;
        const reference = await openReference(browser, look, first, server.base).catch((e: Error) => {
          faults.push(`${look.name} ${group.map((s) => s.id).join(", ")}: ${e.message}`);
          return null;
        });
        if (!reference) continue;
        const world = matched ? await readWorld(reference, withCalendar) : undefined;
        const app = await openApp(browser, look, first, pages.get(first.page)!, world);
        for (const s of group) {
          /* A finder that threw is answered "threw", which the wait would take for an element found: it is a fault. */
          const ready = async (page: Page, expr: string, side: string): Promise<boolean> =>
            page.waitForFunction(markElement, [expr, "ready"] as [string, string], { timeout: 30_000 }).then(
              async (found) => (await found.jsonValue()) === true || (faults.push(`${look.name} ${s.id}: finder of ready threw on the ${side}`), false),
              () => (faults.push(`${look.name} ${s.id}: the ${side} never drew ${expr}`), false),
            );
          if (!(await ready(app, s.ready.app, "app")) || !(await ready(reference, s.ready.reference, "reference"))) continue;
          const list = isPhone(look) ? s.phone
            : world && s.id === "frame" ? [...s.desk, ...taggedRail(world.tagCatalog)] : s.desk;
          const threw = new Set<string>();
          const A = await readStill(app, list, "app", threw);
          const R = await readStill(reference, list, "reference", threw);
          for (const line of threw) faults.push(`${look.name} ${s.id}: ${line}`);
          if (!A.still || !R.still) faults.push(`${look.name} ${s.id}: the ${A.still ? "reference" : "app"} did not stand still`);
          rows.push(...differ({ look: look.name, subject: s.id }, list, A.readings, R.readings, tolerance.box, matched));
          measured.push({ subject: s.id, look: look.name });
          const none = neither.get(s.id) ?? new Set<string>();
          for (const el of list) if (!A.readings[el.name] && !R.readings[el.name]) none.add(el.name);
          neither.set(s.id, none);
          saved[s.id] = {
            ...(world && { input: { mailboxes: world.mailboxes.length, unread: world.unread, waiting: world.waiting.length, conversations: world.threads.length, drafts: world.drafts.length, ...(world.calendar && { dayEvents: world.calendar.events.length }) } }),
            app: A.readings, reference: R.readings,
          };
        }
        saved[`faces ${first.page}`] = { app: await app.evaluate(facesDeclared), reference: await reference.evaluate(facesDeclared) };
        await app.context().close();
        await reference.context().close();
      }
      writeFileSync(join(out, "readings", `${look.name}.json`), JSON.stringify(saved, null, 1));
      say(`${look.name}: ${rows.filter((r) => r.look === look.name).length} differences`);
    }
  } finally {
    await browser.close();
    await server.close();
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

// The stored declarations describe the inventory's sample account. Its expected differences
// must never excuse a changed word, missing control or layout difference in the matched states.
const v = verdict(rows, matched ? [] : declared, measured);
const task = new Map(v.declared.map((r) => [JSON.stringify([r.look, r.subject, r.element, r.property]), r.removedBy]));
const tsv = (list: string[][]): string => list.map((l) => l.join("\t")).join("\n") + "\n";
writeFileSync(join(out, "rows.tsv"), tsv([["look", "subject", "element", "property", "app", "reference", "removedBy"],
  ...rows.map((r) => [r.look, r.subject, r.element, r.property, r.app, r.reference, task.get(JSON.stringify([r.look, r.subject, r.element, r.property])) ?? "UNDECLARED"])]));
writeFileSync(join(out, "gone.tsv"), tsv([["look", "subject", "element", "property", "removedBy"], ...v.gone.map((g) => [g.look, g.subject, g.element, g.property, g.removedBy])]));
writeFileSync(join(out, "undeclared.json"), JSON.stringify(asDeclared(v.undeclared, new Date().toISOString().slice(0, 10)), null, 2) + "\n");

let appTree = "?";
try {
  appTree = execFileSync("git", ["rev-parse", "--short=9", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
} catch {
  /* Not a checkout: the tree is named by nothing. */
}
say(`app ${appTree}; reference ${named ?? "pinned"} (${commit.slice(0, 9)}); ${looks.length} looks; ${subjects.map((s) => s.id).join(", ")}`);
const byTask = new Map<string, number>();
for (const r of v.declared) byTask.set(r.removedBy, (byTask.get(r.removedBy) ?? 0) + 1);
for (const [t, n] of [...byTask].sort((x, y) => y[1] - x[1])) say(`  declared, removed by ${t}: ${n}`);
for (const [s, none] of neither) if (none.size) say(`  ${s}: drawn on neither side: ${[...none].join(", ")}`);
for (const f of [...faults, ...v.faults]) say(`  FAULT ${f}`);
for (const r of v.undeclared.slice(0, 40)) say(`  UNDECLARED ${r.look} ${r.subject} ${r.element} ${r.property}: app ${r.app} | reference ${r.reference}`);
if (v.undeclared.length > 40) say(`  … ${v.undeclared.length - 40} more in rows.tsv`);
for (const g of v.gone.slice(0, 40)) say(`  GONE ${g.look} ${g.subject} ${g.element} ${g.property} (declared for ${g.removedBy}): take it out of declared.json`);
const green = v.green && faults.length === 0;
say(`real-measure: ${green ? "GREEN" : "RED"}: ${rows.length} differences, ${v.declared.length} declared, ${v.undeclared.length} undeclared, ${v.gone.length} declared rows gone, ${faults.length + v.faults.length} faults (${out})`);
process.exit(green ? 0 : 1);
