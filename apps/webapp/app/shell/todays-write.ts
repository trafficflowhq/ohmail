/**
 * TODAY'S COMPOSITION, AS THE NEW SCREEN READS IT: the composer record (`useShellCompose`) handed to `write` as its
 * `Writing`, with the members today's shell derives at the old view's mount derived here the same way, and the
 * shell's pure helpers as its `WriteBeside`. Nothing mounts it but its cases until a host seats the place `write`.
 */
import type { useTranslations } from "next-intl";
import type { EngineDraft, FromOption, OhmailEngine } from "@ohmail/client-engine";
import { addressBook, effectiveSignature, effectiveSignatureHtml, matchAddresses } from "@ohmail/client-engine";
import { composeSessionId, readComposeRow } from "@ohmail/app-logic/writing/compose";
import {
  COMPOSE_SEND_KEY,
  composeStateOnScreen,
  heldRowUnverified,
} from "@ohmail/app-logic/writing/mail-send";
import { holdOf } from "@ohmail/app-logic/writing/send-lock";
import type { Writing, WriteBeside } from "@ohmail/app/write";
import type { ConsentState } from "@ohmail/app-logic/consent/consent-state";
import { composedLocalInput, localInputValue, scheduleLabel, sendLaterMornings, todayEvening } from "./format";
import { activeFormatZone } from "./locale";
import { gatedInvalid, joinRecipients, moveRecipient, splitRecipients } from "./RecipientField";
import { filesNotKeptFor, useScheduleFiles } from "./schedule-files";
import type { ShellCompose } from "./shell-compose";
import { fileSize, sendLine, sendLineValues } from "./SendStatus";
import { replyOf } from "./todays-write-reply";
import { compressImage, readImageQualityLevel, writeImageQualityLevel } from "../components/image-quality";

/** A time for Send later must stand this far ahead of the press (today's composer's floor). */
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
  readonly t: ReturnType<typeof useTranslations>;
}

/** The composition as `write` reads it: the record's own members, and the derived ones as the old view's mount has them. */
export function writingOf(compose: ShellCompose, ctx: WritingContext): Writing {
  const { engine, scope, t } = ctx;
  const row = readComposeRow(scope);
  const hold = holdOf(engine, { lane: COMPOSE_SEND_KEY, draftId: row, session: composeSessionId(scope) }, scope);
  const send = heldRowUnverified(
    composeStateOnScreen(compose.mailSend.stateOf(COMPOSE_SEND_KEY), compose.mailSend.pressHere(COMPOSE_SEND_KEY)),
    row,
    hold,
    composeSessionId(scope),
  );
  return {
    compose: compose.compose,
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
    heldReplyRow: compose.heldReplyRow,
    sendReply: (messageId) => compose.sendReply(messageId),
    openReply: compose.openReply,
    openForward: compose.openForward,
    confirmForward: compose.confirmForward,
    forwardAsk: compose.forwardAsk,
    closeReply: compose.closeReply,
    discardRefusal: compose.discardRefusal,
    resolveHeldSend: compose.resolveHeldSend,
    draftReply: compose.draftReply,
    draftReplyChrome: ctx.noCredits ? { ...compose.draftReplyChrome, noCredits: true } : compose.draftReplyChrome,
    openDraft: compose.openDraft,
    writeTo: (address, name) => compose.writeTo(address, name),
    composeSend: send,
    composeLocked: compose.composeHeldBySend
      ? { sentence: t(engine.outboxUnreadable?.() === true ? "compose.sendingOutboxUnread" : "compose.sendingFromLastSession") }
      : null,
    composeHeld: row !== null && send.phase === "unverified" ? { draftId: row } : null,
    composeFilesNotKept: filesNotKeptFor(ctx.drafts, row),
    signatures: ctx.consent.signaturesKnown
      ? { text: ctx.consent.signatures, html: ctx.consent.signaturesHtml }
      : "unknown",
    discardCompose: compose.discardCompose,
    discardReply: compose.discardReply,
  };
}

/**
 * The shell's pure helpers beside the screen, for the session's storage scope. `surfaceMax` is the shell's own
 * `sendSurfaceMaxTotalBytes`: absent, the hosted request's strict bound; null, none of the window's own. `metered`:
 * the host's managed-service fact (`useManagedService`), whether a draft's price is said.
 */
export function todaysWriteBeside(
  engine: OhmailEngine,
  scope: string,
  surfaceMax: number | null | undefined,
  metered: boolean,
): WriteBeside {
  return {
    scope,
    metered,
    surface: surfaceMax === undefined ? "strict" : surfaceMax === null ? "mailbox" : surfaceMax,
    online: () => typeof navigator === "undefined" || navigator.onLine !== false,
    sendLine,
    sendLineValues,
    lines: {
      split: splitRecipients,
      join: joinRecipients,
      move: ({ rows, move }) => moveRecipient({ ...rows }, { ...move }),
      refused: gatedInvalid,
    },
    suggest: (typed, taken) => {
      const skip = new Set(taken.map((a) => a.toLowerCase()));
      return matchAddresses(addressBook(engine.read()), typed.trim(), 6)
        .filter((e) => !skip.has(e.address))
        .map((e) => ({ name: e.name, address: e.address, they: e.name !== "" }));
    },
    later: {
      options: (now) => {
        const base = new Date(now);
        const evening = todayEvening(base).instant;
        const { tomorrow, monday } = sendLaterMornings(base);
        return [
          ...(evening.getTime() - now > SEND_LATER_FLOOR_MS ? [{ id: "evening", at: evening.toISOString() }] : []),
          { id: "tomorrow", at: tomorrow },
          ...(monday !== null ? [{ id: "monday", at: monday }] : []),
        ];
      },
      floor: (now) => now + SEND_LATER_FLOOR_MS,
      label: (at) => scheduleLabel(at, new Date()),
      seed: (now) => {
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
      compose: (value, notBefore) => {
        const c = composedLocalInput(value, new Date(notBefore));
        if (c === null) return null;
        const two = (n: number): string => String(n).padStart(2, "0");
        return {
          at: c.instant.toISOString(),
          shifted:
            c.verdict === "shifted_forward" ? { booked: `${two(c.hour)}:${two(c.minute)}`, asked: value.slice(11, 16) } : null,
        };
      },
      zone: activeFormatZone,
      useFiles: (asking) => useScheduleFiles(engine, asking),
    },
    size: fileSize,
    signature: (state, mailboxId, stored) => {
      const text = effectiveSignature(state, stored.text, mailboxId);
      return text === null ? null : { text, html: effectiveSignatureHtml(state, stored.html, mailboxId) };
    },
    pictures: {
      level: () => readImageQualityLevel(scope),
      setLevel: (level) => writeImageQualityLevel(level, scope),
      compress: async (file, level) => {
        const picture = await compressImage(file, level);
        return { blob: picture.blob, contentType: picture.contentType };
      },
    },
  };
}
