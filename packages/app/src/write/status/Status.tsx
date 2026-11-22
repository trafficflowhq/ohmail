/**
 * WHAT HAPPENED TO THE LETTER, over its lines: the send line's sentence for the state the composition hands, the
 * offline sentence while the browser is offline and the letter waits, and the two answers for a send nobody can
 * confirm. Nothing here decides whether a letter may go: Send's state is the composition's.
 */
import { useContext, useEffect, useState, type ReactNode } from "react";
import { SendStatus, type SendStatusProps } from "@ohmail/ui/mail";
import { SENDING_LONG_MS, type SendState } from "@ohmail/app-logic/writing/mail-send";
import { useText } from "../../text/index.js";
import { FrameContext } from "../../frame/commands.js";
import { useWriteBeside, useWriting } from "../above.js";
import { HeldSendAnswers } from "../HeldSendAnswers.js";
import { statusWords } from "./status-words.js";
import type { WriteBeside } from "../ports.js";

/** Where the letter's send line stands: over the people for a send nobody can confirm or cannot see the end of, else
 * over the foot; null: the send says nothing. */
export function sendLineAt(
  send: SendState,
  held: string | null,
  locked: string | null,
  beside: Pick<WriteBeside, "sendLine">,
): "top" | "foot" | null {
  if (locked !== null) return "top";
  if (beside.sendLine(send, sendingLong(send)) === null) return null;
  return held !== null && send.phase === "unverified" ? "top" : "foot";
}

const sendingLong = (send: SendState): boolean =>
  send.since !== undefined && Date.now() - send.since >= SENDING_LONG_MS;

/**
 * A send still going when it crosses the threshold is drawn again then, so the line says it is still sending without
 * waiting for anything else to draw it (the long line is read from the send's own stamp at each draw).
 */
function useSendingLongDrawn(send: SendState): void {
  const [, redraw] = useState(0);
  const since = send.since;
  useEffect(() => {
    if (since === undefined) return undefined;
    const left = since + SENDING_LONG_MS - Date.now();
    if (left <= 0) return undefined;
    const timer = setTimeout(() => redraw((n) => n + 1), left);
    return () => clearTimeout(timer);
  }, [since]);
}

export function Status({
  at,
  send,
  held,
  locked,
  showShortSending = false,
  onResolve,
}: {
  /**
   * Which of the letter's places draws it: `top` over the people (a send nobody can confirm, a send this letter
   * cannot see the end of), `foot` over the foot (what happened to a send: why it was not sent, that it is on its
   * way); `one`, every line over the people (the reply, whose foot line is not ruled yet).
   */
  at: "top" | "foot" | "one";
  send: SendState;
  /** The row of a send that is not confirmed: its two answers are offered. */
  held: string | null;
  /** The sentence of a send this letter cannot see the end of. */
  locked: string | null;
  /** Show the short sending line when the same letter is reopened after hand-off. */
  showShortSending?: boolean;
  onResolve: (draftId: string, outcome: "arrived" | "not_arrived") => void;
}) {
  const t = useText("write");
  const frameText = useText("frame");
  const frame = useContext(FrameContext);
  const beside = useWriteBeside();
  useSendingLongDrawn(send);
  const where = sendLineAt(send, held, locked, beside);
  if (where === null || (at !== "one" && at !== where)) return null;
  if (locked !== null) return <SendStatus place="top">{locked}</SendStatus>;
  const line = beside.sendLine(send, sendingLong(send))!;
  if (line.key === "statusSending" && !showShortSending) return null;
  const place = at === "one" ? "top" : where;
  const offline = send.phase === "queued" && send.accepted !== true && !beside.online();
  const words = offline ? t("status.offline") : statusWords(t, line.key, beside);
  const verdict = t("status.notSentVerdict");
  const hasVerdict = words.startsWith(`${verdict} `);
  const status = (acts?: SendStatusProps["acts"]) => (
    <SendStatus
      place={place}
      verdict={hasVerdict ? verdict : undefined}
      sign={line.tone === "pending" ? "clock" : undefined}
      acts={acts}
    >
      {hasVerdict ? words.slice(verdict.length + 1) : words}
    </SendStatus>
  );
  if (line.key === "statusNotSignedIn" && frame !== null) {
    return status([
      {
        label: frameText("connection.act.mailboxes"),
        onPress: () => frame.api.commands.go({ place: "settings", sub: "mailboxes" }),
      },
    ]);
  }
  if (held === null || send.phase !== "unverified") return status();
  return (
    <HeldSendAnswers draftId={held} onResolve={onResolve} sentLabel={t("held.itWasSent")}>
      {(again, sent) => status([again, sent])}
    </HeldSendAnswers>
  );
}

/** The new letter's send line, in the place it stands: over the people, or over the foot; null where it says nothing. */
export function useLetterSendLines(): { top: ReactNode; foot: ReactNode } {
  const w = useWriting();
  const beside = useWriteBeside();
  const held = w.composeHeld?.draftId ?? null;
  const locked = w.composeLocked?.sentence ?? null;
  const said = {
    send: w.composeSend,
    held,
    locked,
    showShortSending: w.composeReopenedSending,
    onResolve: w.resolveHeldSend,
  };
  const at = sendLineAt(w.composeSend, held, locked, beside);
  return {
    top: at === "top" ? <Status at="top" {...said} /> : null,
    foot: at === "foot" ? <Status at="foot" {...said} /> : null,
  };
}
