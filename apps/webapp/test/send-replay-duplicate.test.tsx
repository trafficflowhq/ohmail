/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MutationRejectedError, OhmailEngine, MemoryMirrorStore,
  type EngineMutation, type MirrorStore,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { AUTOSAVE_DELAY_MS } from "@ohmail/app-logic/writing/compose-autosave";
import type { ComposeFields } from "@ohmail/app-logic/writing/compose";
import { storageOwner } from "@ohmail/app-logic/storage/storage-owner";
/** No send is owed an ending in these jar-only cases — the shape every deletion had before keys could be owed. */
const NONE_OWED = (): boolean => false;

/**
 * ═══ THE RESTORED SEND'S RESULT IS DROPPED, AND THAT IS A SECOND DELIVERY ════════════════════
 *
 * ── THE TRACE, VERBATIM FROM THE REVIEW ─────────────────────────────────────────────────────
 *
 * Press Send BEFORE the first autosave, so the mutation carries no row and the ADAPTER will make
 * one. Lose the response — the verb is queued in the durable outbox under `send-key-1`. Reload.
 * The boot replay dispatches the restored entry, the server delivers it and answers `sent` with
 * the row it made... and `replayOutboxInner` keeps only `{ timedOut, held }` and DISCARDS that
 * result. Nobody is told. The queue empties, so the create gate opens, and two seconds later the
 * autosave writes a SECOND row for the message still sitting in the composer.
 *
 * Then the person edits it — they have no reason to think it went out — and the edit is what turns
 * a stale draft into a second delivery: the fingerprint no longer matches the record, so
 * `resumeSendLock` drops `send-key-1` as a mismatch, and Send goes out under a FRESH key. Two
 * copies at the recipient, and the product's one guarantee is broken.
 *
 * ── WHAT THIS FILE ASSERTS ──────────────────────────────────────────────────────────────────
 *
 * The two numbers a person would count: how many sends reached the server, and what the account
 * holds afterwards. Both are RED at this commit and are written down as they are measured, so the
 * fix is judged against the trace rather than against a description of it.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const NOW = new Date("2026-09-08T09:00:00.000Z");
let root: Root | null = null;
let host: HTMLDivElement | null = null;

/**
 * THE SERVER, modelling the half this trace turns on: a send that carries no row makes one, and a
 * lost response leaves the verb queued rather than failed.
 */
interface Wire {
  /** One entry per `mail_send` that REACHED the server, with the key it carried. */
  attempts: Array<{ key: string; body: string }>;
  /** One entry per mail that actually LEFT — a replayed key adds nothing. */
  deliveries: Array<{ key: string; body: string }>;
  /** The account's `drafts` table, as the server would hold it. */
  rows: Array<{ id: string; status: string; body: string }>;
  /** While true, every request answers retryably: the response is lost, the verb stays queued. */
  loseResponse: boolean;
  /**
   * How long the server takes to answer a send, in ms. Zero for every case but the one that needs
   * the composer's own timer to fire FIRST — a slow boot is what puts the create gate on its own.
   */
  slowMs: number;
  /**
   * While true, a send answers TERMINAL-UNKNOWN — `send_unverified`, the answer the route gives
   * when SMTP threw and the Sent probe found nothing.
   *
   * RESERVED FIRST, and that is what makes the state ambiguous rather than failed: the key is
   * spent on the server whether or not the mail went out, so a retry under it can only ever be
   * replayed. The row is marked, and the refusal names it — which is the only way a press that
   * carried no row can learn which draft the message it is waiting on became.
   */
  unverify: boolean;
  /**
   * While true, a send is REFUSED FOR GOOD — a typed 409 the mailbox will answer the same way to
   * every retry, `retryable: false`, naming no row.
   *
   * NOTHING IS RESERVED AND NOTHING LEFT, which is what separates it from `unverify`: the key is
   * spent on an answer everybody can see, so there is no ambiguity for a record to outlive. It is
   * the production shape of the ending the adoption pass had no arm for — the engine abandons the
   * restored entry and hands the answer back `rolled_back`.
   */
  refuse: boolean;
  /**
   * THE ACCOUNT'S ROW-ID COUNTER, on the wire rather than in `engineOver`'s closure.
   *
   * A per-engine counter re-mints `d1` on the second mount, so a row this account already holds is
   * silently overwritten and every reader keyed to it names the wrong message — a harness that
   * cannot stage two messages across a reload. Row ids are unique for the life of the account, as
   * a server's are.
   */
  minted: number;
}

function wire(): Wire {
  return {
    attempts: [], deliveries: [], rows: [], loseResponse: false, slowMs: 0, unverify: false,
    refuse: false, minted: 0,
  };
}

function engineOver(store: MirrorStore, w: Wire, deadlineMs?: number): OhmailEngine {
  const reserved = new Set<string>();
  return new OhmailEngine({
    store,
    now: () => NOW,
    /* THE TEST SEAM for the dispatch deadline. A live press whose server is slower than this has
       its result recorded as a LATE one — the state HIGH #3 is about, and it cannot be staged at
       the production deadline inside a case's own timeout. */
    ...(deadlineMs !== undefined ? { outboxReplayDeadlineMs: deadlineMs } : {}),
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: "1", hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m: EngineMutation, opts: { idempotencyKey: string }) => {
        if (m.kind === "draft_save") {
          if (w.loseResponse) {
            throw new MutationRejectedError("connection reset", { code: "network", retryable: true });
          }
          const body = String((m as { body?: string }).body ?? "");
          const id = (m as { draftId?: string | null }).draftId ?? `d${++w.minted}`;
          const at = w.rows.find((r) => r.id === id);
          if (at) at.body = body;
          else w.rows.push({ id, status: "draft", body });
          return { changes: [], seq: null, entityId: id };
        }
        if (m.kind !== "mail_send") return { changes: [], seq: null };
        const body = String((m as { body?: string }).body ?? "");
        w.attempts.push({ key: opts.idempotencyKey, body });
        if (w.slowMs > 0) await new Promise((r) => setTimeout(r, w.slowMs));
        if (w.loseResponse) {
          // THE RESPONSE IS LOST, NOT REFUSED: the verb is queued with its key preserved, which
          // is the state the reload comes back to.
          throw new MutationRejectedError("connection reset", { code: "network", retryable: true });
        }
        if (w.refuse) {
          /* REFUSED FOR GOOD, and the shape is the production one: a typed refusal, `retryable:
             false`, no `entityId`. The attempt above is recorded — the request DID reach the
             server — and nothing is reserved and nothing delivered. */
          throw new MutationRejectedError("This mailbox cannot send right now.", {
            status: 409, code: "mailbox_disabled", retryable: false,
          });
        }
        // A KEY ALREADY RESERVED IS REPLAYED, NEVER RE-SENT — `SendService.resumeExisting`.
        if (reserved.has(opts.idempotencyKey)) return { changes: [], seq: null };
        reserved.add(opts.idempotencyKey);
        if (w.unverify) {
          /* NOBODY KNOWS. The row exists and is marked, the key is spent, and the answer names
             the row — everything except whether the mail left. */
          const carriedU = (m as { draftId?: string | null }).draftId ?? null;
          const idU = carriedU ?? `d${++w.minted}`;
          const atU = w.rows.find((r) => r.id === idU);
          if (atU) atU.status = "unverified";
          else w.rows.push({ id: idU, status: "unverified", body });
          throw new MutationRejectedError(
            "We could not confirm this send. Check your Sent folder before retrying.",
            { status: 200, code: "send_unverified", retryable: false, entityId: idU },
          );
        }
        /* THE ADAPTER MAKES THE ROW when the press carried none — the case this trace is about. */
        const carried = (m as { draftId?: string | null }).draftId ?? null;
        const id = carried ?? `d${++w.minted}`;
        const at = w.rows.find((r) => r.id === id);
        if (at) { at.status = "sent"; at.body = body; }
        else w.rows.push({ id, status: "sent", body });
        w.deliveries.push({ key: opts.idempotencyKey, body });
        return { changes: [], seq: null, entityId: id, providerMessageId: `<${id}@x>` };
      },
      fetchBody: async () => null,
    } as never,
  });
}

type Mut = Record<string, unknown>;
const compose = (body: string): Mut => ({
  kind: "mail_send", inReplyTo: null, body, subject: "Bis Montag",
  to: [{ name: null, address: "lena@atelier.example" }], mailboxId: "mb",
});
const EMPTY_FIELDS: ComposeFields = ({
  to: "", cc: "", bcc: "", subject: "", body: "", html: "", fromMailboxId: "mb", sig: null,
} as never);
const fieldsFor = (body: string): ComposeFields => ({
  to: "lena@atelier.example, ", cc: "", bcc: "", subject: "Bis Montag",
  body, html: "", fromMailboxId: "mb", sig: null,
} as never);

interface Surface {
  /**
   * EDIT THE TEXT THAT IS ON SCREEN — a REPLACE inside the current body, never a fixed string and
   * never an append.
   *
   * The distinction is the whole test. The trace is "the person edits the still-visible text";
   * you cannot edit text that is not on screen, so on an empty composer this changes nothing and
   * there is nothing to press Send on. A harness that typed a fixed body — or appended to an
   * empty one — would write a NEW message after the fix cleared the composer, press Send on it,
   * and read that message's perfectly correct delivery as the duplicate it was looking for. Both
   * shapes were tried and both lied in that direction.
   */
  edit: (from: string, to: string) => Promise<void>;
  /** Press Send on WHAT IS IN THE COMPOSER, the way the shell builds the mutation from the form. */
  press: () => Promise<void>;
  /**
   * START SOMETHING ELSE ON THIS LANE, the way a contact's Write or a mail link does: the scratch
   * buffer is replaced and the compose SESSION is re-minted. Both halves matter — a session is
   * what tells a new message apart from an edited one, and an edit is not this.
   */
  newMessage: (body: string) => Promise<void>;
  /**
   * IS THIS COMPOSE HELD FOR A SEND THAT IS STILL OUT THERE — the latch the shell renders as a
   * read-only form with a sentence. Read through the hook, not through a flag this file keeps, so
   * a case cannot pass by agreeing with itself.
   */
  locked: () => boolean;
  /**
   * WHAT THE COMPOSER SAYS about this lane's send — the phase the strip's sentence is chosen by.
   * Read through the hook, like `locked`, so a case cannot pass by agreeing with itself.
   */
  phase: () => string;
  body: () => string;
  draftId: () => string | null;
}

/**
 * THE COMPOSE SURFACE, both halves over ONE engine — the send lane and the autosave that writes
 * its rows. Neither alone can show this trace: the send is what leaves the outbox entry behind and
 * the autosave is what mints the second row after the drain.
 */
async function surface(engine: OhmailEngine, body: string): Promise<Surface> {
  const {
    useMailSend, SEND_IN_FLIGHT_PHASES, sendPendingInOutbox,
  } = await import("@ohmail/app-logic/writing/mail-send");
  const { useMailSendText } = await import("../app/shell/mail-send-text.js");
  const { useComposeAutosave } = await import("@ohmail/app-logic/writing/compose-autosave");
  const {
    clearComposeDraft, composeSessionId, writeComposeDraft,
  } = await import("@ohmail/app-logic/writing/compose");
  /* THE SCRATCH BUFFER, WHICH THE SHELL WRITES ON EVERY KEYSTROKE (`AppShell.onComposeFields`)
     and which this harness did not model at all — measured, and it made the hold impossible to
     see: the identity a restored mount latches on IS that buffer, so a harness without one had a
     composer with no message in it and every hold read as OFF. Written BEFORE the mount, because
     that is the order a reload happens in: `localStorage` is already on disk when React starts. */
  writeComposeDraft(fieldsFor(body), storageOwner());
  let api!: Surface;
  let setFields!: (f: ComposeFields) => void;
  const Probe = (): null => {
    const [fields, setF] = React.useState<ComposeFields>(fieldsFor(body));
    setFields = setF;
    /* THE SHELL'S OWN WIRING, modelled: `AppShell.onSendSettled` hands a settled compose send to
       the autosave hook's `settleCompose`, which is invariant T's one ending. A harness that
       passed a no-op here would measure a fix that cannot reach the compose. */
    /* The shell's seam carries the settlement's own verdict beside the row — see
       `ComposeFate.aboutThisCompose`. */
    const settleRef = React.useRef<(rowId: string | null, about: boolean) => void>(() => {});
    const mail = useMailSend(
      engine as never,
      storageOwner(),
      (() => { /* the sentences are another file's subject */ }) as never,
      useMailSendText(), ((key: string, m: { draftId?: string | null }, about: boolean) => {
        if (key === "compose") settleRef.current(m.draftId ?? null, about);
      }) as never,
    );
    const autosave = useComposeAutosave({
      engine: engine as never, fields, mailboxId: "mb", active: true,
      /* The shell's own gate, modelled: the phases, the outbox, and the record for a send this
         mount did not issue — the third is the only one that can see the replay window. */
      sendInFlight: SEND_IN_FLIGHT_PHASES.has(mail.stateOf("compose").phase)
        || sendPendingInOutbox(engine as never, "compose")
        || mail.restoredPending("compose"),
      /* `AppShell.onCleared` sets EMPTY_COMPOSE — the WHOLE form, not just the body. Clearing
         only the body left the subject standing, `worthCreating` still said yes, and the pause
         wrote a row for a message with no words in it. */
      onCleared: () => { setF(EMPTY_FIELDS); },
      scope: storageOwner(),
    });
    settleRef.current = (rowId, about) => {
      autosave.settleCompose({ kind: "sentByMirror", rowId, aboutThisCompose: about });
    };
    api = {
      edit: async (from: string, to: string) => {
        await act(async () => {
          setF((f) => {
            const next = { ...f, body: f.body.replace(from, to) };
            // The shell's own pairing: the form state and the scratch buffer move together.
            writeComposeDraft(next, storageOwner());
            return next;
          });
        });
      },
      press: async () => {
        await act(async () => {
          (mail.send as unknown as (m: Mut) => void)({
            kind: "mail_send", inReplyTo: null, body: fields.body, subject: fields.subject,
            to: [{ name: null, address: "lena@atelier.example" }], mailboxId: "mb",
            ...(autosave.draftId ? { draftId: autosave.draftId } : {}),
          });
        });
      },
      body: () => fields.body,
      draftId: () => autosave.draftId,
      locked: () => mail.restoredPending("compose"),
      phase: () => mail.stateOf("compose").phase,
      newMessage: async (next: string) => {
        await act(async () => {
          clearComposeDraft(storageOwner());          // takes the scratch draft AND the session with it
          const f = fieldsFor(next);
          writeComposeDraft(f, storageOwner());         // which mints a NEW session on the next read
          setF(f);
        });
      },
    };
    return null;
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe),
    }));
  });
  return {
    edit: (f, t) => api.edit(f, t),
    press: () => api.press(),
    body: () => api.body(),
    draftId: () => api.draftId(),
    locked: () => api.locked(),
    phase: () => api.phase(),
    newMessage: (b: string) => api.newMessage(b),
  };
}

async function killTab(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllTimers();
  vi.setSystemTime(NOW);
}

/**
 * REACH INTO THE DURABLE RECORD, to stage the two shapes a fresh press cannot produce: a record
 * from the SHIPPED PREVIOUS BUILD (no `bfp`) and one older than the age limit. Both are states a
 * real browser arrives in — an upgrade with a send still waiting, and a tab shut for a week — and
 * neither can be written by pressing Send with this build.
 */
async function editJar(fn: (rows: Array<Record<string, unknown>>) => void): Promise<void> {
  const { sendLocksKey } = await import("@ohmail/app-logic/writing/send-lock");
  const raw = window.localStorage.getItem(sendLocksKey(storageOwner()));
  const rows = JSON.parse(raw ?? "[]") as Array<Record<string, unknown>>;
  expect(rows.length, "the jar is empty, so this case is staging nothing").toBeGreaterThan(0);
  fn(rows);
  window.localStorage.setItem(sendLocksKey(storageOwner()), JSON.stringify(rows));
}

/** Cross the task boundary the press defers over, and let the queue's own timers run. */
const drain = async (): Promise<void> => {
  for (let i = 0; i < 24; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1); });
};
/** Run the autosave debounce out. */
const pause = async (): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 200); });
  await drain();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  window.localStorage.clear();
});
afterEach(async () => {
  await killTab();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("a send whose result the replay discarded", () => {
  it("the reviewer's trace: reload, drain, EDIT, press — and the message goes out twice", async () => {
    const w = wire();
    /* ONE store for both mounts: the outbox is what survives a reload, and a second store would
       make the replay unreachable — a harness that cannot see the thing it is about. */
    const store = new MemoryMirrorStore();
    await store.load();

    // ── THE PRESS, BEFORE THE FIRST AUTOSAVE, WHOSE RESPONSE IS LOST ────────────────────────
    w.loseResponse = true;
    const first = engineOver(store, w);
    const s1 = await surface(first, "Kommst du noch?");
    await act(async () => { await first.start(); });
    await s1.press();
    await drain();
    expect(s1.draftId(), "the press must carry no row — that is the whole shape").toBeNull();
    expect(w.attempts, "the send never reached the wire").toHaveLength(1);
    const firstKey = w.attempts[0]!.key;

    await killTab();

    // ── THE RELOAD: the outbox is restored and the replay delivers under the ORIGINAL key ────
    w.loseResponse = false;
    const second = engineOver(store, w);
    const s2 = await surface(second, "Kommst du noch?");
    await act(async () => { await second.start(); });
    await drain();
    expect(
      w.deliveries.map((d) => d.key),
      "the boot replay did not deliver the queued send, so this trace has not started",
    ).toEqual([firstKey]);

    // ── THE DRAIN OPENS THE CREATE GATE, AND THE PAUSE MINTS A SECOND ROW ───────────────────
    await pause();

    // ── THE EDIT: the person has no reason to think it went out ─────────────────────────────
    /* Appended to WHAT IS THERE. Once the settle has cleared the composer there is nothing of
       this message left to edit, and that is the property the fix has to produce — asserted
       directly, because it is what makes the press below harmless. */
    await s2.edit("Kommst du noch?", "Kommst du noch? Bis 18 Uhr.");
    await pause();
    /* THE PROPERTY THAT MAKES THE PRESS BELOW HARMLESS, asserted rather than implied: with the
       composer cleared there is nothing of this message left to edit or to send. */
    expect(
      s2.body(),
      "the delivered message is still in the composer, so the edit below turns it into a second "
      + "one — a fingerprint the record cannot match, and a fresh key",
    ).toBe("");

    // ── AND THE PRESS ───────────────────────────────────────────────────────────────────────
    await s2.press();
    await drain();

    expect(
      w.deliveries.length,
      "the same message reached the recipient twice — the edit changed the fingerprint, the "
      + "record's key was dropped as a mismatch, and Send went out under a fresh one",
    ).toBe(1);
    expect(
      w.attempts.map((a) => a.key).filter((k, i, xs) => xs.indexOf(k) === i).length,
      "a second Idempotency-Key reached the server for one message",
    ).toBe(1);
    expect(
      w.rows.map((r) => `${r.id}:${r.status}`).sort(),
      "the account holds a second draft for a message that has already been sent",
    ).toEqual(["d1:sent"]);
  });

  it("a SLOW replay: the composer's own timer fires first, and the gate is what stops the row", async () => {
    /**
     * ── THE CASE THAT TELLS THE TWO HALVES APART ──────────────────────────────────────────────
     *
     * With a fast server the settle lands before the autosave's two seconds are up, so the empty
     * composer is what refuses the create and the gate is never asked — a mutation of the gate
     * stays green, which measures the PAIR and not the part. Slow the boot down (a real shape: the
     * replay is the first request of a session, over whatever network the machine woke up on) and
     * the order reverses. The composer still holds the text, the queue is empty because the
     * replayed entry left it before dispatch, and the only thing standing between the timer and a
     * second row is the record saying a send of this message is still owed an answer.
     *
     * Mutation: neuter `sendUnsettledFromLastSession`. Red here; green in every other case in this
     * file, which is exactly why this one exists.
     */
    const w = wire();
    const store = new MemoryMirrorStore();
    await store.load();

    w.loseResponse = true;
    const first = engineOver(store, w);
    const s1 = await surface(first, "Kommst du noch?");
    await act(async () => { await first.start(); });
    await s1.press();
    await drain();
    await killTab();

    w.loseResponse = false;
    w.slowMs = AUTOSAVE_DELAY_MS * 3;          // the answer arrives well after the debounce
    const second = engineOver(store, w);
    const s2 = await surface(second, "Kommst du noch?");
    await act(async () => { void second.start(); });
    await drain();
    /* THE COMPOSER'S TIMER, while the send is still out there. */
    await pause();
    expect(
      w.rows.filter((r) => r.status === "draft"),
      "the pause wrote a row for a message whose send is still owed an answer — the queue is "
      + "empty because the replayed entry left it before dispatch, so nothing else was looking",
    ).toEqual([]);

    /* AND THE ANSWER, WHEN IT COMES, ends the compose the way a live confirmation would. */
    await act(async () => { await vi.advanceTimersByTimeAsync(w.slowMs + 200); });
    await drain();
    expect(s2.body(), "the delivered message is still in the composer").toBe("");
    expect(
      w.rows.map((r) => `${r.id}:${r.status}`).sort(),
      "the account holds more than the one row this message was sent from",
    ).toEqual(["d1:sent"]);
  });

  it("THE TAIL: an edit DURING the replay cannot mint a second key", async () => {
    /*
     * ── THE LAST DELIVERY ROUTE, AND IT IS REACHABLE IN SECONDS ──────────────────────────────
     *
     * Everything above closes the case where nobody touches the composer. This is the case where
     * somebody does, and it is the ordinary one: come back, see the message still sitting there,
     * change a word, press Send.
     *
     * The replay carries the ORIGINAL key. The edit changes the message, so the durable record no
     * longer matches it and the press mints a FRESH key. The server has nothing left to collapse
     * them by — `outbound_sends UNIQUE (account_id, idempotency_key)` sees two different keys —
     * and the recipient gets the original and the edited copy. Nothing anywhere says it happened.
     *
     * It also defeats the settle: the discriminator that keeps a DIFFERENT message from being
     * wiped reads the edited buffer as a different message and correctly leaves it alone, so the
     * composer is never cleared either. The two halves are right and the sequence still delivers
     * twice, which is why this needs a latch rather than another comparison.
     *
     * THE FIX IS TO MAKE THE EDIT IMPOSSIBLE, not to judge it afterwards: while a send of THIS
     * message is still out there the compose is held — read-only, Send refused — so the buffer
     * cannot move away from what the record names, and the settle clears it by construction.
     */
    const w = wire();
    const store = new MemoryMirrorStore();
    await store.load();

    w.loseResponse = true;
    const first = engineOver(store, w);
    const s1 = await surface(first, "Kommst du noch?");
    await act(async () => { await first.start(); });
    await s1.press();
    await drain();
    expect(w.attempts, "the send never reached the wire, so this case measures nothing")
      .toHaveLength(1);
    const firstKey = w.attempts[0]!.key;

    await killTab();

    /* THE RELOAD. `slowMs` holds the replay open so the edit lands INSIDE its window — with an
       instant server the drain is over before anyone could type, which is the harness measuring
       its own speed rather than the sequence. */
    w.loseResponse = false;
    w.slowMs = 40;
    const second = engineOver(store, w);
    const s2 = await surface(second, "Kommst du noch?");
    await act(async () => { void second.start(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    // ── THE EDIT, THEN THE PRESS — the whole sequence, in the order a person does it ─────────
    await s2.edit("Kommst du noch?", "Kommst du noch? Bis 18 Uhr.");
    await s2.press();
    await act(async () => { await vi.advanceTimersByTimeAsync(w.slowMs + 50); });
    await drain();
    await pause();

    expect(
      [...new Set(w.attempts.map((a) => a.key))],
      "a SECOND Idempotency-Key reached the server for a message already on its way — the server "
      + "cannot collapse two keys, so both reservations stand",
    ).toEqual([firstKey]);
    expect(
      w.deliveries.map((d) => d.body),
      "the recipient received the message twice: the original from the replay and the edited copy "
      + "from the press",
    ).toEqual(["Kommst du noch?"]);
  });

  it("a held compose whose send comes back UNVERIFIED ends PARKED, not editable-idle", async () => {
    /*
     * The hold is for a send whose answer has not arrived. `unverified` IS an answer — the worst
     * one: the key is spent on the server and nobody knows whether the mail left. The message must
     * not go back to being an ordinary editable compose, and it must not stay under this hold's
     * sentence either, because "still being sent" would be false. It parks by its record, which is
     * the state that says what is true and refuses the press for the reason that is true.
     *
     * Two ways to get this wrong and both were live options: yielding to the park too early (the
     * hold never applies) and never yielding (the reader is told the message is on its way for as
     * long as the record lives). The assertion is on the HOLD alone; the park is `holdOf`'s and is
     * driven in the census file.
     */
    const w = wire();
    const store = new MemoryMirrorStore();
    await store.load();

    w.loseResponse = true;
    const first = engineOver(store, w);
    const s1 = await surface(first, "Kommst du noch?");
    await act(async () => { await first.start(); });
    await s1.press();
    await drain();
    await killTab();

    w.loseResponse = false;
    w.unverify = true;
    w.slowMs = 40;
    const second = engineOver(store, w);
    const s2 = await surface(second, "Kommst du noch?");
    expect(s2.locked(), "the restored compose is not held while the answer is still out").toBe(true);
    await act(async () => { void second.start(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(w.slowMs + 100); });
    await drain();
    await pause();

    expect(
      s2.locked(),
      "the compose is still held under \"still being sent\" for a send that came back unverified — "
      + "which is not what happened, and the state that IS true (parked, check your Sent folder) "
      + "cannot be shown while this one stands",
    ).toBe(false);
  });

  it("an OLDER unverified send on the lane does not unlock the RESTORED one", async () => {
    /*
     * ── THE HOLD IS FOR A MESSAGE, AND ARM 1 GAVE IT AWAY FOR A LANE ──────────────────────────
     *
     * `unverified` yields to the park, and it may yield only for the message the park is about.
     * The lane is `"compose"` — the name of every message this browser will ever write — so ANY
     * unverified record on it switched the restored hold off: send A and get terminal-unknown back
     * (its record stays, by design), write B, press before the first autosave, lose the response,
     * reload. B's verb replays under its own key while the composer holds B's text, A's record
     * suppresses B's hold, an edit changes B's fingerprint, and the press mints a fresh key for
     * mail already on its way.
     *
     * Both endings are asserted. B goes out ONCE, and A is still parked by its own record — the
     * positive control, without which "hold everything" would satisfy this case.
     */
    const w = wire();
    const store = new MemoryMirrorStore();
    await store.load();

    // ── SEND A, and the answer is terminal-unknown: its record stays behind, by design ───────
    w.unverify = true;
    const first = engineOver(store, w);
    const sA = await surface(first, "Kommst du noch?");
    await act(async () => { await first.start(); });
    await sA.press();
    await drain();
    expect(sA.phase(), "A's send did not come back unverified, so this case stages nothing")
      .toBe("unverified");
    const rowA = w.rows.find((r) => r.status === "unverified")?.id ?? null;
    expect(rowA, "the unverified answer named no row, so A's park has nothing to hold by")
      .not.toBeNull();

    // ── WRITE B ON THE SAME LANE, press before the first autosave, and lose the response ────
    w.unverify = false;
    w.loseResponse = true;
    await sA.newMessage("Wann kommt der Ofen?");
    await sA.press();
    await drain();
    expect(
      w.attempts.map((a) => a.body),
      "B's press did not reach the wire, so there is no replay for the reload to carry",
    ).toEqual(["Kommst du noch?", "Wann kommt der Ofen?"]);

    await killTab();

    // ── THE RELOAD: B replays under its own key while the composer holds B's text ────────────
    w.loseResponse = false;
    const second = engineOver(store, w);
    const sB = await surface(second, "Wann kommt der Ofen?");
    expect(
      sB.locked(),
      "A's older unverified record switched B's hold off — B's fields are editable while its own "
      + "send is still replaying, and the next press mints a second key for it",
    ).toBe(true);

    await act(async () => { void second.start(); });
    await drain();
    await pause();

    // ── AND THE EDIT AND PRESS THE ROW'S TRACE ENDS ON ──────────────────────────────────────
    await sB.edit("Wann kommt der Ofen?", "Wann kommt der Ofen? Bis Freitag?");
    await pause();
    await sB.press();
    await drain();

    expect(
      w.deliveries.filter((d) => d.body.startsWith("Wann kommt der Ofen")).length,
      "B reached the recipient twice — the edit changed its fingerprint, its own key was dropped "
      + "as a mismatch, and Send went out under a fresh one",
    ).toBe(1);

    // ── THE POSITIVE CONTROL: A IS STILL PARKED, BY ITS OWN RECORD ──────────────────────────
    const { parkedComposeRecord, unresolvedSendRows } =
      await import("@ohmail/app-logic/writing/send-lock");
    expect(
      [...unresolvedSendRows("compose", storageOwner())],
      "A's record stopped naming its row, so the message nobody knows the fate of is unparked",
    ).toEqual([rowA]);
    expect(
      parkedComposeRecord("compose", rowA, null, storageOwner()),
      "A no longer parks by its own record — the older message lost the sentence that is true "
      + "about it, which is what arm 1 yields for",
    ).not.toBeNull();
  });

  it("a restored send REFUSED for good releases the hold — the composer is not left inert for a week", async () => {
    /*
     * ── THE ENDING THE ADOPTION PASS HAD NO ARM FOR ───────────────────────────────────────────
     *
     * `confirmed` settles the compose and `unverified` parks it. Every OTHER settled answer —
     * `send_failed`, or a typed 409 such as `mailbox_disabled` — fell out of the collector's loop
     * with the record left standing, and the record IS the hold: `restoredPending` reads it for
     * the whole seven days it lives, and the shell renders that as every field, Send AND Cancel
     * disabled under "still being sent from your last session". For a send that is over and did
     * not go. No edit, no second try, no discard, and a reload does not help — the record is
     * durable, which is the point of it.
     *
     * A refusal is TERMINAL by the adapter's contract: the key is spent and nothing was
     * delivered. An answer that might have delivered is `send_unverified`, which is the case above
     * and is the one outcome the record must outlive. So this record has nothing left to protect,
     * and the ending has to be the live press's ending — release, and say what happened.
     */
    const w = wire();
    const store = new MemoryMirrorStore();
    await store.load();

    w.loseResponse = true;
    const first = engineOver(store, w);
    const s1 = await surface(first, "Kommst du noch?");
    await act(async () => { await first.start(); });
    await s1.press();
    await drain();
    expect(w.attempts, "the send never reached the wire, so this case measures nothing")
      .toHaveLength(1);
    await killTab();

    /* THE RELOAD, INTO A MAILBOX THAT WILL NOT SEND. The replay carries the original key and is
       refused for good. */
    w.loseResponse = false;
    w.refuse = true;
    const second = engineOver(store, w);
    const s2 = await surface(second, "Kommst du noch?");
    expect(s2.locked(), "the restored compose is not held, so this case starts from the wrong state")
      .toBe(true);
    await act(async () => { await second.start(); });
    await drain();
    await pause();

    expect(
      w.attempts.map((a) => a.key).filter((k, i, xs) => xs.indexOf(k) === i),
      "the boot replay did not re-dispatch the restored send under its own key, so nothing was "
      + "refused and this case measures nothing",
    ).toHaveLength(1);
    expect(w.deliveries, "the refused send delivered anyway — the fixture is not a refusal")
      .toEqual([]);

    expect(
      s2.locked(),
      "the send was refused for good — the key is spent and nothing went out — and the composer "
      + "is still held under \"still being sent from your last session\": the fields, Send AND "
      + "Cancel are inert for the record's seven days, so the message can neither be sent, "
      + "edited nor thrown away",
    ).toBe(false);
    expect(
      s2.phase(),
      "the hold came off and the composer says nothing about a message the person pressed Send "
      + "on — the live path's own refusal sentence is what belongs here",
    ).toBe("failed");
  });

  it("and the RECORD is gone with it, so no later mount can put the hold back", async () => {
    /*
     * The assertion above is a read through the hook; this one is the durable fact under it. A
     * hold that is merely not shown by THIS mount comes back on the next one — the record is what
     * survives a reload, and it is the thing that has to go.
     */
    const w = wire();
    const store = new MemoryMirrorStore();
    await store.load();

    w.loseResponse = true;
    const first = engineOver(store, w);
    const s1 = await surface(first, "Kommst du noch?");
    await act(async () => { await first.start(); });
    await s1.press();
    await drain();
    await killTab();

    w.loseResponse = false;
    w.refuse = true;
    const second = engineOver(store, w);
    await surface(second, "Kommst du noch?");
    await act(async () => { await second.start(); });
    await drain();
    await pause();

    const { allSendLocks } = await import("@ohmail/app-logic/writing/send-lock");
    expect(
      allSendLocks(Date.now(), NONE_OWED, storageOwner()).filter((r) => r.lane === "compose"),
      "the jar still holds a claim for a send that was refused for good, so every later mount "
      + "reads the composer as held and the next press cannot reuse the key either",
    ).toHaveLength(0);
  });

  it("the latch is ON for a restored compose and OFF when nothing is out there", async () => {
    /*
     * The two ends of the latch, because a hold that is always on is a composer nobody can use and
     * a hold that is never on is this file's premise coming back. The ON case reads the state the
     * shell renders as a read-only form; the OFF case is an ordinary first compose.
     */
    const w = wire();
    const store = new MemoryMirrorStore();
    await store.load();

    // OFF: nothing has been sent, nothing is restored.
    const cold = engineOver(store, w);
    const s0 = await surface(cold, "Kommst du noch?");
    await act(async () => { await cold.start(); });
    expect(s0.locked(), "a first compose is held for a send nobody has made").toBe(false);

    // ON: the press whose answer was lost, then the reload.
    w.loseResponse = true;
    await s0.press();
    await drain();
    await killTab();

    w.loseResponse = false;
    w.slowMs = 40;
    const second = engineOver(store, w);
    const s2 = await surface(second, "Kommst du noch?");
    expect(
      s2.locked(),
      "the restored compose is not held, so the text a send is still carrying stays editable — "
      + "and an edit there is a second key",
    ).toBe(true);
    await act(async () => { void second.start(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(w.slowMs + 50); });
    await drain();
    await pause();
    expect(
      s2.locked(),
      "the hold outlived the send it was held for — the composer is stuck",
    ).toBe(false);
  });

  it("a LIVE press whose confirmation arrives LATE clears the compose — it is not left wedged", async () => {
    /*
     * ── THE COLLECTOR MUST NOT EAT WHAT IT WILL NOT USE ──────────────────────────────────────
     *
     * `flushPending()` is DESTRUCTIVE: whatever it hands back is gone from the engine. The
     * adoption pass pulls it and then skips any key this mount is already tracking, on the
     * reasoning that such a key is `flush`'s business — but the result has already been consumed
     * by then, and `flush` will never see it. Nothing is left anywhere: no pending mutation, no
     * late result, no answer.
     *
     * The compose stays `queued` for the rest of the session. Fields disabled, Cancel disabled,
     * Send refused — for a message that WAS DELIVERED. There is no way out but a reload, and a
     * reload is where the second key comes from.
     *
     * Staged with a dispatch deadline shorter than the server: the press's own promise gives up
     * first, so the answer is recorded as a late one while this mount is still very much alive.
     * That is the only difference from the ordinary path, and it is not exotic — it is a slow
     * network on a live tab.
     */
    const w = wire();
    const store = new MemoryMirrorStore();
    await store.load();

    w.slowMs = 200;
    const engine = engineOver(store, w, 20);   // the answer will be LATE, this mount still live
    const s1 = await surface(engine, "Kommst du noch?");
    await act(async () => { await engine.start(); });
    await s1.press();
    await drain();
    // The answer comes back after the press gave up waiting for it.
    await act(async () => { await vi.advanceTimersByTimeAsync(w.slowMs + 200); });
    await drain();
    await pause();

    expect(
      w.deliveries.map((d) => d.body),
      "the send did not go out, so this case measures nothing",
    ).toEqual(["Kommst du noch?"]);
    expect(
      s1.body(),
      "the message was DELIVERED and the composer still holds it — the surface never heard, so "
      + "every field and Cancel stay disabled with no way out but a reload, and a reload is where "
      + "the second Idempotency-Key comes from",
    ).toBe("");
  });

  it("a NEW message started DURING the replay is not held once the drain is over", async () => {
    /*
     * The hold is for the message a send is carrying. Start something else while that send is
     * still out — a contact's Write, a mail link — and the hold must not follow the composer onto
     * it: a latch that outlives the message it was taken for is a Send button that does nothing,
     * for a message nobody has sent, until the tab is reloaded.
     *
     * A NEW MESSAGE IS NOT AN EDIT, and the session is what tells them apart. An edit keeps the
     * compose session (the hold must survive it — that is the whole point of the latch); starting
     * something else re-mints it. So the latch is keyed on the session it was taken under, and
     * nothing about the buffer's content, which is what keeps an edit from lifting it.
     */
    const w = wire();
    const store = new MemoryMirrorStore();
    await store.load();

    w.loseResponse = true;
    const first = engineOver(store, w);
    const s1 = await surface(first, "Kommst du noch?");
    await act(async () => { await first.start(); });
    await s1.press();
    await drain();
    await killTab();

    w.loseResponse = false;
    w.slowMs = 60;
    const second = engineOver(store, w);
    const s2 = await surface(second, "Kommst du noch?");
    expect(s2.locked(), "the restored compose is not held, so this case starts from the wrong state")
      .toBe(true);
    await act(async () => { void second.start(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    // The person starts something else while the first send is still going out.
    await s2.newMessage("Wann kommt der Ofen?");
    expect(
      s2.locked(),
      "the hold followed the composer onto a message it was never taken for",
    ).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(w.slowMs + 200); });
    await drain();
    const before = w.attempts.length;
    await s2.press();
    await drain();
    await pause();

    expect(
      w.attempts.length - before,
      "Send did nothing for a message nobody had sent — the hold outlived the message it was "
      + "taken for, and only a reload would clear it",
    ).toBe(1);
    expect(
      w.attempts[w.attempts.length - 1]!.body,
      "the request that went out was not the new message",
    ).toBe("Wann kommt der Ofen?");
  });

  it("a record from the SHIPPED PREVIOUS BUILD holds while its send is pending, then lets go", async () => {
    /*
     * ── THE UPGRADE WINDOW, AND IT FAILS CLOSED ──────────────────────────────────────────────
     *
     * The hold compares the message on screen against what the press wrote down. A record written
     * by the build before this one carries no such value: `bfp` did not exist, so there is nothing
     * to compare and no way to ask whether the text in the composer is the message that send is
     * carrying. Install the new build with a send still waiting to go out and that old record is
     * all there is.
     *
     * With no evidence, the answer is to WAIT, not to guess: while that lane's replay is pending
     * everything on the lane is held, and the hold lapses when the outbox drains. Deliberately too
     * strict — a genuinely different message is held too — and that is the trade, stated: seconds
     * of waiting during an upgrade against a second copy in somebody's inbox.
     */
    const w = wire();
    const store = new MemoryMirrorStore();
    await store.load();

    w.loseResponse = true;
    const first = engineOver(store, w);
    const s1 = await surface(first, "Kommst du noch?");
    await act(async () => { await first.start(); });
    await s1.press();
    await drain();
    const firstKey = w.attempts[0]!.key;
    await killTab();

    /* THE UPGRADE: the record is exactly what the previous build wrote — everything but `bfp`. */
    await editJar((rows) => { for (const r of rows) delete r.bfp; });

    w.loseResponse = false;
    w.slowMs = 60;
    const second = engineOver(store, w);
    const s2 = await surface(second, "Kommst du noch?");
    expect(
      s2.locked(),
      "a record this build cannot compare against left the composer editable while its send was "
      + "still going out — an edit there is a second Idempotency-Key",
    ).toBe(true);
    await act(async () => { void second.start(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await s2.edit("Kommst du noch?", "Kommst du noch? Bis 18 Uhr.");
    await s2.press();
    await act(async () => { await vi.advanceTimersByTimeAsync(w.slowMs + 200); });
    await drain();
    await pause();

    expect(
      [...new Set(w.attempts.map((a) => a.key))],
      "a second Idempotency-Key reached the server through the upgrade window",
    ).toEqual([firstKey]);

    /* AND IT LETS GO. The hold is the outbox's, so the drain ends it — a different message
       started afterwards sends normally, with a key of its own. */
    await s2.newMessage("Wann kommt der Ofen?");
    const before = w.attempts.length;
    await s2.press();
    await drain();
    expect(
      w.attempts.length - before,
      "the upgrade hold outlived the send it was taken for, so nothing can be sent at all",
    ).toBe(1);
    expect(w.attempts[w.attempts.length - 1]!.key, "the new message reused the dead key")
      .not.toBe(firstKey);
  });

  it("a record older than the age limit is still LIVE while its send sits in the outbox", async () => {
    /*
     * ── THE OUTBOX ENDS THE RECORD, NOT THE CLOCK ────────────────────────────────────────────
     *
     * The record expires after seven days. The durable outbox does not expire at all — an entry
     * survives every reload until the server answers. Leave a tab shut for a week with a send
     * still waiting and the two disagree: the replay carries the mail out under its original key
     * while the record naming that key has just been pruned. The composer still holds the text,
     * nothing recognises it, and the next press mints a fresh key. The same mail arrives twice, a
     * week apart.
     *
     * There is a second edge in the same place: the read that answers this question PERSISTS its
     * own filtered list, so an unexempted read deletes the record before anybody can consult it.
     * Exempting the lane spares it from the pruning as well as from the limit.
     */
    const w = wire();
    const store = new MemoryMirrorStore();
    await store.load();

    w.loseResponse = true;
    const first = engineOver(store, w);
    const s1 = await surface(first, "Kommst du noch?");
    await act(async () => { await first.start(); });
    await s1.press();
    await drain();
    const firstKey = w.attempts[0]!.key;
    await killTab();

    /* EIGHT DAYS LATER. The clock does not move — the record is aged instead, which is the same
       fact and keeps every other timer in this file honest. */
    const EIGHT_DAYS = 8 * 24 * 60 * 60 * 1000;
    await editJar((rows) => {
      for (const r of rows) r.at = (r.at as number) - EIGHT_DAYS;
    });

    w.loseResponse = false;
    w.slowMs = 60;
    const second = engineOver(store, w);
    const s2 = await surface(second, "Kommst du noch?");
    expect(
      s2.locked(),
      "the record aged out while its send was still in the outbox, so the composer came up "
      + "editable holding a message nothing could recognise any more",
    ).toBe(true);
    await act(async () => { void second.start(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await s2.edit("Kommst du noch?", "Kommst du noch? Bis 18 Uhr.");
    await s2.press();
    await act(async () => { await vi.advanceTimersByTimeAsync(w.slowMs + 200); });
    await drain();
    await pause();

    expect(
      [...new Set(w.attempts.map((a) => a.key))],
      "a week-old record let a second Idempotency-Key through",
    ).toEqual([firstKey]);
    expect(
      s2.locked(),
      "the hold outlived the settle — the exemption is the outbox's and must lapse with it",
    ).toBe(false);
  });

  it("a DIFFERENT message started on the lane while the replay was out is LEFT ALONE", async () => {
    /*
     * THE ANSWER IS FOR A MESSAGE, NOT FOR A LANE — the arm that keeps the fix from costing text.
     *
     * `settleCompose`'s `sentByMirror` arm empties the form unconditionally. On the live path that
     * is right: the surface being cleared is the one that pressed. The adoption pass has no such
     * guarantee. A contact's Write, or a mail link, re-mints the compose session and puts a
     * DIFFERENT message on the same lane while the earlier send is still out there — and the
     * replay's answer would then wipe words nobody has sent. The person cannot undo that and
     * cannot see what caused it.
     *
     * Driven rather than argued, because the whole trace above exists to make the settle REACH the
     * compose, and a fix that reaches the wrong one is worse than the defect it closed.
     */
    const w = wire();
    const store = new MemoryMirrorStore();
    await store.load();
    const { composeSessionKey } = await import("@ohmail/app-logic/writing/compose");

    w.loseResponse = true;
    const first = engineOver(store, w);
    const s1 = await surface(first, "Kommst du noch?");
    await act(async () => { await first.start(); });
    await s1.press();
    await drain();
    expect(w.attempts, "the send never reached the wire, so this case measures nothing")
      .toHaveLength(1);
    const firstKey = w.attempts[0]!.key;

    await killTab();

    /* THE RE-MINT. `composeSessionId` names the message-in-progress and is minted beside the
       scratch draft, so a door that starts something else writes a new name here — which is
       exactly the state this line puts the jar in. */
    window.localStorage.setItem(composeSessionKey(storageOwner()), "a-different-compose");

    w.loseResponse = false;
    const second = engineOver(store, w);
    const s2 = await surface(second, "Wann kommt der Ofen?");
    await act(async () => { await second.start(); });
    await drain();

    expect(
      w.deliveries.map((d) => d.key),
      "the boot replay did not deliver, so nothing was settled and this case measures nothing",
    ).toEqual([firstKey]);
    expect(
      s2.body(),
      "the replay's answer cleared a compose it does not name — the words on screen belonged to a "
      + "message nobody had sent, and they are gone",
    ).toBe("Wann kommt der Ofen?");
  });

  it("EDIT AND PRESS while the replay is still out there — a LONG replay, and still one key", async () => {
    /**
     * ── THIS CASE WAS A MEASUREMENT AND IS NOW A GUARD, WHICH IS WHY IT READS LIKE ONE ───────
     *
     * It was written to RECORD the residual: with both settle-side halves in, the composer still
     * held the message, an edit changed the fingerprint, `resumeSendLock` dropped the stored key
     * as spent, and the press minted a fresh one. Its own message said what to do the day the
     * number moved — "if this is 1 the residual is fixed and this case should become the guard it
     * is currently only a record of" — and the identity-keyed latch moved it. So it asserts 1.
     *
     * TWO EARLIER CLOSURES WERE BUILT AND BACKED OUT, and the difference is worth keeping: both
     * were keyed on the LANE — refuse every press while an inherited send is unsettled, and refuse
     * one whose fingerprint does not match. Both turn "a DIFFERENT message written after the crash
     * gets a key of its own" red in the durable lock's own file, because a lane is the name of
     * every message this browser will ever write. The latch is keyed on WHICH MESSAGE, so a
     * different one never arms it and is never refused.
     *
     * It is kept beside the tail case rather than folded into it because the timing differs: this
     * one holds the replay open for THREE autosave debounces, so the composer's own timer, the
     * edit and the press all land well inside the window rather than beside its edge.
     */
    const w = wire();
    const store = new MemoryMirrorStore();
    await store.load();

    w.loseResponse = true;
    const first = engineOver(store, w);
    const s1 = await surface(first, "Kommst du noch?");
    await act(async () => { await first.start(); });
    await s1.press();
    await drain();
    await killTab();

    w.loseResponse = false;
    w.slowMs = AUTOSAVE_DELAY_MS * 3;
    const second = engineOver(store, w);
    const s2 = await surface(second, "Kommst du noch?");
    await act(async () => { void second.start(); });
    await drain();
    /* INSIDE THE WINDOW: the answer has not come back yet. */
    await s2.edit("Kommst du noch?", "Kommst du noch? Bis 18 Uhr.");
    await s2.press();
    await drain();
    await act(async () => { await vi.advanceTimersByTimeAsync(w.slowMs + 400); });
    await drain();

    expect(
      [...new Set(w.attempts.map((a) => a.key))].length,
      "a SECOND Idempotency-Key reached the server. The server collapses two presses only under "
      + "ONE key — `outbound_sends UNIQUE (account_id, idempotency_key)` — so two keys is two "
      + "reservations and a second copy at the recipient whenever the later one settles",
    ).toBe(1);
    expect(
      w.deliveries.map((d) => d.body),
      "the recipient received the message twice",
    ).toEqual(["Kommst du noch?"]);
  });

  it("the pre-lock variant: the edit is typed before the drain, and the settle still clears", async () => {
    /*
     * The same trace with the edit landing BEFORE the replay drains — the window a read-only lock
     * alone cannot close, because the text has already moved by the time the lock could be shown.
     * The settle has to clear on the RESULT, which carries the row.
     */
    const w = wire();
    const store = new MemoryMirrorStore();
    await store.load();

    w.loseResponse = true;
    const first = engineOver(store, w);
    const s1 = await surface(first, "Kommst du noch?");
    await act(async () => { await first.start(); });
    await s1.press();
    await drain();
    const firstKey = w.attempts[0]!.key;
    await killTab();

    w.loseResponse = false;
    const second = engineOver(store, w);
    const s2 = await surface(second, "Kommst du noch?");
    /* THE EDIT FIRST, then the boot replay — the window a read-only lock cannot close. */
    await s2.edit("Kommst du noch?", "Kommst du noch? Bis 18 Uhr.");
    await act(async () => { await second.start(); });
    await drain();
    await pause();
    await s2.press();
    await drain();

    expect(
      w.deliveries.map((d) => d.key),
      "the message went out twice: once under the replayed key and once under a fresh one",
    ).toEqual([firstKey]);
    expect(
      w.rows.map((r) => `${r.id}:${r.status}`).sort(),
      "the account holds a second draft for a message that has already been sent",
    ).toEqual(["d1:sent"]);
  });
});
