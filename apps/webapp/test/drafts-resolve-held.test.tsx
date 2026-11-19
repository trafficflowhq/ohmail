/** @vitest-environment jsdom */
import type { EngineDraft } from "@ohmail/wire";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { DraftsView } from "../app/views/DraftsView";
import {
  SEND_LOCK_FORMAT,
  claimSendLock,
  holdOf,
  markSendLockUnverified,
  releaseSendLockForRow,
  sendLocksKey,
  type HoldMirror,
} from "@ohmail/app-logic/writing/send-lock";
/** No send is owed an ending in these jar-only cases — the shape every deletion had before keys could be owed. */
const NONE_OWED = (): boolean => false;

/**
 * ═══ A HELD SEND HAS A WAY OUT, AND A HELD REPLY TAKES THE SAME ONE ══════════════════════
 *
 * ── THE LOSS THIS CLOSES ─────────────────────────────────────────────────────────────────
 *
 * `drafts-unverified.test.tsx` next door pins that the row SAYS what is and is not known. It
 * says it by asking a question — *"check your Sent folder"* — and there was nowhere to put the
 * answer. So the row was a dead end in the strongest sense: Discard was refused by the client
 * before the wire and by the server after it, and nothing in the product could ever move the
 * status that caused both refusals. Pressed five times on a live account, the row stayed five
 * times, and would have stayed for ever.
 *
 * Two verbs are the answer, and they are the only two things a reader is in a position to
 * know: they looked in the folder we sent them to, and the message is either there or it is
 * not.
 *
 * ── AND THE REPLY ARM, WHICH IS WHY THE SAME ROW HAD A SEND BUTTON ───────────────────────
 *
 * `openDraft` computed its hold BELOW the reply arm, so a held draft whose parent message is
 * in the mirror never reached the check: it opened in the inline reply editor with Send live,
 * and `replySeedDrafts` marked it for discard on the next confirmed reply. The one row that
 * must not be re-sent was the one row that opened ready to re-send it — a second copy of a
 * message that may already have been delivered. The row that found this in the field IS a
 * reply, which is exactly how it went unnoticed while the Drafts-list door was correct.
 *
 * The fix hoists the existing `holdOf` read above that arm, so the hold is a property of
 * OPENING THE ROW rather than of which surface opens it. Pinned structurally here, the way
 * `drafts-unverified.test.tsx` pins the shell's recovery wiring, because the arm is inside a
 * component thousands of lines long that no test mounts whole.
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
let resolved: string[] = [];
let sentAgain: string[] = [];
let discarded: string[] = [];

async function mountDrafts(drafts: EngineDraft[]): Promise<void> {
  resolved = [];
  sentAgain = [];
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
          onOpen: () => {},
          onDiscard: (id: string) => { discarded.push(id); },
          onResolve: (id: string, outcome: "arrived" | "not_arrived") => {
            resolved.push(`${id}:${outcome}`);
          },
          onCancelSchedule: () => {},
          onEditScheduled: () => {},
          onSendAgain: (d) => { sentAgain.push(d.id); },
          repliesHere: () => false,
        }),
      }),
    );
  });
}

const q = <T extends Element>(sel: string): T | null => host!.querySelector<T>(sel);
const qa = (sel: string): Element[] => Array.from(host!.querySelectorAll(sel));
const press = async (el: HTMLElement): Promise<void> => { await act(async () => { el.click(); }); };

/** The verb whose label matches, from the held row's own group. */
function verb(rowId: string, label: string): HTMLElement {
  const found = Array.from(
    host!.querySelectorAll<HTMLElement>(`.draft-row[data-id="${rowId}"] .draft-resolve button`),
  ).find((b) => (b.textContent ?? "").trim() === label);
  if (!found) throw new Error(`no verb labelled "${label}" on row ${rowId}`);
  return found;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

describe("a held row offers the two answers a reader can actually give", () => {
  /**
   * Mutation: drop the `d.status === "unverified"` block from `DraftsView`. Real failure text:
   *   Error: no verb labelled "It was sent — dismiss" on row u1
   */
  it("an unverified row carries both verbs; an ordinary draft carries none", async () => {
    await mountDrafts([
      draft({ id: "u1", status: "unverified" }),
      draft({ id: "p1", updatedAt: "2026-08-07T13:00:00.000Z" }),
    ]);

    expect(
      q('.draft-row[data-id="u1"] .draft-resolve'),
      "a held row offers no way to answer the question its own note asks — the state that made "
      + "the row permanent is unreachable from the surface again",
    ).not.toBeNull();
    expect(
      q('.draft-row[data-id="p1"] .draft-resolve'),
      "an ordinary draft is asked whether it arrived, which is a question about a send that was "
      + "never attempted",
    ).toBeNull();

    // Both acts, by their labels, so a single-verb regression cannot pass.
    expect(verb("u1", "It was sent — dismiss")).toBeDefined();
    expect(verb("u1", "Send again")).toBeDefined();
  });

  /**
   * Mutation: wire "Send again" to `onResolve(id, "arrived")` in `DraftsView`. Real failure text:
   *   AssertionError: pressing "Send again" answered for the send instead of handing the row to
   *   the shell … expected [ 'u1:arrived' ] to deeply equal []
   */
  it("each act dispatches its OWN thing for its own row", async () => {
    await mountDrafts([draft({ id: "u1", status: "unverified" })]);

    await press(verb("u1", "Send again"));
    expect(sentAgain, '"Send again" did not hand the row to the shell').toEqual(["u1"]);
    expect(
      resolved,
      'pressing "Send again" answered for the send instead of handing the row to the shell — the '
      + "shell answers `not_arrived` and opens the message; the view decides nothing",
    ).toEqual([]);

    await press(verb("u1", "It was sent — dismiss"));
    expect(resolved).toEqual(["u1:arrived"]);
  });

  /**
   * THE POSITIVE CONTROL FOR THE SURFACE. Every other case here is about a held row; this one
   * is the ordinary draft, and it is what fails if the held treatment ever leaks onto rows that
   * have no send behind them.
   */
  it("an ordinary draft still discards in two presses, with no resolution asked", async () => {
    await mountDrafts([draft({ id: "p1" })]);

    await press(q<HTMLElement>('.draft-row[data-id="p1"] .draft-discard')!);
    await press(
      Array.from(host!.querySelectorAll<HTMLElement>(".draft-confirm .gate-actions button"))
        .find((b) => (b.textContent ?? "").trim() === "Discard")!,
    );

    expect(discarded, "the ordinary discard stopped working").toEqual(["p1"]);
    expect(resolved, "an ordinary discard asked the server to resolve a send").toEqual([]);
  });

  /**
   * ── AND THE ROW THAT NEVER GOT AN ANSWER AT ALL ─────────────────────────────────────────
   *
   * `draftsList` lists a `sending` row once it is past every invocation's lifetime: the send died
   * mid-flight and nothing will ever say how it ended. The row carried its own note and NO verbs,
   * on the reading that `resolve` moved an `unverified` reservation and nothing else — so the one
   * row in the list whose state is stranded by construction was the one with no way out of it.
   * Both halves are asserted: the state is NAMED, and the same two verbs are under it.
   *
   * Mutation: narrow `DraftsView`'s block back to `d.status === "unverified"`. Real failure text:
   *   Error: no verb labelled "It was sent — dismiss" on row s1
   */
  it("a stranded `sending` row names its state and carries both verbs", async () => {
    await mountDrafts([
      draft({ id: "s1", status: "sending" }),
      draft({ id: "p1", updatedAt: "2026-08-07T13:00:00.000Z" }),
    ]);

    expect(
      q('.draft-row[data-id="s1"] .draft-state')?.textContent,
      "the interrupted row stopped saying what happened to it",
    ).toContain("the send was interrupted");
    expect(
      q('.draft-row[data-id="s1"] .draft-resolve'),
      "a row whose send died mid-flight offers no way to answer for it — it can be neither "
      + "re-sent nor discarded, which is a state with no exit",
    ).not.toBeNull();
    expect(verb("s1", "It was sent — dismiss")).toBeDefined();
    expect(verb("s1", "Send again")).toBeDefined();
    expect(
      q('.draft-row[data-id="p1"] .draft-resolve'),
      "an ordinary draft is asked whether it arrived",
    ).toBeNull();
  });

  it("the stranded row's verbs carry its own id and outcome", async () => {
    await mountDrafts([draft({ id: "s1", status: "sending" })]);

    await press(verb("s1", "Send again"));
    expect(sentAgain, "the interrupted row's act is misrouted").toEqual(["s1"]);
    await press(verb("s1", "It was sent — dismiss"));
    expect(resolved).toEqual(["s1:arrived"]);
  });

  /** The held row keeps its Discard trigger — the verbs are added beside it, not instead. */
  it("the held row still carries its own Discard trigger", async () => {
    await mountDrafts([draft({ id: "u1", status: "unverified" })]);
    expect(
      q('.draft-row[data-id="u1"] .draft-discard'),
      "the held row lost its Discard, so answering the question leaves nothing to press",
    ).not.toBeNull();
  });
});

describe("the shell asks about the hold BEFORE it opens a reply", () => {
  // Its four cases over the shell's composition moved to `drafts-resolve-held-shell.test.ts`.

  /**
   * ONE component on EVERY door, so the words and the outcomes cannot fall apart.
   *
   * Three doors show a held message: the Drafts row, the message's own reply editor, and the
   * composer. The Drafts row had the answers; the other two stated the hold and offered nothing,
   * so the only exit from either was to leave for a third screen.
   */
  it("all three doors render the same resolution component", () => {
    const read = (rel: string): string =>
      readFileSync(resolve(process.cwd(), rel), "utf8");
    for (const f of [
      "apps/webapp/app/views/DraftsView.tsx",
      "apps/webapp/app/shell/InlineReply.tsx",
      "apps/webapp/app/views/ComposeView.tsx",
    ]) {
      expect(
        read(f),
        `${f} renders its own copy of the held-send verbs — two sets of words, and one of them `
        + "falls behind",
      ).toMatch(/<HeldSendResolve\s/);
    }
  });
});

/**
 * ═══ AND THE JAR THE SERVER'S ANSWER LEAVES BEHIND ════════════════════════════════════════
 *
 * The resolution is two halves and only one of them was built. The server frees the row; this
 * browser's durable record goes on saying the message may already be out there, and `holdOf` asks
 * the RECORD first — so the row a person had just answered for was still parked here: Discard
 * refused before the wire, the composer still held, on a row the account calls an ordinary draft.
 *
 * It leaves by the door the settled compose already uses ({@link releaseSendLockForRow}) and by no
 * other — a second release path is how the two readings of "this record is spent" drift apart.
 * And exactly ONCE: the second case below is the damage an unlatched repeat does.
 */
const OWNER = "acct-resolve";

/** The mirror, as narrow as `holdOf` needs it. */
const mirrorOf = (status: string): HoldMirror => ({
  read: () => ({ get: <T = unknown, >(): T | undefined => ({ status } as unknown as T) }),
});

function parkRecord(draftId: string, fp: string): void {
  claimSendLock({
    v: SEND_LOCK_FORMAT, lane: "compose", key: `idem-${fp}`, at: Date.now(),
    draftId, subject: `draft:${draftId}`, fp,
  }, NONE_OWED, OWNER);
  markSendLockUnverified("compose", fp, OWNER);
}

const held = (draftId: string, status = "draft"): string =>
  holdOf(mirrorOf(status), { lane: "compose", draftId, session: null }, OWNER).kind;

describe("the server's answer spends this browser's record too", () => {
  afterEach(() => { window.localStorage.removeItem(sendLocksKey(OWNER)); });

  /**
   * Mutation: drop the `releaseSendLockForRow` call from `resolveHeldSend`. This case is what
   * that call is FOR, driven against the real jar rather than the shell.
   */
  it("the record holds the row until it is released, and the one door releases it", () => {
    parkRecord("d1", "fp-1");
    expect(
      held("d1"),
      "the durable record does not park the row at all, so this case is measuring nothing",
    ).toBe("parked");

    releaseSendLockForRow("compose", "d1", null, NONE_OWED, OWNER);

    expect(
      held("d1"),
      "the record still parks a row the server has just made an ordinary draft — Discard is "
      + "refused before the wire and the composer still holds it, on a row nothing holds",
    ).toBe("free");
  });

  /**
   * THE LATCH'S REASON, measured. A second confirm for this row arriving late is not harmless:
   * by then the recovered text may have been sent again, and that send's record is named by the
   * SAME row. Releasing it frees a key a request is still carrying, and the next press mints a
   * second one — a duplicate delivery reached through the verb that exists to prevent one.
   */
  it("a SECOND release destroys the record a later send of the same row minted", () => {
    parkRecord("d1", "fp-1");
    releaseSendLockForRow("compose", "d1", null, NONE_OWED, OWNER);

    // The person answered "it didn't arrive", edited nothing, and pressed Send again.
    parkRecord("d1", "fp-2");
    expect(held("d1"), "the retry's own record never parked the row").toBe("parked");

    releaseSendLockForRow("compose", "d1", null, NONE_OWED, OWNER);

    expect(
      held("d1"),
      "a repeated release freed the RETRY's key — this is the damage the latch in "
      + "`resolveHeldSend` exists to prevent, and it is real",
    ).toBe("free");
  });

  // "the shell releases through the one door, once, and only on a confirmed answer" moved to
  // `drafts-resolve-held-shell.test.ts`.
});
