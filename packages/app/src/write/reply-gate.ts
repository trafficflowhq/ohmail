/**
 * THE REPLY's GATE AND ITS PANEL: whether Send may take the reply now, and the refusals its press says in words (past
 * the draft ceiling; nothing to send); and Send, Send + Done and Discard published to the reading sheet's one panel
 * while the reply stands. Moved out of `Reply.tsx` as they stood.
 */
import { useModGlyph } from "@ohmail/app-logic/keys";
import { useEffect, useMemo, useRef } from "react";
import { inlineForwardKey, SEND_IN_FLIGHT_PHASES } from "@ohmail/app-logic/writing/mail-send";
import { usePublishVerbs, useWriteBeside, useWriting } from "./above.js";
import type { WriteReply } from "./ports.js";
import { useText } from "../text/index.js";
import { useNeedsContent, type NeedsContent } from "./status/needs-content.js";
import { useOverLimit } from "./status/over-limit.js";
import { discardVerb, sendAndDoneVerb, sendVerb, sendWaits } from "./verbs/Verbs.js";

import { SEND_AND_DONE_KEY, SEND_KEY, writingKey } from "./keys.js";

const NOTHING = (): void => undefined;

/**
 * The send's own gate decides; a file still being read is not on the reply yet. PAST THE DRAFT CEILING, and WITH
 * NOTHING TO SEND, Send stays pressable: its press (or the chord) sends nothing and says why.
 */
export function useReplyGate(
  reply: WriteReply,
  attaching: boolean,
): {
  readonly mayGo: boolean;
  readonly tooLong: boolean;
  readonly longLine: string | null;
  readonly refused: () => void;
  readonly empty: NeedsContent & { readonly sentence: string };
} {
  const tr = useText("reply");
  const tc = useText("compose");
  const w = useWriting();
  const beside = useWriteBeside();
  const long = useOverLimit(
    { refusal: reply.refusal, held: attaching, words: { body: w.replyBody.text, html: w.replyBody.html } },
    {
      send: () => tr("sendTooLong", beside.sendLineValues()),
      save: () => tr("bodyTooLong", beside.sendLineValues()),
    },
  );
  const draft = w.draftReplyChrome.control;
  const previewing =
    reply.mode !== "forward" && draft.preview !== undefined && draft.messageId === reply.messageId;
  const sentence = tc("needContent");
  const empty = useNeedsContent({ refusal: reply.refusal, held: attaching }, sentence);
  return {
    mayGo: reply.refusal === null && !attaching && !previewing,
    tooLong: long.tooLong,
    longLine: long.line,
    refused: long.refused,
    empty: { ...empty, sentence },
  };
}

/** The reply shows its send while it stands: its ending is said here, once, and not again in the frame's report. */
export function useShowsSend(reply: WriteReply): void {
  const { showSend } = useWriting();
  const lane = reply.mode === "forward" ? inlineForwardKey(reply.messageId) : reply.messageId;
  useEffect(() => showSend(lane), [showSend, lane]);
}

/** The panel's verbs for this reply over its gate; Send presses through `send` (the signature's own order). */
export function useReplyVerbs(
  reply: WriteReply,
  gate: ReturnType<typeof useReplyGate>,
  send: () => void,
): void {
  const w = useWriting();
  const waits = sendWaits(reply.send.phase);
  useReplyPanel({
    send,
    done: w.sendReplyAndDone(reply.messageId),
    /* While its send only waits, Discard is the reply's Cancel: the send withdrawn first, the words kept as one draft. */
    discard: waits ? w.closeReply : w.discardReply,
    gate: {
      mayGo: gate.mayGo,
      tooLong: gate.tooLong,
      refused: gate.refused,
      going: SEND_IN_FLIGHT_PHASES.has(reply.send.phase),
      waits,
      empty: gate.empty.empty ? { sentence: gate.empty.sentence, told: gate.empty.told } : null,
      busy: reply.send.phase === "sending",
    },
  });
}

/**
 * Send, Send + Done and Discard stand in the reading sheet's one panel while this reply stands: handed there, each
 * press reading the reply as it is when pressed. Past the draft ceiling the two sends rest and their press says why.
 */
function useReplyPanel(p: {
  readonly send: () => void;
  readonly done: (() => void) | null;
  readonly discard: () => void;
  readonly gate: {
    readonly mayGo: boolean;
    readonly tooLong: boolean;
    readonly refused: () => void;
    readonly going: boolean;
    readonly waits: boolean;
    /** Nothing to send: the reason Send and Send + Done say, and the press that says it in place. */
    readonly empty: { readonly sentence: string; readonly told: () => void } | null;
    /** The reply going out now. */
    readonly busy: boolean;
  };
}): void {
  const t = useText("write");
  const tr = useText("reply");
  const mod = useModGlyph();
  const { mayGo, tooLong, refused, going, waits, empty, busy } = p.gate;
  const sentence = empty?.sentence;
  const presses = useRef({ send: p.send, done: NOTHING, discard: p.discard });
  presses.current = {
    send: p.send,
    done: () =>
      mayGo && p.done !== null ? p.done() : tooLong ? refused() : empty !== null ? empty.told() : undefined,
    discard: p.discard,
  };
  const offersDone = p.done !== null;
  const sendWord = t("send");
  const doneWord = tr("sendAndDone");
  const discardWord = t("discard");
  const verbs = useMemo(
    () => [
      {
        ...sendVerb(sendWord, mayGo, going, () => presses.current.send(), tooLong, {
          ...(sentence === undefined ? {} : { refused: sentence }),
          busy,
        }),
        ...writingKey(SEND_KEY, mod),
        shortcutWhileWriting: true,
      },
      ...(offersDone
        ? [
            {
              ...sendAndDoneVerb(doneWord, mayGo, going, () => presses.current.done(), tooLong, {
                ...(sentence === undefined ? {} : { refused: sentence }),
              }),
              ...writingKey(SEND_AND_DONE_KEY, mod),
            },
          ]
        : []),
      discardVerb(discardWord, going && !waits, () => presses.current.discard()),
    ],
    [mod, sendWord, doneWord, discardWord, mayGo, tooLong, going, waits, sentence, busy, offersDone],
  );
  usePublishVerbs(verbs);
}
