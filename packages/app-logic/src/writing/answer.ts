/**
 * A LIST's ANSWER TO A LETTER, through the one composer: Reply and Reply all toggle the reply's editor on that
 * letter, Forward asks before an original that may not be forwarded, and Draft reply opens the editor (keeping the
 * audience it already holds on that letter) and then asks the drafter, where the host hands one. The four arms of
 * today's shell (`apps/webapp/app/shell/shell-verbs.ts`, `onMessageAction`), moved word for word: a place that
 * answers from its rows calls this with what it reads of `useComposer()`, and keeps no way of its own.
 */
import type { EngineMessage } from "@ohmail/wire";
import type { ListAnswer } from "../press/verb-context.js";
import type { ShellCompose } from "./shell-compose.js";

/**
 * The composer's doors an answer takes, and no other: an answer cannot send, save or discard. `replyTo` (the letter
 * whose reply is open) is the mount's own state, which the composer takes as an input and Write's port hands on.
 */
export type ComposerAnswers = Pick<
  ShellCompose,
  "toggleReply" | "openForward" | "openReply" | "replyAll" | "draftReply"
> & {
  readonly replyTo: string | null;
};

export function answerThrough(composer: ComposerAnswers, how: ListAnswer, m: EngineMessage): void {
  switch (how) {
    case "reply":
      composer.toggleReply(m.id);
      return;
    case "reply_all":
      composer.toggleReply(m.id, true);
      return;
    case "forward":
      composer.openForward(m.id, m);
      return;
    case "draft":
      composer.openReply(m.id, composer.replyTo === m.id && composer.replyAll);
      if (composer.draftReply !== null) composer.draftReply.open(m.id);
      return;
  }
}
