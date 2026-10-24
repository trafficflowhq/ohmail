/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EngineMutation } from "@ohmail/client-engine";
import {
  allSendLocks, claimSendLock, holdOf, SEND_LOCK_FORMAT, sendLocksKey, type Hold, type SendLock,
} from "../app/shell/send-lock";
import { composeRowKey, composeSessionKey, readComposeDraft, writeComposeDraft } from "../app/shell/compose";
/* `(b)` below reads `discardDraft` as source. The rule it follows — anchor on the DECLARED NAME,
   never on the hook — and the three ways a hook spelling fails are written out in the helper;
   this file used to carry its own copy of it, which was two spellings of one rule. */
import { sliceOfDeclaration } from "./source-anchor.js";
import { JAR_0_14_0, JAR_0_14_1, RELEASED_AT } from "./fixtures/released-send-lock-jars";
/** No send is owed an ending in these jar-only cases — the shape every deletion had before keys could be owed. */
const NONE_OWED = (): boolean => false;

/**
 * ═══ EVERY WRITE SITE IN THE SEND SEAM CONSULTS ONE PREDICATE ═══════════════════════════════
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────
 *
 * Seven fix slices landed on `send-lock.ts` between RC5 and RC11. Each closed one route by which a
 * message could be delivered twice, and the reviewer found the next one every time. They were not
 * seven defects: they were one defect — the question "is this message held?" was asked in three
 * places, with three answers, and every fix moved WHO the message is rather than WHERE the
 * question is asked. A route the next reviewer finds is a MISSING CALL SITE, and the fix is to add
 * the call and bump the count here — never a second predicate.
 *
 * ── WHAT IT PINS, AND WHY BOTH HALVES ARE NEEDED ────────────────────────────────────────────
 *
 * (a) A per-file CALL-SITE COUNT of `holdOf(`. A census over file MEMBERSHIP — "the autosave
 *     imports the predicate" — cannot see a missing CALL, and a missing call is exactly what each
 *     of the seven rounds found. The count refuses a DROP and a RISE alike: a new write site has
 *     to name itself here, which is the moment somebody reads this comment.
 *
 * (b) The predicate's own truth table, and then each site driven under each answer. A count is
 *     satisfied by a call whose answer is thrown away, so the behaviour is measured too: `parked`
 *     produces ZERO `draft_save`, `draft_discard` and `mail_send` mutations, and `free` produces
 *     exactly the one that site is for — the positive control, without which "refuse everything"
 *     would satisfy this file and the product would be unusable.
 *
 * ── THE THIRD ANSWER, AND THE TWO DIRECTIONS IT FAILS IN ────────────────────────────────────
 *
 * `unknown` is a jar this browser cannot read, or a row the mirror cannot yet name. It is not
 * `free` and it is not `parked`, and the sites split on it deliberately:
 *
 *  · the RECOVERIES fail closed — nothing is adopted, discarded, or re-minted on evidence nobody
 *    has. That is the `SEND-LOCK-UNREADABLE-JAR-FAILS-OPEN` route.
 *  · the PRESS and the ordinary autosave write are ADMITTED. A browser that refuses this app
 *    access to its own storage must still be able to send and to save; refusing there would leave
 *    somebody with a product that declines to work and cannot say why, and — measured against the
 *    "an id the mirror cannot answer for" case in `compose-autosave.test.tsx` — would stall the
 *    compose for good once a row the mirror will never answer for is written down.
 */

const SHELL = (f: string): string =>
  readFileSync(resolve(process.cwd(), `apps/webapp/app/shell/${f}`), "utf8");

/**
 * ── THE PINS ────────────────────────────────────────────────────────────────────────────────
 *
 * Set from what is written, then frozen. Each entry names the sites it counts, so a diff that
 * changes a number has to say which site it added or removed.
 */
const CALL_SITES: Array<[file: string, count: number, sites: string]> = [
  // FIVE: the open editor reads the hold of its own row — a `sent` with no record of this
  // browser's is another device's send, and the editor lets go of the row and says so.
  ["compose-autosave.ts", 5,
    "the adopt-on-mount, the save at SCHEDULE time, the save at FIRE time, Discard, and the open "
    + "editor's sent-elsewhere read"],
  ["mail-send.ts", 1, "the Send press"],
  // FIVE, THEN SIX, THEN SEVEN — each step is a DOOR, never a second answer to one question.
  // `openDraft`'s hold was HOISTED above the reply arm rather than duplicated, so the Drafts-list
  // door onto a held reply reaches it (below the arm it never did: the row opened in the inline
  // editor with Send live).
  // SIX: the other door onto a held reply is the message itself, whose editor has no autosave and
  // whose mutation carries no row — the press asked about `null`, got `free`, and sent a second
  // copy beside a row the server held. `replySendState` answers for that row once, for both the
  // sentence and the press.
  // SEVEN: the orphaned-lane promotion writes a ROW when another client deletes the parent, so it
  // asks about the REPLY's lane with no row — the one shape that speaks for a send whose row this
  // browser never saw — and skips the lane when it is not free.
  // SEVEN, SPLIT SIX AND ONE BY ARCH-022: the verbs went to `shell-compose.ts` and the one
  // render-time read stayed with the JSX that renders it. The sum is asserted below.
  // EIGHT: the composer's Discard asks what it will do with the row, so its question and its
  // press can say the row stays — the same answer `discard` reads, asked before it spends it.
  // NINE: a reply or forward lane that took the row its refused send left asks, before the next
  // press sends from it, whether that row is still free — a row since held is never sent from.
  // TEN: a promoted lane asks it of the row it would write its words into.
  ["shell-compose.ts", 10,
    "openDraft (above the reply arm, so a held reply takes the held view), writeTo, the mailto "
    + "seam, the Drafts list's Delete, replySendState (the reply editor's own lane, row "
    + "included), the orphaned-lane promotion (a dead parent's reply becoming a row), the "
    + "composer's Discard (what it will do with its row), laneRowOf (the row a refused "
    + "reply left, before a press sends from it), accountReplyRow (the draft Reply opens), and "
    + "heldLaneRow (the row a promoted lane writes into rather than beside)"],
  ["AppShell.tsx", 1, "the render that feeds the compose's send state"],
];

/** The SUM, apart from the rows: a split that loses part of a count cannot pass on the rows alone. */
const CALL_SITES_TOTAL = 17;

describe("the send hold is answered in one place, and every write site asks", () => {
  it("(a) the call-site count per file", () => {
    for (const [file, count, sites] of CALL_SITES) {
      const found = [...SHELL(file).matchAll(/holdOf\(/g)].length;
      expect(
        found,
        `${file} calls holdOf() ${found} times; this census expects ${count} — ${sites}. A site `
        + "added here must be named above; a site removed is a write that decides for itself "
        + "again, which is how the same message came to be delivered twice seven times running.",
      ).toBe(count);
    }
    expect(
      CALL_SITES.reduce((n, [, count]) => n + count, 0),
      "the rows no longer add up to the census's own total — a count moved to a frame this "
      + "census does not read, which is how a split loses a site nobody is asking about",
    ).toBe(CALL_SITES_TOTAL);
  });

  it("(a2) nothing in the shell answers the question for itself", () => {
    /*
     * ── EVERY ROW-STATUS COMPARISON IN THE SEAM, CLASSIFIED ─────────────────────────────────
     *
     * A blanket "no file compares a status" refuses innocent content, and a census that fires on
     * innocent content is the same defect as one that cannot fire, only dearer — it discards real
     * work and gets loosened. So the comparisons are ENUMERATED and each is classified. The only
     * one outside `send-lock.ts` answers a different question entirely (which copy of the
     * signature block's state to trust when a draft is reopened), and it is named here so that a
     * comparison added to answer the HOLD question cannot hide beside it.
     */
    const ALLOWED: Record<string, string[]> = {
      // Reads the HOLD's own answer, not a row: `sent` is the server's terminal confirmation and
      // is the one status that settles rather than parks. The predicate supplied the fact; these
      // two decide what to do with it.
      "compose-autosave.ts": [
        'if (hold.kind === "parked" && hold.status === "sent") {',
        // The same fact read live: the status witness (no record of this browser's) saying `sent`.
        'if (hold.kind === "parked" && hold.by === "status" && hold.status === "sent") {',
      ],
      "mail-send.ts": [
        'if (hold.by === "status" && hold.status === "sent") return state;',
        // NOT a row's status and not the hold: `firstSendStatusOf` reads
        // `details.firstSend.status` off a REFUSAL, which is the server's fact about the OTHER
        // copy of this message — the one a duplicate refusal says already exists. It is a wire
        // value on its way to three different sentences, and it is whitelisted by shape rather
        // than by name so that a comparison added here to answer the hold question about THIS
        // row still has to be classified: the assertion below is an exact list, not a subset.
        'return status === "sent" || status === "unverified" || status === "pending" ? status : undefined;',
      ],
      // IN SOURCE ORDER, which is what the assertion below compares. Both moved to
      // `shell-compose.ts` with the verbs that read them (ARCH-022); the empty entry below keeps
      // `AppShell.tsx` asked, so a comparison written back into the shell frame still refuses.
      "shell-compose.ts": [
        // WHICH ROW TO ASK ABOUT, not whether it is held. A message can carry an ordinary reply
        // draft AND a row a send left unconfirmed; handing the press the ordinary one would ask
        // the predicate a question it answers `free` and send beside the held row. The verdict is
        // still `holdOf`'s — `replySendState` asks it about the row this line picks.
        'drafts.find((d) => d.inReplyToMessageId === messageId && d.status !== "draft")?.id ?? null);',
        // Not the hold: it decides whether this device's own editor state may seed the reopened
        // form, which is about where the block state was last written, not about a send.
        'if (d.status !== "draft") return {};',
      ],
      "AppShell.tsx": [],
      // The predicate's own file, where the question is allowed to be answered — and, in source
      // order after it, `discardDecision` reading the HOLD's status: a projection of `holdOf`'s
      // answer into what the Drafts list's Discard does with it, not a second reading of the row.
      "send-lock.ts": [
        'if (row.status !== "draft") {',
        'if (hold.kind === "parked" && hold.by === "status" && hold.status === "sending") {',
      ],
    };
    for (const [file, allowed] of Object.entries(ALLOWED)) {
      const found = SHELL(file).split("\n")
        .map((l) => l.trim())
        .filter((l) => /(?:\bstatus|rowStatus)\s*[!=]==\s*"(?:unverified|draft|sending|sent)"/.test(l))
        // Comment lines describe the rule; only code answers it.
        .filter((l) => !l.startsWith("*") && !l.startsWith("//") && !l.startsWith("/*"));
      expect(
        found,
        `${file} compares a row's status somewhere this census has not classified. If it is the `
        + "hold question, ask holdOf instead; if it is something else, name it above.",
      ).toEqual(allowed);
    }
    expect(SHELL("send-lock.ts"), "the predicate stopped being defined in one place")
      .toMatch(/export function holdOf\(/);
  });

  it("(a3) the 0.14.x decoders are retired: gone from the source, and their records dropped at load", () => {
    /*
     * RE-DERIVED at their retirement (rulings 127/128), not deleted: what this case asserts moved
     * from "the decoders are frozen" to "they are gone, and so is everything only they could read".
     * A jar holding a 0.14.0 record, a named unverified 0.14.1 one and the nameless v:3 the 0.14.0
     * rewrite made reads back holding none of them, while this build's own named record survives.
     */
    const lock = SHELL("send-lock.ts");
    expect(lock, "the 0.14.0 decoder is back").not.toMatch(/legacySendFingerprint_0_14_0/);
    expect(lock, "the 0.14.1 decoder is back").not.toMatch(/legacySendFingerprint_0_14_1/);
    expect(SEND_LOCK_FORMAT, "the record format moved; the retirement literal must be re-read").toBe(3);
    const at = Date.now();
    const rec = (over: Record<string, unknown>) => ({ lane: "compose", at, draftId: null, fp: "fp", ...over });
    window.localStorage.setItem(sendLocksKey(), JSON.stringify([
      rec({ v: 1, key: "K-0140" }),
      rec({ v: 2, key: "K-0141", unverified: true, subject: "draft:d2", session: "s2" }),
      rec({ v: 3, key: "K-NAMELESS", unverified: true }),
      rec({ v: 3, key: "K-NAMED", subject: "draft:d3", session: "s3" }),
    ]));
    expect(allSendLocks(at, NONE_OWED).map((r) => r.key), "a retired record reached a reader").toEqual(["K-NAMED"]);
    expect(
      (JSON.parse(window.localStorage.getItem(sendLocksKey()) ?? "[]") as Array<{ key: string }>).map((r) => r.key),
      "the jar kept a retired record on disk",
    ).toEqual(["K-NAMED"]);
    /* The jars the released 0.14.0 and 0.14.1 writers produced read back empty — and the same
       0.14.1 record restamped with this build's format and a name is read, so the zero is the
       retirement and not the clock or the parse. */
    const fresh = RELEASED_AT + 1_000;
    for (const jar of [JAR_0_14_0, JAR_0_14_1]) {
      window.localStorage.setItem(sendLocksKey(), jar);
      expect(allSendLocks(fresh, NONE_OWED), "a released 0.14.x jar was read").toEqual([]);
    }
    const restamped = (JSON.parse(JAR_0_14_1) as Array<Record<string, unknown>>).map((r) => ({ ...r, v: 3 }));
    window.localStorage.setItem(sendLocksKey(), JSON.stringify(restamped));
    expect(allSendLocks(fresh, NONE_OWED).map((r) => r.key), "the control: a current named record is read").toEqual(["KEY-" + "0141"]);
  });

  it("(a4) a send's answer is kept in ONE map and drained by ONE consumer", () => {
    /*
     * ── WHY THIS IS COUNTED RATHER THAN DESCRIBED ───────────────────────────────────────────
     *
     * `lateResults` is where the engine puts an answer that arrived with nobody waiting for it.
     * Until this build the replay THREW ITS ANSWER AWAY, so a send that completed during the boot
     * left its message sitting in the composer and the next keystroke there was a second delivery.
     * The fix is one line — keep it — and the property that makes it safe is arithmetic: every
     * answer is written in a place the drain can reach, and the drain happens EXACTLY ONCE.
     *
     * Both halves are counted because each fails in its own direction and neither is visible in a
     * behavioural run.
     *
     *  · A THIRD WRITER is an answer stored somewhere the census has not read, which is how the
     *    two paths (the timeout, the replay) came to disagree about who owns a result.
     *  · A SECOND DRAIN SITE double-consumes: `flushPending()` empties the map, so the second
     *    caller gets nothing and the surface it speaks for waits for ever — the shape the header
     *    of `mail-send.ts` calls a wedged Send, worse than a stale composer.
     *  · A SECOND CONSUMING FILE is the same defect one level out, and it is the one a reader is
     *    most likely to add innocently: `compose-autosave.ts` wants this answer too and must go on
     *    receiving it through `onSettled`, never by pulling the map itself.
     */
    const engine = readFileSync(
      resolve(process.cwd(), "packages/client-engine/src/engine.ts"), "utf8",
    );
    const code = (src: string): string[] => src.split("\n").map((l) => l.trim())
      .filter((l) => !l.startsWith("*") && !l.startsWith("//") && !l.startsWith("/*"));

    expect(
      code(engine).filter((l) => /this\.lateResults\.set\(/.test(l)).length,
      "the engine writes a late result somewhere this census has not read. Six writers are named: the dispatch "
      + "that timed out while a caller was waiting, the boot replay, whose answer used to be discarded, a withdrawn "
      + "press handing over the confirmation that waited for it, a Cancel's ending as the server decided it, "
      + "the owed Cancels a drive asks, and the hung change a Try again ended and sent ahead of the press "
      + "(`dispatchEndedFirst`). A seventh is an answer the drain cannot reach.",
    ).toBe(6);
    expect(
      code(engine).filter((l) => /this\.lateResults\.delete\(/.test(l)).length,
      "the map is emptied in more than one place; `flushPending` is destructive, so the second "
      + "reader gets nothing and the surface waiting on it never settles",
    ).toBe(1);

    /* ONE FILE IN THE SHELL PULLS IT, and it is the hook that owns the send. */
    const pullers = ["compose-autosave.ts", "mail-send.ts", "AppShell.tsx", "shell-compose.ts"]
      .filter((f) => code(SHELL(f)).some((l) => /\.flushPending\(/.test(l)));
    expect(
      pullers,
      "a second surface drains the engine's late results. `flushPending()` hands each answer to "
      + "exactly one caller, so whichever of the two runs second settles nothing — and neither "
      + "one can tell that it lost.",
    ).toEqual(["mail-send.ts"]);
  });

  it("(a5) the compose's HOLD has exactly one producer", () => {
    /*
     * ── WHY A SECOND PRODUCER IS THE DEFECT AND NOT A CONVENIENCE ───────────────────────────
     *
     * `ComposeView`'s `locked` prop is what makes the form read-only and both send buttons refuse
     * while a send from the last session is still carrying the message on screen. It is a REFUSAL,
     * and the whole subject of this census is that a refusal with more than one author drifts into
     * more than one answer: the send seam had several, and one message went out twice, seven
     * fixes running, because each site decided for itself.
     *
     * Two producers would also be invisible. Whichever ran second would set the same prop from a
     * different rule, and both would look correct in isolation — the shape that produced
     * `heldRowUnverified` disagreeing with `holdOf` about the same row.
     *
     * Counted as JSX ATTRIBUTES, not as the word: `locked` is a local in `ComposeView` and a
     * property name in its own type, and a census that fired on those would be a census that
     * fires on innocent content — which discards real work and gets loosened until it fires on
     * nothing.
     */
    const producers = ["compose-autosave.ts", "mail-send.ts", "AppShell.tsx", "shell-compose.ts"]
      .flatMap((f) => [...SHELL(f).matchAll(/\blocked=\{/g)].map(() => f));
    expect(
      producers,
      "the compose's hold is set from more than one place. A refusal with two authors has two "
      + "rules, and the one that runs second wins silently — ask the hook and pass its answer.",
    ).toEqual(["AppShell.tsx"]);
    /* TWO, and both are named: the entry on `MailSendApi` and the single implementation in the
       returned object. A third is a second answer to the question the prop above renders. */
    expect(
      [...SHELL("mail-send.ts").matchAll(/restoredPending:/g)].length,
      "the hook answers `restoredPending` from somewhere this census has not read — two are "
      + "expected, the type's entry and the one implementation",
    ).toBe(2);
  });
});

// ── the truth table ──────────────────────────────────────────────────────────────────────────

const LANE = "compose";
const SESSION = "sess-census";
const NOW = new Date("2026-09-08T09:00:00.000Z").getTime();

/** A mirror holding exactly the rows given, and answering `undefined` for anything else. */
const mirrorOf = (rows: Array<{ id: string; status: string }>) => ({
  read: () => ({
    get: <T,>(_type: string, id: string): T | undefined =>
      rows.find((r) => r.id === id) as T | undefined,
  }),
});

/** A jar the accessor THROWS on — a browser refusing this app its own storage. */
function blockStorage(): void {
  const real = window.localStorage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() { throw new DOMException("The operation is insecure.", "SecurityError"); },
  });
  (globalThis as unknown as { __realStorage: Storage }).__realStorage = real;
}
function unblockStorage(): void {
  const real = (globalThis as unknown as { __realStorage?: Storage }).__realStorage;
  if (!real) return;
  Object.defineProperty(window, "localStorage", { configurable: true, value: real });
}

/** An unresolved record naming this compose session and no row — the press-before-first-save shape. */
function parkBySession(): void {
  claimSendLock({
    v: SEND_LOCK_FORMAT, lane: LANE, key: "KEY-1", at: NOW, draftId: null,
    fp: "fp-of-the-parked-message", session: SESSION, unverified: true,
  } as SendLock, NONE_OWED);
}

/**
 * THE SAME SHAPE WITHOUT THE MARK — a send whose response was LOST rather than answered.
 *
 * The press wrote this record before the verb reached the engine; the tab died, or the transport
 * queued it, so no outcome was ever observed and nothing marked it `unverified`. `absorb` releases
 * a record on every terminal outcome it DOES observe, so a record that survives is exactly this.
 */
function ordinaryRecordBySession(): void {
  claimSendLock({
    v: SEND_LOCK_FORMAT, lane: LANE, key: "KEY-Q", at: NOW, draftId: null,
    fp: "fp-of-the-queued-message", session: SESSION,
  } as SendLock, NONE_OWED);
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  unblockStorage();
  window.localStorage.clear();
});

describe("the predicate's three answers, each produced by the state it is about", () => {
  it("free — no record, and a row the mirror calls a draft", () => {
    const hold = holdOf(mirrorOf([{ id: "d1", status: "draft" }]), {
      lane: LANE, draftId: "d1", session: SESSION,
    });
    expect(hold, "an ordinary draft is held, so nothing in the account can be written to")
      .toEqual({ kind: "free" });
  });

  it("free — no row at all, which is a compose nobody has saved yet", () => {
    expect(
      holdOf(mirrorOf([]), { lane: LANE, draftId: null, session: SESSION }),
      "a compose with no row is held, so the first save can never happen",
    ).toEqual({ kind: "free" });
  });

  it("free — a record with NO ROW does not park a message, and that is deliberate", () => {
    /*
     * ── THE PARK THAT WAS TRIED HERE AND REFUSED THE RIGHT PERSON ──────────────────────────
     *
     * The press-before-first-autosave sequence leaves an ORDINARY record (nothing observed an
     * outcome, so nothing marked it `unverified`) naming the message by its compose SESSION and
     * carrying no row. Parking on it looks right and is not: a genuinely new message written on
     * the same lane answers to that same name, so the park refused a message nobody had ever
     * pressed Send on — `send-lock-durable.test.tsx`'s "a DIFFERENT message written after the
     * crash gets a key of its own" went red, which is that suite doing its job.
     *
     * The sequence is covered by the DURABLE OUTBOX instead (`sendPendingInOutbox` below), which
     * names the actual pending verb and cannot mistake one message for another. This case pins
     * the refusal of the weaker rule so it is not re-derived.
     */
    ordinaryRecordBySession();
    expect(
      holdOf(mirrorOf([]), { lane: LANE, draftId: null, session: SESSION }),
      "a record with no row parks its session again — which refuses every NEW message written on "
      + "this lane until it ages out",
    ).toEqual({ kind: "free" });
  });

  it("parked/status carries WHICH status, because `sent` is not `unverified`", () => {
    /*
     * A send commits, `/sync` brings the row back as `sent`, and the tab that owned the response
     * dies before it can settle the record. Every status past `draft` refuses a WRITE and that
     * does not vary — but projecting `sent` into "we couldn't confirm this send" tells somebody to
     * go looking for mail that is in their Sent folder. The hold carries the fact; the surface
     * decides what to say with it.
     */
    const sent = holdOf(mirrorOf([{ id: "d9", status: "sent" }]), {
      lane: LANE, draftId: "d9", session: SESSION,
    });
    expect(sent.kind, "a sent row stopped refusing writes").toBe("parked");
    if (sent.kind === "parked") expect(sent.status, "the hold does not carry the status").toBe("sent");
    const stranded = holdOf(mirrorOf([{ id: "d8", status: "sending" }]), {
      lane: LANE, draftId: "d8", session: SESSION,
    });
    if (stranded.kind === "parked") {
      expect(stranded.status, "a stranded send reads as something it is not").toBe("sending");
    }
  });

  it("parked/record — this browser wrote down a send it never got an answer to", () => {
    parkBySession();
    const hold = holdOf(mirrorOf([{ id: "d1", status: "draft" }]), {
      lane: LANE, draftId: "d1", session: SESSION,
    });
    expect(hold.kind, "the record this browser wrote does not park its own message").toBe("parked");
    if (hold.kind !== "parked") return;
    expect(hold.by, "the record is not named as the witness, so the caller cannot restore the "
      + "identity it carries").toBe("record");
    expect(hold.session, "the record's own session is not handed back — a door in between mints a "
      + "new one and the message is then presented under a session the record never heard of")
      .toBe(SESSION);
  });

  it("parked/status — the row the ADAPTER made, which no record here can name", () => {
    /*
     * A press that carried no row makes the adapter create one and send THAT. The server marks it,
     * and the client is never told which row it is — so the durable record cannot speak for it and
     * the mirror's status is the only witness there is.
     */
    for (const status of ["unverified", "sending", "sent"]) {
      const hold = holdOf(mirrorOf([{ id: "srv-1", status }]), {
        lane: LANE, draftId: "srv-1", session: SESSION,
      });
      expect(hold.kind, `a row the server calls '${status}' is free — writing to it is refused by `
        + "the server and sending it again is a second copy").toBe("parked");
      if (hold.kind === "parked") {
        expect(hold.by, `'${status}' is attributed to a record that does not exist`).toBe("status");
      }
    }
  });

  it("unknown — the mirror cannot name the row yet, which a cold reload always looks like", () => {
    expect(
      holdOf(mirrorOf([]), { lane: LANE, draftId: "not-loaded-yet", session: SESSION }),
      "a mirror that has not finished loading reads as a decision",
    ).toEqual({ kind: "unknown" });
  });

  it("unknown — the jar itself refuses to be read", () => {
    blockStorage();
    expect(
      holdOf(mirrorOf([{ id: "d1", status: "draft" }]), {
        lane: LANE, draftId: "d1", session: SESSION,
      }),
      "a browser that will not let this app read its own records reads as a browser with none — "
      + "which is how every recovery door opened on evidence nobody had",
    ).toEqual({ kind: "unknown" });
  });

  it("an EMPTY jar admits, which is the half `unknown` must not swallow", () => {
    // Invariant S(4)'s last clause. Without this the fail-closed rule above would refuse every
    // first-ever compose in a browser that has simply never sent anything.
    expect(window.localStorage.getItem(sendLocksKey()), "the jar was not empty for this case")
      .toBeNull();
    expect(
      holdOf(mirrorOf([{ id: "d1", status: "draft" }]), {
        lane: LANE, draftId: "d1", session: SESSION,
      }),
      "an empty jar refuses",
    ).toEqual({ kind: "free" });
  });
});

// ── every write site, driven ─────────────────────────────────────────────────────────────────

/**
 * What each site is ASKED for and what it may write. `expect` is the mutation kind a `free` hold
 * must produce — the positive control — and every site must produce NOTHING under `parked`.
 */
interface Site {
  name: string;
  /** Drive the site and return every mutation it dispatched. */
  run: (hold: Hold, record: (m: EngineMutation) => void) => Promise<void> | void;
}

/** The seam's own reading of a hold, restated NOWHERE — each site consumes `holdOf`'s answer. */
const REFUSES_WRITE = (hold: Hold): boolean => hold.kind !== "free";

describe("what a site may do under each answer", () => {
  it("the rule itself: only `free` admits a write, and it admits it", () => {
    /*
     * The shape every site's guard reads, asserted once so a site that spells the test differently
     * (`=== "parked"` where a recovery needs `!== "free"`) is a difference somebody has to argue
     * for rather than a typo that ships.
     */
    expect(REFUSES_WRITE({ kind: "free" }), "a free hold refuses the write").toBe(false);
    expect(REFUSES_WRITE({ kind: "unknown" }), "an unknown hold admits a recovery").toBe(true);
    expect(
      REFUSES_WRITE({ kind: "parked", by: "record", status: null, draftId: null, session: SESSION }),
      "a parked hold admits the write",
    ).toBe(true);
  });

  it("the RECOVERY sites read `!== free`; the ordinary WRITE sites read `=== parked`", () => {
    /*
     * ── THE ONE PLACE THE TWO READINGS ARE ALLOWED TO DIFFER, AND IT IS ASSERTED ─────────────
     *
     * A recovery — adopt, discard, re-mint — fails closed on `unknown`: it acts on evidence, and
     * there is none. An ordinary save admits `unknown`, because refusing it stalls a compose whose
     * row the mirror will never answer for. Both readings are pinned so neither can be "tidied"
     * into the other by somebody who has only seen one of the two arguments.
     */
    const autosave = SHELL("compose-autosave.ts");
    const shell = SHELL("shell-compose.ts");
    const send = SHELL("mail-send.ts");

    expect(autosave, "the adopt-on-mount stopped failing closed on an answer nobody has")
      .toMatch(/if \(hold\.kind !== "free"\) return false;/);
    expect(autosave, "Discard stopped failing closed — it can delete a row on no evidence again")
      .toMatch(/if \(hold\.kind !== "free"\) \{/);
    /* BOTH READINGS, PINNED SEPARATELY. The save at SCHEDULE time still admits `unknown`; the save
       at WRITE time admits it too EXCEPT for a create beside a row already written down, which is
       the reload duplicate. Neither can be tidied into the other by somebody who has seen only one
       of the two arguments. The write-time arm answers the CLOSE as well as the pause now — one
       write, two callers — so it returns a flush outcome where it used to return nothing. */
    expect(
      [...autosave.matchAll(/\}\)\.kind === "parked"\) return;/g)].length,
      "the save at schedule time no longer admits `unknown`, so a compose whose row the mirror "
      + "cannot name can never be written to the account again",
    ).toBe(1);
    expect(autosave, "the write-time check stopped reading the hold it just computed")
      .toMatch(/if \(hold\.kind === "parked"\) return \{ kind: "nothing" \};/);
    expect(
      autosave,
      "a create beside a row that IS written down no longer refuses on `unknown` — that is the "
      + "reload duplicate: the adoption waits, this hook holds no row, and the timer mints a second",
    ).toMatch(
      /if \(row === null && readComposeRow\(\) !== null && hold\.kind === "unknown"\) return \{ kind: "nothing" \};/,
    );
    /* AND THE LIST'S DELETE, which was the write site the census did not count. */
    expect(shell, "the Drafts list's Delete writes without asking the predicate")
      .toMatch(/const hold = holdOf\(engine, \{[\s\S]{0,320}\}\);\n\s*const decision = discardDecision\(hold\);\n\s*if \(decision\.kind === "refuse"\) \{\n\s*setDiscardRefusal\(/);
    expect(shell, "the race the server refuses by name is not told to anybody")
      .toMatch(/res\.error\?\.code === "send_recorded"/);
    /* AND THE ONE STATUS THAT SETTLES RATHER THAN PARKS, on both sides of the seam. */
    expect(send, "the surface projects the mirror's `sent` into `we couldn't confirm this send`")
      .toMatch(/if \(hold\.by === "status" && hold\.status === "sent"\) return state;/);
    expect(autosave, "a row the server calls `sent` is still held, so the surface stays parked on "
      + "a send that is finished")
      .toMatch(/if \(hold\.kind === "parked" && hold\.status === "sent"\) \{/);
    expect(shell, "the reopen stopped failing closed on an answer nobody has")
      .toMatch(/const parked = hold\.kind !== "free";/);
    expect(send, "the press stopped admitting `unknown` — a browser that refuses this app its own "
      + "storage can no longer send at all")
      .toMatch(/if \(hold\.kind === "parked"\) \{/);
  });
});

// ── invariant T: what happens when M's fate becomes known ────────────────────────────────────

/**
 * ═══ EVERY ENDING OF A BOUND COMPOSE GOES THROUGH ONE FUNCTION ═══════════════════════════════
 *
 * S says which message a compose is holding; T says what happens when that message's story ends.
 * Three reviewed sequences ended the same way — the fate arrived, the durable record was tidied
 * away, and the compose was left POPULATED with the delivered text behind a projection reading
 * `idle`, after which an ordinary press minted a fresh key (a second delivery) or an ordinary
 * pause wrote a second row.
 *
 * The pins below are the same pair the `holdOf` census uses and for the same reason: a per-file
 * CALL-SITE COUNT, because a census over file membership cannot see a missing call, and END-STATE
 * assertions, because a count is satisfied by a call whose answer is thrown away.
 */
const SETTLE_SITES: Array<[file: string, count: number, sites: string]> = [
  ["compose-autosave.ts", 1, "the adopt-on-mount arm for a row the mirror calls `sent`"],
  ["shell-compose.ts", 2,
    "`onSendSettled`'s confirmed compose and `onSendOutcome`'s refused send that names its row "
    + "(`refusedWithRow`); a Discard empties the editor before the wire, so its 409 restores nothing"],
  // The shell frame keeps none: both endings moved with the verbs (ARCH-022), and a zero here is
  // the claim that no third ending was written back beside the JSX.
  ["AppShell.tsx", 0, "nothing — the endings live with the verbs"],
];

/** The SUM, apart from the rows, for `CALL_SITES_TOTAL`'s reason. */
const SETTLE_SITES_TOTAL = 3;

describe("a compose's ending is written in one place", () => {
  it("(a) the settleCompose call-site count per file", () => {
    for (const [file, count, sites] of SETTLE_SITES) {
      const found = [...SHELL(file).matchAll(/settleComposeRef\.current\(/g)].length;
      expect(
        found,
        `${file} ends a bound compose ${found} times; this census expects ${count} — ${sites}. A `
        + "site added here must be named above; one removed is an ending that clears the compose "
        + "its own way again, which is how a delivered message came to sit in the composer.",
      ).toBe(count);
    }
    expect(
      SETTLE_SITES.reduce((n, [, count]) => n + count, 0),
      "the rows no longer add up to the census's own total — an ending moved to a frame this "
      + "census does not read",
    ).toBe(SETTLE_SITES_TOTAL);
    /* And it is ONE implementation: the hook owns it and the shell is wired to that one. */
    expect(SHELL("compose-autosave.ts"), "the one function is gone")
      .toMatch(/const settleCompose = useCallback\(\(fate: ComposeFate\) => \{/);
    expect(SHELL("shell-compose.ts"), "the shell holds its own copy of the ending again")
      .toMatch(/settleComposeRef\.current = autosave\.settleCompose;/);
  });

  it("(b) no FATE site releases the binding on its own, and the identity doors still do", () => {
    /*
     * `autosave.release()` forgets which message the compose is bound to. That is right at a door
     * that REPLACES the message — the reopen, Write-to, a mail link are identity moves and keep
     * it — and wrong at a fate, where the ending has to be the whole ending. `discardDraft` had it
     * unconditionally, before the server had answered: the 409 then restored the row while the
     * binding was already gone, and the next pause wrote a second one.
     *
     * Counted on CODE lines only — a comment naming the call is not a call, and the count read 4
     * with one of them in a docblock.
     */
    const shell = SHELL("shell-compose.ts");
    const codeReleases = shell.split("\n")
      .map((l) => l.trim())
      /* THE STATEMENT, not the mention. Filtering on a leading `*` missed a docblock line that
         begins with a backtick — the count read 4 for three calls. A call is a whole line that
         IS the call. */
      .filter((l) => l === "autosave.release();");
    expect(
      codeReleases.length,
      "the doors that replace the message on screen are the only places that forget the binding: "
      + "the reopen's parked arm, Write-to, and the mailto seam",
    ).toBe(3);

    /* The Drafts list's Delete empties every editor bound to the row before the request goes, by
       design (`compose-draft-gone-elsewhere.test.tsx` drives it): a refusal leaves the row in Drafts
       and the editor empty, so nothing can write a second row for it. */
  });

  it("(c) the census REFUSES an anchor that finds nothing", () => {
    /*
     * THE CONTROL for `sliceOfDeclaration`. `(b)` located `discardDraft` by the hook it was
     * declared with; a codemod renamed that hook, the anchor became -1, the slice became "", and
     * both of `(b)`'s `not.toContain` judgements passed on nothing while the release call they
     * refuse could have been anywhere in that function. A name the shell does not declare has to
     * throw, not hand back something to assert nothing against.
     */
    const shell = SHELL("shell-compose.ts");
    expect(() => sliceOfDeclaration(shell, "noSuchName")).toThrow("anchor not found: noSuchName");
    /* The positive half — the name `(b)` DOES use resolves to a slice with the arm in it. */
    expect(sliceOfDeclaration(shell, "discardDraft")).toContain("emptyEditorsOf(draftId, heldRow)");
  });
});

// ── the sites, driven ────────────────────────────────────────────────────────────────────────

/**
 * A FAKE ENGINE, not `OhmailEngine`, and the choice is the point: what is under test is which
 * mutations each site DISPATCHES under each hold, and a real engine puts an outbox, a mirror and a
 * reconciliation drain between the assertion and that fact. The mirror is a literal, so
 * `parked/status` and `unknown` are states this file can put the seam into rather than states it
 * has to arrange for.
 */
function fakeEngine(rows: Array<{ id: string; status: string }>) {
  const dispatched: EngineMutation[] = [];
  let minted = 0;
  return {
    dispatched,
    engine: {
      read: () => ({
        get: <T,>(_type: string, id: string): T | undefined =>
          rows.find((r) => r.id === id) as T | undefined,
        list: () => [],
      }),
      /* An outbox read and empty, as production's is after its restore: a double with no outbox
         reading makes every send record owed, and nothing would ever be let go. */
      outboxKnown: () => true,
      pendingMutations: () => [],
      inFlightMutations: () => [],
      hasLateResults: () => false,
      subscribe: () => () => { /* the mirror in this harness never changes under a case */ },
      mutate: async (m: EngineMutation) => {
        dispatched.push(m);
        if (m.kind !== "draft_save") return { id: "x", key: "k", status: "confirmed", seq: 1 };
        const id = m.draftId ?? `srv-${++minted}`;
        rows.push({ id, status: "draft" });
        return { id: "x", key: "k", status: "confirmed", seq: 1, entityId: id };
      },
    },
  };
}

const FIELDS = {
  to: "lena@atelier.example, ", cc: "", bcc: "", subject: "Bis Montag",
  body: "Kommst du noch?", html: "", fromMailboxId: "mb-1", sig: null,
} as never;
/** The shape a door seeds: a recipient and nothing the person typed. */
const DOOR_SEED = { ...(FIELDS as object), subject: "", body: "" } as never;

/*
 * A REAL DEBOUNCE PER DRIVE. `useComposeAutosave` waits `AUTOSAVE_DELAY_MS` (two seconds) before it
 * writes, and these cases arrange two or three states each, so the deadline is raised rather than
 * the debounce faked: fake timers under React's `act` put a second async machine between the
 * assertion and the thing asserted, which is how a green harness comes to measure nothing.
 */
describe("every write site, under every answer the predicate can give", { timeout: 30_000 }, () => {
  /**
   * ── THE FOUR STATES, AS FIXTURES ────────────────────────────────────────────────────────────
   *
   * Each case arranges ONE of them and drives ONE site. The negative and the positive live in the
   * same case wherever the site allows it, because a refusal with no admission beside it is
   * satisfied by refusing everybody — which is a product nobody can use, with the suite green.
   */
  let React: typeof import("react");
  let createRoot: typeof import("react-dom/client").createRoot;
  let act: (cb: () => Promise<void> | void) => Promise<void>;
  let root: import("react-dom/client").Root | null = null;

  beforeEach(async () => {
    React = await import("react");
    ({ createRoot } = await import("react-dom/client"));
    (globalThis as unknown as { React: unknown }).React = React;
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    act = (React as unknown as { act: typeof act }).act;
    window.localStorage.setItem(composeSessionKey(), SESSION);
  });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
  });

  /**
   * Mount the autosave hook over a fixed form, run the debounce out, and hand back everything the
   * engine was asked to write. `sendInFlight` is a prop rather than a state so the press-race case
   * can set it without a send.
   */
  /**
   * Replace the jar with one that throws on every call, and remember how to put it back. jsdom's
   * `localStorage` is a own-property getter, so the swap is a `defineProperty` and the restore is
   * the descriptor it returned.
   */
  let jarDescriptor: PropertyDescriptor | undefined;
  function blindJar(): void {
    jarDescriptor ??= Object.getOwnPropertyDescriptor(window, "localStorage");
    const refuse = (): never => { throw new DOMException("denied", "SecurityError"); };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => ({
        getItem: refuse, setItem: refuse, removeItem: refuse, clear: refuse, key: refuse,
        get length(): number { return refuse(); },
      }),
    });
  }
  afterEach(() => {
    if (jarDescriptor !== undefined) Object.defineProperty(window, "localStorage", jarDescriptor);
    jarDescriptor = undefined;
  });

  async function drive(opts: {
    rows: Array<{ id: string; status: string }>;
    fields?: unknown;
    heldRow?: string | null;
    /**
     * A BROWSER THAT REFUSES THIS APP ITS STORAGE — every jar call throws, which is what a
     * private window with site data blocked does. The held row can then only be remembered for
     * the life of the tab, and `writeComposeRow` is the one writer that can do it.
     */
    jarThrows?: boolean;
    sendInFlight?: boolean;
    onCleared?: (toList: "ohbox" | "drafts") => void;
    after?: (api: import("../app/shell/compose-autosave").ComposeAutosave) => Promise<void>;
  }): Promise<{ dispatched: EngineMutation[]; api: import("../app/shell/compose-autosave").ComposeAutosave }> {
    const { useComposeAutosave, AUTOSAVE_DELAY_MS } = await import("../app/shell/compose-autosave");
    const { dispatched, engine } = fakeEngine(opts.rows);
    /* A FRESH TAB. The remembered row (`forgetComposeRows`) is module state and outlives a
       `localStorage.clear()`, so without this a case's second drive inherits the first's row and
       reads as a refusal nothing in the product would make. */
    (await import("../app/shell/compose")).forgetComposeRows();
    if (opts.jarThrows === true) {
      /* THE JAR GOES BLIND FIRST, so the row is written the only way this browser can write it. */
      blindJar();
      const { writeComposeRow } = await import("../app/shell/compose");
      if (opts.heldRow !== undefined && opts.heldRow !== null) writeComposeRow(opts.heldRow);
    } else if (opts.heldRow !== undefined && opts.heldRow !== null) {
      window.localStorage.setItem(composeRowKey(), opts.heldRow);
    }
    let api!: import("../app/shell/compose-autosave").ComposeAutosave;
    /* THE SURFACE HALF, MODELLED: `AppShell.onCleared` empties the form. Without it this harness
       would hand the hook a populated form for ever and the pause after a clear would write a row
       for text no surface is showing — a fixture disagreeing with the shell, not a defect. */
    const Harness = (): null => {
      const [fields, setFields] = React.useState(opts.fields ?? FIELDS);
      api = useComposeAutosave({
        engine: engine as never,
        fields: fields as never,
        mailboxId: "mb-1",
        active: true,
        sendInFlight: opts.sendInFlight ?? false,
        onCleared: (toList: "ohbox" | "drafts") => {
          setFields({ ...(FIELDS as object), to: "", subject: "", body: "" } as never);
          opts.onCleared?.(toList);
        },
      });
      return null;
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(React.createElement(Harness)));
    await act(async () => { await new Promise((r) => setTimeout(r, AUTOSAVE_DELAY_MS + 60)); });
    if (opts.after) await act(async () => { await opts.after!(api); });
    return { dispatched, api };
  }

  const saves = (ms: EngineMutation[]): EngineMutation[] => ms.filter((m) => m.kind === "draft_save");
  const discards = (ms: EngineMutation[]): EngineMutation[] =>
    ms.filter((m) => m.kind === "draft_discard");

  it("(c) sentByMirror ends the compose the way the live confirmed path ends it", async () => {
    /**
     * ── THE DOUBLE DELIVERY, AS AN END STATE ──────────────────────────────────────────────────
     *
     * Reload onto a mount that did not issue the send; the mirror shows the bound row `sent`. The
     * arm used to release the record and drop the held row and stop — leaving the DELIVERED TEXT
     * in the form with the projection reading `idle`, so the next ordinary press minted a second
     * Idempotency-Key for a message that had already gone.
     *
     * The buffer is the assertion that matters: an empty compose cannot be sent (`canSend` refuses
     * an empty body), so this end state is what makes the second press impossible. The press
     * itself is not driven here and that is a limit worth stating — the demo world cannot put a
     * row into `sent`, so there is no mounted path to this state.
     *
     * Mutation: drop `clearComposeDraft()` from `settleCompose`, or restore the two-statement arm.
     */
    writeComposeDraft({
      to: "lena@atelier.example, ", cc: "", bcc: "", subject: "Bis Montag",
      body: "Kommst du noch?", html: "", fromMailboxId: "mb-1", sig: null,
    } as never);
    ordinaryRecordBySession();
    const cleared: string[] = [];
    const out = await drive({
      rows: [{ id: "d-sent", status: "sent" }], heldRow: "d-sent",
      onCleared: (to) => cleared.push(to),
    });
    expect(
      readComposeDraft().body,
      "the delivered message's text is still in the composer — the next press mints a second key "
      + "for a message the mirror says was already sent",
    ).toBe("");
    expect(window.localStorage.getItem(composeRowKey()), "the compose still holds the sent row")
      .toBeNull();
    expect(window.localStorage.getItem(sendLocksKey()), "the record about the sent row was kept")
      .toBeNull();
    expect(cleared, "the surface was never told the compose is over, so the form stays on screen")
      .toEqual(["ohbox"]);
    expect(saves(out.dispatched), "the delivered row was written to").toHaveLength(0);
  });

  it("(c2) a Discard lets go of the row before the wire, and nothing is written for the letter after", async () => {
    /**
     * The Drafts list's Discard empties the editor before the request goes; a 409 that keeps the row
     * leaves it in Drafts and the composer holds nothing, so the pause writes no row and no update.
     * Mutation: drop `release()`'s `abandonedAt` mark, or re-adopt the row on the refusal.
     */
    const out = await drive({
      rows: [{ id: "d1", status: "draft" }], heldRow: "d1",
      after: async (api) => {
        expect(api.draftId, "the ordinary row was not adopted, so this case measures nothing").toBe("d1");
        api.release();
      },
    });
    const before = out.dispatched.length;
    await new Promise((r) => setTimeout(r, 2_400));
    expect({ row: out.api.draftId, stored: window.localStorage.getItem(composeRowKey()), saves: saves(out.dispatched.slice(before)).length },
      "the released letter was written again, or the composer still holds the row").toEqual({ row: null, stored: null, saves: 0 });
  });
  it("the CREATE arm: free writes exactly one row; parked/record writes none", async () => {
    const free = await drive({ rows: [] });
    expect(
      saves(free.dispatched).map((m) => (m as { draftId: string | null }).draftId),
      "an ordinary compose no longer reaches the account at all — this is the positive control, "
      + "and without it a predicate that refuses everything satisfies this file",
    ).toEqual([null]);

    window.localStorage.clear();
    window.localStorage.setItem(composeSessionKey(), SESSION);
    parkBySession();
    const parked = await drive({ rows: [] });
    expect(
      saves(parked.dispatched),
      "a second row was created for a message this browser is already waiting on — that is the "
      + "reload half of the measured duplicate delivery",
    ).toHaveLength(0);
  });

  it("the CREATE arm: a door's seed is not a message until somebody types", async () => {
    /*
     * `WRITETO-DOOR-MINTS-EMPTY-DRAFT-ROW`, measured live: every use of a contact's Write, and
     * every `mailto:` from outside the app, put a "(no subject)" row on the account two seconds
     * later. A recipient is not a message.
     */
    const seeded = await drive({ rows: [], fields: DOOR_SEED });
    expect(
      saves(seeded.dispatched),
      "a door that only prefilled the To line wrote a row nobody had written anything into",
    ).toHaveLength(0);
    const typed = await drive({ rows: [], fields: FIELDS });
    expect(
      saves(typed.dispatched),
      "typing a subject and a body no longer creates the row — the create gate refuses everything",
    ).toHaveLength(1);
  });

  it("the CREATE arm: a cold mirror beside a HELD ROW creates nothing until it answers", async () => {
    /*
     * ── THE RELOAD DUPLICATE THE `=== "parked"` GATE LET THROUGH ─────────────────────────────
     *
     * A reload with a row written down and a send that is unconfirmed but NOT `unverified` — a
     * transport-queued send, or a record a sweep has already taken — comes back to an EMPTY
     * mirror. `holdOf` answers `unknown` (no record to speak, no row the mirror can name), the
     * adopt-on-mount correctly WAITS, and `draftId` therefore stays null. The save effect's gate
     * read `=== "parked"`, so `unknown` walked past it and the two-second timer minted a SECOND
     * row for a message that already had one — invariant S(1) broken on the one path the adoption
     * exists for.
     *
     * Measured red before the fix: `expected [ { kind: 'draft_save' } ] to have a length of +0 but
     * got 1`. Mutation: drop the `readComposeRow() !== null && hold.kind === "unknown"` line.
     */
    const rows: Array<{ id: string; status: string }> = [];   // the mirror answers NOTHING yet
    const cold = await drive({ rows, heldRow: "d-reload" });
    expect(
      saves(cold.dispatched),
      "a second row was created for a message whose row is written down and whose status the "
      + "mirror cannot yet name — the reload duplicate",
    ).toHaveLength(0);
    expect(
      window.localStorage.getItem(composeRowKey()),
      "the held row was thrown away while the mirror was still loading",
    ).toBe("d-reload");

    /* THE POSITIVE CONTROL, in the same case: once the mirror answers, the row is ADOPTED and the
       next save is a PUT to it. Without this the refusal above is satisfied by never writing. */
    rows.push({ id: "d-reload", status: "draft" });
    const warm = await drive({ rows, heldRow: "d-reload" });
    expect(
      warm.api.draftId,
      "the row is not adopted once the mirror can name it, so the surface never writes again",
    ).toBe("d-reload");
    expect(
      saves(warm.dispatched).map((m) => (m as { draftId: string | null }).draftId),
      "the adopted row is not written to",
    ).toEqual(["d-reload"]);
  });

  it("the CREATE arm: a BROWSER WITH NO STORAGE creates nothing beside the row it opened", async () => {
    /*
     * ── THE ONE WITNESS THAT WAS NOT THERE ────────────────────────────────────────────────────
     *
     * The refusal above is gated on `readComposeRow() !== null`, and in a browser that refuses
     * this app its storage that call answered `null` BY CONSTRUCTION: nothing could be written, so
     * nothing could be read. So `holdOf` answered `unknown`, the adopt-on-mount correctly waited,
     * and the timer created a SECOND row for the row the reopen had just opened — two rows for one
     * message, in the one browser where nothing learned survives a reload either.
     *
     * The row the door opened is remembered for the life of the tab instead, which is what such a
     * browser can have. `writeComposeRow` is the only writer, so the fact cannot be set by anyone
     * who did not open a row, and the sign-out sweep forgets it with the key.
     *
     * Mutation: drop the in-memory fallback from `readComposeRow`. Real failure text:
     *   AssertionError: a second row was created beside the row this browser had opened …
     */
    const cold = await drive({ rows: [], heldRow: "d-blind", jarThrows: true });
    expect(
      saves(cold.dispatched),
      "a second row was created beside the row this browser had opened — the jar refuses every "
      + "call, so the witness the refusal reads was empty by construction",
    ).toHaveLength(0);

    /* THE POSITIVE CONTROL. A FIRST compose in such a browser has opened no row, so there is no
       message a create could be a second row for — and it must still reach the account. */
    const first = await drive({ rows: [], jarThrows: true });
    expect(
      saves(first.dispatched),
      "a first compose in a browser that refuses storage cannot be saved at all — the refusal "
      + "widened from the row it was written for to every message",
    ).toHaveLength(1);

    /* AND THE DOOR THAT ENDS IT. Every door starting a new message calls `clearComposeDraft`, and
       in this browser its first jar call throws — so the forget has to happen before the try, or
       the remembered row would name a message that has been cleared and refuse every save after
       it. */
    const { clearComposeDraft, readComposeRow, writeComposeRow } =
      await import("../app/shell/compose");
    blindJar();
    writeComposeRow("d-blind");
    expect(readComposeRow(), "the row this browser opened is not remembered at all").toBe("d-blind");
    clearComposeDraft();
    expect(
      readComposeRow(),
      "a door that starts a new message left the old row remembered, so every save after it is "
      + "refused as a second row for a message nobody is holding",
    ).toBeNull();
  });

  it("a row the server calls `sent` is let go of, its record settled, and NOT called unconfirmed", async () => {
    /*
     * The second case: the send committed and `/sync` brought the row back as `sent`, but the tab that owned
     * the response died before it could settle the record. The restored compose was still holding
     * that row: the status arm parked it (right — nothing may write to a sent row) and the surface
     * projected the park into "We couldn't confirm this send", about a message the mirror says was
     * delivered. A false state is worse than none: it sends somebody looking for mail that is in
     * their Sent folder, and it refuses a press that would have replayed the original key.
     *
     * Mutation: drop `hold.status === "sent"` from either arm.
     */
    const { heldRowUnverified } = await import("../app/shell/mail-send");
    ordinaryRecordBySession();
    const rows = [{ id: "d-sent", status: "sent" }];
    const settled = await drive({ rows, heldRow: "d-sent" });
    expect(
      window.localStorage.getItem(composeRowKey()),
      "the compose is still holding a row whose send is finished",
    ).not.toBe("d-sent");
    expect(
      window.localStorage.getItem(sendLocksKey()),
      "the record about a row the server calls `sent` was not settled",
    ).toBeNull();
    /* THE DELIVERED ROW ITSELF IS NEVER WRITTEN TO — which is the claim, and it is asserted by
       NAME rather than by a count of zero writes. What the form does afterwards is the ordinary
       path and deliberately out of scope here: the text on screen is the person's, the app does
       not delete it, so a compose still holding unsent words saves them as a new draft exactly as
       it would have if no send had ever happened. Asserting "no writes at all" would make this
       case pass for that reason instead of for the one it is about. */
    expect(
      saves(settled.dispatched).map((m) => (m as { draftId: string | null }).draftId),
      "the row the server already delivered was written to",
    ).not.toContain("d-sent");

    /* THE SURFACE SAYS NOTHING ABOUT IT — the projection half of the same evidence. */
    const sentHold = holdOf(mirrorOf(rows), { lane: LANE, draftId: "d-sent", session: SESSION });
    expect(
      heldRowUnverified({ phase: "idle" }, "d-sent", sentHold, SESSION).phase,
      "a message the mirror says was sent is shown as one we could not confirm",
    ).toBe("idle");

    /* THE NEGATIVE, so the arm above cannot be widened into "never warn": a STRANDED `sending`
       row is not a confirmation and keeps the warning and the refusal. */
    const strandedHold = holdOf(mirrorOf([{ id: "d-str", status: "sending" }]), {
      lane: LANE, draftId: "d-str", session: SESSION,
    });
    expect(
      heldRowUnverified({ phase: "idle" }, "d-str", strandedHold, SESSION).phase,
      "a send that died without a verdict stopped being held",
    ).toBe("unverified");
  });

  it("the durable outbox is what sees a send with no row, and it names the LANE", async () => {
    /*
     * ── THE THIRD CASE'S DISCRIMINATOR, driven ──────────────────────────────────────────────
     *
     * Press Send before the first autosave, lose the response, reload. The verb is in the outbox
     * and its replay will create the row server-side; the restored surface holds no row, no phase
     * and — correctly — no park, so without this read its timer creates a SECOND row for the same
     * message, and an edit of that row can later mint a fresh send key for mail already delivered.
     *
     * Every arm below is a control the two weaker rules failed: a pending send on ANOTHER lane
     * must not refuse this surface (the record-by-session park did), a pending verb that is not a
     * send must not either, and an empty queue must admit (or a first compose could never save).
     *
     * Mutation: `p.mutation.kind === "mail_send"` → `true`, or drop the lane comparison.
     */
    const { sendPendingInOutbox } = await import("../app/shell/mail-send");
    const queue = (ms: Array<Record<string, unknown>>) => ({
      pendingMutations: () => ms.map((m, i) => ({ id: `p${i}`, key: `k${i}`, mutation: m })),
    });
    const composeSend = {
      kind: "mail_send", inReplyTo: null, forwardOf: null, subject: "Bis Montag",
      body: "Kommst du noch?", to: [{ name: null, address: "lena@atelier.example" }],
      mailboxId: "mb-1",
    };
    const replySend = { ...composeSend, inReplyTo: "giulia" };

    expect(
      sendPendingInOutbox(queue([composeSend]) as never, "compose"),
      "a compose send still in the durable outbox is invisible, so a reload inside that window "
      + "creates a second row for the message the replay is already carrying",
    ).toBe(true);
    expect(
      sendPendingInOutbox(queue([replySend]) as never, "compose"),
      "a REPLY's pending send refuses the compose surface's first save — the false park again, "
      + "one lane over",
    ).toBe(false);
    expect(
      sendPendingInOutbox(queue([{ kind: "draft_save", draftId: null }]) as never, "compose"),
      "a pending save reads as a pending send",
    ).toBe(false);
    expect(
      sendPendingInOutbox(queue([]) as never, "compose"),
      "an empty queue refuses — a first compose could then never reach the account",
    ).toBe(false);

    /* AND THE SURFACE READS IT BESIDE THE PHASE, not instead of it: the phase covers the live tab,
       the outbox covers the one that died. */
    expect(
      SHELL("shell-compose.ts"),
      "the shell reads only the phase again, so a reload inside the send window is unguarded",
    ).toMatch(/SEND_IN_FLIGHT_PHASES\.has\(mailSend\.stateOf\(COMPOSE_SEND_KEY\)\.phase\)\s*\n\s*\|\| sendPendingInOutbox\(engine, COMPOSE_SEND_KEY\)/);
  });

  it("the CREATE arm: nothing is created while a send of this message is on the wire", async () => {
    /*
     * `DRAFT-ROW-B-MINTED-ON-PRESS-BEFORE-FIRST-AUTOSAVE`. The press at 1.9 s carries no row, so
     * the ADAPTER creates one and sends it; the armed save then created a second for the same
     * message and both were listed in Drafts.
     */
    const racing = await drive({ rows: [], sendInFlight: true });
    expect(
      saves(racing.dispatched),
      "a row was created while a send of the same message was in flight — the send is already "
      + "carrying one, so this is the second row for one message",
    ).toHaveLength(0);
  });

  it("the PUT arm: free updates the adopted row; parked/status writes nothing", async () => {
    const rows = [{ id: "d1", status: "draft" }];
    const free = await drive({
      rows, heldRow: "d1",
      after: async (api) => { expect(api.draftId, "the ordinary row was not adopted").toBe("d1"); },
    });
    expect(
      saves(free.dispatched).map((m) => (m as { draftId: string | null }).draftId),
      "the adopted row is no longer written to — every edit after a reopen is lost",
    ).toEqual(["d1"]);

    window.localStorage.clear();
    window.localStorage.setItem(composeSessionKey(), SESSION);
    const parked = await drive({ rows: [{ id: "srv-1", status: "unverified" }], heldRow: "srv-1" });
    expect(
      saves(parked.dispatched),
      "the composer wrote to a row the server holds as unconfirmed — every PUT answers 409 and "
      + "the write is aimed at a message that may already have been delivered",
    ).toHaveLength(0);
  });

  it("the ADOPT-ON-MOUNT: free adopts; parked/status holds the row without adopting it", async () => {
    const free = await drive({
      rows: [{ id: "d1", status: "draft" }], heldRow: "d1",
      after: async (api) => {
        expect(api.draftId, "a reload no longer picks the row back up, so the next pause mints a "
          + "second one for the same message").toBe("d1");
      },
    });
    expect(free.dispatched.length, "the adoption itself wrote to the account").toBeGreaterThan(-1);

    window.localStorage.clear();
    window.localStorage.setItem(composeSessionKey(), SESSION);
    const parked = await drive({
      rows: [{ id: "srv-1", status: "sending" }], heldRow: "srv-1",
      after: async (api) => {
        expect(api.draftId, "a row the server may still be sending was adopted — a PUT or a "
          + "Discard would go straight at it").toBeNull();
      },
    });
    expect(
      window.localStorage.getItem(composeRowKey()),
      "the held row was thrown away, which is what let the next pause mint a second row for the "
      + "message whose send is most likely still in flight",
    ).toBe("srv-1");
    expect(saves(parked.dispatched), "a row was written for a held message").toHaveLength(0);
  });

  it("DISCARD: free deletes the row; parked deletes nothing and unknown deletes nothing", async () => {
    const free = await drive({
      rows: [{ id: "d1", status: "draft" }], heldRow: "d1",
      after: async (api) => { await api.discard(); },
    });
    expect(
      discards(free.dispatched).map((m) => (m as { draftId: string }).draftId),
      "Discard on an ordinary draft no longer deletes it — the row somebody threw away stays in "
      + "Drafts for ever",
    ).toEqual(["d1"]);

    /*
     * ── THE ROW IS ADOPTED FIRST, AND THE HOLD ARRIVES AFTERWARDS ──────────────────────────────
     *
     * The obvious fixture — a row that is already `unverified` at mount — does NOT measure this
     * guard: the adoption refuses to adopt such a row, so the hook holds nothing and Discard has
     * nothing to delete whether or not the guard exists. It measures the pair, not the part. This
     * arranges the state the guard is actually for: the composer legitimately adopted an ordinary
     * draft, a send of it came back unconfirmed while the form was still open, and Discard is
     * pressed on a row this hook IS holding.
     */
    window.localStorage.clear();
    window.localStorage.setItem(composeSessionKey(), SESSION);
    const rows2 = [{ id: "d2", status: "draft" }];
    const parked = await drive({
      rows: rows2, heldRow: "d2",
      after: async (api) => {
        expect(api.draftId, "the ordinary row was not adopted, so this case measures nothing")
          .toBe("d2");
        rows2[0]!.status = "unverified";
        await api.discard();
      },
    });
    expect(
      discards(parked.dispatched),
      "a row whose send may already have gone was deleted — it is the only surviving copy of that "
      + "message and the account's only record that the send happened",
    ).toHaveLength(0);

    /* AND THE JAR'S SIDE OF THE SAME GUARD: a record, no status change, same refusal. */
    window.localStorage.clear();
    window.localStorage.setItem(composeSessionKey(), SESSION);
    const rows3 = [{ id: "d3", status: "draft" }];
    const byRecord = await drive({
      rows: rows3, heldRow: "d3",
      after: async (api) => {
        expect(api.draftId, "the ordinary row was not adopted, so this case measures nothing")
          .toBe("d3");
        parkBySession();
        await api.discard();
      },
    });
    expect(
      discards(byRecord.dispatched),
      "a row belonging to a message this browser is still waiting on was deleted",
    ).toHaveLength(0);
  });
});
