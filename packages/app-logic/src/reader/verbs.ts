/**
 * THE READER'S OWN RUNNERS: what a verb on one letter does where no list handed the column its visit (with a
 * visit, every verb takes the list's own path, `visit.act`). Plain functions of the one press seam: each act leaves
 * through it, and its sentence and its Undo come from it. The same mutations the web shell's message verbs send for
 * one letter off the Ohbox.
 */
import type { EngineMessage } from "@ohmail/client-engine";
import type { MessageAction } from "../press/actions.js";
import type { ShellDispatch } from "../press/shell-dispatch.js";
import { markSeenOver } from "./mark-seen.js";

/** The sentences the runners say, in the reader's own words. */
export interface VerbWords {
  readonly queued: string;
  readonly aside: string;
  readonly unqueued: string;
  readonly unparked: string;
  readonly resurfaces: (when: string) => string;
  readonly resurfaceNow: string;
}

/** The verbs a reader runs itself; the rest are offered only where a list's visit stands. */
export type OwnVerb = "later" | "aside" | "unread" | "resurface_now" | `resurface:${string}` | "delete";

export function isOwnVerb(action: MessageAction): action is OwnVerb {
  return (
    action === "later" ||
    action === "aside" ||
    action === "unread" ||
    action === "resurface_now" ||
    action === "delete" ||
    action.startsWith("resurface:")
  );
}

type Press = Pick<ShellDispatch, "mutateAndReport" | "deleting">;
type Letter = Pick<EngineMessage, "id" | "mailboxId" | "unread" | "triage">;

/**
 * Run `action` on `m`. `whenLabel` says an instant as the sentence wants it. Answers whether it acted: a refused
 * delete (a reader install moves nothing) answers false and the seam has said why.
 */
export function runOwnVerb(
  press: Press,
  words: VerbWords,
  action: OwnVerb,
  m: Letter,
  whenLabel: (iso: string) => string,
): boolean {
  switch (action) {
    case "later":
    case "aside": {
      const state = action === "later" ? ("reply_later" as const) : ("set_aside" as const);
      const off = m.triage?.state === state;
      void press.mutateAndReport(
        { kind: "triage_set", messageId: m.id, state: off ? "none" : state },
        off
          ? action === "later"
            ? words.unqueued
            : words.unparked
          : action === "later"
            ? words.queued
            : words.aside,
      );
      return true;
    }
    case "unread":
      // A read here is a read in ohmail: the row read by its own verb.
      void markSeenOver(press)([m.id], !m.unread, undefined, m.unread ? m.id : undefined);
      return true;
    case "resurface_now":
      void press.mutateAndReport(
        { kind: "triage_set", messageId: m.id, state: "resurfaced" },
        words.resurfaceNow,
      );
      return true;
    case "delete":
      return press.deleting.remove({ id: m.id, mailboxId: m.mailboxId });
    default: {
      const when = action.slice("resurface:".length);
      void press.mutateAndReport(
        { kind: "triage_set", messageId: m.id, state: "bubbled_up", bubbleUpAt: when },
        words.resurfaces(whenLabel(when)),
      );
      return true;
    }
  }
}
