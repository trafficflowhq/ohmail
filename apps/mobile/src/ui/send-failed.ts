/**
 * WHAT A REFUSED SEND SAYS IN THE COMPOSER. The toast and the top bar's connection line render
 * beneath the composer's Modal, so a refusal said only there answers a press nobody can see: the
 * sheet says it itself, above its buttons. Chosen here (no React Native renderer in this
 * workspace) and read out of `MessageActions.tsx` by its test.
 *
 * The offline sentence needs both facts it states: the phone's own connection verdict says the
 * mail server cannot be reached, and the refused send left a row the composer holds.
 */
import { Copy } from "../copy";
import type { ConnectionSay, FailedSendCopy } from "../state/live";

export function failedSendLine(kind: FailedSendCopy, connection: ConnectionSay | null, kept: boolean): string {
  const offline = connection !== null && (connection.kind === "lost" || connection.kind === "gone");
  if ((kind === "replyFailed" || kind === "replyUnreachable") && offline && kept) return Copy.composeNotSentOffline;
  return Copy[kind];
}
