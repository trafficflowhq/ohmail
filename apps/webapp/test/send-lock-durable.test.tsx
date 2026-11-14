/** @vitest-environment jsdom */
import type { EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MutationRejectedError,
  OhmailEngine,
  MemoryMirrorStore,
  type MirrorStore,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { sendLocksKey, sendFingerprint } from "@ohmail/app-logic/writing/send-lock";
import { canSend, SENT_BEAT_MS, type SendState } from "@ohmail/app-logic/writing/mail-send";
import type { MailSend } from "@ohmail/app-logic/writing/compose";
import { storageOwner } from "@ohmail/app-logic/storage/storage-owner";
/** No send is owed an ending in these jar-only cases — the shape every deletion had before keys could be owed. */
const NONE_OWED = (): boolean => false;
/** The record's own send is still unsettled — the one state a record resumes in. */
const OWED = (key: string) => (k: string): boolean => k === key;

/**
 * ONE PRESS IS ONE DELIVERY, ACROSS A RELOAD — the send lock's kill test.
 *
 * ## THE DEFECT
 *
 * `queued`, `inFlight` and `locked` are all `useRef`, and the file's
 * own comment records why `locked` had to leave React state: two presses in one tick each minted an
 * Idempotency-Key and each delivered. **The same argument applies one level up and was not made
 * there.** A ref does not survive a reload either. Reload inside the queued window and the durable
 * outbox replays the send under its original key (correct), while the restored composer — the
 * scratch draft is in `localStorage` and is cleared only when the UI observes a confirmation —
 * comes up `idle`. The next press minted a SECOND key, and a second key is a different key:
 * `idempotency_keys` cannot replay it and `outbound_sends UNIQUE (account_id, idempotency_key)`
 * cannot collapse it. The same mail is delivered twice to a real person — the one outcome in this
 * application that cannot be rolled back.
 *
 * ## THE HARNESS IS A SERVER, NOT A SPY
 *
 * The adapter models the half of `SendService` this is actually about: a key it has already
 * delivered under is REPLAYED, never re-sent (`resumeExisting`), and a key whose attempt failed
 * reserves nothing. `deliveries` therefore counts real mail leaving, not requests made — which is
 * the number the invariant is about and the only one worth asserting.
 *
 * ## THE FAILURE THIS FIX COULD HAVE OPENED, AND THE CASE THAT SHOWS IT DID NOT
 *
 * A lock bound to the LANE alone would be bound to `"compose"` plus a null draft id — the identity
 * of every compose this browser will ever write. Crash between the mint and the terminal outcome,
 * write a NEW message, press Send, and the stale key is resumed: the server replays the FIRST
 * send's result, the editor reads `confirmed`, clears the scratch, says "Sent." — and the new
 * message was never sent. **A silently unsent mail is worse than the duplicate.** The third case
 * drives exactly that sequence and asserts the second message goes out under a key of its own.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-10T12:00:00.000Z");

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** The server's own key ledger: what has been delivered, under which key. */
interface Wire {
  /** Every `mail_send` request, in order, with the key it carried. */
  attempts: Array<{ key: string; body: string }>;
  /** The mutation each request carried, as the server saw it — see the fingerprint case. */
  sent: Array<Record<string, unknown>>;
  /** One entry per mail that actually LEFT — a replayed key adds nothing. */
  deliveries: Array<{ key: string; body: string }>;
  /** Presses the server's content claim refused as a second copy within the hour (`duplicate_send`). */
  duplicates: Array<{ key: string; body: string }>;
  /** While true, every send request fails retryably and reserves nothing. */
  fail: boolean;
  /**
   * While true, every send request answers TERMINAL-UNKNOWN — `send_unverified`, the answer the
   * send route gives when SMTP threw and the Sent probe found nothing. Nobody knows whether the
   * mail left, which is why the reservation is recorded here: a delivery may have happened.
   */
  unverify: boolean;
  /**
   * The row the SERVER marked, handed back on the refusal — `MutationRejectedError.entityId`.
   *
   * The adapter creates a row for a press that carried none and sends THAT; the server marks it,
   * and until the refusal named it the client had no way to know which row in its Drafts list the
   * message it is waiting on belongs to. `null` models a server (or a press) that named none.
   */
  unverifiedRow: string | null;
}

function wire(): Wire {
  return {
    attempts: [], deliveries: [], duplicates: [], sent: [], fail: false, unverify: false, unverifiedRow: null,
  };
}

function engineOver(store: MirrorStore, w: Wire): OhmailEngine {
  const reserved = new Set<string>();
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      /**
       * TWO PARENTS IN THE MIRROR, because a reply's optimistic effect needs the message it
       * answers — an empty mirror rejects every reply with `not_found` before the send path is
       * reached, which is a green harness measuring nothing. Delivered once, on the first sync.
       */
      sync: async () => ({
        changes: {
          // Delivered on EVERY sync rather than gated on the cursor: applying the same create
          // twice is an upsert, and a cursor guard that guessed the store's empty value wrong is
          // how this harness sat green with an empty mirror.
          creates: [
            { type: "message", id: "giulia", op: "create", seq: 1, updatedAt: ISO, entity: parent("giulia") },
            { type: "message", id: "petra", op: "create", seq: 2, updatedAt: ISO, entity: parent("petra") },
          ],
          updates: [], moves: [], deletes: [],
        },
        cursor: "2", hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m: EngineMutation, opts: { idempotencyKey: string }) => {
        if (m.kind !== "mail_send") return { changes: [], seq: null };
        const body = String((m as { body?: string }).body ?? "");
        w.attempts.push({ key: opts.idempotencyKey, body });
        w.sent.push(m as unknown as Record<string, unknown>);
        // A KEY ALREADY RESERVED IS REPLAYED, NEVER RE-SENT — `SendService.resumeExisting`.
        if (reserved.has(opts.idempotencyKey)) return { changes: [], seq: null };
        if (w.fail) {
          throw new MutationRejectedError("network failure: connection reset", {
            code: "network", retryable: true,
          });
        }
        if (w.unverify) {
          // RESERVED FIRST, and that is what makes the state ambiguous rather than failed: the
          // key is spent on the server whether or not the mail went out, so a retry under it can
          // only ever be replayed. This is the shape the route answers with, not a bare failure.
          reserved.add(opts.idempotencyKey);
          throw new MutationRejectedError(
            "We could not confirm this send. Check your Sent folder before retrying.",
            {
              status: 200, code: "send_unverified", retryable: false,
              // THE ROW THE SERVER MARKED, which is the only way a press that carried none can
              // ever learn it — see `http-adapter.ts`'s `unverified` arm.
              entityId: w.unverifiedRow,
            },
          );
        }
        // THE SERVER'S CONTENT CLAIM (`SEND_DUPLICATE_WINDOW_MS`): the same words and files under a
        // new key within the hour are refused, naming the first send — the collapse the SERVER owns.
        const content = JSON.stringify([body, (m as { attachments?: unknown }).attachments ?? null]);
        if (w.deliveries.some((d) => JSON.stringify([d.body, (w.sent.find((x) => x.body === d.body) as { attachments?: unknown } | undefined)?.attachments ?? null]) === content)) {
          w.duplicates.push({ key: opts.idempotencyKey, body });
          throw new MutationRejectedError("This message was already sent; nothing was sent now.", {
            status: 409, code: "duplicate_send", retryable: false, details: { firstSend: { status: "sent", at: ISO } },
          });
        }
        reserved.add(opts.idempotencyKey);
        w.deliveries.push({ key: opts.idempotencyKey, body });
        return { changes: [], seq: null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({
        text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  });
}

const ISO = NOW.toISOString();
/** A message a reply can answer. The mirror is otherwise empty in this harness. */
const parent = (id: string): Record<string, unknown> => ({
  id, accountId: "acct-1", mailboxId: "mb", threadId: null, messageIdHeader: null,
  subject: "Hallo", from: { name: "Lena", address: "lena@atelier.example" },
  to: [], cc: [], date: ISO, folder: "INBOX", snippet: "hello", unread: true,
  hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [],
  remoteContent: "none", updatedAt: ISO,
});

type Mut = Record<string, unknown>;
const compose = (body: string): Mut => ({
  kind: "mail_send", inReplyTo: null, body, subject: "Hallo",
  to: [{ name: null, address: "lena@atelier.example" }], mailboxId: "mb",
});
/**
 * THE SAME MESSAGE CARRYING ONE FILE. `contentBase64` is the only thing a caller varies, so a
 * pair built from this differs in the file's CONTENT and in nothing else — the filename, the type
 * and the length are fixed here rather than at the call sites, where they could drift apart and
 * turn a content case into a name case.
 */
const withFile = (m: Mut, contentBase64: string): Mut => ({
  ...m,
  attachments: [{ filename: "glaze.jpg", contentType: "image/jpeg", contentBase64 }],
});
/** A reply, whose lane AND subject are the parent message — `sendKeyOf` / `sendSubject`. */
const reply = (parent: string, body: string, over: Mut = {}): Mut => ({
  kind: "mail_send", inReplyTo: parent, body, subject: "Re: Hallo",
  to: [{ name: null, address: "lena@atelier.example" }], mailboxId: "mb", ...over,
});

interface Probe {
  send: (m: Mut) => void;
  /** What the compose surface reads to decide whether Send is pressable — `AppShell` passes it. */
  stateOf: (key: string) => SendState;
}

async function probe(engine: OhmailEngine): Promise<Probe> {
  // STARTED, so the mirror holds the messages a reply answers. Without this the store is empty and
  // every reply is rejected as `not_found` before the send path is reached — a harness that cannot
  // see the thing it was extended to test.
  await act(async () => { await engine.start(); });
  const { useMailSend } = await import("@ohmail/app-logic/writing/mail-send");
  // The send machine's words as the mail ground hands them (today's shell words leave with today's shell).
  const { useMailSendText } = await import("./_write-1-send-text.js");
  let send!: (m: Mut) => void;
  let stateOf!: (key: string) => SendState;
  const Probe = (): null => {
    const api = useMailSend(
      engine as never,
      storageOwner(),
      (() => { /* the sentences are another file's subject */ }) as never,
      useMailSendText(), (() => { /* nor is the surface's close */ }) as never,
    );
    send = api.send as unknown as (m: Mut) => void;
    stateOf = api.stateOf;
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
  return { send: (m) => send(m), stateOf: (k) => stateOf(k) };
}

/** THE KILL: the editor and its event loop are gone; the mirror and the jar are not. */
async function killTab(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllTimers();
  // `vi.clearAllTimers()` resets the fake clock to REAL time — see the same note in
  // `screener-decision-durable.test.tsx`, where it cost an hour before it was measured.
  vi.setSystemTime(NOW);
}

const drain = async (): Promise<void> => {
  // A PRESS NOW CROSSES A TASK BOUNDARY, so the drain has to as well. `useMailSend.send`
  // acknowledges on screen and defers `engine.mutate` to a later task (`afterPaint`), which a
  // microtask-only drain can never reach: microtasks drain before the task ends. Flushing a
  // zero-delay timer per round is what makes this helper able to observe the send it started.
  // ADVANCED, not awaited: this suite runs on FAKE timers (`vi.useFakeTimers()` below), so a
  // real `setTimeout` promise would never settle and the drain would sit until the case's own
  // deadline — which looks exactly like a hang in the code under test.
  for (let i = 0; i < 10; i++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  }
};

/**
 * Run out the CLOSING BEAT a settled send holds its state for (`SENT_BEAT_MS`).
 *
 * The lane is locked for the whole beat — `canSend` refuses `sent`, because a press inside it
 * would mint a second key for a message that has already gone — so a case that presses Send
 * twice has to let the first one finish closing. Separate from `drain` on purpose: a case that
 * wants to observe the delivered state BEFORE the surface closes needs the drain without this.
 */
const beat = async (): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(SENT_BEAT_MS + 1); });
};

async function store(): Promise<MirrorStore> {
  const s = new MemoryMirrorStore();
  await s.load();
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  window.localStorage.clear();
});

afterEach(async () => {
  await killTab();
  vi.useRealTimers();
});

describe("the send lock outlives the component that held it", () => {
  it("a reload inside the queued window cannot deliver the same mail twice", async () => {
    const w = wire();
    const st = await store();

    // 1 — the send goes out, the transport drops it: `queued`, the verb persisted under key K.
    w.fail = true;
    const { send: send1 } = await probe(engineOver(st, w));
    await act(async () => { send1(compose("Donnerstag passt.")); });
    await drain();
    expect(w.attempts, "the first press never reached the wire").toHaveLength(1);
    expect(w.deliveries, "a failed attempt must reserve nothing").toHaveLength(0);
    const firstKey = w.attempts[0]!.key;
    expect(window.localStorage.getItem(sendLocksKey(storageOwner())), "the key was not persisted with the lane")
      .toContain(firstKey);

    // 2 — the tab dies inside the window.
    await killTab();

    // 3 — the restart. The network is back; the composer still holds the message, because the
    //     scratch draft is cleared only by a confirmation the dead session never saw.
    w.fail = false;
    const { send: send2 } = await probe(engineOver(st, w));
    await act(async () => { send2(compose("Donnerstag passt.")); });
    await drain();

    expect(
      w.deliveries.map((d) => d.body),
      "the same message was delivered more than once",
    ).toEqual(["Donnerstag passt."]);
    // A key the restart's replay already settled is spent: a press after it is a new key, and
    // the server's content claim refuses it as a second copy. Before the replay settles, it resumes.
    const keys = [...new Set(w.attempts.map((a) => a.key))];
    expect(keys[0]).toBe(firstKey);
    expect(w.duplicates.map((d) => d.key), "a second key was delivered rather than refused").toEqual(keys.slice(1));
  });

  it("a DIFFERENT message written after the crash gets a key of its own", async () => {
    const w = wire();
    const st = await store();

    w.fail = true;
    const { send: send1 } = await probe(engineOver(st, w));
    await act(async () => { send1(compose("the first message")); });
    await drain();
    const firstKey = w.attempts[0]!.key;

    await killTab();

    // A NEW message on the same lane. Resuming the stale key here would replay the first send's
    // outcome and leave this one silently unsent — the defect a lane-only lock would introduce.
    w.fail = false;
    const { send: send2 } = await probe(engineOver(await store(), w));
    await act(async () => { send2(compose("a completely different message")); });
    await drain();

    expect(
      w.deliveries.map((d) => d.body),
      "the new message did not go out",
    ).toEqual(["a completely different message"]);
    expect(
      w.deliveries[0]!.key,
      "the new message went out under the dead send's key",
    ).not.toBe(firstKey);
  });

  it("two presses in one tick are still one send — the ref lock is untouched", async () => {
    const w = wire();
    const { send } = await probe(engineOver(await store(), w));
    await act(async () => {
      send(compose("twice in one tick"));
      send(compose("twice in one tick"));
    });
    await drain();
    expect(w.attempts, "the same-tick double slipped through").toHaveLength(1);
  });

  it("a delivered send releases the lane, so the NEXT message mints a fresh key", async () => {
    const w = wire();
    const st = await store();
    const { send } = await probe(engineOver(st, w));

    await act(async () => { send(compose("first")); });
    await drain();
    await beat();
    expect(w.deliveries).toHaveLength(1);
    expect(
      window.localStorage.getItem(sendLocksKey(storageOwner())),
      "a confirmed send must not leave its spent key claiming the lane",
    ).toBeNull();

    await act(async () => { send(compose("second")); });
    await drain();
    expect(w.deliveries.map((d) => d.body)).toEqual(["first", "second"]);
    expect(w.deliveries[0]!.key).not.toBe(w.deliveries[1]!.key);
  });

  /**
   * ── A REPLACED FILE IS A DIFFERENT MESSAGE, EVEN WHEN IT IS THE SAME SIZE ───────────────────
   *
   * The identity folded attachments in by name, type and byte LENGTH. Two different files of the
   * same length under the same name were therefore one message, and the pair is not contrived:
   * the image-quality pass re-encodes a picked picture in place under its original filename
   * (`ComposeAttach.tsx`), and a regenerated document keeps its name.
   *
   * The harm is the resumed key. `SendService.resumeExisting` never sends twice under a key it
   * has already reserved — that is the guarantee this whole file is built on — so a second
   * message handed the FIRST one's key gets the first one's stored result replayed at it. The
   * editor reads `confirmed`, clears the scratch and says "Sent." about a file that never left.
   * A silently unsent mail is worse than the duplicate the lock exists to prevent, which is why
   * the key is what these two cases assert: it is the thing that decides which message the
   * server thinks it is being asked about.
   *
   * The pair differs in ONE thing — four bytes of base64 against four different ones. Same lane,
   * same body, same recipient, same filename, same type, same length. So a green here is about
   * the content and cannot be about anything else.
   */
  it("a replacement attachment of the same length gets a key of its own", async () => {
    const w = wire();

    // The press goes out and the transport drops it: the key is on disk, no mail has left.
    w.fail = true;
    const { send: send1 } = await probe(engineOver(await store(), w));
    await act(async () => { send1(withFile(compose("the same note"), "AAAA")); });
    await drain();
    expect(w.attempts, "the first press never reached the wire").toHaveLength(1);
    expect(w.deliveries, "a failed attempt must reserve nothing").toHaveLength(0);
    const firstKey = w.attempts[0]!.key;

    await killTab();

    // A FRESH store, so nothing the durable outbox held can replay: the only way this press can
    // reach the wire under `firstKey` is the stored lock offering it.
    w.fail = false;
    const { send: send2 } = await probe(engineOver(await store(), w));
    await act(async () => { send2(withFile(compose("the same note"), "BBBB")); });
    await drain();

    expect(w.deliveries, "the replacement did not go out at all").toHaveLength(1);
    expect(
      w.deliveries[0]!.key,
      "the replacement went out under the dead send's key, so a server that had reserved that "
        + "key would have replayed the first send and this file would never have left",
    ).not.toBe(firstKey);
  });

  /**
   * THE OTHER HALF, and the one a stronger identity is most likely to break.
   *
   * An identity that changed on nothing at all would pass the case above and wreck the feature:
   * a genuine re-send after a lost answer would stop resuming its key and mint a fresh one for a
   * message that may already be out there — the duplicate delivery this file was written for.
   * Same sequence, same fixture, ONE difference: the file is unchanged.
   */
  it("the SAME attachment after the crash goes once: a key no longer owed is spent, and the server refuses a second copy", async () => {
    const w = wire();

    w.fail = true;
    const { send: send1 } = await probe(engineOver(await store(), w));
    await act(async () => { send1(withFile(compose("the same note"), "AAAA")); });
    await drain();
    const firstKey = w.attempts[0]!.key;

    await killTab();

    w.fail = false;
    const { send: send2 } = await probe(engineOver(await store(), w));
    await act(async () => { send2(withFile(compose("the same note"), "AAAA")); });
    await drain();

    expect(w.deliveries.map((d) => d.body), "the message did not go out").toEqual(["the same note"]);
    // As above: a key no longer owed is spent; any key but the delivered one is refused by the server.
    const keys = [...new Set(w.attempts.map((a) => a.key))];
    expect(keys[0]).toBe(firstKey);
    expect(w.duplicates.map((d) => d.key), "the same message and file was delivered twice")
      .toEqual(keys.filter((k) => k !== w.deliveries[0]!.key && k !== firstKey));
  });
});

/**
 * ── AN UNRESOLVED SEND PARKS THE MESSAGE IT IS OF, AND NOTHING ELSE ─────────────────────────
 *
 * `send_unverified` means the reservation may already have delivered and nobody can tell. The key
 * is kept and the surface refuses a fresh press, because a second key is a second delivery.
 *
 * WHAT IS PARKED IS THE SUBJECT OF THE SEND — the parent message for a reply, the draft row or the
 * compose session for a new message. Two earlier attempts at this got it wrong in opposite
 * directions, and both are asserted here:
 *
 *  · the LANE was parked. The compose surface has one lane for every message this browser will
 *    ever write, so one ambiguous delivery disabled Send and Send Later for good.
 *  · the FINGERPRINT was parked. An edit changes it, so typing one character into a reply whose
 *    outcome nobody knows walked straight out of the lock and sent under a fresh key.
 *
 * The subject is what an edit does not change and what a different message does not share.
 */
describe("an unresolved send parks the message it is of", () => {
  const composeOf = (body: string): MailSend => compose(body) as unknown as MailSend;
  const replyOf = (parent: string, body: string, over: Record<string, unknown> = {}): MailSend =>
    reply(parent, body, over) as unknown as MailSend;

  it("an EDITED reply after an unverified attempt is refused, and no second key reaches the wire", async () => {
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    await act(async () => { p.send(reply("giulia", "as first written")); });
    await drain();
    expect(w.attempts, "the reply never reached the wire").toHaveLength(1);
    const firstKey = w.attempts[0]!.key;
    expect(p.stateOf("giulia").phase, "the reply's own lane was not parked").toBe("unverified");

    // The person edits the text and presses Send again. The fingerprint has moved; the reply has
    // not — it is still the answer to the same message, and it may already be in an inbox.
    await act(async () => { p.send(reply("giulia", "as first written, plus a second thought")); });
    await drain();
    expect(
      w.attempts.map((a) => a.key),
      "an edit escaped the lock and went out under a fresh key, so the same reply can be "
        + "delivered twice",
    ).toEqual([firstKey]);
    expect(
      canSend(p.stateOf("giulia"), replyOf("giulia", "edited again")),
      "the edited reply reads as sendable",
    ).toBe(false);
  });

  it("an unchanged reply that acquired its signature and HTML is still parked", async () => {
    /**
     * The button and the status line judge a mutation the surface builds; the wire carries one
     * AppShell builds, with the HTML body, the signature, the attachments, the subject and the
     * sender on it. Those two disagreeing is how an unverified reply rendered idle and sendable
     * again: the recorded fingerprint could not match anything the surface computed. The subject
     * matches whatever the fields do.
     */
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    await act(async () => {
      p.send(reply("giulia", "text\n\n-- \nMila", { html: "<p>text</p><p>-- <br>Mila</p>" }));
    });
    await drain();
    expect(w.attempts).toHaveLength(1);

    // The same reply as the surface would rebuild it, without the rich half or the signature.
    expect(
      canSend(p.stateOf("giulia"), replyOf("giulia", "text")),
      "the reply the surface can name reads as sendable while the recorded one is unresolved",
    ).toBe(false);
  });

  it("a reply to a DIFFERENT message sends, under a key of its own", async () => {
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    await act(async () => { p.send(reply("giulia", "the ambiguous reply")); });
    await drain();
    const firstKey = w.attempts[0]!.key;

    w.unverify = false;
    await act(async () => { p.send(reply("petra", "an answer to somebody else entirely")); });
    await drain();
    expect(
      w.deliveries.map((d) => d.body),
      "one ambiguous reply locked every other conversation",
    ).toEqual(["an answer to somebody else entirely"]);
    expect(w.deliveries[0]!.key, "the other conversation reused the ambiguous key").not.toBe(firstKey);
  });

  it("the record survives a reload and still parks its own subject alone", async () => {
    const w = wire();
    const st = await store();
    const first = await probe(engineOver(st, w));

    w.unverify = true;
    await act(async () => { first.send(reply("giulia", "the ambiguous reply")); });
    await drain();
    const ambiguousKey = w.attempts[0]!.key;

    // THE KILL: React state is gone, the jar is not.
    await killTab();
    w.unverify = false;
    const after = await probe(engineOver(st, w));

    expect(
      canSend(after.stateOf("giulia"), replyOf("giulia", "the ambiguous reply")),
      "a fresh mount came back live for the ambiguous reply",
    ).toBe(false);
    expect(
      canSend(after.stateOf("giulia"), replyOf("giulia", "edited after the reload")),
      "an edit after a reload escaped the lock",
    ).toBe(false);
    expect(
      canSend(after.stateOf("petra"), replyOf("petra", "another conversation")),
      "the reloaded surface refuses a conversation that has nothing to do with it",
    ).toBe(true);
    expect(
      window.localStorage.getItem(sendLocksKey(storageOwner())) ?? "<the jar holds nothing at all>",
      "the reload dropped the record",
    ).toContain(ambiguousKey);
  });

  it("a new COMPOSE is parked while the ambiguous one is still on the surface, and sends once it is abandoned", async () => {
    /**
     * A new message has no draft row until autosave gives it one, so its subject is the compose
     * session — the id minted beside the scratch buffer and cleared with it. That gives the park
     * exactly the reach it should have: while the composer still holds the message whose outcome
     * nobody knows, a press is refused however the text has changed; once the message is
     * abandoned (or delivered), the buffer and the session go and the next message is its own.
     *
     * The earlier fix let the new message send immediately, on the fingerprint. That was a
     * designed escape: the same composer, one edit, a fresh key.
     */
    const { clearComposeDraft } = await import("@ohmail/app-logic/writing/compose");
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    await act(async () => { p.send(compose("the ambiguous message")); });
    await drain();
    expect(w.attempts).toHaveLength(1);
    const ambiguousKey = w.attempts[0]!.key;

    w.unverify = false;
    await act(async () => { p.send(compose("typed over the top of it")); });
    await drain();
    expect(
      w.deliveries,
      "a press in the composer that still holds the ambiguous message went out under a fresh key",
    ).toHaveLength(0);

    // The person abandons it. The scratch buffer goes, and the session id with it.
    clearComposeDraft(null);
    await act(async () => { p.send(compose("a genuinely new message")); });
    await drain();
    expect(
      w.deliveries.map((d) => d.body),
      "the new message could not be sent even after the ambiguous one was abandoned",
    ).toEqual(["a genuinely new message"]);
    expect(w.deliveries[0]!.key, "the new message reused the ambiguous key").not.toBe(ambiguousKey);
    expect(
      window.localStorage.getItem(sendLocksKey(storageOwner())) ?? "<the jar holds nothing at all>",
      "the ambiguous record was deleted on the way past",
    ).toContain(ambiguousKey);
  });

  it("two unresolved sends coexist on one lane, and a third message still goes out", async () => {
    const { clearComposeDraft } = await import("@ohmail/app-logic/writing/compose");
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    await act(async () => { p.send(compose("first ambiguous")); });
    await drain();
    clearComposeDraft(null); // abandoned; the next message is its own subject
    await act(async () => { p.send(compose("second ambiguous")); });
    await drain();
    const keys = w.attempts.map((a) => a.key);
    expect(new Set(keys).size, "the second ambiguous send reused the first one's key").toBe(2);

    const jar = window.localStorage.getItem(sendLocksKey(storageOwner())) ?? "";
    for (const k of keys) {
      expect(jar, "one unresolved record replaced the other; a message's key is gone").toContain(k);
    }

    clearComposeDraft(null);
    w.unverify = false;
    await act(async () => { p.send(compose("a third, ordinary message")); });
    await drain();
    await beat();
    expect(
      w.deliveries.map((d) => d.body),
      "two unresolved sends locked the surface against everything else",
    ).toEqual(["a third, ordinary message"]);

    /**
     * AND BOTH ARE STILL PARKED ON A FRESH MOUNT, which is the part the mount cannot fake: the
     * assertions above run against a live surface, where `absorb` names the intent it observed in
     * React state, so they stay green even if a DURABLE record was never marked. React state is
     * what a reload takes away.
     */
    await killTab();
    const after = await probe(engineOver(st, w));
    const parked = (window.localStorage.getItem(sendLocksKey(storageOwner())) ?? "");
    for (const k of keys) {
      expect(parked, "an unresolved record did not survive the reload").toContain(k);
    }
    expect(
      after.stateOf("compose").phase,
      "the reloaded compose lane forgot that two sends are unresolved",
    ).toBe("unverified");
  });

  it("a reopened DRAFT stays parked after it is edited, and another draft does not", async () => {
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));
    const withDraft = (id: string, body: string): Record<string, unknown> =>
      ({ ...compose(body), draftId: id });

    w.unverify = true;
    await act(async () => { p.send(withDraft("draft-77", "as first written")); });
    await drain();
    expect(w.attempts).toHaveLength(1);

    expect(
      canSend(p.stateOf("compose"), withDraft("draft-77", "as first written") as unknown as MailSend),
      "the draft that may already have gone became sendable",
    ).toBe(false);
    expect(
      canSend(p.stateOf("compose"), withDraft("draft-77", "edited afterwards") as unknown as MailSend),
      "editing the reopened draft escaped the lock",
    ).toBe(false);
    /**
     * A DIFFERENT DRAFT IS A DIFFERENT MESSAGE, AND IT IS THE DOOR THAT SAYS SO, not the row.
     * This arm used to assert that a message naming another row was admitted under the SAME
     * session — the rule that let a row difference outrank a session match, and the hole the
     * reviewed reload sequence went through. `openDraft` re-mints the session before it seeds the
     * form, so the two messages never share one; the assertion follows that path.
     */
    expect(
      canSend(p.stateOf("compose"), withDraft("draft-40", "a different draft entirely") as unknown as MailSend),
      "a second draft opened WITHOUT the session being re-minted was admitted — the row must not outrank the session",
    ).toBe(false);
    const { clearComposeDraft } = await import("@ohmail/app-logic/writing/compose");
    clearComposeDraft(storageOwner());
    expect(
      canSend(p.stateOf("compose"), withDraft("draft-40", "a different draft entirely") as unknown as MailSend),
      "opening a different draft left it parked by the message before it",
    ).toBe(true);
    expect(
      canSend(p.stateOf("compose"), withDraft("draft-77", "as first written") as unknown as MailSend),
      "the message whose send is unresolved stopped being parked once another draft had been opened",
    ).toBe(false);
  });

  it("the RECORDED fingerprint is the one over the body that went on the wire", async () => {
    /**
     * The identity has to be computed from the fields the SERVER is given, not from a mutation the
     * surface rebuilds — that disagreement is how a signed or rich send recorded one fingerprint
     * and offered another. Asserted against the request the adapter received, so a future change
     * that fingerprints a UI twin fails here rather than in somebody's inbox.
     */
    const { sendFingerprint } = await import("@ohmail/app-logic/writing/send-lock");
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    // UNVERIFIED, so the record is still there to read: a confirmed send releases it, which is
    // correct and would leave this case asserting an empty jar.
    w.unverify = true;
    await act(async () => {
      p.send(reply("giulia", "text\n\n-- \nMila", { html: "<p>text</p>", threadId: "th-9" }));
    });
    await drain();
    expect(w.sent, "the reply never reached the wire").toHaveLength(1);
    const rows = JSON.parse(window.localStorage.getItem(sendLocksKey(storageOwner())) ?? "[]") as Array<{ fp: string }>;
    expect(rows, "the send claimed no record").toHaveLength(1);
    expect(
      rows[0]!.fp,
      "the recorded fingerprint is not the one over the body that went out",
    ).toBe(sendFingerprint(w.sent[0]! as unknown as MailSend));
  });
});

/**
 * ── A DRAFT ROW APPEARING DOES NOT MAKE ONE MESSAGE INTO TWO ─────────────────────────────────
 *
 * Measured end to end on a real browser against a real SMTP server cut after DATA, twice: a send
 * answered `unverified`, the surface said *"We couldn't confirm this send. Check your Sent folder
 * before sending it again."*, Send went disabled and the durable record was written with
 * `subject: "compose:<session>"` and `draftId: null`. Half a second later — nothing typed — Send
 * was ENABLED again with the record byte-for-byte unchanged. In that window the composer's
 * autosave had created a draft row, so the surface computed `draft:<id>` for the same
 * message-in-progress while the record still said `compose:<session>`; the two forms cannot
 * match, the unresolved lookup found nothing for a message it held a record of, and the press
 * that followed minted a second key and delivered the mail again. The recipient held two copies
 * and the sender's Sent folder held one, so neither side showed the duplicate — and the sentence
 * the product prints is what invites that press.
 *
 * The identity is therefore the compose SESSION for the session's whole lifetime, carried on the
 * record beside the subject, and a record parks a message when the two name sets intersect.
 */
describe("an unresolved send survives autosave giving the message a draft row", () => {
  const jar = (): Array<{
    key: string; draftId: string | null; subject?: string; session?: string; unverified?: boolean;
  }> => JSON.parse(window.localStorage.getItem(sendLocksKey(storageOwner())) ?? "[]");

  it("the retry after autosave mints a row is REFUSED, and the record picks up the row", async () => {
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    // 1 — the send nobody can resolve. The composer has no draft row of its own yet, which is the
    //     state the measured run was in: the row the send used was the adapter's own.
    w.unverify = true;
    const first = compose("Donnerstag passt.");
    await act(async () => { p.send(first); });
    await drain();
    expect(w.attempts, "the first press never reached the wire").toHaveLength(1);
    const firstKey = w.attempts[0]!.key;
    const parked = jar();
    expect(parked, "the unresolved send claimed no record").toHaveLength(1);
    expect(parked[0]!.draftId, "the composer had no row of its own at the press").toBeNull();
    expect(parked[0]!.subject, "the record was not named by the compose session").toMatch(/^compose:/);

    // 2 — AUTOSAVE. `useComposeAutosave` creates a row for the message still on screen and adopts
    //     its id, so every later mutation from this surface carries it. Nothing was typed: the
    //     body is the same string.
    const afterRow = { ...compose("Donnerstag passt."), draftId: "row-b" };

    // 3 — the press the product's own sentence invites.
    expect(
      canSend(p.stateOf("compose"), afterRow as unknown as MailSend),
      "the surface unlocked for a message it holds an unresolved record of",
    ).toBe(false);
    await act(async () => { p.send(afterRow); });
    await drain();

    expect(
      w.attempts.map((a) => a.key),
      "the retry reached the wire under a second key — this is the duplicate delivery",
    ).toEqual([firstKey]);
    expect(w.deliveries, "a second reservation was made for one message").toHaveLength(0);

    const after = jar();
    expect(after, "the lane holds more than the one unresolved record").toHaveLength(1);
    expect(after[0]!.key, "the record was re-keyed rather than kept").toBe(firstKey);
    expect(
      after[0]!.draftId,
      "the row the message acquired was never attached to the record that names it",
    ).toBe("row-b");
    expect(
      after[0]!.subject,
      "the subject was re-keyed onto the new row — the identity must not move",
    ).toBe(parked[0]!.subject);
  });

  it("the message stays parked after it LOSES the row the record names", async () => {
    /**
     * The bridge runs both ways, and this is the direction that is not the measured run: the press
     * carried a row, the send consumed it, and the surface is back to a message with no row of its
     * own. Named by the subject alone the record would say `draft:row-a` against a message that
     * can no longer answer to it, so the same unedited message would read as new.
     *
     * It is the same one-sided shape as the measured case, so the session decides. Where BOTH
     * sides name a row and the rows disagree, they are two messages and the row decides instead —
     * `a reopened DRAFT stays parked after it is edited, and another draft does not` above is the
     * case that holds that line, and it is why the session's authority stops here.
     */
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    await act(async () => { p.send({ ...compose("Freitag auch."), draftId: "row-a" }); });
    await drain();
    expect(w.attempts, "the first press never reached the wire").toHaveLength(1);
    const firstKey = w.attempts[0]!.key;
    const rec = jar()[0]!;
    expect(rec.session, "the compose lane's session was not recorded").toMatch(/.+/);
    expect(rec.subject, "the record was not named by the row the press carried").toBe("draft:row-a");

    const rowless = compose("Freitag auch.");
    expect(
      canSend(p.stateOf("compose"), rowless as unknown as MailSend),
      "losing the draft row unlocked a message whose send is unresolved",
    ).toBe(false);
    await act(async () => { p.send(rowless); });
    await drain();
    expect(w.attempts.map((a) => a.key), "the rowless message sent under a second key").toEqual([firstKey]);
  });

  it("a DIFFERENT message is still admitted while the compose lane is parked", async () => {
    /**
     * THE POSITIVE CONTROL. A refusal rule with no case proving it admits the right message would
     * be satisfied by refusing everything, which is a product nobody can send mail from. The
     * park is scoped to the message, so a reply to another thread goes out normally — and the
     * jar afterwards holds both records, each naming its own message.
     */
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    await act(async () => { p.send(compose("Donnerstag passt.")); });
    await drain();
    expect(jar(), "the unresolved compose claimed no record").toHaveLength(1);

    // A genuinely different message, on its own lane and named by the thread it answers.
    w.unverify = false;
    await act(async () => { p.send(reply("petra", "Bis dann.")); });
    await drain();

    expect(
      w.deliveries.map((d) => d.body),
      "the parked compose refused a different message as well",
    ).toEqual(["Bis dann."]);
    expect(
      canSend(p.stateOf("petra"), reply("petra", "Bis dann.") as unknown as MailSend),
      "the delivered reply's own lane stayed pressable after it settled",
    ).toBe(false);
  });

  it("abandoning the compose frees the surface for the next message", async () => {
    /**
     * The session is what the park is scoped to, so the case that shows the scope is real is the
     * one where it ENDS. `clearComposeDraft` drops the scratch buffer and the session id together
     * — the message-in-progress is over — and the next compose is a new message under a new
     * session, which must send under a key of its own. Without this the compose surface would be
     * parked for the life of the browser by one ambiguous delivery, which is the defect the
     * subject-scoped park was introduced to fix and must not be reintroduced from the other side.
     */
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    await act(async () => { p.send(compose("Donnerstag passt.")); });
    await drain();
    const firstKey = w.attempts[0]!.key;

    const { clearComposeDraft } = await import("@ohmail/app-logic/writing/compose");
    clearComposeDraft(storageOwner());

    w.unverify = false;
    const next = compose("Ganz andere Nachricht.");
    expect(
      canSend(p.stateOf("compose"), next as unknown as MailSend),
      "a new compose session was still parked by the abandoned message",
    ).toBe(true);
    await act(async () => { p.send(next); });
    await drain();

    expect(
      w.deliveries.map((d) => d.body),
      "the new message did not go out",
    ).toEqual(["Ganz andere Nachricht."]);
    expect(
      w.attempts.map((a) => a.key).filter((k) => k !== firstKey),
      "the new message did not get a key of its own",
    ).toHaveLength(1);
    expect(
      jar().some((r) => r.key === firstKey),
      "the abandoned message's unresolved record was deleted — it is the only evidence it may have gone",
    ).toBe(true);
  });

  it("the row moving under one message does not unlock the surface", async () => {
    /**
     * ── THE REVIEWED SEQUENCE, AT THE SURFACE ─────────────────────────────────────────────────
     *
     * A compose sent from saved draft `d1` comes back unverified. The reload preserves the
     * compose session (the scratch buffer is in `localStorage`) and used to lose the ROW: the
     * composer's autosave had no `d1` to adopt, so the next pause created `d2`. Two rows, one
     * message, one session — and the rule that let a row difference outrank a session match read
     * that as two messages, unlocked Send, and the next press minted a second key for a message
     * that may already be in somebody's inbox.
     *
     * The row is adopted on mount now (`compose-autosave.test.tsx`), so in the product `d2` is
     * never minted. This case is the OTHER half and is deliberately blind to that fix: the
     * message it presses with carries `d2`, exactly as if the adoption had not happened, so what
     * is measured here is the session park alone.
     *
     * Mutation: restore the row-outranks-session line in `unresolvedNames`
     * (`if (myRow !== undefined && itsRow !== undefined && myRow !== itsRow) return false;`).
     */
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    await act(async () => { p.send({ ...compose("Bis Donnerstag."), draftId: "d1" }); });
    await drain();
    expect(w.attempts, "the send from the saved draft never reached the wire").toHaveLength(1);
    const firstKey = w.attempts[0]!.key;
    const rec = jar()[0]!;
    expect(rec.subject, "the record was not named by the row the press carried").toBe("draft:d1");
    expect(rec.session, "the compose lane's session was not recorded").toMatch(/.+/);

    const afterReload = { ...compose("Bis Donnerstag."), draftId: "d2" };
    expect(
      canSend(p.stateOf("compose"), afterReload as unknown as MailSend),
      "a row minted afresh after the reload unlocked a message whose send is unresolved",
    ).toBe(false);
    await act(async () => { p.send(afterReload); });
    await drain();
    expect(
      w.attempts.map((a) => a.key),
      "the press after the reload reached the wire under a second key — the duplicate delivery",
    ).toEqual([firstKey]);
    expect(w.deliveries, "a second reservation was made for one message").toHaveLength(0);
    expect(jar(), "the lane holds more than the one unresolved record").toHaveLength(1);
  });

  it("the same message under a moved row is parked even after one character is edited", async () => {
    /**
     * The two escapes are independent and a rule that admitted either would be a second
     * delivery: the row moved (above) and the CONTENT moved. Keying anything on the fingerprint
     * is what makes the second one work — type one character into a message whose outcome nobody
     * knows and a fresh key goes out. Both at once here, which is the state a person is actually
     * in: they reloaded, autosave re-rowed the message, and they tidied a word before retrying.
     *
     * Mutation: `return i.fp === fpOf();` in place of the intersection.
     */
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    await act(async () => { p.send({ ...compose("Bis Donnerstag."), draftId: "d1" }); });
    await drain();
    const firstKey = w.attempts[0]!.key;

    const edited = { ...compose("Bis Donnerstag!"), draftId: "d2" };
    expect(
      canSend(p.stateOf("compose"), edited as unknown as MailSend),
      "editing the message escaped the park it was under",
    ).toBe(false);
    await act(async () => { p.send(edited); });
    await drain();
    expect(w.attempts.map((a) => a.key), "the edited message sent under a second key").toEqual([firstKey]);
  });

  it("a re-minted session admits the replacement message, and still parks its own", async () => {
    /**
     * THE POSITIVE CONTROL FOR THE SESSION'S NEW AUTHORITY, and the reason the row rule could go.
     * With a session match final, the thing that has to be true is that the doors which replace
     * the form give the replacement a session of its own — `clearComposeDraft` before the seed,
     * in `openDraft`, `writeTo` and the mailto effect (censused in `compose-autosave.test.tsx`).
     * This drives that door and asserts both directions: the replacement sends, and the message
     * the record actually names is still refused when it comes back.
     *
     * Without the second half the first would be satisfied by a park that had stopped working.
     */
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    await act(async () => { p.send({ ...compose("Bis Donnerstag."), draftId: "d1" }); });
    await drain();
    const firstKey = w.attempts[0]!.key;

    // THE DOOR: a `mailto:` click, the contact popover's Write, or opening another draft.
    const { clearComposeDraft } = await import("@ohmail/app-logic/writing/compose");
    clearComposeDraft(storageOwner());

    w.unverify = false;
    const replacement = compose("Ganz andere Nachricht.");
    expect(
      canSend(p.stateOf("compose"), replacement as unknown as MailSend),
      "a message the person had never pressed Send on was parked by the one before it",
    ).toBe(true);
    await act(async () => { p.send(replacement); });
    await drain();
    expect(
      w.deliveries.map((d) => d.body),
      "the replacement message did not go out",
    ).toEqual(["Ganz andere Nachricht."]);
    expect(
      w.attempts.map((a) => a.key).filter((k) => k !== firstKey),
      "the replacement did not get a key of its own",
    ).toHaveLength(1);

    // AND THE RECORD STILL PARKS THE MESSAGE IT NAMES — reopened from Drafts, row and all.
    expect(
      canSend(p.stateOf("compose"), { ...compose("Bis Donnerstag."), draftId: "d1" } as unknown as MailSend),
      "the unresolved send stopped parking its own message once the session had moved on",
    ).toBe(false);
  });

  it("the row moving a SECOND time under one message is still parked", async () => {
    /**
     * ── THE ROW APPEARS, THEN IS REPLACED, AND THE RECORD NAMED NEITHER ───────────────────────
     *
     * The press carried no row at all, so the record is named by the compose session alone. A row
     * then appears (the pause after the press) and is replaced again — the create was undone, or
     * the row a send consumed is gone and autosave made another. Every one of those states is one
     * message, and the only name the record and the message ever share is the session. A rule that
     * read a row difference as two messages could not see that, and this is the shape it could not
     * see TWICE: the record names no row, so the first move was already outside what such a rule
     * compared, and the second move is inside it.
     *
     * Driven with the rows handed in rather than left to the composer, so what is measured is the
     * park alone and not the row adoption that stops the rows moving in the first place.
     *
     * ── WHAT THIS CASE IS AND IS NOT EVIDENCE FOR, MEASURED ───────────────────────────────────
     *
     * It is NOT a control for the row rule's removal. Restoring
     * `if (myRow !== undefined && itsRow !== undefined && myRow !== itsRow) return false;` leaves
     * this case GREEN, because the record here names no row at all — `itsRow` is `undefined`, so
     * the rule's own condition is false and it never decides anything. The cases above it are that
     * control. What this one pins is the one-sided arm under a REPEATED move, a sequence no other
     * case drives: two rows in succession under one session, each of which used to be a fresh
     * identity to any reader that went by the row.
     *
     * Mutation that does redden it: `return i.fp === fpOf();` in place of the intersection — the
     * message carries a row the record's fingerprint was not computed with, so a fingerprint
     * comparison unlocks it. Recorded because a mutation note nobody watched is a claim, and this
     * one was wrong the first time it was written.
     */
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    await act(async () => { p.send(compose("Sonntag, wenn es passt.")); });
    await drain();
    expect(w.attempts, "the rowless press never reached the wire").toHaveLength(1);
    const firstKey = w.attempts[0]!.key;
    const rec = jar()[0]!;
    expect(rec.subject, "the record was not named by the compose session").toMatch(/^compose:/);

    for (const row of ["row-first", "row-second"]) {
      const m = { ...compose("Sonntag, wenn es passt."), draftId: row };
      expect(
        canSend(p.stateOf("compose"), m as unknown as MailSend),
        `the surface unlocked once the message was saved to ${row}`,
      ).toBe(false);
      await act(async () => { p.send(m); });
      await drain();
      expect(
        w.attempts.map((a) => a.key),
        `the press under ${row} reached the wire under a second key`,
      ).toEqual([firstKey]);
    }
    expect(w.deliveries, "a second reservation was made for one message").toHaveLength(0);
    expect(
      jar()[0]!.draftId,
      "the record did not pick up the row the message ended on",
    ).toBe("row-second");
  });

  it("the row the ADAPTER made is named by the refusal, and the record picks it up", async () => {
    /**
     * ── `SEND-DRAFT-ROW-NEVER-REACHES-THE-CLIENT`, closed from the wire side ──────────────────
     *
     * A press before the first autosave carries NO row, so the adapter creates one server-side
     * and sends that. The server marks THAT row `unverified` — and until the refusal named it, the
     * client had no way to learn its id. The row therefore sat in the Drafts list looking like an
     * ordinary draft: `unresolvedSendRows` did not report it, `parkedComposeRecord` could not find
     * it by row, opening it took the ordinary door, and one press delivered the message a second
     * time. Measured live, recipient total 2.
     *
     * `MutationRejectedError.entityId` carries the row now, and `absorb` writes it onto the record
     * that was just marked. The session named the message all along; the ROW is the name that
     * survives a door in between and a reload.
     *
     * Mutation: drop `entityId` from the `unverified` throw in `http-adapter.ts` (modelled here by
     * `w.unverifiedRow = null`). Real failure text: AssertionError: the row the send made for
     * itself is not on the record, so the Drafts list shows it as an ordinary draft and reopening
     * it sends the message again: expected [] to deeply equal [ 'srv-9' ]
     */
    const { unresolvedSendRows, parkedComposeMessage } =
      await import("@ohmail/app-logic/writing/send-lock");
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    w.unverifiedRow = "srv-9";
    // NO `draftId`: this is the press the adapter has to create a row for.
    await act(async () => { p.send(compose("Kommst du noch?")); });
    await drain();
    expect(w.attempts, "the press never reached the wire").toHaveLength(1);
    expect(jar()[0]!.unverified, "the record does not say the outcome is unknown").toBe(true);
    expect(
      [...unresolvedSendRows("compose", storageOwner())],
      "the row the send made for itself is not on the record, so the Drafts list shows it as an "
        + "ordinary draft and reopening it sends the message again",
    ).toEqual(["srv-9"]);
    expect(
      parkedComposeMessage("compose", "srv-9", null, storageOwner()),
      "reopening the row the send made for itself is not parked — it takes the ordinary door",
    ).toBe(true);
    /* THE CONTROL: a row nothing named is not parked, or every draft in the account would be. */
    expect(
      parkedComposeMessage("compose", "some-other-row", null, storageOwner()),
      "an unrelated row is parked, which refuses every other draft in the account",
    ).toBe(false);
  });

  it("a server that names NO row still parks the message by its session", async () => {
    /*
     * The other half of the pair, and it is why the row is an ADDITION rather than a replacement:
     * an older server, or a press whose row the refusal could not name, leaves the record with the
     * session alone — which is the name it always had and is enough to park the surface. Without
     * this case the assertion above would be satisfied by a park that only works when a row is
     * named, which is the smaller half of the states this reaches.
     */
    const { unresolvedSendRows, parkedComposeMessage } =
      await import("@ohmail/app-logic/writing/send-lock");
    const { composeSessionId } = await import("@ohmail/app-logic/writing/compose");
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    w.unverifiedRow = null;
    await act(async () => { p.send(compose("Kommst du noch?")); });
    await drain();
    expect([...unresolvedSendRows("compose", storageOwner())], "a row was invented for a refusal that named none")
      .toEqual([]);
    expect(
      parkedComposeMessage("compose", null, composeSessionId(storageOwner()), storageOwner()),
      "the message is not parked at all once the row is missing — the press that follows mints a "
        + "fresh key for mail that may already have gone",
    ).toBe(true);
  });

  it("reopening the parked row is not a recovery: it stays the message the record names", async () => {
    /**
     * ── MEASURED LIVE ON THE RELEASE CANDIDATE, RECIPIENT TOTAL 2 ─────────────────────────────
     *
     * A saved draft `d1` is opened from the drafts list, sent, and comes back unverified. Send
     * goes disabled and the record names `draft:d1` under session `S`. The drafts list still
     * lists `d1` — an unverified row IS listed, which is what makes the next step reachable at
     * all — and reopening it took `openDraft`'s RECOVERY door: a new row `d2` was minted and the
     * compose session was RE-MINTED. Both names the record carries were off the message at once,
     * so the park could not recognise it, Send lit up, and one press delivered a second copy
     * under a fresh key.
     *
     * The re-mint is the half this file can measure: with the session preserved, the reopened
     * message is still the message the record names, whatever row it ends up carrying. The other
     * half — that `openDraft` does not re-mint and does not mint a row for such a draft — is
     * pinned in `drafts-unverified.test.tsx`, which reads the decision itself.
     *
     * `unresolvedSendRows` is the question `openDraft` asks. It is asserted here against a jar a
     * real send wrote, rather than a hand-built one, because the row it must find was attached to
     * the record after the press by `attachSendLockDraft`.
     */
    const { unresolvedSendRows, parkedComposeMessage } =
      await import("@ohmail/app-logic/writing/send-lock");
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    await act(async () => { p.send({ ...compose("Bis Montag."), draftId: "d1" }); });
    await drain();
    expect(w.attempts, "the send from the saved draft never reached the wire").toHaveLength(1);
    const firstKey = w.attempts[0]!.key;
    expect(jar()[0]!.subject, "the record was not named by the row the press carried").toBe("draft:d1");

    expect(
      [...unresolvedSendRows("compose", storageOwner())],
      "the row an unresolved send belongs to is not reported, so the reopen takes the recovery door",
    ).toEqual(["d1"]);
    expect(
      unresolvedSendRows("compose", storageOwner()).has("d9"),
      "an unrelated row is reported as parked, which would refuse every other draft in the account",
    ).toBe(false);

    /* THE SHAPE THE REOPEN ASKS IN, against a jar a real send wrote — and the shape the RELOAD
       asks in is the same function with the session supplied. No session here: at that moment the
       session still names the message being left behind, and every draft in the account would
       answer to it. The row alone decides which message is being opened. */
    expect(
      parkedComposeMessage("compose", "d1", null, storageOwner()),
      "the row an unresolved send belongs to is not parked when the row is the only name asked",
    ).toBe(true);
    expect(
      parkedComposeMessage("compose", "d9", null, storageOwner()),
      "an unrelated row is parked by another message's unresolved send",
    ).toBe(false);

    // REOPENED AS ITSELF: the session is NOT re-minted, so both the row and a fresh row the pause
    // may write later are still the message the record names.
    for (const m of [
      { ...compose("Bis Montag."), draftId: "d1" },
      { ...compose("Bis Montag."), draftId: "d2" },
      compose("Bis Montag."),
    ]) {
      expect(
        canSend(p.stateOf("compose"), m as unknown as MailSend),
        `the reopened message was sendable carrying ${String((m as { draftId?: string }).draftId ?? "no row")}`,
      ).toBe(false);
      await act(async () => { p.send(m); });
      await drain();
      expect(
        w.attempts.map((a) => a.key),
        "the reopened message reached the wire under a second key — the duplicate delivery",
      ).toEqual([firstKey]);
    }
    expect(w.deliveries, "a second reservation was made for one message").toHaveLength(0);
  });

  it("a door in between does not unlock the parked row: the reopen restores the record's session", async () => {
    /**
     * ── THE PARK SURVIVED THE REOPEN AND NOT THE DETOUR ───────────────────────────────────────
     *
     * Round 3 kept the session when the parked row was reopened DIRECTLY. Go somewhere else first
     * — write to a contact from their card, follow a mail link from outside the app — and that
     * door legitimately starts a new message with a new session. Coming back to Drafts and
     * opening the unconfirmed row then recognised the park (the row still names it) and presented
     * the message under the DOOR's session, holding no row: the record matched neither current
     * name, the warning was gone, Send was live, and one press was a second copy under a fresh
     * key.
     *
     * So the reopen restores what the record carries. This is that chain end to end: a real send
     * that comes back unverified, a real door, and then the two writes the parked branch makes
     * (`writeComposeRow`, `writeComposeSession` — pinned to the branch itself in
     * `drafts-unverified.test.tsx`, which reads the decision). `stateOf` reads the session from
     * storage on every call, so the refusal below is the shipped comparison, not a restatement.
     *
     * Mutation: drop the `writeComposeSession(parkedRecord.session)` line. Real failure text:
     *   AssertionError: the reopened parked message is sendable — one press is a second copy
     */
    const { parkedComposeRecord } = await import("@ohmail/app-logic/writing/send-lock");
    const { clearComposeDraft, composeSessionId, writeComposeRow, writeComposeSession } =
      await import("@ohmail/app-logic/writing/compose");
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    const s1 = composeSessionId(storageOwner());
    w.unverify = true;
    await act(async () => { p.send({ ...compose("Bis Montag."), draftId: "d1" }); });
    await drain();
    expect(w.attempts, "the send from the saved draft never reached the wire").toHaveLength(1);
    const firstKey = w.attempts[0]!.key;

    // THE DOOR. Autosave releases its row and the form is replaced, so a new message begins.
    clearComposeDraft(storageOwner());
    const s2 = composeSessionId(storageOwner());
    expect(s2, "the door minted no new session, so this case measures nothing").not.toBe(s1);

    /* WHAT THE REOPEN ARRIVES HOLDING: no row (the parked branch holds one, it does not adopt
       it) and the door's session. Sendable, which is the defect being closed — asserted so a
       later change that parks it for another reason cannot make this case vacuous. */
    const reopened = compose("Bis Montag.") as unknown as MailSend;
    expect(
      canSend(p.stateOf("compose"), reopened),
      "the message is already refused before the restore, so the restore is not what is measured",
    ).toBe(true);

    const rec = parkedComposeRecord("compose", "d1", null, storageOwner());
    expect(
      rec,
      "the reopen cannot name the message it has just recognised as parked",
    ).toEqual({ session: s1, draftId: "d1" });
    // The two writes the parked branch makes, in its order.
    writeComposeRow(rec!.draftId!, storageOwner());
    writeComposeSession(rec!.session!, storageOwner());

    expect(
      canSend(p.stateOf("compose"), reopened),
      "the reopened parked message is sendable — one press is a second copy",
    ).toBe(false);
    await act(async () => { p.send(reopened); });
    await drain();
    expect(
      w.attempts.map((a) => a.key),
      "the reopened message reached the wire under a second key — the duplicate delivery",
    ).toEqual([firstKey]);
    expect(w.deliveries, "a second reservation was made for one message").toHaveLength(0);
  });

  it("the row this surface was holding is written onto the record as it is created", async () => {
    /**
     * ── THE ROW THAT LANDED BEFORE THE RECORD ─────────────────────────────────────────────────
     *
     * Measured live, recipient total 2. A compose pressed with no row: the send makes its OWN row
     * server-side and parks that one, while the composer's armed autosave mints another with the
     * same text. Which of the two lands first is a race, and only one direction was covered — the
     * create-time attach catches a row that appears AFTER the record. This is the other
     * direction: the row was already held when the unverified answer came back, and nothing
     * wrote it down, so the record named no row at all and the row in Drafts was traceable to
     * nothing.
     *
     * Mutation: delete the `attachSendLockDraft(...)` block beside `markSendLockUnverified`.
     * Real failure text:
     *   AssertionError: the record was written naming no row, so the row in Drafts is traceable
     *   to nothing: expected null to be 'B'
     */
    const { parkedComposeRecord } = await import("@ohmail/app-logic/writing/send-lock");
    const { writeComposeRow } = await import("@ohmail/app-logic/writing/compose");
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    // The armed autosave landed first: this surface is holding B when the press is answered.
    writeComposeRow("B", storageOwner());
    w.unverify = true;
    await act(async () => { p.send(compose("Kommst du noch?")); });
    await drain();
    expect(w.attempts, "the press never reached the wire").toHaveLength(1);

    expect(
      jar()[0]!.draftId ?? null,
      "the record was written naming no row, so the row in Drafts is traceable to nothing",
    ).toBe("B");
    expect(
      parkedComposeRecord("compose", "B", null, storageOwner()),
      "reopening that row from Drafts finds nothing, so it recovers and sends a second copy",
    ).not.toBeNull();
  });

  it("a draft with NO unresolved record is not parked, and still sends once", async () => {
    /**
     * THE POSITIVE CONTROL for the question `openDraft` asks. A refusal rule with no case showing
     * it admits the right draft would be satisfied by reporting every row, which would send every
     * reopened draft in the account down the parked door and make Drafts unusable.
     *
     * Two rows here on purpose: the one an unresolved send belongs to, and an ordinary one beside
     * it. Only the first is reported, and the second sends under a key of its own.
     */
    const { unresolvedSendRows } = await import("@ohmail/app-logic/writing/send-lock");
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    await act(async () => { p.send({ ...compose("Bis Montag."), draftId: "d1" }); });
    await drain();
    const firstKey = w.attempts[0]!.key;

    expect(
      unresolvedSendRows("compose", storageOwner()).has("d5"),
      "an ordinary saved draft was reported as parked — every reopen would refuse",
    ).toBe(false);
    const { parkedComposeMessage } = await import("@ohmail/app-logic/writing/send-lock");
    expect(
      parkedComposeMessage("compose", "d5", null, storageOwner()),
      "an ordinary saved draft is parked — every reopen in the account would refuse",
    ).toBe(false);

    // The ordinary draft is reopened through the door that DOES re-mint, and sends.
    const { clearComposeDraft } = await import("@ohmail/app-logic/writing/compose");
    clearComposeDraft(storageOwner());
    w.unverify = false;
    const ordinary = { ...compose("Ein anderer Entwurf."), draftId: "d5" };
    expect(
      canSend(p.stateOf("compose"), ordinary as unknown as MailSend),
      "an ordinary draft was parked by another message's unresolved send",
    ).toBe(true);
    await act(async () => { p.send(ordinary); });
    await drain();
    expect(w.deliveries.map((d) => d.body), "the ordinary draft did not go out")
      .toEqual(["Ein anderer Entwurf."]);
    expect(
      w.attempts.map((a) => a.key).filter((k) => k !== firstKey),
      "the ordinary draft did not get a key of its own",
    ).toHaveLength(1);
  });

  it("a record named by the SESSION alone still reports the row it acquired", async () => {
    /**
     * The press carried no row, so the record is named `compose:<session>` and the row is written
     * onto it afterwards by `attachSendLockDraft`. Reading only the subject would miss it, and
     * missing it is the recovery door opening on a parked message — the measured duplicate, one
     * step earlier in the same message's life.
     *
     * Mutation: drop the `r.draftId` arm of `unresolvedSendRows` and keep only the subjects.
     */
    const { unresolvedSendRows } = await import("@ohmail/app-logic/writing/send-lock");
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    await act(async () => { p.send(compose("Ohne Zeile.")); });
    await drain();
    expect(jar()[0]!.subject, "the record was not named by the compose session").toMatch(/^compose:/);
    expect(jar()[0]!.draftId, "the press carried a row it should not have").toBeNull();

    // The row appears and the refusal writes it onto the record — `send`'s refused path.
    const withRow = { ...compose("Ohne Zeile."), draftId: "late-row" };
    await act(async () => { p.send(withRow); });
    await drain();
    expect(jar()[0]!.draftId, "the row the message acquired was never attached").toBe("late-row");

    expect(
      [...unresolvedSendRows("compose", storageOwner())],
      "a row acquired after the press is not reported, so reopening it takes the recovery door",
    ).toEqual(["late-row"]);
  });

  it("BOTH rows are reported when the row moved under the record", async () => {
    /**
     * ── WHY `unresolvedSendRows` READS TWO FIELDS AND NOT ONE ─────────────────────────────────
     *
     * The two arms agree for every record written by a press that carried a row: `claimSendLock`
     * writes `draftId` and the subject from the same message, so dropping the SUBJECT arm left
     * every case above green. That is a question, not a licence to delete it — measured, and this
     * is the answer.
     *
     * The record's identity does not move when the row does; only `draftId` is rewritten
     * (`attachSendLockDraft`), and the subject keeps naming the row the key was minted for. So a
     * message whose row moved leaves the record naming `draft:d1` while carrying `draftId: d2`,
     * and BOTH rows are the parked message: reopening either one must not take the recovery door.
     * With only `draftId`, reopening `d1` — the row that is actually in the drafts list, the one
     * the person sees — would recover, mint a third row, and deliver a second copy.
     *
     * Mutation (each arm, one case): drop the `lockSubjects` arm — expected [ 'd2' ] to deeply
     * equal [ 'd1', 'd2' ]; drop the `r.draftId` arm — the case above this one.
     */
    const { unresolvedSendRows } = await import("@ohmail/app-logic/writing/send-lock");
    const w = wire();
    const st = await store();
    const p = await probe(engineOver(st, w));

    w.unverify = true;
    await act(async () => { p.send({ ...compose("Der Zeilenwechsel."), draftId: "d1" }); });
    await drain();
    expect(jar()[0]!.subject, "the record was not named by the row the press carried").toBe("draft:d1");

    // The row moves: the refused press carries d2, and the record records it without re-keying.
    await act(async () => { p.send({ ...compose("Der Zeilenwechsel."), draftId: "d2" }); });
    await drain();
    expect(jar()[0]!.draftId, "the record did not pick up the row the message moved to").toBe("d2");
    expect(jar()[0]!.subject, "the identity moved with the row — it must not").toBe("draft:d1");

    expect(
      [...unresolvedSendRows("compose", storageOwner())].sort(),
      "a row the record still NAMES is not reported, so reopening it takes the recovery door",
    ).toEqual(["d1", "d2"]);
    expect(w.deliveries, "a second reservation was made for one message").toHaveLength(0);
  });

  it("a message this browser cannot name at all is refused, not admitted", async () => {
    /**
     * THE FAIL-CLOSED ARM, pinned beside the rule above it so a later simplification of the
     * intersection cannot quietly turn it into a fail-open. Empty names mean a jar this browser
     * cannot write: no row yet AND no session id. That is not evidence of a different message,
     * and the cost of guessing wrong is a duplicate delivery.
     *
     * Mutation: `if (subjects.length === 0) return false;`.
     */
    const state: SendState = {
      phase: "unverified",
      unresolved: [{ subjects: ["compose:sess-elsewhere"], fp: "some-hash" }],
    };
    const unnameable = compose("Kein Name, kein Raten.") as unknown as MailSend;
    expect(
      canSend(state, unnameable),
      "a message the browser cannot name was admitted while a send was unresolved",
    ).toBe(false);
  });
});

/**
 * ── A RECORD OF THIS BUILD'S FORMAT, OR A LATER ONE, IS KEPT ────────────────────────────────
 *
 * The 0.14.0 and 0.14.1 decoders are retired and `load` drops their records (the census's case a3
 * holds that). What stays is the other half of the same rule: a record this build wrote is untouched
 * by the load, and one from a later format is neither matched, deleted, swept nor aged out, because
 * a downgrade must not eat the evidence a newer install left behind.
 */
describe("a record of this build's format, or a later one, is kept", () => {
  /** A reopened draft — `draftId` stable across a reload, which is what makes a match possible. */
  const REOPENED = {
    kind: "mail_send", inReplyTo: null, forwardOf: null, draftId: "draft-0140",
    mailboxId: "mb", subject: "Hallo",
    to: [{ name: null, address: "lena@atelier.example" }],
    body: "Donnerstag passt.",
  } as unknown as MailSend;
  const OTHER = { ...REOPENED, body: "Ganz andere Nachricht." } as unknown as MailSend;
  const AT = NOW.getTime();
  const jar = (): Array<Record<string, unknown>> =>
    JSON.parse(window.localStorage.getItem(sendLocksKey(storageOwner())) ?? "[]");

  it("(c) a current-format record is untouched by the load", async () => {
    const { resumeSendLock, sendIdentity, claimSendLock, sendFingerprint, SEND_LOCK_FORMAT } =
      await import("@ohmail/app-logic/writing/send-lock");
    claimSendLock({
      v: SEND_LOCK_FORMAT, lane: "compose", key: "KEY-CURRENT", at: AT,
      draftId: "draft-0140", fp: sendFingerprint(REOPENED),
      subject: "draft:draft-0140", session: "sess-current",
    }, NONE_OWED, storageOwner());
    const before = JSON.stringify(jar());
    expect(
      resumeSendLock("compose", sendIdentity(REOPENED, "sess-current"), AT, OWED("KEY-CURRENT"), storageOwner()),
      "a current record stopped resuming its own message",
    ).toBe("KEY-CURRENT");
    expect(JSON.stringify(jar()), "the load rewrote a current-format record").toBe(before);
    expect(
      jar()[0]!.v,
      "the claim was not stamped with this build's format — the load would retire it",
    ).toBe(SEND_LOCK_FORMAT);
  });

  it("(d) a record from a LATER format is neither matched nor deleted", async () => {
    const { resumeSendLock, sendIdentity, allSendLocks } = await import("@ohmail/app-logic/writing/send-lock");
    // Shaped as a build after this one might write it: a version this build has never seen, and a
    // field it knows nothing about, and a fingerprint in an algebra this build does not compute.
    const future = { v: 9, lane: "compose", key: "KEY-FUTURE", at: AT, draftId: "draft-0140",
      fp: "some-later-algebra-hash", unverified: true, somethingNew: { kind: "unknown" } };
    window.localStorage.setItem(sendLocksKey(storageOwner()), JSON.stringify([future]));

    expect(
      resumeSendLock("compose", sendIdentity(REOPENED, "sess-upgrade"), AT, NONE_OWED, storageOwner()),
      "a record from a later format was resumed for a message it does not name",
    ).toBeNull();
    expect(jar(), "a later format's record was deleted by this build").toEqual([future]);
    expect(
      allSendLocks(AT, NONE_OWED, storageOwner()).map((r) => r.key),
      "a later format's record was handed to a caller that cannot read its shape",
    ).toEqual([]);

    // AND a press for a DIFFERENT message on that lane still does not eat it: the spent-record
    // sweep is where the deletion would happen.
    expect(resumeSendLock("compose", sendIdentity(OTHER, "sess-upgrade"), AT, NONE_OWED, storageOwner())).toBeNull();
    expect(jar(), "the spent-record sweep deleted a later format's record").toEqual([future]);
  });

  it("(d2) an ORDINARY record from a later format survives the spent-record sweep", async () => {
    /**
     * (d) uses an `unverified` record, and unverified records are exempt from the sweep for their
     * own reason — so it measures the pair rather than the version condition. Removing that
     * condition left every case green. This is the record that tells the two apart: no
     * `unverified` flag, a fingerprint that does not name the message being pressed, so the ONLY
     * thing standing between it and deletion is that its format is newer than this build's.
     *
     * Keeping it matters because deletion is not recoverable and the record may be load-bearing
     * for the build that wrote it — this one cannot tell whether it is, which is the whole point.
     */
    const { resumeSendLock, sendIdentity } = await import("@ohmail/app-logic/writing/send-lock");
    const ordinaryFuture = { v: 9, lane: "compose", key: "KEY-FUTURE-2", at: AT,
      draftId: null, fp: "some-later-algebra-hash", somethingNew: { kind: "unknown" } };
    window.localStorage.setItem(sendLocksKey(storageOwner()), JSON.stringify([ordinaryFuture]));

    expect(
      resumeSendLock("compose", sendIdentity(REOPENED, "sess-upgrade"), AT, NONE_OWED, storageOwner()),
      "a later format's ordinary record was resumed for a message it does not name",
    ).toBeNull();
    expect(
      jar(),
      "a later format's ordinary record was swept as spent by a build that cannot read it",
    ).toEqual([ordinaryFuture]);
  });

  it("(d3) a later format's record is not AGED OUT either, in either reader", async () => {
    /**
     * The version condition had to hold in three places and held in two. `isLive` is the age
     * limit, it is shared by `resumeSendLock` and `allSendLocks`, and BOTH persist what they
     * keep — so a downgrade running eight days after a newer install left an unresolved send
     * deleted the one record naming the key that send went under. Re-upgrading then minted a
     * fresh key for a message that may already have been delivered, which is the failure this
     * whole file exists to prevent, reached by way of a version nobody here can read.
     *
     * No `unverified` flag on purpose: that flag exempts a record from the limit for its own
     * reason, so a record carrying it would measure the pair rather than the version condition —
     * (d) makes exactly that mistake and is kept for the matching half it does measure.
     *
     * Mutation (one per assertion): delete `if (r.v > SEND_LOCK_FORMAT) return true;` from
     * `isLive`.
     */
    const { resumeSendLock, sendIdentity, allSendLocks, SEND_LOCK_TTL_MS } =
      await import("@ohmail/app-logic/writing/send-lock");
    const aged = { v: 9, lane: "compose", key: "KEY-FUTURE-3", at: AT,
      draftId: null, fp: "some-later-algebra-hash", somethingNew: { kind: "unknown" } };
    const eightDays = AT + SEND_LOCK_TTL_MS + 24 * 60 * 60 * 1000;

    window.localStorage.setItem(sendLocksKey(storageOwner()), JSON.stringify([aged]));
    expect(resumeSendLock("compose", sendIdentity(REOPENED, "sess-upgrade"), eightDays, NONE_OWED, storageOwner())).toBeNull();
    expect(
      jar(),
      "the age sweep inside resumeSendLock deleted a later format's record",
    ).toEqual([aged]);

    window.localStorage.setItem(sendLocksKey(storageOwner()), JSON.stringify([aged]));
    expect(
      allSendLocks(eightDays, NONE_OWED, storageOwner()).map((r) => r.key),
      "a later format's record was handed to a caller that cannot read its shape",
    ).toEqual([]);
    expect(
      jar(),
      "the age sweep inside allSendLocks deleted a later format's record",
    ).toEqual([aged]);
  });
});

/**
 * ── THE FORMAT THIS BUILD WRITES IS PINNED TOO, AND THAT IS WHAT MAKES `3` SAFE TO KEEP ─────
 *
 * 0.14.1 changed what a fingerprint hashes and did NOT bump the version, and two frozen decoders
 * were needed for it until their retirement. The live algebra gets a golden vector of its own, over
 * two fixtures, emitted by the released 0.14.2 tree's own `sendFingerprint` — extracted with
 * `git show` and run unmodified.
 *
 * What it refuses: a change to `sendFingerprint` that leaves `SEND_LOCK_FORMAT` at `3`. Every
 * `v: 3` record on a person's disk is compared against the live function, so such a change
 * silently stops matching them — a second key is minted for a message that may already have
 * gone, which is the delivery this whole file exists to prevent. The remedy when this reddens is
 * never to move the number here: it is to bump `SEND_LOCK_FORMAT` to `4` and keep a frozen decoder
 * for the `v: 3` records until they, too, are retired.
 */
describe("the fingerprint THIS build writes is pinned to the released 0.14.2 output", () => {
  /*
   * ITS OWN FIXTURES, not the describe above's. They are the same two messages, written out here
   * because a pin must not be able to move when somebody edits a fixture belonging to a
   * different algebra's decoder: this block's goldens were emitted over THESE literals, so the
   * two have to travel together.
   */
  const REOPENED = {
    kind: "mail_send", inReplyTo: null, forwardOf: null, draftId: "draft-0140",
    mailboxId: "mb", subject: "Hallo",
    to: [{ name: null, address: "lena@atelier.example" }],
    body: "Donnerstag passt.",
  } as unknown as MailSend;
  const RICH = {
    kind: "mail_send", inReplyTo: null, forwardOf: null, draftId: "draft-rich",
    mailboxId: "mb", threadId: "th-9", subject: "Hallo",
    to: [{ name: "Lena Vogt", address: "Lena@Atelier.Example" }],
    cc: [{ name: null, address: "cc@atelier.example" }],
    body: "plain half", html: "<p>rich half</p>",
    attachments: [{ filename: "glaze.jpg", contentType: "image/jpeg", contentBase64: "AAAABBBB" }],
  } as unknown as MailSend;

  /** Emitted by the released 0.14.2 tree's OWN `sendFingerprint` over the two fixtures above. */
  const GOLDEN_0142 = { REOPENED: "9jdtgt", RICH: "4kb00f" } as const;
  const AT_0142 = new Date("2026-09-08T10:00:00.000Z").getTime();

  it("the live algebra still reproduces what the released 0.14.2 build printed", async () => {
    const { sendFingerprint: live } = await import("@ohmail/app-logic/writing/send-lock");
    for (const [name, m] of [["REOPENED", REOPENED], ["RICH", RICH]] as const) {
      expect(
        live(m),
        `the live fingerprint no longer agrees with what 0.14.2 itself printed for ${name}. If `
          + "the algebra changed on purpose, bump SEND_LOCK_FORMAT and freeze a decoder for the "
          + "records this build has already written — do not move this number",
      ).toBe(GOLDEN_0142[name]);
    }
  });

  it("a v:3 record written by 0.14.2 RESUMES its key for the unchanged message", async () => {
    /*
     * The v:2 case's mirror, for the format this build writes. A person pressed Send, the answer
     * never arrived, the tab reloaded onto a later build, and they press Send again on the same
     * unchanged message: it must go out under the ORIGINAL key so the server replays or verifies
     * rather than sending a second copy.
     */
    const { resumeSendLock, sendIdentity } = await import("@ohmail/app-logic/writing/send-lock");
    window.localStorage.setItem(sendLocksKey(storageOwner()), JSON.stringify([{
      v: 3, lane: "compose", key: "KEY-" + "0142", at: AT_0142, draftId: "draft-0140",
      fp: GOLDEN_0142.REOPENED, subject: "draft:draft-0140", session: "sess-0142",
    }]));
    expect(
      resumeSendLock("compose", sendIdentity(REOPENED, "sess-0142"), AT_0142, OWED("KEY-" + "0142"), storageOwner()),
      "a record this very build wrote was not resumed — the next press mints a fresh key for a "
        + "message that may already have gone",
    ).toBe("KEY-" + "0142");
  });

  it("and does NOT resume for a message that was changed", async () => {
    /* Without this the case above is satisfied by resuming every key for every message, which is
       the silently-unsent half of the pair. */
    const { resumeSendLock, sendIdentity } = await import("@ohmail/app-logic/writing/send-lock");
    window.localStorage.setItem(sendLocksKey(storageOwner()), JSON.stringify([{
      v: 3, lane: "compose", key: "KEY-" + "0142", at: AT_0142, draftId: "draft-0140",
      fp: GOLDEN_0142.REOPENED, subject: "draft:draft-0140", session: "sess-0142",
    }]));
    const changed = { ...(REOPENED as object), body: "Doch lieber Freitag." } as unknown as MailSend;
    expect(
      resumeSendLock("compose", sendIdentity(changed, "sess-0142"), AT_0142, NONE_OWED, storageOwner()),
      "an edited message was handed the key its unedited version went out under",
    ).toBeNull();
  });
});


/**
 * THE FINGERPRINT IS THE LOCK'S MESSAGE IDENTITY, and getting it wrong loses mail rather than
 * duplicating it — the worse of the two, by this file's own header.
 *
 * A resumed key is correct behaviour: the server replays that key's stored outcome and does NOT
 * send again. The fingerprint is what decides whether resuming is the right thing to do at all. If
 * two DIFFERENT messages fingerprint alike, the second one resumes the first one's spent key, the
 * server replays `sent`, and the editor says "Sent." for a message that never went. No server-side
 * guard can cover it: a replay returns before any content is compared.
 */
describe("sendFingerprint — attachments are folded by CONTENT", () => {
  const base = { kind: "mail_send", inReplyTo: "m1", body: "here" } as never;
  const withFile = (b64: string) => ({
    ...(base as object),
    attachments: [{ filename: "invoice.csv", contentType: "text/csv", contentBase64: b64 }],
  }) as never;

  it("a corrected file of the SAME name, type and length is a different message", () => {
    // The measured sequence: attach `amount\n100\n`, notice the figure is wrong, re-pick the
    // corrected `amount\n900\n`. Same length — a changed digit usually is. Folding by length
    // alone matched, the spent key was resumed, and the correction was reported as sent.
    const a = Buffer.from("amount\n100\n", "utf8").toString("base64");
    const b = Buffer.from("amount\n900\n", "utf8").toString("base64");
    expect(a.length, "the premise of the case: identical base64 length").toBe(b.length);
    expect(sendFingerprint(withFile(a))).not.toBe(sendFingerprint(withFile(b)));
  });

  it("the SAME file twice is the same message — the lock still resumes what it should", () => {
    const a = Buffer.from("amount\n100\n", "utf8").toString("base64");
    expect(sendFingerprint(withFile(a))).toBe(sendFingerprint(withFile(a)));
  });

  it("a changed FILENAME at identical content is still a different message", () => {
    const a = Buffer.from("x", "utf8").toString("base64");
    const one = sendFingerprint(withFile(a));
    const two = sendFingerprint({
      ...(base as object),
      attachments: [{ filename: "other.csv", contentType: "text/csv", contentBase64: a }],
    } as never);
    expect(one).not.toBe(two);
  });
});
