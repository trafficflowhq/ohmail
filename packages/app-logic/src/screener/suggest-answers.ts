import type { ScreenerQuoteGrant } from "@ohmail/wire";

/**
 * WHAT THE SUGGESTION WIRE ANSWERS, AS THE RUN READS IT: one page of what is already bought, and the answer to a
 * priced or bought set, each field with the type the server client's own declaration gives it (that declaration
 * says what each field means). A host's wire answers these shapes whatever carries them.
 */
export interface ScreenerWireItem {
  id: string;
  messageId: string;
  sender: { name: string | null; address: string };
  subject: string;
  snippet: string;
  receivedAt: string;
  aiSuggestion: {
    decision: "yes" | "no" | "hold";
    confidence: number;
    rationale: string;
    reasonCode?: string;
    reasonBrand?: string;
    reasonCount?: number;
  } | null;
}

export interface ScreenerWirePage {
  items: ScreenerWireItem[];
  nextCursor: string | null;
  suggestable: { senders: string[]; maxPerRequest: number };
  pendingDecisions?: Array<{
    subject: string;
    scope: "sender" | "domain";
    decidedAt: string;
    sent: boolean;
    state?: "pending" | "sent" | "refused";
    refusedReason?: string | null;
  }>;
}

export type ScreenerSkipReason =
  | "not_held"
  | "out_of_credits"
  | "over_quote"
  | "spend_unavailable"
  | "model_unavailable"
  | "model_declined"
  | "no_auto_ai";

export interface ScreenerSuggestWire {
  dryRun: boolean;
  requested: number;
  quoted: number;
  quotedCredits?: number;
  quoteGrant?: ScreenerQuoteGrant;
  charged: number;
  stopped?: "out_of_credits" | "over_quote" | "spend_unavailable";
  remainingCredits?: number;
  suggestions: Array<{
    sender: string;
    messageId: string;
    decision: "yes" | "no" | "hold";
    destination?: string;
    spam?: boolean;
    confidence: number;
    rationale: string;
    reasonCode?: string;
    reasonBrand?: string;
    reasonCount?: number;
  }>;
  skipped: Array<{ sender: string; reason: ScreenerSkipReason }>;
}
