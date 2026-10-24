/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineDraft } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { DraftsView } from "../app/views/DraftsView";

/**
 * ═══ A SEND THAT DID NOT CONFIRM IS FINDABLE, SAYS SO, AND CAN BE RECOVERED ══════════════
 *
 * ── THE LOSS THIS CLOSES ─────────────────────────────────────────────────────────────────
 *
 * An `unverified` send — SMTP threw AND the server's Sent-folder probe found nothing — leaves
 * its full text in a draft row and appends nothing to any Sent folder. The Drafts list used to
 * filter to `status === "draft"`, so after the compose sheet closed NO surface anywhere named
 * the state: the user, told to "check your Sent folder", found nothing there, found nothing in
 * Drafts either, and concluded the message was gone. Seen on a live account: a send went
 * `unverified` and its only copy sat in a row no list showed.
 *
 * `draftsList` now surfaces those rows (and `sending` rows old enough that no send can still
 * be running) — that inclusion is pinned in `compose-autosave.test.tsx` beside the selector's
 * other consumers. What THIS file pins is the surface: the row must SAY what is and is not
 * known, in the row, before any press — and the saying must survive a refactor, which is what
 * the mutation runs below measured.
 *
 * ── RECOVERY IS A FRESH ROW, STRUCTURALLY ────────────────────────────────────────────────
 *
 * `SendService.reserve` sends only a `status='draft'` row, so "open it to send again" cannot
 * mean adopting the stranded row — every retry would 409 forever (the compose surface had
 * exactly that defect: after an `unverified` outcome the plan still carried the row's id, and
 * the deliberate second press the warning invites answered "draft cannot be sent from status
 * 'unverified'"). The shell therefore seeds the TEXT, lets autosave write a fresh row, and
 * discards the stranded one only when the fresh send CONFIRMS. Those are shell decisions
 * (`AppShell.openDraft` / `sendCompose` / `onSendSettled`, the `recoverySeed` ref), pinned
 * structurally below the way `compose-autosave.test.tsx` pins the autosave wiring.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const draft = (over: Partial<EngineDraft> = {}): EngineDraft => ({
  id: "d1",
  mailboxId: "mb-1",
  threadId: null,
  inReplyToMessageId: null,
  subject: "Invoice for the paper order",
  body: "The only copy of this text lives in this row.",
  to: [{ name: null, address: "sam@customer.example" }],
  cc: [],
  bcc: [],
  rationale: null,
  status: "draft",
  createdAt: "2026-08-07T09:00:00.000Z",
  updatedAt: "2026-08-07T14:02:00.000Z",
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let opened: string[] = [];
let discarded: string[] = [];

async function mountDrafts(drafts: EngineDraft[]): Promise<void> {
  opened = [];
  discarded = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: new Date("2026-08-07T15:00:00.000Z"),
        children: h(DraftsView, {
          settled: true,
          owed: false,
          drafts,
          scheduled: [],
          now: new Date("2026-08-07T15:00:00.000Z"),
          onOpen: (d: EngineDraft) => { opened.push(d.id); },
          onDiscard: (id: string) => { discarded.push(id); },
          onResolve: () => {},
          onCancelSchedule: () => {},
          onEditScheduled: () => {},
          onSendAgain: () => {},
          repliesHere: () => false,
        }),
      }),
    );
  });
}

const q = <T extends Element>(sel: string): T | null => host!.querySelector<T>(sel);
const qa = (sel: string): Element[] => Array.from(host!.querySelectorAll(sel));
const press = async (el: HTMLElement): Promise<void> => { await act(async () => { el.click(); }); };

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

describe("the row says what is and is not known", () => {
  /**
   * ══ THE CENTRAL GUARD ══════════════════════════════════════════════════════════════════
   *
   * Mutation: drop the `d.status !== "draft"` block from `DraftsView`. Real failure text:
   *   AssertionError: an unverified send carries no state line — the row is indistinguishable
   *   from an ordinary draft: expected null not to be null
   */
  it("an unverified row carries the not-confirmed line; an ordinary draft carries none", async () => {
    await mountDrafts([
      draft({ id: "u1", status: "unverified" }),
      draft({ id: "p1", updatedAt: "2026-08-07T13:00:00.000Z" }),
    ]);

    const rows = qa(".draft-row");
    expect(rows).toHaveLength(2);
    const state = q<HTMLElement>('.draft-row[data-id="u1"] .draft-state');
    expect(
      state,
      "an unverified send carries no state line — the row is indistinguishable from an ordinary draft",
    ).not.toBeNull();
    // The sentence states uncertainty and points at Sent — never "failed", never a claim it went.
    expect(state!.textContent).toMatch(/not sure this was sent/i);
    expect(state!.textContent).toMatch(/sent folder/i);
    // Out of band, so it must reach a screen reader without focus near it.
    expect(state!.getAttribute("role")).toBe("status");
    // The ordinary draft says nothing.
    expect(q('.draft-row[data-id="p1"] .draft-state')).toBeNull();
  });

  it("a stranded `sending` row carries the interrupted line instead", async () => {
    await mountDrafts([draft({ id: "s1", status: "sending" })]);
    const state = q<HTMLElement>('.draft-row[data-id="s1"] .draft-state');
    expect(state, "a stranded send carries no state line").not.toBeNull();
    expect(state!.textContent).toMatch(/interrupted/i);
  });

  it("an unverified row still opens and still discards — recovery needs both verbs", async () => {
    await mountDrafts([draft({ id: "u1", status: "unverified" })]);

    await press(q<HTMLButtonElement>('.draft-row[data-id="u1"] .draft-open')!);
    expect(opened, "the stranded row cannot be opened, so its text cannot be recovered")
      .toEqual(["u1"]);

    await press(q<HTMLButtonElement>('.draft-row[data-id="u1"] .draft-discard')!);
    // The destructive button by its label: Keep comes first in the confirm, on purpose.
    await press(
      Array.from(host!.querySelectorAll<HTMLButtonElement>(".draft-confirm button"))
        .find((b) => (b.textContent ?? "").trim() === "Discard")!,
    );
    expect(discarded, "the stranded row cannot be discarded").toEqual(["u1"]);
  });
});

describe("the shell recovers into a fresh row, never the stranded one", () => {
  /**
   * Structural, the `compose-autosave.test.tsx` idiom: everything above drives the view directly,
   * and a view that works perfectly can still be wired to a shell that re-sends a row the server
   * refuses forever.
   *
   * ── THE RECOVERY DOOR IS GONE, AND ITS ABSENCE IS WHAT IS PINNED ───────────────────────────
   *
   * This used to require the shell to seed a stranded row's TEXT into a FRESH row and remember the
   * stranded one for deletion. Invariant S(2) forbids it: a row past `draft` is never recovered
   * into a fresh key, and the only reachable case was a stranded `sending` row — the row whose send
   * is most likely still in flight. The fresh key such a recovery minted is one the server cannot
   * recognise, so the message could go out twice.
   *
   * `holdOf` calls every non-`draft` status parked, so the branch cannot be entered; it and the
   * `recoverySeed` it armed are removed rather than left as a dead arm a later reader would take
   * for a guarantee.
   */
  it("AppShell adopts only a free row, and the unverified press keeps the row id", async () => {
    const shell = readFileSync(
      resolve(process.cwd(), "apps/webapp/app/shell/shell-compose.ts"), "utf8",
    );
    expect(shell, "the reopen adopts a row without asking whether the message is held")
      .toMatch(/\} else \{[\s\S]{0,900}autosave\.adopt\((?:d|handle)\.id, seeded(?:, (?:d\.contentRevision \?\? null|handle\.revision))?\);/);
    expect(shell, "the recovery seed came back — a row a send may still be delivering is armed "
      + "for deletion again")
      .not.toMatch(/recoverySeed\.current =/);
    /**
     * INVERTED BY RULING. This required the source to SHED the draft id after an unverified send
     * — `draftId: _stranded, ...fresh` — which is the duplicate-delivery path itself: a send with
     * no draft id creates a new draft, the hook mints a new key for it, and server uniqueness is
     * `(account_id, idempotency_key)`, so the second reservation collides with nothing.
     *
     * `unverified` is terminal-UNKNOWN. The send parks, keeps its draft id and keeps its key. The
     * assertion is now that the shedding does not exist.
     */
    expect(
      shell,
      "the compose still sheds its draft id after an unverified send — that mints a fresh key for "
        + "a message that may already have gone",
    ).not.toMatch(/draftId: _stranded/);
  });

  /**
   * ── AND THE RECOVERY DOOR IS NOT FOR A ROW WE ARE STILL WAITING ON ────────────────────────
   *
   * Measured end to end on the release candidate, recipient total 2: a saved draft sent from the
   * drafts list came back unverified, the row stayed listed, and reopening it took the recovery
   * door — a new row minted, the compose session re-minted. Both names the durable record carries
   * were off the message at once, so the park could not recognise it, Send lit up, and one press
   * delivered a second copy under a fresh key.
   *
   * The behaviour is measured in `send-lock-durable.test.tsx` (the record's side, and that a
   * preserved session keeps the reopened message parked). What only the source can say is the
   * DECISION: that the parked question is asked before the status branch, and that the parked
   * arm does none of the four things the other two doors do. Structural for the reason the case
   * above it is — the shell is not mounted here — and specific enough to fail on each one
   * separately.
   *
   * Mutation: `const parked = false;`. Real failure text:
   *   AssertionError: the reopen does not ask whether a record is still unresolved for this row
   */
  it("a row an unresolved send belongs to is reopened as itself, not recovered", async () => {
    const shell = readFileSync(
      resolve(process.cwd(), "apps/webapp/app/shell/shell-compose.ts"), "utf8",
    );
    expect(shell, "the reopen does not ask whether a record is still unresolved for this row")
      .toMatch(/const hold = holdOf\(engine, \{[\s\S]{0,200}\}\);\n\s*const parked = hold\.kind !== "free";/);
    /* THE SERVER'S OWN MARK IS A PARK. The send creates its own row when the press carried none
       and the client never learns that id, so the row in Drafts belongs to a message no record
       here names — and recovering a row the server calls `unverified` is a duplicate by
       definition. */
    /* ONE PREDICATE FOR THE THREE SITES. They were measured disagreeing twice, and each
       disagreement was a second copy: the autosave once decided a message was new two seconds
       after the reopen had decided it was held, created a row and replaced the hold with it. */
    const autosaveSrc = readFileSync(
      resolve(process.cwd(), "apps/webapp/app/shell/compose-autosave.ts"), "utf8",
    );
    const sendSrc = readFileSync(
      resolve(process.cwd(), "apps/webapp/app/shell/mail-send.ts"), "utf8",
    );
    for (const [src, where] of [[autosaveSrc, "the autosave"], [sendSrc, "the send gate"]] as Array<[string, string]>) {
      expect(src, `${where} decides for itself whether a message is held`)
        .toContain("holdOf(");
    }
    /* …and no site reads a ROW's status for itself. Deliberately not a count of the string: it
       also names a send PHASE ("unverified" is a phase of a press in flight), and a census that
       fires on innocent content is the same defect as one that cannot fire, only dearer. */
    for (const [src, where] of [
      [shell, "the shell"], [autosaveSrc, "the autosave"], [sendSrc, "the send gate"],
    ] as Array<[string, string]>) {
      expect(src, `${where} reads a row's status for itself instead of asking the predicate`)
        .not.toMatch(/(?:\.status|rowStatus|row\.status)\s*[!=]==\s*"unverified"/);
    }
    const lock = readFileSync(
      resolve(process.cwd(), "apps/webapp/app/shell/send-lock.ts"), "utf8",
    );
    expect(lock, "the predicate does not read the row's status at all")
      .toMatch(/if \(row\.status !== "draft"\) \{/);
    /* By the SPECIFIER the defence needs, not by the whole list: the shell gained a third import
       from this module when the resolution learned to release its own record, and a pin on the
       exact line would make every future consumer look like a regression of `holdOf`. */
    expect(shell, "the held-message predicate is not imported, so the question cannot be asked")
      .toMatch(/import \{[^}]*\bholdOf\b[^}]*\} from "\.\/send-lock"/);
    /* THE SESSION IS ASKED ABOUT ONLY FOR THE ROW THIS COMPOSE IS HOLDING. Unconditionally, one
       unresolved send would park every draft in the account; never, a record naming a session and
       a row it never got attached to would not be found at all. */
    expect(shell, "the reopen does not link the row being opened to the session holding it")
      .toMatch(/heldRow !== null && heldRow === d\.id \? composeSessionId\(\) : null/);
    /* THE SAME FUNCTION THE RELOAD ASKS. Two call sites that answered this differently is how the
       reload kept minting a second row for a message the reopen had learned to keep parked, so
       the shared name is pinned on both sides rather than the behaviour being described twice. */
    const autosave = readFileSync(
      resolve(process.cwd(), "apps/webapp/app/shell/compose-autosave.ts"), "utf8",
    );
    expect(autosave, "the reload asks a question of its own, which is how the two came to disagree")
      .toMatch(/holdOf\(engine, \{\n\s*lane: COMPOSE_SEND_KEY, draftId: held, session: composeSessionId\(\),\n\s*\}\)/);

    // The parked question is asked BEFORE anything is written to the form.
    const askedAt = shell.indexOf('const parked = hold.kind !== "free";');
    const statusAt = shell.indexOf('if (parked) {', askedAt);
    const seedAt = shell.indexOf("setCompose(seeded);", askedAt);
    expect(askedAt, "the parked question is not asked in openDraft at all").toBeGreaterThan(-1);
    expect(statusAt, "there is no parked door").toBeGreaterThan(askedAt);
    expect(
      seedAt,
      "the form is seeded before the hold is known, so the refusal below cannot come first",
    ).toBeGreaterThan(askedAt);

    // The session is re-minted for every door EXCEPT this one — the whole of the defect.
    expect(shell, "the reopen re-mints the session unconditionally, which is the duplicate itself")
      .toMatch(/if \(!parked\) clearComposeDraft\(\)/);

    /*
     * The parked arm's body, read on its own: it takes no row, releases nothing, arms no delete.
     * Sliced between the parked branch and the `else if`, so an `adopt` or a `release` belonging
     * to another door cannot satisfy it.
     */
    const body = shell.slice(statusAt, shell.indexOf("} else {", statusAt));
    expect(body, "the parked door was not found").toContain("autosave.release();");
    expect(body, "reopening a parked row adopts it — every autosave PUT would answer 409")
      .not.toContain("autosave.adopt(");
    /* AND THE IDENTITY GOES BACK. Recognising the park and then presenting the message under a
       session the record never heard of is the same duplicate reached from a door in between. */
    expect(body, "the parked message is not held by its row — the next pause mints one beside it")
      .toContain('writeComposeRow(hold.kind === "parked" ? hold.draftId ?? d.id : d.id)');
    expect(body, "the record's own session is not restored, so `canSend` compares against a stranger")
      .toContain("writeComposeSession(hold.session)");
    /* AND THE SEND GATE READS THE HELD ROW, not only the jar — the refusal for a row the server
       marked unverified but this browser holds no record of. It is a JSX prop, so it stayed in the
       shell frame when the reopen moved to `shell-compose.ts` (ARCH-022). */
    const frame = readFileSync(
      resolve(process.cwd(), "apps/webapp/app/shell/AppShell.tsx"), "utf8",
    );
    /* The lane's state reaches the projection as THIS message sees it (`composeStateOnScreen`: another
       message's send is not this one's to show), and the held row is still asked about over it. */
    expect(frame, "the compose send state does not consider the row the composer is holding")
      .toMatch(/send=\{heldRowUnverified\(\s*composeStateOnScreen\(mailSend\.stateOf\(COMPOSE_SEND_KEY\), mailSend\.pressHere\(COMPOSE_SEND_KEY\)\),\s*readComposeRow\(\),\s*holdOf\(engine, \{/);
    /* IT DOES RELEASE, AND THAT IS NOT THE RECOVERY DOOR. The recovery door releases and then
       lets the next pause write a FRESH row (`recoverySeed` arms the delete of the stranded one).
       Here the release only drops whatever row the composer was holding for the message being
       left behind — otherwise the parked message's text would PUT into that row — and the very
       next line holds the parked row instead. Release WITHOUT the re-hold is the defect, so the
       two are asserted together and in that order. */
    const releasedAt = body.indexOf("autosave.release()");
    const heldAt = body.indexOf('writeComposeRow(hold.kind === "parked" ? hold.draftId ?? d.id : d.id)');
    expect(releasedAt, "the parked branch stopped releasing the row it arrived holding")
      .toBeGreaterThan(-1);
    expect(heldAt, "the release is not followed by the re-hold, so the row is simply dropped")
      .toBeGreaterThan(releasedAt);
    expect(body, "reopening a parked row arms a delete of the one row that still holds it")
      .not.toContain("draft_discard");
    expect(body, "reopening a parked row re-mints its session")
      .not.toContain("clearComposeDraft()");
  });
});
