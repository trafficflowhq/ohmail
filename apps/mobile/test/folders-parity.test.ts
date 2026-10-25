/**
 * FOLDERS + DELETE PARITY WITH THE WEBAPP — derived from the webapp's own source where the
 * webapp carries the surface (the `action-parity.test.ts` idiom: the webapp file is the
 * source of truth, this file keeps no list of its own to go stale).
 *
 * Folders: the rail group's strings, the Settings switch's strings and the filter threshold
 * all mirror the webapp's; the phone's surfaces must actually REFERENCE them (reachable, not
 * just defined), and the folders group must be gated on the consent answer — a flag-off More
 * screen is the pre-feature screen (FOLDERS-SPEC.md §10).
 *
 * Delete: the verb is the ENGINE's (`message_delete`, mail 0065) and BOTH readers now carry
 * it — the phone since mail 0065, the webapp's reading pane since the §16 UI wave (a
 * flag-gated ⋯-menu entry over a confirm strip, `MessagePane.tsx`). The one-sided guard this
 * file used to hold ("the pane still lacks the verb") fired exactly as designed and was
 * replaced by the reconciliation it existed to force: the phone's `Copy.actionDelete` family
 * must equal the webapp catalogue's `ohbox.*` delete strings word for word, and both surfaces
 * keep the same ceremony — a confirm before the act, no undo (there is no un-delete on the
 * wire to promise), one dispatch site.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Copy } from "../src/copy";
import { FOLDER_FILTER_AT } from "../src/state/folders";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string) => readFileSync(at(p), "utf8");

const en = JSON.parse(read("../../webapp/messages/en.json")) as {
  rail: Record<string, string>;
  settings: { folders: Record<string, string> };
  ohbox: Record<string, string>;
  compose: Record<string, string>;
};

/**
 * A minimal ICU plural resolver for the shapes the rail's catalogue uses —
 * `{key, plural, =0 {…} one {…} other {… # …}}` — so the phone's resolved sentences can be
 * compared against the webapp's ICU source for chosen numbers instead of a hand-copy that
 * drifts. Deliberately tiny: exactly the syntax `folderDeleteConfirm` carries, nothing more.
 */
function icu(template: string, values: Record<string, number>): string {
  return template.replace(/\{(\w+), plural,((?:\s*(?:=\d+|one|other) \{[^{}]*\})+)\}/g, (_, key: string, arms: string) => {
    const n = values[key]!;
    const branches = [...arms.matchAll(/(=\d+|one|other) \{([^{}]*)\}/g)]
      .map((m) => ({ sel: m[1]!, text: m[2]! }));
    const hit =
      branches.find((b) => b.sel === `=${n}`) ??
      (n === 1 ? branches.find((b) => b.sel === "one") : undefined) ??
      branches.find((b) => b.sel === "other")!;
    return hit.text.replace(/#/g, String(n));
  });
}
const webappFolders = read("../../webapp/app/shell/folders.ts");

describe("the folders strings are the webapp catalogue's", () => {
  const pairs: Array<[unknown, string]> = [
    [Copy.folders, en.rail.folders],
    [Copy.folderEmpty, en.rail.folderEmpty],
    [Copy.folderFilter, en.rail.folderFilter],
    [Copy.folderNoMatch, en.rail.folderNoMatch],
    [Copy.folderShowFewer, en.rail.folderShowFewer],
    /* The junk foot's unnamed arm (JUNK-INVISIBLE) — one sentence, two surfaces, and a phone
       that worded it differently would be a second claim about the same mailbox. */
    [Copy.junkNoteUnnamed, en.rail.junkNoteUnnamed],
    [Copy.foldersUseTitle, en.settings.folders.useTitle],
    [Copy.foldersUseOn, en.settings.folders.useOn],
    [Copy.foldersUseOff, en.settings.folders.useOff],
    [Copy.foldersMicrocopy, en.settings.folders.microcopy],
    [Copy.foldersFailed, en.settings.folders.failed],
  ];
  it("every mirrored string equals the webapp's, word for word", () => {
    for (const [mobile, webapp] of pairs) expect(mobile).toBe(webapp);
  });
  it("the ICU-shaped strings resolve to the same sentences", () => {
    // rail.folderShowAll is "Show all {count}…"; the phone's is a function of the count.
    expect(Copy.folderShowAll(240)).toBe(en.rail.folderShowAll.replace("{count}", "240"));
    expect(Copy.folderExpand("Q1")).toBe(en.rail.folderExpand.replace("{name}", "Q1"));
    expect(Copy.folderCollapse("Q1")).toBe(en.rail.folderCollapse.replace("{name}", "Q1"));
    // rail.junkNote names the provider's own folder; the phone's is a function of that name.
    expect(Copy.junkNote("Spamverdacht"))
      .toBe(en.rail.junkNote.replace("{folder}", "Spamverdacht"));
  });
  it("the many-folders threshold is the webapp's own constant", () => {
    const m = webappFolders.match(/export const FOLDER_FILTER_AT = (\d+);/);
    expect(m, "webapp folders.ts no longer declares FOLDER_FILTER_AT").not.toBeNull();
    expect(FOLDER_FILTER_AT).toBe(Number(m![1]));
  });
});

describe("the folders surfaces are reachable, and gated on the consent answer", () => {
  const more = read("../app/(tabs)/more.tsx") +
    /* The rows moved into the shared MoreNav (the big-screen drawer mounts the same list, so
       the two cannot drift) — the More screen's properties live in the pair. */
    read("../src/ui/MoreNav.tsx");
  const group = read("../src/ui/FoldersGroup.tsx");
  const screen = read("../app/folder/[id].tsx");
  const settings = read("../app/settings.tsx");

  it("the More screen renders the group ONLY while the flag is on", () => {
    // The gate and the group in one expression — deleting either turns this red.
    expect(more).toMatch(/w\.folders\.enabled\s*\?\s*\(\s*<FoldersGroup/);
  });
  it("the group's rows navigate to the folder screen, which exists and renders the list", () => {
    expect(more).toContain("/folder/");
    expect(group).toContain("onOpen(f.id)");
    expect(screen).toContain("w.folders.items(folder.id)");
    // The honest boundary: the phone-specific empty/tail sentences, never the webapp's
    // reach-past-earned "Nothing in this folder".
    expect(screen).toContain("Copy.folderEmptyTitle");
    expect(screen).toContain("Copy.folderTail");
  });
  it("Settings carries the Use-folders control, wired to the server-confirmed value", () => {
    expect(settings).toContain("Copy.foldersUseTitle");
    expect(settings).toMatch(/on=\{w\.folders\.enabled\}/);
    expect(settings).toMatch(/setEnabled=\{w\.folders\.setEnabled\}/);
  });
  it("…and withholds it on a door that cannot KEEP the choice", () => {
    /* The gate and the panel in one expression, the More screen's idiom above: deleting either
       turns this red. Every door built from `localRoutes` — the desktop host this phone pairs
       with, an operator's self-host server, this app's own standalone door — serves no folder
       verb and its consent answer carries no folders axis at all, so a control drawn there
       writes into a field the door drops: the switch flipped and snapped back with no sentence.
       The wire half is measured against the real stripper in `paired-folders-door.test.ts`. */
    expect(settings).toMatch(/w\.folders\.storable\s*\?\s*\(\s*<FoldersPanel/);
  });
  it("a drain asked for mid-drain is OWED, and the syncing-falling effect pays it", () => {
    // (`syncNow` answers the round's completion promise since pull-to-refresh; these two
    // call sites are fire-and-forget by design, hence the `void`.)
    // `syncNow` is deliberately a no-op while a drain is running (connection.tsx), so the
    // machine's drain must branch on the live syncing state and the falling edge must pay
    // the debt before the refresh — a review finding, held at the source since the hook
    // wiring has no node renderer to drive it through.
    const world = read("../src/state/world.tsx");
    expect(world).toMatch(/if \(syncingRef\.current\) drainOwed\.current = true;\s*else void syncNowRef\.current\(\);/);
    expect(world).toMatch(/if \(drainOwed\.current\) \{\s*drainOwed\.current = false;\s*void syncNowRef\.current\(\);\s*\}/);
  });
});

describe("the delete verb — the engine's, behind a confirm", () => {
  const actions = read("../src/ui/MessageActions.tsx");
  const pane = read("../../webapp/app/shell/MessagePane.tsx");

  it("the More sheet carries Delete, and the dispatch stands INSIDE the confirm sheet", () => {
    // The entry row opens the confirm; only the confirm sheet dispatches.
    expect(actions).toMatch(/label=\{Copy\.actionDelete\}\s+onPress=\{\(\) => setOpen\("delete"\)\}/);
    expect(actions).toMatch(/open === "delete"/);
    // The dispatch carries `onCommitted` now — the reader leaves at the window's COMMIT, not
    // the press (the device fix); the site is still one, still inside the confirm sheet.
    expect(actions).toMatch(/a\.deleteMessage\(m\.id, \{ onCommitted:/);
    // Exactly ONE dispatch site — a second (an unconfirmed shortcut) is the defect this holds out.
    expect(actions.match(/deleteMessage\(/g)).toHaveLength(1);
  });
  it("BOTH delete surfaces are gated on the foundation flag — flag-off is the pre-verb reader", () => {
    // FOLDERS-SPEC.md §16.3/§16.7: the reader Delete verb ships behind "Use folders"; with the
    // flag off the reader carries no Delete verb at all. The entry row AND the confirm sheet
    // each stand inside their own flag conditional, so a stale open sheet cannot dispatch
    // after the flag goes off — a review finding, held by both halves. RE-DERIVED, not
    // relaxed: the entry row's gate moved into the posture placement (`reader-verbs.ts`), and
    // the chain is pinned link by link — the row stands on `moreHas("delete")`, the placement
    // admits "delete" only on `foldersEnabled`, and that fact IS `w.folders.enabled`.
    expect(actions).toMatch(/moreHas\("delete"\) \? \(\s*<>\s*<Rule inset=\{14\} \/>\s*<SheetRow icon="trash"/);
    expect(actions).toMatch(/foldersEnabled: w\.folders\.enabled/);
    const verbs = read("../src/ui/reader-verbs.ts");
    expect(verbs).toMatch(/id === "delete" \? f\.foldersEnabled/);
    expect(actions).toMatch(/\{w\.folders\.enabled \? \(\s*<Sheet open=\{open === "delete"\}/);
  });
  it("the webapp's reading pane carries the verb, and the wording is ONE catalogue", () => {
    // The reconciliation the retired one-sided guard existed to force. The webapp's strings
    // live in `ohbox.*` (`messages/en.json`); the phone's `Copy.actionDelete` family must be
    // those strings word for word, so the two readers can never describe the same wire verb
    // in two voices.
    expect(pane).toMatch(/"delete"/);
    expect(Copy.actionDelete).toBe(en.ohbox.actionDelete);
    expect(Copy.deleteAsk).toBe(en.ohbox.deleteAsk);
    expect(Copy.deleteNote).toBe(en.ohbox.deleteNote);
    expect(Copy.toastDeleted).toBe(en.ohbox.toastDeleted);
    expect(Copy.deleteFailed).toBe(en.ohbox.deleteFailed);
  });
  it("the webapp keeps the phone's ceremony — confirm-only, one name, exactly one dispatch site", () => {
    // A census across two applications pins DECLARED NAMES and CALL SITES, never a predicate's
    // inline text — a red about a spelling says nothing about the ceremony.
    //
    // The flag half is NOT asserted, and its absence is the ruling rather than a gap in this
    // case: the webapp stopped reading "Use folders" for delete admission (fix "the cursor delete
    // stops reading the Use-folders flag", 2026-09-09 — the selection delete never read it, so a
    // folders-off account could Trash a picked pile and not the row under its cursor), and
    // `apps/webapp/test/delete-admission-census.test.ts` now asserts that term is ABSENT at all
    // four webapp sites, this predicate among them. Demanding it here made two guards contradict
    // each other. The phone still gates on `w.folders.enabled` (the case above): the two readers
    // differ, which is a gap row, not a spelling for this census to assert.
    const declared = pane.match(/const deleteConfirmAdmitted\s*=([\s\S]*?);/);
    expect(declared, "MessagePane no longer declares `deleteConfirmAdmitted`").not.toBeNull();
    const predicate = declared![1]!;
    expect(
      predicate.match(/chrome\.verbHolds\?\.\(message\.id\) !== false/g),
      "the verb-reader gate is not in `deleteConfirmAdmitted` exactly once",
    ).toHaveLength(1);
    // The menu entry offers the verb only when the predicate admits …
    expect(pane).toMatch(/\.\.\.\(deleteConfirmAdmitted\s*\?/);
    // … and the confirm strip RE-ASKS it, independently, so a stale open confirm cannot
    // dispatch after the row leaves the mirror.
    expect(pane).toMatch(/panel === "delete" && deleteConfirmAdmitted/);
    expect(pane.match(/onAction\("delete"\)/g)).toHaveLength(1);
  });
});

/*
 * ── STAGE 2 — THE FOLDER VERBS (FOLDERS-SPEC.md §18) ────────────────────────────────────────
 *
 * The phone's copy deck is English like the rest of `src/copy.ts`; the webapp catalogue
 * carries the same keys in German for the surfaces that localize. Parity here means the EN
 * catalogue word for word — a wording change there is a red test here, never a silent drift.
 */
describe("the folder verb strings are the webapp catalogue's", () => {
  const pairs: Array<[unknown, string]> = [
    [Copy.folderNew, en.rail.folderNew],
    [Copy.folderNewSub, en.rail.folderNewSub],
    [Copy.folderRename, en.rail.folderRename],
    [Copy.folderDelete, en.rail.folderDelete],
    [Copy.folderNamePlaceholder, en.rail.folderNamePlaceholder],
    [Copy.folderRenamePlaceholder, en.rail.folderRenamePlaceholder],
    [Copy.folderCreating, en.rail.folderCreating],
    [Copy.folderDeleting, en.rail.folderDeleting],
    [Copy.folderDismiss, en.rail.folderDismiss],
    [Copy.folderErrRefused, en.rail.folderErrRefused],
    [Copy.folderErrBadName, en.rail.folderErrBadName],
    [Copy.folderErrExists, en.rail.folderErrExists],
    [Copy.folderErrGone, en.rail.folderErrGone],
    [Copy.folderErrNoTrash, en.rail.folderErrNoTrash],
    [Copy.folderErrGotMail, en.rail.folderErrGotMail],
    [Copy.folderNameEmpty, en.rail.folderNameEmpty],
    [Copy.folderNameSpaces, en.rail.folderNameSpaces],
    [Copy.folderNameChars, en.rail.folderNameChars],
    [Copy.folderNameLong, en.rail.folderNameLong],
    [Copy.folderNameReserved, en.rail.folderNameReserved],
    [Copy.folderNameTaken, en.rail.folderNameTaken],
    [Copy.folderDeleteCounting, en.rail.folderDeleteCounting],
    [Copy.folderDeleteConfirmUncounted, en.rail.folderDeleteConfirmUncounted],
    [Copy.folderDeleteGo, en.rail.folderDeleteGo],
    [Copy.folderDeleteCancel, en.rail.folderDeleteCancel],
    [Copy.folderVerbFailed, en.rail.folderVerbFailed],
  ];
  it("every mirrored string equals the webapp's, word for word", () => {
    for (const [mobile, webapp] of pairs) expect(mobile).toBe(webapp);
  });
  it("the ICU-shaped strings resolve to the same sentences", () => {
    expect(Copy.folderMenuAria("Q1")).toBe(en.rail.folderMenuAria.replace("{name}", "Q1"));
    expect(Copy.folderRenaming("Q1")).toBe(en.rail.folderRenaming.replace("{name}", "Q1"));
    // The delete confirm across its plural arms: no seen messages, the singular, the plural.
    for (const [messages, folders] of [[0, 1], [1, 1], [41, 3], [2, 2]] as const) {
      expect(Copy.folderDeleteConfirm(messages, folders)).toBe(
        icu(en.rail.folderDeleteConfirm, { messages, folders }),
      );
    }
  });
});

describe("the verb surfaces are reachable, honest, and dispatch where the webapp dispatches", () => {
  const group = read("../src/ui/FoldersGroup.tsx");
  const more = read("../app/(tabs)/more.tsx") +
    /* The rows moved into the shared MoreNav (the big-screen drawer mounts the same list, so
       the two cannot drift) — the More screen's properties live in the pair. */
    read("../src/ui/MoreNav.tsx");

  it("the More screen hands the group the verbs and the first-create mailbox", () => {
    expect(more).toMatch(/verbs=\{\{/);
    expect(more).toMatch(/create: w\.actions\.folderCreate/);
    expect(more).toMatch(/rename: w\.actions\.folderRename/);
    expect(more).toMatch(/remove: w\.actions\.folderDelete/);
    expect(more).toMatch(/dismiss: w\.actions\.folderDismiss/);
    expect(more).toMatch(/summary: w\.folders\.summary/);
    expect(more).toMatch(/soleMailboxId=\{w\.folders\.soleCreateMailboxId\}/);
  });
  it("`+ New folder` is the section's own affordance, gated on the verbs", () => {
    expect(group).toMatch(/\{verbs \? newFolderRow\(mb\.id\) : null\}/);
    // The zero-folders invite line gains the first create only with an unambiguous mailbox.
    expect(group).toMatch(/\{verbs && soleMailboxId \? newFolderRow\(soleMailboxId\) : null\}/);
  });
  it("the … control is ABSENT while a command is in flight, and on the read-only render", () => {
    expect(group).toMatch(/\{verbs && !f\.op \? \(/);
  });
  it("the delete dispatch stands INSIDE the confirm sheet alone, never mid-count", () => {
    // The menu's Delete row only opens the confirm (and starts the count); the confirm's go
    // row is withheld while the count is in the air; exactly ONE dispatch site exists.
    expect(group.match(/verbs\?\.remove\(/g)).toHaveLength(1);
    expect(group).toMatch(/\{!open\.loading \? \(\s*<SheetRow\s*icon="trash"\s*label=\{Copy\.folderDeleteGo\}/);
    expect(group).toMatch(/setOpen\(\{ kind: "confirm", folder: f, counts: null, loading: true, seq \}\)/);
    // A cancelled confirm's slow count must not settle a reopened one: the settle is guarded
    // on the GENERATION it was asked under, not merely the folder id (codex round 1).
    expect(group).toMatch(/held\.kind === "confirm" && held\.seq === seq/);
  });
  it("names are validated with the server's own rules BEFORE the wire", () => {
    // `folderNameError` reaches the group through the live seam (the engine re-export), and
    // both commits run the problem gate — a bad name never dispatches.
    expect(group).toMatch(/import \{ folderNameError \} from "\.\.\/state\/live"/);
    expect(group.match(/const bad = nameProblem\(/g)).toHaveLength(2);
    expect(group).toMatch(/if \(bad !== null\) \{\s*setProblem\(bad\);\s*return;\s*\}/);
    // A FAILED create's row keeps its name TAKEN until dismissal — the server retains the
    // command row and `assertNoOpOverlap` refuses any overlapping path, so re-offering the
    // spelling promised a create the server deterministically rejects (codex round 1). Both
    // clients hold the same rule now: no create-error exception in either taken-check.
    const rail = read("../../webapp/app/shell/FoldersRailGroup.tsx");
    expect(group).toMatch(/if \(own\.some\(\(x\) => x\.name === path\)\)/);
    expect(rail).toMatch(/if \(mb\.folders\.some\(\(x\) => x\.name === path\)\)/);
    expect(group).not.toMatch(/op\?\.kind === "create" && x\.op\.error/);
    expect(rail).not.toMatch(/op\?\.kind === "create" && x\.op\.error/);
  });
  it("a pending row keeps the mailbox's name on every join and wears the commanded leaf", () => {
    expect(group).toMatch(/pending && f\.op!\.kind === "rename" && f\.op!\.to \? folderLeafOf\(f\.op!\.to\) : leaf/);
  });
  it("a FAILED row carries the refusal sentence and its dismiss", () => {
    expect(group).toMatch(/failed && sentence !== null/);
    expect(group).toMatch(/verbs\.dismiss\(f\.id\)/);
  });
});

/*
 * ── SIG-MOB — the signature block on the phone's composer ──────────────────────────────────
 */
describe("the signature block — the webapp composer's strings and rules", () => {
  const actions = read("../src/ui/MessageActions.tsx");

  it("the block's strings are the webapp compose catalogue's, word for word", () => {
    expect(Copy.sigLabel).toBe(en.compose.signature);
    expect(Copy.sigRemove).toBe(en.compose.signatureRemove);
    expect(Copy.sigAria).toBe(en.compose.signatureAria);
  });
  it("what is shown is what ships — ONE derivation feeds the block and the send", () => {
    // `effectiveSignature` is called exactly once; the block renders `sigText` and the send
    // arms pass the same value. A second derivation is the torn-mix defect.
    expect(actions.match(/effectiveSignature\(/g)).toHaveLength(1);
    expect(actions).toMatch(/sendForward\(m!\.id, recipients \?\? \[\], body, sigText, files, andDone, forwardConfirmed, draftId,\s*forwardPlan/);
    // The Send-later arm rides the SAME call — one send machine, one signature (mail 0077).
    expect(actions).toMatch(/sendReply\(m!\.id, body, mode === "replyAll", sigText, sendAt, files, andDone, draftId\)/);
  });
  it("no block from a guess: the map must be server-confirmed, the sender the mutation's own", () => {
    /* The sending mailbox is the composer's: an opened draft keeps its own, a reply inherits the
       parent's, a mail with no parent takes the engine's compose-from fallback, and ALL reach the
       block through the one `mailboxId` the send also uses. */
    expect(actions).toMatch(/w\.signatures === null \|\| mailboxId === null \? null : effectiveSignature\(sig, w\.signatures, mailboxId\)/);
    expect(actions).toMatch(/const mailboxId = draft\?\.mailboxId \?\? m\?\.mailboxId \?\? w\.mailboxes\.sendingId;/);
  });
  it("a signature never lights Send up — the content rule reads the body and the files, never the block", () => {
    /* The invariant is unchanged; its mechanism moved with the attachments slice: `canSend`
       judges `phoneSendNeedsContent` (empty body AND no attachments, forward exempt), and the
       signature is still not an input — `sig`/`sigText` appear in neither line. */
    expect(actions).toMatch(/const needsContent = phoneSendNeedsContent\(\{ forward, body, attachmentCount: attachments\.length \}\);/);
    expect(actions).toMatch(/const canSend =\s*phase === "idle" && !needsContent && \(addressed \? recipients !== null && recipients\.length > 0 : true\)\s*&& \(!fresh \|\| sendCopies !== null\);/);
  });
  it("the block is distinct and removable — the strike acts on this one message", () => {
    // `&& later === null` is the Send-later picker's panel-height yield (mail 0077) — what is
    // SHOWN steps aside while a time is chosen; what SHIPS is untouched (`send-later.test.ts`).
    expect(actions).toMatch(/\{sigText !== null && later === null \? \(/);
    expect(actions).toMatch(/accessibilityLabel=\{Copy\.sigRemove\}/);
    expect(actions).toMatch(/setSig\(\{ kind: "removed" \}\)/);
    expect(actions).toMatch(/setSig\(\{ kind: "edited", text \}\)/);
  });
  it("the block's editor is height-bounded — a long stored signature scrolls, never buries Send", () => {
    // Signatures may run thousands of characters; an unbounded content-measured input grows
    // the panel past the viewport with the keyboard open (codex round 1).
    expect(actions).toMatch(/maxHeight: 144/);
  });
});
