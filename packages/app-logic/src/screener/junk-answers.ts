/**
 * WHAT THE JUNK WINDOW'S WIRE ANSWERS, AS THE WINDOW READS IT: a page of the provider's own Junk, a search over it,
 * a recorded rescue and the sweep's preview, each field with the type the server client's own declaration gives it
 * (that declaration says what each field means). A host's wire answers these shapes whatever carries them.
 */
export interface JunkItemWire {
  mailboxId: string;
  uid: number;
  uidValidity: string;
  subject: string;
  from: { name: string | null; address: string };
  date: string | null;
  messageIdHeader: string | null;
  seen: boolean;
  origin: "verdict" | "provider";
  rescue?: "queued" | "refused";
  rescueId?: string;
}

export interface JunkMailboxWire {
  id: string;
  address: string;
  window: "ok" | "no_junk_folder" | "unreachable";
  reset?: boolean;
}

export interface JunkPageWire {
  mailboxes: JunkMailboxWire[];
  items: JunkItemWire[];
  nextCursor: string | null;
}

export interface JunkRescueWire {
  status: "queued";
  rescueId: string;
  allowed?: { disabledRuleIds: string[]; createdRuleId: string | null };
}

export interface JunkSearchWire {
  mailboxes: JunkMailboxWire[];
  items: JunkItemWire[];
  truncated: boolean;
}

export interface JunkSweepMailboxWire {
  id: string;
  address: string;
  candidates: number;
  hasJunkFolder: boolean;
  pending: boolean;
}

export interface JunkSweepWire {
  mailboxes: JunkSweepMailboxWire[];
  movable: number;
  pending: boolean;
  held?: { ids: string[]; truncated: boolean };
}
