import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DELIVERABLE_EVENTS, NOTICE_EVENTS } from "@ohmail/client-engine";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  "FULLY OFF" MEANS NO CODE PATH FIRES — the structural half
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `packages/client-engine/test/notifications-gate.test.ts` drives the gate and proves that with
 * the master off it returns nothing to draw. That is necessary and not sufficient: it can only
 * speak for emitters it knows about, and the one that will break this rule is the one somebody
 * adds next year without reading any of it.
 *
 * So this scans the SOURCE. Two lists, because two different things are being permitted:
 *
 *  · {@link TRANSPORTS} may touch a platform notification API. They decide nothing — they are the
 *    "how does this OS draw a notice" half — and they must contain no branch of their own.
 *  · {@link EMITTERS} decide WHETHER to draw, and every one of them must consult the shared gate.
 *
 * A new `new Notification(...)` in a view component is in neither list and fails this file.
 *
 * ── THIS FILE SCANS FOR STRINGS IT WOULD OTHERWISE CONTAIN ────────────────────────────────
 *
 * The trap `apps/mobile/test/privacy.test.ts` names about itself. Two defences, both used here:
 * the scan covers shipped source only and never `test/`, and every pattern is COMPOSED from
 * fragments rather than written out, so this file would not match even if it were scanned.
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The shipped surfaces that could draw a notice.
 *
 * `apps/webapp/public` is in the list for one file — the service worker. It is plain `.js` served
 * at the origin root rather than compiled source, which is exactly the kind of place a notice
 * could be drawn without anybody noticing, so the scan reaches it too.
 */
const ROOTS = [
  "apps/desktop/src", "apps/webapp/app", "packages/app-logic/src", "apps/mobile/src", "apps/webapp/public",
] as const;

/** Extensions worth scanning. `.js` is here for the service worker and nothing else today. */
const EXTS = [".ts", ".tsx", ".js"];

interface Source { path: string; body: string }

/**
 * THE SOURCE WITH COMMENTS REMOVED — and this is the load-bearing part of the file.
 *
 * Found by mutating it: two of the three mutations below PASSED before this existed. This
 * census's own explanatory comments name `decideNotices` while explaining why every emitter must
 * call it, so a scan of the raw text is satisfied by the PROSE — an emitter that stopped calling
 * the gate and kept the paragraph saying it does still went green. A census that a comment can
 * satisfy is decorative, and it reads exactly like a working one.
 *
 * A small state machine and not a regex, for the reason the worker's content-free census gives:
 * a regex that strips `//…` also eats the tail of `"https://…"`, and these files contain URLs.
 * String and template literals are tracked so their contents survive verbatim.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let mode: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code";
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") { mode = "line"; i += 2; continue; }
      if (c === "/" && n === "*") { mode = "block"; i += 2; continue; }
      if (c === "'") mode = "sq";
      else if (c === '"') mode = "dq";
      else if (c === "`") mode = "tpl";
      out += c; i += 1; continue;
    }
    if (mode === "line") {
      if (c === "\n") { mode = "code"; out += c; }
      i += 1; continue;
    }
    if (mode === "block") {
      if (c === "*" && n === "/") { mode = "code"; i += 2; continue; }
      if (c === "\n") out += c;          // keep line numbers honest
      i += 1; continue;
    }
    // inside a literal: copy verbatim, honour escapes, and close on the matching quote
    out += c;
    if (c === "\\") { if (i + 1 < src.length) { out += src[i + 1]!; i += 2; continue; } }
    if ((mode === "sq" && c === "'") || (mode === "dq" && c === '"') || (mode === "tpl" && c === "`")) {
      // the opening quote was already copied by the code branch, so this closes only when it is
      // not that same character position
      if (out.length > 1) mode = "code";
    }
    i += 1;
  }
  return out;
}

function walk(dir: string, out: Source[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // a root that does not exist is caught by the reach assertion below, not here
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full, out); continue; }
    if (!EXTS.includes(extname(entry))) continue;
    const raw = readFileSync(full, "utf8");
    out.push({ path: relative(REPO, full).split("\\").join("/"), body: stripComments(raw) });
  }
}

const shipped: Source[] = [];
for (const r of ROOTS) walk(join(REPO, r), shipped);

/**
 * MAY TOUCH THE PLATFORM. `native.ts` is the desktop's binding to the shell command that owns
 * the OS notification centre; it takes a title and a body and has no opinion about either.
 */
const TRANSPORTS = new Set([
  "apps/desktop/src/native.ts",
  /**
   * THE SERVICE WORKER, and why it is a transport rather than an emitter.
   *
   * It cannot consult the gate and never will: it has no module system, no mirror, and no idea
   * what changed — the wake that starts it is a closed constant, deliberately, so the kind of
   * event never travels. Asking it to import `decideNotices` would be asking it to decide with
   * nothing to decide from.
   *
   * WHAT GATES IT INSTEAD IS THE SUBSCRIPTION. The app registers for wakes only while the master
   * and the new-mail switch are both on, so "off" means the server has no endpoint to dial and
   * this file is never entered — the switch is enforced one layer out, at the registration,
   * rather than inside the worker. The stored state it reads is a second belt: a worker that
   * outlived its app, or one whose subscription was not tidied, draws nothing.
   *
   * It is admitted here rather than exempted silently so that the reason is reviewed rather
   * than assumed, and so a SECOND draw call added to it would still have to pass the scan below.
   */
  "apps/webapp/public/sw.js",
]);

/**
 * MUST CONSULT THE GATE. One per surface today — the desktop's unread sink. The browser's
 * service worker and the phone's renderer bridge join this list as they land, and adding one
 * without the gate import fails the second test below.
 */
const EMITTERS = new Set(["apps/desktop/src/DesktopGate.tsx"]);

/** The shared decision layer, and the call every emitter owes it. */
const GATE_MODULE = "@ohmail/client-engine";
const GATE_CALL = ["decide", "Notices"].join("");

/**
 * Every way to draw a notice, composed so this file does not match itself.
 *  · the desktop's shell binding — renamed FROM `notify`, which is also the client-engine's
 *    subscriber callback and so useless as a census key;
 *  · the two browser forms, page and service worker.
 * `expo-notifications` is absent deliberately: `apps/mobile/test/privacy.test.ts` bans the module
 * outright, so the phone's notice goes through its own native renderer instead.
 */
const DRAW_PATTERNS: [string, RegExp][] = [
  ["desktop shell notice", new RegExp(`\\b${["post", "OsNotice"].join("")}\\s*\\(`)],
  ["Notification constructor", new RegExp(`new\\s+${["Notifi", "cation"].join("")}\\s*\\(`)],
  ["service-worker notice", new RegExp(`\\.${["show", "Notification"].join("")}\\s*\\(`)],
];

describe("the scan reaches the surfaces — a census over nothing passes vacuously", () => {
  it("found source under each root", () => {
    for (const r of ROOTS) {
      /* `apps/webapp/public` holds exactly one scanned file, the worker; the compiled roots hold
         many. The point of the assertion is that the walk REACHED each root at all. */
      const want = r === "apps/webapp/public" ? 1 : 5;
      expect(
        shipped.filter((f) => f.path.startsWith(r)).length,
        `no source scanned under ${r} — this census is looking at an empty tree`,
      ).toBeGreaterThanOrEqual(want);
    }
  });

  it("every allow-listed file EXISTS — a stale allow-list is itself a failure", () => {
    const paths = new Set(shipped.map((f) => f.path));
    for (const p of [...TRANSPORTS, ...EMITTERS]) {
      expect(paths, `allow-listed but missing: ${p}`).toContain(p);
    }
  });

  it("the patterns actually match the emitter we know about — a pattern that matches nothing guards nothing", () => {
    const gate = shipped.find((f) => f.path === "apps/desktop/src/DesktopGate.tsx")!;
    const matched = DRAW_PATTERNS.some(([, re]) =>
      gate.body.split("\n").some((l) => re.test(l)));
    expect(matched, "no draw pattern matches the known emitter — the census is decorative").toBe(true);
  });
});

describe("nothing draws a notice outside the allow-lists", () => {
  it("no shipped source outside them reaches a platform notification API", () => {
    const hits: string[] = [];
    for (const { path, body } of shipped) {
      if (TRANSPORTS.has(path) || EMITTERS.has(path)) continue;
      for (const [label, re] of DRAW_PATTERNS) {
        for (const [i, line] of body.split("\n").entries()) {
          if (re.test(line)) hits.push(`${path}:${i + 1} [${label}] ${line.trim()}`);
        }
      }
    }
    expect(hits, "a notice is drawn somewhere the master switch cannot reach").toEqual([]);
  });
});

describe("the pane may only offer a switch something can deliver", () => {
  /**
   * BOTH DIRECTIONS, because each is a different lie.
   *
   * An event listed as deliverable that no emitter names is a switch that cannot act — the
   * inert-control defect this surface was built to remove, returning as soon as the vocabulary
   * grows faster than the emitters. An event some emitter DRAWS that the list does not admit is
   * the opposite: a notice arriving with no switch to stop it.
   */
  /**
   * EMITTERS ONLY, and the exclusion of the transports is not tidiness.
   *
   * A transport draws what it is handed and holds no event vocabulary, so scanning one matches
   * unrelated strings that merely spell the same word — `native.ts` carries the desktop's MENU
   * view names, one of which is "screener", and including it reported an emitter drawing an
   * event nothing emits. A census with a false positive gets weakened until it is quiet, so it
   * is narrowed to the files where the decision actually lives.
   */
  const emitterSource = [...EMITTERS]
    .map((p) => shipped.find((f) => f.path === p)!.body).join("\n");

  it("every deliverable event is named by an emitter", () => {
    for (const e of DELIVERABLE_EVENTS) {
      expect(
        new RegExp(`["']${e}["']`).test(emitterSource),
        `"${e}" is offered as a switch and no emitter mentions it`,
      ).toBe(true);
    }
  });

  it("no emitter draws an event the pane withholds a switch for", () => {
    const withheld = NOTICE_EVENTS.filter((e) => !DELIVERABLE_EVENTS.includes(e));
    for (const e of withheld) {
      expect(
        new RegExp(`["']${e}["']`).test(emitterSource),
        `"${e}" is drawn by an emitter but the pane offers no switch to stop it`,
      ).toBe(false);
    }
  });
});

describe("every emitter consults the gate", () => {
  it("each imports the shared decision layer and calls it", () => {
    const missing: string[] = [];
    for (const path of EMITTERS) {
      const body = shipped.find((f) => f.path === path)!.body;
      if (!new RegExp(`from ["']${GATE_MODULE}`).test(body)) {
        missing.push(`${path}: never imports ${GATE_MODULE}`);
      }
      // A CALL, with its paren, in code rather than in prose. `includes(GATE_CALL)` was the first
      // spelling and a mutation walked straight through it: the identifier also appears in this
      // file's and the emitter's own comments. Removing the IMPORT while keeping the call is not
      // covered here and does not need to be — it is a compile error, and the desktop's own
      // `tsc --noEmit` is the guard for it.
      if (!new RegExp(`\\b${GATE_CALL}\\s*\\(`).test(body)) {
        missing.push(`${path}: never calls ${GATE_CALL}()`);
      }
    }
    expect(missing, "an emitter that draws without asking the gate").toEqual([]);
  });
});
