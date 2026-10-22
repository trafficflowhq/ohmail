import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  withoutComments, withoutCommentsAndLiterals, bracketSpan, lineOf,
} from "../../../../scripts/lib/source-scan.mjs";

/**
 * ═══ NO SITE IN CORE KEEPS A BARE UID ══════════════════════════════════════════════════════
 *
 * A remembered uid is a fact only under the UIDVALIDITY that issued it: a folder deleted and
 * recreated re-issues the same small integers to different messages. Three sites had lost the
 * pairing at once — the passive folder skip's cached counters, the request drain's expunge and
 * the settings cleanup's — so a rule stated in three places and checked in one is what this
 * census replaces.
 *
 * Every DECLARED member of an interface or type in `packages/core/src` that holds a uid gets a
 * row saying how its epoch travels, and a row is refused four ways: an unregistered member (a new
 * store arriving unclassified), a registered member that has gone, an `epoch-beside-it` row whose
 * named sibling is no longer in that body, and an `epoch-on-the-container` row whose named
 * container no longer states one. The last two are derived from the source rather than restated,
 * which is what makes this a measurement and not a list.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "../../src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** A member name that holds a uid NUMBER. `uidValidity` is the epoch itself, never the uid. */
const HOLDS_A_UID = /^(?:uid|uids|uidNext|[A-Za-z0-9]*[Uu]id|[A-Za-z0-9]*[Uu]ids)$/;
const DECL = /\b(?:interface\s+([A-Za-z0-9_]+)|type\s+([A-Za-z0-9_]+)\s*=)/g;
const MEMBER = /(?:^|[{;,\s])(?:readonly\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\??\s*:/g;

interface Site {
  key: string;
  file: string;
  line: number;
  decl: string;
  name: string;
  body: string;
}

/** Every declared uid-holding member under `packages/core/src`, with the body it was declared in. */
function census(): Site[] {
  const sites = new Map<string, Site>();
  for (const file of walk(SRC).sort()) {
    const raw = readFileSync(file, "utf8");
    const blanked = withoutCommentsAndLiterals(raw);
    DECL.lastIndex = 0;
    let decl: RegExpExecArray | null;
    while ((decl = DECL.exec(blanked)) !== null) {
      const open = blanked.indexOf("{", decl.index);
      if (open < 0) break;
      // `interface X extends Y;` and `type X = Y;` have no body here — the next `{` belongs to
      // something else entirely, and reading it would attribute members to the wrong declaration.
      const semi = blanked.indexOf(";", decl.index);
      if (semi >= 0 && semi < open) { DECL.lastIndex = decl.index + 1; continue; }
      const span = bracketSpan(blanked, open, "{", "}");
      const body = blanked.slice(open, span.end + 1);
      const name = decl[1] ?? decl[2]!;
      MEMBER.lastIndex = 0;
      let member: RegExpExecArray | null;
      while ((member = MEMBER.exec(body)) !== null) {
        const field = member[1]!;
        if (field === "uidValidity" || field === "uidvalidity") continue;
        if (!HOLDS_A_UID.test(field)) continue;
        const key = `${file.slice(SRC.length + 1)} ${name}.${field}`;
        if (sites.has(key)) continue;
        sites.set(key, {
          key, file: file.slice(SRC.length + 1), line: lineOf(blanked, open + member.index),
          decl: name, name: field, body,
        });
      }
      DECL.lastIndex = open + 1;
    }
  }
  return [...sites.values()];
}

/**
 * HOW EACH ONE'S EPOCH TRAVELS.
 *
 *  · `epoch-beside-it`         — the same declaration body states the epoch, under `with`;
 *  · `epoch-on-the-container`  — the value is only ever reached through `with`, which states one;
 *  · `keyed-by-generation`     — the store is keyed by a generation that invalidates the entry;
 *  · `dropped-on-an-epoch-change` — in memory, and discarded by name when the epoch moves;
 *  · `within-one-call`         — never outlives the call that produced it;
 *  · `not-a-stored-uid`        — an option flag or a search criterion, not a uid at all.
 */
type Kind =
  | "epoch-beside-it"
  | "epoch-on-the-container"
  | "keyed-by-generation"
  | "dropped-on-an-epoch-change"
  | "within-one-call"
  | "not-a-stored-uid";

const PINS: Record<string, { kind: Kind; with?: string; why: string }> = {
  "ics.ts IcsEventPreview.uid":
    { kind: "not-a-stored-uid", why: "an iCalendar event's UID (RFC 5545), compared within one message; no IMAP uid" },
  "adapters/drizzle-repo.ts PersistedFolderCursor.uidNext":
    { kind: "epoch-beside-it", with: "uidValidity", why: "the folder cursor's own epoch" },
  "adapters/drizzle-repo.ts KnownLocator.uid":
    { kind: "epoch-beside-it", with: "uidValidity", why: "the pairing this row exists for" },
  "adapters/drizzle-repo.ts JunkFiledHuskRow.uid":
    { kind: "epoch-beside-it", with: "uidValidity", why: "the husk names one message" },
  "adapters/drizzle-repo.ts MessageFailureRow.uid":
    { kind: "epoch-beside-it", with: "uidValidity", why: "the durable retry target" },
  "adapters/drizzle-repo.ts PendingJunkRescue.uid":
    { kind: "epoch-beside-it", with: "uidValidity", why: "the queued rescue's one coordinate" },
  "adapters/drizzle-repo.ts MessageFailureInput.uid":
    { kind: "epoch-beside-it", with: "uidValidity", why: "what the retry row is written from" },
  "adapters/drizzle-repo.ts WorkerRepo.uid":
    { kind: "epoch-beside-it", with: "uidValidity", why: "`resolveMessageFailure`'s site argument" },
  "adapters/imap-types.ts PersistedFolderCursor.uidNext":
    { kind: "epoch-beside-it", with: "uidValidity", why: "checked by the passive skip" },
  "adapters/imap-types.ts KnownEntry.uid":
    {
      kind: "epoch-on-the-container", with: "PersistedFolderCursor",
      why: "reached only as `FolderCursor.known`, and that cursor carries the epoch",
    },
  "adapters/imap.ts FolderStatusAnswer.uidNext":
    { kind: "epoch-beside-it", with: "uidValidity", why: "one STATUS reading: the counter and the epoch it is under" },
  "adapters/imap-types.ts MessageSite.uid":
    { kind: "epoch-beside-it", with: "uidValidity", why: "a set-aside message, skipped only at its own epoch" },
  "adapters/imap-types.ts BudgetStop.uid":
    { kind: "epoch-beside-it", with: "uidValidity", why: "the folder a spent budget stopped at" },
  "adapters/imap-types.ts FolderBudgetStop.uid":
    {
      kind: "epoch-beside-it", with: "uidValidity",
      why: "the same pair as the row holds it, stored in two columns (mail 0115)",
    },
  "adapters/imap-types.ts ChangeBatch.uid":
    { kind: "epoch-beside-it", with: "uidValidity", why: "`unanswered` and `oversize` rows" },
  "adapters/imap-types.ts MailboxAdapter.uids":
    { kind: "within-one-call", why: "`fetchByUid`'s argument; nothing is kept" },
  "adapters/imap.ts FolderPageItem.uid":
    {
      kind: "epoch-on-the-container", with: "FolderPage",
      why: "a page row, and the page states the epoch it was read at",
    },
  "adapters/imap.ts CappedFetch.uid":
    { kind: "within-one-call", why: "one folder's capped fetch, read by the pass that asked under its live epoch" },
  "adapters/imap.ts InternalCreate.uid":
    { kind: "epoch-beside-it", with: "uidValidity", why: "becomes a `${uidvalidity}:${uid}` ref" },
  "adapters/imap.ts InternalDelete.uid":
    { kind: "epoch-beside-it", with: "uidValidity", why: "becomes a `${uidvalidity}:${uid}` ref" },
  "adapters/imap.ts QuietRead.uidNext":
    { kind: "epoch-beside-it", with: "uidValidity", why: "the keys of a full read that found nothing, under their epoch" },
  "adapters/imap.ts FlagDrain.resumeUid":
    {
      kind: "dropped-on-an-epoch-change", with: "flagDrain.delete",
      why: "`changesSince` drops the drain when `uidValidityChanged`, before anything reads it",
    },
  "adapters/meta-memo.ts MetaMemo.claimUid":
    { kind: "keyed-by-generation", with: "generation", why: "a mismatch clears the whole entry" },
  "adapters/meta-memo.ts MetaMemo.profileUid":
    { kind: "keyed-by-generation", with: "generation", why: "a mismatch clears the whole entry" },
  "adapters/meta-memo.ts MetaMemo.undeletableUid":
    { kind: "keyed-by-generation", with: "generation", why: "the probe checks it against its generation before the delete" },
  "adapters/organizer-lease.ts LeaseIo.uid":
    { kind: "within-one-call", why: "the streak read and the probe's answer, spent inside one gate run" },
  "adapters/organizer-lease.ts MetaFolderStamp.uidNext":
    { kind: "epoch-beside-it", with: "uidValidity", why: "one STATUS, both fields" },
  "adapters/organizer-lease.ts LeaseImapClient.uidNext":
    { kind: "epoch-beside-it", with: "uidValidity", why: "the selected mailbox's own fields" },
  "adapters/organizer-lease.ts LeaseImapClient.uid":
    { kind: "not-a-stored-uid", why: "the SEARCH criterion string and the `{ uid: true }` flag" },
  "adapters/organizer-lease.ts SequenceProbeClient.uidNext":
    { kind: "within-one-call", why: "a STATUS answer, read and spent" },
  "adapters/organizer-lease.ts DescendingWalk.uids":
    { kind: "within-one-call", why: "one walk's result" },
  "adapters/organizer-profile.ts Row.uid":
    { kind: "within-one-call", why: "one listing's header rows, read and spent under one lock and one generation" },
  "adapters/organizer-lease.ts MetaEnumClient.uid":
    { kind: "within-one-call", why: "one FETCH row of the enumeration, read and spent inside it" },
  "adapters/organizer-lease.ts Seen.uid":
    { kind: "within-one-call", why: "one enumeration's rows, under one generation checked before and after" },
  "adapters/organizer-profile.ts ProfileImapClient.uidNext":
    { kind: "within-one-call", why: "a STATUS answer, read and spent" },
  "adapters/organizer-profile.ts ProfileImapClient.uid":
    { kind: "not-a-stored-uid", why: "the SEARCH criterion string and the fetch flag" },
  "blank-repair.ts BlankPlace.uid":
    { kind: "epoch-beside-it", with: "uidValidity", why: "one place a blank row holds, read only at its own epoch" },
  "epoch.ts UidRef.uid":
    { kind: "epoch-beside-it", with: "epoch", why: "the pair this whole rule is written as" },
};

describe("every uid declared in core says how its epoch travels", () => {
  const sites = census();

  it("finds the stores at all — the census is not vacuous", () => {
    // A scanner that found nothing would pass every assertion below it. Twenty-six sites were
    // measured when this was written; the floor is well under that so an honest removal does not
    // redden it, and a scan that broke reads zero.
    expect(sites.length).toBeGreaterThan(20);
  });

  it("classifies every declared uid, and pins nothing that has gone", () => {
    const found = new Set(sites.map((s) => s.key));
    const unclassified = sites.filter((s) => PINS[s.key] === undefined)
      .map((s) => `${s.file}:${s.line} ${s.decl}.${s.name}`);
    expect(unclassified,
      "a uid is declared with nothing said about the epoch it belongs to").toEqual([]);
    const rotted = Object.keys(PINS).filter((k) => !found.has(k));
    expect(rotted, "a pinned site no longer exists — the census is describing the past").toEqual([]);
  });

  it("proves the epoch a row NAMES is actually in that declaration", () => {
    // The refusal that bites: remove `uidValidity` from a row and its uid is bare, whatever the
    // pin says. Derived, so the pin cannot outlive the pairing it claims.
    const broken: string[] = [];
    for (const site of sites) {
      const pin = PINS[site.key]!;
      if (pin.kind !== "epoch-beside-it") continue;
      const sibling = new RegExp(`(?:^|[{;,\\s])(?:readonly\\s+)?${pin.with}\\s*\\??\\s*:`);
      if (!sibling.test(site.body)) broken.push(`${site.file}:${site.line} ${site.decl}.${site.name}`);
    }
    expect(broken, "a row says its epoch is beside it and it is not").toEqual([]);
  });

  it("proves the container a row names still states an epoch", () => {
    const broken: string[] = [];
    for (const site of sites) {
      const pin = PINS[site.key]!;
      if (pin.kind !== "epoch-on-the-container") continue;
      const src = withoutCommentsAndLiterals(readFileSync(join(SRC, site.file), "utf8"));
      const at = new RegExp(`\\binterface\\s+${pin.with}\\b`).exec(src);
      if (at === null) { broken.push(`${site.decl}.${site.name}: no ${pin.with}`); continue; }
      const open = src.indexOf("{", at.index);
      const body = src.slice(open, bracketSpan(src, open, "{", "}").end + 1);
      if (!/(?:^|[{;,\s])(?:readonly\s+)?uidValidity\s*\??\s*:/.test(body)) {
        broken.push(`${site.decl}.${site.name}: ${pin.with} states no uidValidity`);
      }
    }
    expect(broken, "a container a row leans on no longer carries the epoch").toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("the sites that act on a remembered uid take ONE guard", () => {
  /**
   * Parsed for the CALL, never for the symbol appearing: a file that imports `uidRefsAtEpoch` and
   * never calls it would satisfy a needle and check nothing. The passive skip and the three
   * `ohmail/_meta` cleanups are the four places a remembered uid decides something.
   */
  const CALLERS: Record<string, number> = {
    "adapters/imap.ts": 2,               // the passive folder skip and the quiet-folder skip
    "adapters/organizer-lease.ts": 3,    // removeClaims, the request drain's expunge, and the blocked gate's probe
    "adapters/organizer-profile.ts": 3,  // removeProfiles, markSeen's one flag, and the write's C across its read-back
  };

  it("calls it exactly where the rule applies, and the count is pinned", () => {
    for (const [file, expected] of Object.entries(CALLERS)) {
      const src = withoutComments(readFileSync(join(SRC, file), "utf8"));
      const calls = src.match(/\buidRefsAtEpoch\s*\(/g) ?? [];
      expect(calls.length, `${file} calls the one guard ${calls.length} time(s)`).toBe(expected);
    }
  });

  /* NOT A SECOND "nobody rolls their own compare" RULE HERE. `packages/core/test/epoch.test.ts`
     already censuses every epoch comparison in three source roots from the AST, by exact text,
     and refuses both a new one and a stale pin — strictly stronger than a regex over three files,
     and it is where the four comparisons this change makes are placed. A weaker twin beside it is
     the second spelling this whole change exists to remove. */
});
