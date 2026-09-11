/**
 * THE SUGGEST CONTROL ON THE HOSTED DOOR — the shared one, asking down the pipe. The shared
 * control reaches a server through the browser's API client, which is not part of this app,
 * so it was withheld — correct on a STANDALONE install (`local-suggest.tsx` fits there) and a
 * hole on a HOSTED one: that account has an allowance, a balance and suggestions to buy, the
 * window mirrors its mail and can reach its routes through the write-through proxy, and the
 * surface offered nothing. This is the shared machinery and ladder with ONE substitution, the
 * transport: quote, confirm, request-sized chunks, one idempotency key per chunk, progress,
 * summary and balance are the shared control's, unchanged — a second flow is a second set of
 */

/*
 * pricing rules. Two host duties a browser tab lacks: answers are pushed into the SHELL's
 * overlay through `absorb` (or the chips would be paid for and undrawable), and NOTHING IS
 * BOUGHT WITHOUT A PRESS — the automatic batch cannot be opted into here.
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
