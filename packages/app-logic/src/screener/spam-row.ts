import type { ScreenerSenderDTO } from "@ohmail/client-engine";

export interface SpamRow {
  sender: ScreenerSenderDTO;
  /** Locally pinned: a sender the user marked spam this session. */
  pinned: boolean;
}
