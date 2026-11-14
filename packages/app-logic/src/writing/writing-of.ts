/**
 * THE COMPOSITION, AS THE SCREEN READS IT: the one composer's record (`useShellCompose`) as the screen `write` takes
 * it (its `Writing`, member for member), with the members a caller derives of it (the send on screen, the hold and
 * its row, the reply planned, the signatures once they are known), and the pure helpers beside the screen (its
 * `WriteBeside`). The screen's own types are the screen's: what these two answer is checked against them where the
 * composer's one mount hands it over (`WritingMount.tsx` of the mail ground), and a case calls them over a
 * composition of its own.
 */
import type { EngineDraft } from "@ohmail/wire";
import type {
  EntityReader,
  FromOption,
  ImageQualityLevel,
  OhmailEngine,
  SignatureState,
} from "@ohmail/client-engine";
import {
  addressBook,
  effectiveSignature,
  effectiveSignatureHtml,
  matchAddresses,
  sendAndDonePlanFor,
} from "@ohmail/client-engine";
import type { ConsentState } from "../consent/consent-state.js";
import { activeFormatZone } from "../text/format-words.js";
import {
  composedLocalInput,
  localInputValue,
  scheduleLabel,
  sendLaterMornings,
  todayEvening,
} from "../text/format.js";
import type { Translator } from "../text/translator.js";
import type { SendSurface } from "../write/files.js";
import { compressImage, readImageQualityLevel, writeImageQualityLevel } from "../write/image-quality.js";
import { readComposeRow, readComposeSession } from "./compose.js";
import { DRAFT_REPLY_COST_CREDITS, NEW_LETTER, type DraftReplyControl } from "./draft-reply.js";
import { COMPOSE_SEND_KEY, composeStateOnScreen, heldRowUnverified, sendStateFor } from "./mail-send.js";
import {
  gatedInvalid,
  joinRecipients,
  moveRecipient,
  splitRecipients,
  type RecipientMove,
} from "./recipient-lines.js";
import { filesNotKeptFor, useScheduleFiles } from "./schedule-files.js";
import { sendLine, sendLineValuesOver } from "./send-line.js";
import { holdOf } from "./send-lock.js";
import type { ShellCompose } from "./shell-compose.js";
import { replyOf } from "./writing-reply.js";

/** A time for Send later must stand this far ahead of the press (the composer's floor). */
export const SEND_LATER_FLOOR_MS = 3 * 60_000;

export interface WritingContext {
  readonly engine: OhmailEngine;
  /** Whose letter this is: the session's storage scope. Required; never defaulted. */
  readonly scope: string;
  readonly replyTo: string | null;
  /** The account's sendable addresses (the mailbox facts' options); empty while they cannot be seen. */
  readonly options: readonly FromOption[];
  readonly consent: Pick<ConsentState, "signatures" | "signaturesHtml" | "signaturesKnown">;
  readonly drafts: readonly EngineDraft[];
  /** The account's balance was last refused as empty (the Screener's standing): the draft control says so, no price. */
  readonly noCredits: boolean;
  /** The whole catalogue's reader, as the composer is handed it. */
  readonly t: Translator;
  /** The letters as the Ohbox shows them (the composer's own `presented`): where Send + Done is offered. */
  readonly presented: EntityReader;
}

const NOTHING = (): void => undefined;

/**
 * The screen's draft control over a host that names no drafter. The composer answers no control there (`null`): no
 * hook stands behind this one, so it draws nothing (`offered: false`) and none of its doors can ask anything.
 */
type NotOffered = {
  readonly [K in keyof DraftReplyControl]: K extends "offered" ? false : DraftReplyControl[K];
};
const NO_DRAFTER: NotOffered = {
  offered: false,
  phase: "closed",
  messageId: null,
  cost: DRAFT_REPLY_COST_CREDITS,
  notice: null,
  open: NOTHING,
  cancel: NOTHING,
  confirm: NOTHING,
  press: NOTHING,
  fromText: "none",
  letter: "none",
  letterId: NEW_LETTER,
  own: new Map(),
  keep: NOTHING,
  forget: NOTHING,
  moved: NOTHING,
  restore: NOTHING,
};
const NO_DRAFT_CHROME = { control: NO_DRAFTER, pending: null, resolve: NOTHING };

/**
 * SEND + DONE, offered per letter by the engine's one rule, asked of the letters as the Ohbox shows them and never of
 * the raw mirror (a letter a rule presents under Reads still stands in INBOX there). The press is the composer's own
 * `pressSendAndDone`, which reads the rule again at the press: a render and a press are two moments.
 */
function sendAndDoneFor(
  compose: ShellCompose,
  presented: EntityReader,
  messageId: string,
): (() => void) | null {
  return sendAndDonePlanFor(presented, messageId) === null ? null : () => compose.pressSendAndDone(messageId);
}

/** The composition as `write` reads it: the record's own members, and the ones a caller derives of it. */
export function writingOf(compose: ShellCompose, ctx: WritingContext) {
  const { engine, scope, t } = ctx;
  const row = readComposeRow(scope);
  /* Read in a render, so never minted: a render writes no key of the account. None names no record. */
  const session = readComposeSession(scope);
  const hold = holdOf(engine, { lane: COMPOSE_SEND_KEY, draftId: row, session }, scope);
  /* THE STATE AS IT APPLIES TO THE LETTER ON SCREEN (`sendStateFor`): a send nobody could confirm parks the letter it
     belongs to, and its warning and answers stand over that letter alone; the next letter on the lane draws neither.
     Narrowed for what is drawn, not for the rule: the send's gate answers the same over either. */
  const send = sendStateFor(
    heldRowUnverified(
      composeStateOnScreen(
        compose.mailSend.stateOf(COMPOSE_SEND_KEY),
        compose.mailSend.pressHere(COMPOSE_SEND_KEY),
      ),
      row,
      hold,
      session,
    ),
    compose.plan.mutation,
  );
  return {
    compose: compose.compose,
    composeEpochNow: compose.composeEpochNow,
    onComposeFields: compose.onComposeFields,
    plan: compose.plan,
    composeFrom: compose.composeFrom,
    composeElsewhere: compose.composeElsewhere,
    composeSaveRefused: compose.composeSaveRefused,
    composeResumed: compose.composeResumed,
    composeWaitNote: compose.composeWaitNote,
    composeCloseRefusal: compose.composeCloseRefusal,
    composeForwardFiles: compose.composeForwardFiles,
    sendCompose: compose.sendCompose,
    closeCompose: compose.closeCompose,
    discardKeepsCompose: compose.discardKeepsCompose,
    replyTo: ctx.replyTo,
    reply: replyOf(compose, { engine, replyTo: ctx.replyTo, options: ctx.options }),
    replyMode: compose.replyMode,
    replyAll: compose.replyAll,
    replyBody: compose.replyBody,
    onReplyBody: compose.onReplyBody,
    replyEnvelope: compose.replyEnvelope,
    setReplyEnvelope: compose.setReplyEnvelope,
    replyFromId: compose.replyFromId,
    setReplyFromId: compose.setReplyFromId,
    replySig: compose.replySig,
    onReplySig: compose.onReplySig,
    replySubjectEdit: compose.replySubjectEdit,
    onReplySubject: compose.onReplySubject,
    replyAttachments: compose.replyAttachments,
    setReplyAttachments: compose.setReplyAttachments,
    replyForwardFiles: compose.replyForwardFiles,
    replyBook: compose.replyBook,
    replySendState: compose.replySendState,
    showSend: compose.mailSend.showing,
    heldReplyRow: compose.heldReplyRow,
    sendReply: (messageId: string) => compose.sendReply(messageId),
    sendReplyAndDone: (messageId: string) => sendAndDoneFor(compose, ctx.presented, messageId),
    openReply: compose.openReply,
    openForward: compose.openForward,
    confirmForward: compose.confirmForward,
    forwardAsk: compose.forwardAsk,
    closeReply: compose.closeReply,
    discardRefusal: compose.discardRefusal,
    resolveHeldSend: compose.resolveHeldSend,
    draftReply: compose.draftReply ?? NO_DRAFTER,
    draftReplyChrome:
      compose.draftReplyChrome === null
        ? NO_DRAFT_CHROME
        : ctx.noCredits
          ? { ...compose.draftReplyChrome, noCredits: true }
          : compose.draftReplyChrome,
    openDraft: compose.openDraft,
    writeTo: (address: string, name?: string) => compose.writeTo(address, name),
    composeSend: send,
    composeLocked: compose.composeHeldBySend
      ? {
          sentence: t(
            engine.outboxUnreadable?.() === true
              ? "compose.sendingOutboxUnread"
              : "compose.sendingFromLastSession",
          ),
        }
      : null,
    composeHeld: row !== null && send.phase === "unverified" ? { draftId: row } : null,
    composeFilesNotKept: filesNotKeptFor(ctx.drafts, row),
    signatures: ctx.consent.signaturesKnown
      ? { text: ctx.consent.signatures, html: ctx.consent.signaturesHtml }
      : ("unknown" as const),
    discardCompose: compose.discardCompose,
    discardReply: compose.discardReply,
  };
}

/** The three recipient rows of a letter, as their wire strings. */
interface Rows {
  to: string;
  cc: string;
  bcc: string;
}
/** The account's stored signatures by mailbox, with their formatted halves. */
interface Stored {
  readonly text: Readonly<Record<string, string>>;
  readonly html: Readonly<Record<string, string>>;
}

/**
 * The pure helpers beside the screen, for the session's storage scope. `surface` is the host's own answer for what
 * one send may carry (its `sendCeiling`: the hosted request's strict bound, the mailbox's own, or a number of bytes),
 * handed on as the host says it. `metered`: whether the host is the managed service, where a draft's price is said.
 * `size`: a file's size in the person's language, as whoever holds the size words says it. `online`: whether the
 * device is on a network now, asked at the press by whoever reads the device's own fact.
 */
export function writeBesideOf(
  engine: OhmailEngine,
  scope: string,
  surface: SendSurface,
  metered: boolean,
  size: (bytes: number) => string,
  online: () => boolean,
) {
  return {
    scope,
    metered,
    surface,
    online,
    sendLine,
    sendLineValues: () => sendLineValuesOver(size),
    lines: {
      split: splitRecipients,
      join: joinRecipients,
      move: ({ rows, move }: { rows: Readonly<Rows>; move: Readonly<RecipientMove> }) =>
        moveRecipient({ ...rows }, { ...move }),
      refused: gatedInvalid,
    },
    suggest: (typed: string, taken: readonly string[]) => {
      const skip = new Set(taken.map((a) => a.toLowerCase()));
      return (
        matchAddresses(addressBook(engine.read()), typed.trim(), 6)
          .filter((e) => !skip.has(e.address))
          /* `they`: somebody who wrote to the account and whom it never wrote to, said beside the name. */
          .map((e) => ({ name: e.name, address: e.address, they: e.evidence === "they_wrote" }))
      );
    },
    later: {
      options: (now: number) => {
        const base = new Date(now);
        const evening = todayEvening(base).instant;
        const { tomorrow, monday } = sendLaterMornings(base);
        return [
          ...(evening.getTime() - now > SEND_LATER_FLOOR_MS
            ? [{ id: "evening", at: evening.toISOString() }]
            : []),
          { id: "tomorrow", at: tomorrow },
          ...(monday !== null ? [{ id: "monday", at: monday }] : []),
        ];
      },
      floor: (now: number) => now + SEND_LATER_FLOOR_MS,
      label: (at: string) => scheduleLabel(at, new Date()),
      seed: (now: number) => {
        /* Ceiled to the next whole minute (the field holds minutes), and checked through the inverse: in an autumn
           fold the seeded clock names two instants and the earlier one can sit under the floor; then an hour on. */
        const seedOf = (ms: number): string =>
          localInputValue(new Date(Math.ceil(ms / 60_000) * 60_000).toISOString());
        const seed = seedOf(now + SEND_LATER_FLOOR_MS);
        const inverse = composedLocalInput(seed, new Date(now + SEND_LATER_FLOOR_MS));
        return inverse === null || inverse.instant.getTime() - now < SEND_LATER_FLOOR_MS
          ? seedOf(now + SEND_LATER_FLOOR_MS + 3_600_000)
          : seed;
      },
      compose: (value: string, notBefore: number) => {
        const c = composedLocalInput(value, new Date(notBefore));
        if (c === null) return null;
        const two = (n: number): string => String(n).padStart(2, "0");
        return {
          at: c.instant.toISOString(),
          shifted:
            c.verdict === "shifted_forward"
              ? { booked: `${two(c.hour)}:${two(c.minute)}`, asked: value.slice(11, 16) }
              : null,
        };
      },
      zone: activeFormatZone,
      useFiles: (asking: boolean) => useScheduleFiles(engine, asking),
    },
    size,
    signature: (state: SignatureState, mailboxId: string | null, stored: Stored) => {
      const text = effectiveSignature(state, stored.text, mailboxId);
      return text === null ? null : { text, html: effectiveSignatureHtml(state, stored.html, mailboxId) };
    },
    pictures: {
      level: () => readImageQualityLevel(scope),
      setLevel: (level: ImageQualityLevel) => writeImageQualityLevel(level, scope),
      compress: async (file: Blob, level: ImageQualityLevel) => {
        const picture = await compressImage(file, level);
        return { blob: picture.blob, contentType: picture.contentType };
      },
    },
  };
}
