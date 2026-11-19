/** @vitest-environment jsdom */
/**
 * THE HELD SEND's SENTENCE STANDS ONLY OVER ITS OWN LETTER (the switch's point 66, PART B; by RULING-JOIN J-1 what an
 * act does is today's). A send nobody could confirm is kept on purpose for as long as it lives, and it parks the
 * letter it belongs to: that letter says "We're not sure this was sent" and offers its answers. Today's composer and
 * reply narrowed the phase they drew to the message on screen (`sendStateFor`), so every NEXT letter on the same
 * surface drew no warning and offered no answers over its live Send. What `write` reads of the composition
 * (`writingOf`) is that narrowed state, for the letter and for the reply; the lock is the send's own rule, unchanged.
 */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import { canSend, sendRefusal, type SendState } from "../../src/writing/mail-send.js";
import { sendFingerprint } from "../../src/writing/send-lock.js";
import type { ShellCompose } from "../../src/writing/shell-compose.js";
import { writingOf, type WritingContext } from "../../src/writing/writing-of.js";

const SCOPE = "acc-narrowed";

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
});

/** A letter (its draft row names it) or a reply (its parent does). */
const letter = (body: string, inReplyTo: string | null = null, draftId: string | null = null) =>
  ({
    kind: "mail_send",
    inReplyTo,
    ...(draftId === null ? {} : { draftId }),
    body,
    subject: "s",
    to: [{ name: null, address: "lena@atelier.example" }],
    mailboxId: "mb",
  }) as never;

/** The send nobody could confirm: it names the letter it belongs to. */
function unverifiedFor(subject: string, m: never): SendState {
  return { phase: "unverified", unresolved: [{ subjects: [subject], fp: sendFingerprint(m) }] } as SendState;
}

const PARENT = {
  id: "m1",
  mailboxId: "mb",
  subject: "Hello",
  from: { name: "Lena", address: "lena@atelier.example" },
  to: [{ name: null, address: "me@atelier.example" }],
  cc: [],
  labels: [],
} as unknown as EngineMessage;

const engine = {
  read: () => ({
    get: (type: string, id: string) => (type === "message" && id === "m1" ? PARENT : undefined),
    list: () => [],
  }),
  verbRead: () => ({ get: () => undefined, list: () => [] }),
} as unknown as OhmailEngine;

function ctx(replyTo: string | null): WritingContext {
  return {
    engine,
    scope: SCOPE,
    replyTo,
    options: [],
    consent: { signatures: {}, signaturesHtml: {}, signaturesKnown: false },
    drafts: [],
    noCredits: false,
    t: ((key: string) => key) as never,
    presented: { get: () => undefined, list: () => [] } as never,
  };
}

/** The composition as far as `writingOf` reads it: the letter on screen, the reply's words, and the one lane's state. */
function composeOver(onScreen: never, lane: SendState, replyBody = "a reply to somebody else"): ShellCompose {
  return {
    compose: {},
    plan: { mutation: onScreen },
    mailSend: { stateOf: () => lane, pressHere: () => true },
    replyMode: "reply",
    replyAll: false,
    replyEnvelope: null,
    replyBody: { text: replyBody, html: "" },
    replyFromId: null,
    replySubjectEdit: null,
    replyAttachments: [],
    replyForwardFiles: null,
    replySendState: () => lane,
    heldReplyRow: () => null,
    composeHeldBySend: false,
    draftReplyChrome: null,
  } as unknown as ShellCompose;
}

describe("the held send's sentence over the letter on screen", () => {
  it("a new letter written after another letter's unverified send draws no warning; the lock is the send's own rule", () => {
    const parked = letter("the letter that may already have gone", null, "d-1");
    const lane = unverifiedFor("draft:d-1", parked);
    const next = letter("a different letter, written after", null, "d-2");
    const w = writingOf(composeOver(next, lane), ctx(null));
    expect(w.composeSend.phase, "a warning about somebody else's mail stands over a live Send").toBe("idle");
    expect(canSend(w.composeSend, next)).toBe(canSend(lane, next));
    expect(sendRefusal(w.composeSend, next)).toBe(sendRefusal(lane, next));
  });

  it("the parked letter itself keeps the warning", () => {
    const parked = letter("the letter that may already have gone", null, "d-1");
    const lane = unverifiedFor("draft:d-1", parked);
    const w = writingOf(composeOver(parked, lane), ctx(null));
    expect(w.composeSend.phase).toBe("unverified");
  });

  it("a reply to another letter, written after a reply's unverified send on the lane, draws no warning", () => {
    const other = letter("the reply that may already have gone", "giulia");
    const lane = unverifiedFor("reply:giulia", other);
    const w = writingOf(composeOver(letter("x"), lane), ctx("m1"));
    expect(w.reply?.send.phase, "a reply's warning stands over a reply it is not about").toBe("idle");
    expect(w.reply?.refusal ?? null).toBe(null);
  });

  it("CONTROL: a phase nobody named keeps its warning on both (fail closed)", () => {
    const lane = { phase: "unverified" } as SendState;
    const w = writingOf(composeOver(letter("x"), lane), ctx("m1"));
    expect({ letter: w.composeSend.phase, reply: w.reply?.send.phase }).toEqual({
      letter: "unverified",
      reply: "unverified",
    });
  });
});
