import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { bracketSpan, withoutComments, withoutCommentsAndLiterals } from "../scripts/lib/source-scan.mjs";

/**
 * ONE DECIDER FOR WHY A READER'S PRESS HAS NOWHERE TO GO. Six server sites and the client's
 * Screener each chose between `organizer_outdated` and `no_organizer` on `by.kind === null` alone,
 * so a holder that stopped renewing was told to update ohmail. The choice now lives in
 * `packages/core/src/reader-refusal.ts`; this walks every product source root for a second
 * statement of it and reads each refusal that carries a reason for the decider's call.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const LEAF = "packages/core/src/reader-refusal.ts";
const ROOTS = ["apps", "packages"];
const SKIP = new Set(["node_modules", "dist", "build", "test", "tests", ".next", "android", "ios", "src-tauri"]);

function sources(): { file: string; raw: string }[] {
  const out: { file: string; raw: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (SKIP.has(e) || e.startsWith(".")) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts)$/.test(e) && !/\.(test|spec)\.tsx?$/.test(e)) out.push({ file: relative(REPO, p), raw: readFileSync(p, "utf8") });
    }
  };
  for (const r of ROOTS) walk(join(REPO, r));
  return out;
}

/** A conditional whose two arms are the two reasons — the shape every copy of the rule took. */
const CHOOSES = /\?\s*"(no_organizer|organizer_outdated)"\s*:\s*"(no_organizer|organizer_outdated)"/g;

/** The top-level arguments of the call whose `(` sits at `open`, in the blanked text. */
function argsAt(blank: string, open: number): string[] {
  const s = bracketSpan(blank, open);
  expect(s.closed, "a call that never closes").toBe(true);
  const body = blank.slice(s.start, s.end);
  const args: string[] = [];
  let depth = 0; let from = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if ("({[".includes(c)) depth++;
    else if (")}]".includes(c)) depth--;
    else if (c === "," && depth === 0) { args.push(body.slice(from, i).trim()); from = i + 1; }
  }
  const last = body.slice(from).trim();
  if (last !== "") args.push(last);
  return args;
}

describe("the reason a reader's press is refused has one decider, and every refusal asks it", () => {
  it("is chosen in the leaf and nowhere else in any product source root", () => {
    expect(existsSync(join(REPO, LEAF)), `${LEAF} is missing`).toBe(true);
    const all = sources();
    // A walk that found nothing passes every assertion under it: the count comes first.
    expect(all.length).toBeGreaterThan(500);
    const found: string[] = [];
    for (const { file, raw } of all) {
      for (const m of withoutComments(raw).matchAll(CHOOSES)) if (m[1] !== m[2]) found.push(file);
    }
    expect(found.sort()).toEqual([LEAF, LEAF]);
  });

  it("every OrganizedElsewhereError carrying a reason takes it from the decider", () => {
    const seen: string[] = [];
    for (const { file, raw } of sources()) {
      const blank = withoutCommentsAndLiterals(raw);
      for (const m of blank.matchAll(/\bnew OrganizedElsewhereError\(/g)) {
        const args = argsAt(blank, m.index! + m[0].length - 1);
        if (args.length < 3) continue;
        seen.push(`${file}: ${args[2]}`);
      }
    }
    // `named.reason` is a fan-out refusal's own reason, which the next case pins to the decider.
    expect(seen.sort()).toEqual([
      "packages/services/src/reader-request.ts: named.reason",
      "packages/services/src/reader-request.ts: requestRefusalReason(e)",
      "packages/services/src/reader-request.ts: requestRefusalReason(eligibility)",
      "packages/services/src/screener-service.ts: requestRefusalReason(e)",
      "packages/services/src/screener-service.ts: requestRefusalReason(eligibility)",
      "packages/services/src/screener-service.ts: requestRefusalReason(ineligible)",
    ]);
  });

  it("the fan-out's per-mailbox refusal and the client's Screener read the same leaf", () => {
    const fanOut = withoutCommentsAndLiterals(readFileSync(join(REPO, "packages/services/src/reader-request.ts"), "utf8"));
    expect(fanOut).toMatch(/refused\.push\(\{\s*mailboxId: id, holder: e\.by, reason: requestRefusalReason\(e\) \}\)/);
    const client = readFileSync(join(REPO, "apps/webapp/app/shell/mail-state.ts"), "utf8");
    expect(withoutComments(client)).toMatch(/from "@trafficflow\/core\/reader-refusal"/);
    const at = withoutCommentsAndLiterals(client).indexOf("export function screenerMode(");
    expect(at).toBeGreaterThan(-1);
    const body = withoutCommentsAndLiterals(client).slice(at);
    expect(body.slice(0, body.indexOf("\n}\n")), "screenerMode does not ask the decider").toMatch(/\brosterRefusalReason\(/);
    // The Mailboxes pane's row and its takeover line ask the same liveness the reasons rest on.
    expect(withoutCommentsAndLiterals(client)).toMatch(/!holderIsLive\(\{ by: m\.organizedBy, state: m\.organizerState \}\)/);
    const pane = withoutCommentsAndLiterals(readFileSync(join(REPO, "apps/webapp/app/(product)/mailbox/MailboxSection.tsx"), "utf8"));
    expect(pane, "the row does not ask whether its holder is live").toMatch(/\breaderHolderLapsed\(m\)/);
    expect(pane, "the takeover line does not ask whether the holder is live").toMatch(/\bholderIsLive\(\{/);
  });
});

/* ══ EVERY SENTENCE THAT NAMES WHO ORGANIZES A MAILBOX ASKS THE SAME DECIDER ══════════════════
   The Screener's move refusal, its preview notes, the message verbs, the desktop's reader rows and
   the phone's paired card each named the first recorded holder, so a machine that had stopped read
   as the organizer. A sentence is admitted only where the code choosing it CALLS a door below, and
   every door is read for the decider's call. Parsed for calls in blanked source, never a word. */

type SourceFile = { file: string; raw: string };

const MAIL_STATE = "apps/webapp/app/shell/mail-state.ts";
const SCREENER_STATE = "apps/webapp/app/shell/screener-state.ts";
const SHELL_DISPATCH = "apps/webapp/app/shell/shell-dispatch.ts";
const APP_SHELL = "apps/webapp/app/shell/AppShell.tsx";
const PHONE_FORM = "apps/mobile/src/ui/standalone-form.ts";
const READER_HOLDER = "apps/webapp/app/shell/reader-holder.ts";
const PHONE_LIVE = "apps/mobile/src/state/live.ts";

/** A door is a function a holder sentence is chosen from; `asks` is read in its body. */
const DOORS: { file: string; fn: string; asks: RegExp; literals?: true }[] = [
  { file: MAIL_STATE, fn: "screenerMode", asks: /\bholderIsLive\(/ },
  { file: MAIL_STATE, fn: "screenerMode", asks: /\brosterRefusalReason\(/ },
  // The role's `reason` is `screenerMode`'s decider answer: read, never re-derived.
  { file: MAIL_STATE, fn: "readerHolder", asks: /\brole\.reason === "no_organizer"/, literals: true },
  { file: MAIL_STATE, fn: "readerMoveRefusal", asks: /\bholderIsLive\(/ },
  { file: "apps/webapp/app/shell/first-run-subject.ts", fn: "accountOrganizer", asks: /\bholderIsLive\(/ },
  // A 409's reason is the server's decider answer (case 2 above pins the server side).
  { file: "apps/webapp/app/shell/organizer-refusal.ts", fn: "organizerRefusalOf", asks: /\?\.reason === "no_organizer"/, literals: true },
  { file: PHONE_FORM, fn: "claimFrom", asks: /\bholderIsLive\(/ },
  { file: PHONE_LIVE, fn: "phoneOrganizer", asks: /\bholderIsLive\(/ },
  // The stop is the decider's too: a named holder that is not live (READER-SENTENCES-STOPPED-ARMS).
  { file: LEAF, fn: "holderStopped", asks: /\bholderIsLive\(/ },
  { file: READER_HOLDER, fn: "holderStopped", asks: /\bleaseStopped\(/ },
  { file: READER_HOLDER, fn: "phoneHolder", asks: /\bholderIsLive\(/ },
  // The organizing situation is the one derivation; its reader arm asks the decider.
  { file: LEAF, fn: "standingSituation", asks: /\bholderIsLive\(/ },
  { file: MAIL_STATE, fn: "noticeKind", asks: /\borganizerSituation\(/ },
  { file: MAIL_STATE, fn: "readerStandDown", asks: /\borganizerSituation\(/ },
  // The sheets' organizer: a hand-back read as this install organizing it while it asked the decider alone.
  { file: MAIL_STATE, fn: "otherOrganizerOf", asks: /\borganizerSituation\(/ },
  { file: PHONE_FORM, fn: "claimHere", asks: /\borganizerSituation\(/ },
  // The rail's `who.stopped` (FILING-RAIL-SAYS-A-STOPPED-HOLDER-FILES).
  { file: MAIL_STATE, fn: "filingReportOf", asks: /\bholderStopped\(/ },
];

/**
 * A SITE renders holder sentences (`keys`, a catalogue key as quoted or a copy member as read) in
 * `file`, inside `fn` when named; each of `calls` must appear as a call in its own file and
 * function — for a prop-driven sentence, the file that hands it its holder.
 */
interface Site {
  file: string;
  fn?: string;
  keys: string[];
  calls: { file: string; fn?: string; call: RegExp }[];
}

const SITES: Site[] = [
  { file: SCREENER_STATE, fn: "refuseMove", keys: ['"readerMoveRefused"', '"readerMoveRefusedUnknown"', '"readerMoveRefusedNobody"'],
    calls: [{ file: SCREENER_STATE, fn: "refuseMove", call: /\breaderHolder\(role\)/ }] },
  { file: SCREENER_STATE, fn: "refuseReadOnly", keys: ['"readerRefused"', '"readerRefusedUnknown"'],
    calls: [{ file: SCREENER_STATE, fn: "refuseReadOnly", call: /\breaderHolder\(role\)/ }] },
  { file: SHELL_DISPATCH, fn: "useShellDispatch",
    keys: ['"screener.readerMoveRefused"', '"screener.readerMoveRefusedUnknown"', '"screener.readerMoveRefusedNobody"'],
    calls: [{ file: SHELL_DISPATCH, fn: "useShellDispatch", call: /\breaderMoveRefusal\(/ }] },
  { file: SHELL_DISPATCH, fn: "refusalSentence",
    keys: ['"ohbox.refusedOrganized"', '"ohbox.refusedOrganizedUnknown"', '"ohbox.refusedNobody"'],
    calls: [{ file: SHELL_DISPATCH, fn: "refusalSentence", call: /\borganizerRefusalOf\(err\)/ }] },
  { file: "apps/webapp/app/views/ScreenerView.tsx",
    keys: ['"moveBarWhy"', '"moveBarWhyUnknown"', '"moveBarWhyNobody"', '"readerBarWhy"', '"readerBarWhyUnknown"'],
    calls: [{ file: "apps/webapp/app/views/ScreenerView.tsx", call: /reader=\{readerHolder\(state\.role\)\}/ }] },
  { file: "apps/webapp/app/shell/SenderMenu.tsx", keys: ['"orgPending"', '"orgPendingUnnamed"', '"orgNobody"'],
    calls: [{ file: APP_SHELL, call: /organizer=\{otherOrganizerOf\(/ }] },
  { file: "apps/webapp/app/shell/SubjectRuleSheet.tsx", keys: ['"subjectOrgNobody"'],
    calls: [{ file: APP_SHELL, call: /nobody=\{otherOrganizerOf\(/ }] },
  // The connect notice was exempt as "the connect's outcome at that moment" and outlived a hand-back
  // it is chosen over the live claim the strip reads now.
  { file: PHONE_FORM, fn: "readingAtConnectLine", keys: ["Copy.readingAtConnect", "Copy.readingAtConnectKept", "Copy.readingAtConnectJoinWaits"],
    calls: [{ file: "apps/mobile/app/(tabs)/index.tsx", call: /readingAtConnectNow\([^;]*\bclaim\)/ },
      { file: "apps/mobile/src/ui/OrganizerStrip.tsx", fn: "useStandaloneClaim", call: /\bclaimHere\(/ }] },
  { file: "apps/webapp/app/shell/FirstRun.tsx", keys: ['"doorReaderWhy"', '"doorReaderWhyLegacy"'],
    calls: [{ file: APP_SHELL, call: /accountOrganizer=\{accountOrganizer\(/ }] },
  { file: "apps/desktop/src/install-role.ts",
    keys: ["DOOR_COPY.mailboxWhyReadsNamed", "DOOR_COPY.mailboxWhyReads", "DOOR_COPY.mailboxWhyReadsNobody"],
    calls: ["DesktopAbout", "DesktopSettings"].map((pane) => ({
      file: `apps/desktop/src/${pane}.tsx`, call: /\breaderHolder\(screenerMode\(/,
    })) },
  // Whole-file components: JSX text is not a scanner's grammar, so their bodies are not walked.
  { file: "apps/desktop/src/DesktopScreening.tsx", keys: ['"readerNote"', '"readerNoteUnknown"', '"readerNoteNobody"'],
    calls: [{ file: "apps/desktop/src/DesktopScreening.tsx", call: /\breaderHolder\(screenerMode\(/ }] },
  { file: "apps/desktop/src/DesktopMailboxes.tsx", keys: ['"readerAlongSet"', '"organizeHereWhat"'],
    calls: [{ file: "apps/desktop/src/DesktopMailboxes.tsx", call: /\bholderIsLive\(\{ by: m\.organizedBy, state: m\.organizerState \}\)/ }] },
  { file: PHONE_FORM,
    keys: ["Copy.phoneStateReader", "Copy.phoneStateReaderWhy", "Copy.phoneStateReaderWhyPhone", "Copy.phoneStateReaderLegacy"],
    calls: [{ file: PHONE_FORM, fn: "claimFrom", call: /\bholderIsLive\(/ }] },
  { file: PHONE_LIVE, fn: "phoneBannerLines", keys: ["Copy.phoneBanner", "Copy.phoneBannerStopped"],
    calls: [{ file: "apps/mobile/src/state/world-projection.ts", call: /\bphoneOrganizer\(inp\.mailboxes\)/ }] },
  { file: READER_HOLDER, fn: "phoneHolderKey", keys: ['"readerHolderPhone"'],
    calls: [{ file: READER_HOLDER, fn: "phoneHolder", call: /\bholderIsLive\(/ }] },
  { file: "apps/webapp/app/shell/OrganizerNotice.tsx", keys: ['"noticeElsewhere"'],
    calls: [{ file: MAIL_STATE, fn: "noticeKind", call: /\borganizerSituation\(/ }] },
  { file: "apps/webapp/app/shell/FirstRun.tsx", keys: ['"elsewhereChoiceReadWhy"'],
    calls: [{ file: "apps/webapp/app/shell/FirstRun.tsx", call: /\bholderStopped\(facts\.mailbox\)/ }] },
  { file: PHONE_FORM, fn: "scheduledNotHereSentence", keys: ["Copy.scheduledReaderHere"],
    calls: [{ file: PHONE_FORM, fn: "scheduledNotHereSentence", call: /\bholder\.stopped\b/ },
      { file: "apps/mobile/src/state/world-projection.ts", call: /\bphoneOrganizer\(inp\.mailboxes\)/ }] },
  // A Start refused with the consent kept names the holder the live claim names (RULING-026 Q3).
  { file: PHONE_FORM, fn: "pressSaidLine", keys: ["Copy.settingsStartHeldConsented", "Copy.settingsStartHeldReturns"],
    calls: [{ file: "apps/mobile/src/ui/OrganizerStrip.tsx", fn: "useStandaloneClaim", call: /\bclaimHere\(/ }] },
  // A reader's refused pile or tag press names the roster's holder, live by the decider.
  { file: PHONE_LIVE, fn: "readerRefusal", keys: ['"readerPressRefused"'],
    calls: [{ file: PHONE_LIVE, fn: "readerRefusal", call: /\bholderIsLive\(/ }] },
  // The phone's refused server change names the new server's holder only where the engine sent one.
  { file: "apps/mobile/src/net/mailboxes.ts", fn: "serverChangeRefusal", keys: ['"serverSettingsHostHeld"'],
    calls: [{ file: "apps/sidecar/src/engine.ts", fn: "claimOnCandidate", call: /\bholderIsLive\(/ }] },
];

/**
 * THE RATCHET, AT ZERO AND PINNED THERE: a sentence naming a holder that read the lease's `stopped`
 * verdict itself rather than the decider. The last three (the phone arm, the organizer notice, the
 * first-run claim question) are registered sites now; an entry here is a regression by definition.
 */
const STOPPED_ARMS: Record<string, { file: string; fn?: string; reads: RegExp }> = {};

/** Named-holder sentences that are not a reader's holder, or are chosen by the refusal's own kind. */
const EXEMPT: Record<string, string> = {
  "ohbox.whyRefused.outdated": "rendered only from an OrganizerRefusal, whose kind is organizerRefusalOf's or postureRefusal's",
  "ohbox.whyRefused.elsewhere": "rendered only from an OrganizerRefusal, whose kind is organizerRefusalOf's or postureRefusal's",
  "mailboxes.stopOrganizingSiblingLapseHost": "about this install's own copy on the paired computer, not a reader's holder",
};

/** Positions of the function `name`'s body, found in the literal-blanked text. */
function bodySpan(blank: string, name: string): { start: number; end: number } | null {
  const decl = new RegExp(`(?:function\\s+${name}\\s*|const\\s+${name}\\s*=\\s*(?:use(?:StableCallback|Callback|Memo)\\()?\\s*)(?=[<(])`);
  const m = decl.exec(blank);
  if (!m) return null;
  let at = m.index + m[0].length;
  if (blank[at] === "<") at = bracketSpan(blank, at, "<", ">").end + 1;
  const params = bracketSpan(blank, blank.indexOf("(", at));
  // The first `{` after the parameters that is not a return type's own brace opens the body.
  for (let i = params.end + 1; i < blank.length; i++) {
    if (blank[i] !== "{") continue;
    const before = blank.slice(params.end + 1, i).trimEnd();
    if (/[:|&<,]$/.test(before)) { i = bracketSpan(blank, i, "{", "}").end; continue; }
    const b = bracketSpan(blank, i, "{", "}");
    return b.closed ? { start: b.start, end: b.end } : null;
  }
  return null;
}

/** Where `key` is rendered in one comment-blanked file: quoted as a key, or read as a copy member. */
function keyUses(text: string, key: string): number[] {
  const at: number[] = [];
  const needle = key.startsWith('"') ? [key, `\`${key.slice(1, -1)}\``] : [key];
  for (const n of needle) {
    for (let i = text.indexOf(n); i !== -1; i = text.indexOf(n, i + 1)) {
      const next = text[i + n.length] ?? "";
      if (!key.startsWith('"') && /[A-Za-z0-9_$]/.test(next)) continue;
      at.push(i);
    }
  }
  return at;
}

/** Every door in a tree whose body does not ask the decider — empty when each does. */
function doorViolations(files: SourceFile[], doors: typeof DOORS): string[] {
  const out: string[] = [];
  const byFile = new Map(files.map((f) => [f.file, f.raw]));
  for (const d of doors) {
    const raw = byFile.get(d.file);
    if (raw === undefined) { out.push(`${d.file}: missing`); continue; }
    const s = bodySpan(withoutCommentsAndLiterals(raw), d.fn);
    if (s === null) { out.push(`${d.file}: no function ${d.fn}`); continue; }
    const body = (d.literals ? withoutComments(raw) : withoutCommentsAndLiterals(raw)).slice(s.start, s.end);
    if (!d.asks.test(body)) out.push(`${d.file}: ${d.fn} does not ask the decider`);
  }
  return out;
}

/** Every reason a tree's holder sentences do not ask the decider — empty when every one does. */
function holderSentenceViolations(files: SourceFile[], sites: Site[]): string[] {
  const out: string[] = [];
  const byFile = new Map(files.map((f) => [f.file, f.raw]));
  const commented = new Map(files.map((f) => [f.file, withoutComments(f.raw)]));
  const inFn = (file: string, fn: string | undefined, at: number) => {
    if (fn === undefined) return true;
    const s = bodySpan(withoutCommentsAndLiterals(byFile.get(file) ?? ""), fn);
    return s !== null && at >= s.start && at < s.end;
  };
  for (const site of sites) {
    for (const key of site.keys) {
      const seen = keyUses(commented.get(site.file) ?? "", key);
      if (seen.length === 0) out.push(`${site.file}: ${key} is not rendered where it is registered`);
      for (const at of seen) if (!inFn(site.file, site.fn, at)) out.push(`${site.file}: ${key} outside ${site.fn}`);
      for (const [file, text] of commented) {
        if (file !== site.file && text.includes(key.startsWith('"') ? key.slice(1, -1) : key)
          && keyUses(text, key).length > 0) out.push(`${file}: ${key} rendered outside its site`);
      }
    }
    for (const c of site.calls) {
      const raw = byFile.get(c.file);
      if (raw === undefined) { out.push(`${c.file}: missing`); continue; }
      const blank = withoutCommentsAndLiterals(raw);
      const s = c.fn === undefined ? { start: 0, end: blank.length } : bodySpan(blank, c.fn);
      if (s === null) { out.push(`${c.file}: no function ${c.fn}`); continue; }
      if (!c.call.test(withoutComments(raw).slice(s.start, s.end))) {
        out.push(`${c.file}${c.fn ? ` ${c.fn}` : ""}: ${site.keys[0]} is chosen without ${c.call.source}`);
      }
    }
  }
  return out;
}

describe("every sentence that names who organizes a mailbox asks the same decider", () => {
  const all = sources();
  const read = (file: string) => readFileSync(join(REPO, file), "utf8");

  it("every door the sentences are chosen from calls the decider in its own body", () => {
    expect(doorViolations(all, DOORS)).toEqual([]);
  });

  it("every registered sentence is rendered only at its site, and its site calls a door", () => {
    expect(all.length).toBeGreaterThan(500);
    expect(holderSentenceViolations(all, SITES)).toEqual([]);
  });

  it("every catalogue sentence naming a holder as its organizer is registered, ratcheted or exempt", () => {
    const en = JSON.parse(read("apps/webapp/messages/en.json")) as Record<string, unknown>;
    const found: string[] = [];
    const walk = (o: Record<string, unknown>, at: string) => {
      for (const [k, v] of Object.entries(o)) {
        const path = at ? `${at}.${k}` : k;
        if (v && typeof v === "object") walk(v as Record<string, unknown>, path);
        else if (typeof v === "string" && /\{name\}(?:,[^.—]*?)? (?:organizes|is organizing|keeps organizing)\b/.test(v)) found.push(path);
      }
    };
    walk(en, "");
    // The phone's deck is source: its members that name a holder as the organizer, the same way.
    const deck = read("apps/mobile/src/copy.en.ts");
    for (const m of deck.matchAll(/^ {2}(\w+): \(name: string\) =>\s*`([^`]*)`/gm)) {
      if (/Organized by \$\{name\}|\$\{name\} (?:organizes|is organizing|keeps organizing)\b/.test(m[2]!)) found.push(`Copy.${m[1]}`);
    }
    // The reach first: a scan that found nothing classifies nothing.
    expect(found.length).toBe(28);
    const registered = new Set(SITES.flatMap((s) => s.keys));
    const unclassified = found.filter((path) => {
      const leaf = path.slice(path.lastIndexOf(".") + 1);
      return !registered.has(`"${leaf}"`) && !registered.has(`"${path}"`) && !registered.has(`DOOR_COPY.${leaf}`)
        && !registered.has(path) && !(path in STOPPED_ARMS) && !(path in EXEMPT);
    });
    expect(unclassified, "a sentence names a holder as organizing with no decider behind it").toEqual([]);
    expect(Object.keys(STOPPED_ARMS).length, "the ratchet is at zero and stays there").toBe(0);
    for (const [key, arm] of Object.entries(STOPPED_ARMS)) {
      const raw = read(arm.file);
      const s = arm.fn === undefined ? { start: 0, end: raw.length } : bodySpan(withoutCommentsAndLiterals(raw), arm.fn);
      expect(s, `${arm.file}: no function ${arm.fn}`).not.toBeNull();
      expect(withoutComments(raw).slice(s!.start, s!.end), `${key}'s site reads no stopped verdict`).toMatch(arm.reads);
    }
  });

  it("POSITIVE CONTROL: a planted sentence without a door is refused, and admitted with one", () => {
    const planted = (body: string): SourceFile[] => [{
      file: "apps/webapp/app/shell/planted.ts",
      raw: `export function planted(role) {\n  // readerHolder(role) in a comment is no call\n  ${body}\n  return t("plantedHolderNamed", { name: role.name });\n}\n`,
    }];
    const site: Site = {
      file: "apps/webapp/app/shell/planted.ts", fn: "planted", keys: ['"plantedHolderNamed"'],
      calls: [{ file: "apps/webapp/app/shell/planted.ts", fn: "planted", call: /\breaderHolder\(role\)/ }],
    };
    expect(holderSentenceViolations(planted(""), [site])).toEqual([
      "apps/webapp/app/shell/planted.ts planted: \"plantedHolderNamed\" is chosen without \\breaderHolder\\(role\\)",
    ]);
    expect(holderSentenceViolations(planted("const who = readerHolder(role);"), [site])).toEqual([]);
    // …and the same sentence rendered in a second file is refused by name.
    const twice = [...planted("const who = readerHolder(role);"),
      { file: "apps/webapp/app/shell/elsewhere.ts", raw: `const s = t("plantedHolderNamed");\n` }];
    expect(holderSentenceViolations(twice, [site]))
      .toEqual(["apps/webapp/app/shell/elsewhere.ts: \"plantedHolderNamed\" rendered outside its site"]);
    // A door whose body names the decider only in a comment is refused; one that calls it is not.
    const door = (body: string): SourceFile[] => [{
      file: "apps/webapp/app/shell/planted-door.ts",
      raw: `export function plantedDoor(rows) {\n  // holderIsLive(row) in a comment is no call\n  return rows.find((r) => ${body});\n}\n`,
    }];
    const doors = [{ file: "apps/webapp/app/shell/planted-door.ts", fn: "plantedDoor", asks: /\bholderIsLive\(/ }];
    expect(doorViolations(door("r.by"), doors))
      .toEqual(["apps/webapp/app/shell/planted-door.ts: plantedDoor does not ask the decider"]);
    expect(doorViolations(door("holderIsLive(r)"), doors)).toEqual([]);
  });
});
