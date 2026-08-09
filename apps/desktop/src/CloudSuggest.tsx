/**
 * THE SUGGEST CONTROL ON THE HOSTED DOOR — the shared one, asking down the pipe.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────────
 *
 * The Screener's suggest control is built by the shared client and reaches a server through the
 * browser's API client. That client is not part of this app, so on the desktop it reports "there is
 * no server here" and the control is withheld — correctly, because a spend control with nothing
 * behind it is the one thing that surface must never be.
 *
 * On a STANDALONE install that is the end of the story: nothing is metered, the model belongs to
 * whoever set it up, and `local-suggest.tsx` is the control that fits. On an install pointed at a
 * HOSTED account it was simply a hole. That account has an allowance, a balance and suggestions to
 * buy; the window mirrors its mail and can reach its routes through the engine's write-through
 * proxy. Everything needed was there, and the surface offered nothing at all — a feature the same
 * account has in a browser tab, absent in the app, for want of a way to ask.
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ───────────────────────────────────────────
 *
 * It is the shared machinery and the shared ladder, with one substitution: the transport. The
 * quote, the confirm, the request-sized chunks, one idempotency key per chunk, the progress track,
 * the summary and the remaining balance are all the shared control's, unchanged and unreachable
 * from here. It is NOT a desktop-flavoured purchase flow, and that is the point — a second flow is
 * a second set of pricing rules, and the two would disagree the first time either was edited.
 *
 * ── TWO THINGS THIS HOST HAS TO DO THAT A BROWSER TAB DOES NOT ──────────────────────────────
 *
 *  · ANSWERS GO TO SOMEBODY ELSE'S OVERLAY. There is one suggestion overlay in a rendered client
 *    and the shell owns it; this control holds its own instance of the machinery beside it, so
 *    what it buys is pushed into the shell's through `absorb`, or the chips would be paid for and
 *    undrawable.
 *  · NOTHING IS BOUGHT WITHOUT A PRESS. The automatic batch is not opted into here and cannot be:
 *    the setting that authorises it is written from a Settings row this app does not render, and a
 *    spend nobody pressed for is not something to arrive at by omission.
 */

import { useToast } from "@ohmail/ui";

import { SuggestControl } from "../../webapp/app/views/ScreenerView";
import {
  useScreenerSuggestions,
  type SenderSuggestion,
} from "../../webapp/app/shell/screener-suggest";
import { cloudSuggestWire } from "./cloud-suggest.js";

export interface CloudSuggestProps {
  /** Waiting senders with no answer yet, in queue order — what a purchase would buy. */
  senders: string[];
  /** Waiting senders that already have one — what a re-ask would cover. */
  resuggestable: string[];
  /** Put answers into the one overlay the rows read their chips from. */
  absorb: (rows: Array<{ address: string; suggestion: SenderSuggestion }>) => void;
}

export function CloudSuggest({ senders, resuggestable, absorb }: CloudSuggestProps) {
  const toast = useToast();
  const suggestions = useScreenerSuggestions({
    /* Mounted only inside the Screener, so being here IS being active. The flag exists for the
       shell, which builds this machinery once and keeps it across every view. */
    active: true,
    toast,
    wire: cloudSuggestWire,
    publish: absorb,
  });
  return <SuggestControl control={suggestions.forSenders(senders, resuggestable)} />;
}
