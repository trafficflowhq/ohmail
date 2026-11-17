/**
 * WHAT A CONSENT READ ANSWERS, AS THE CONSENT ROW READS IT: the fields the hook takes off `GET /consent`, each
 * with the type the server client's own declaration gives it (that declaration says what each field means). One
 * is wider here: `screeningByMailbox` is handed unread to the engine's own reader of it.
 */
import type { TravelledChangeWire } from "./travelled-change.js";

export interface ConsentStateWire {
  seedConfirmedAt: string | null;
  dormancyDays: number;
  screeningBaselineAt?: string | null;
  autoSuggestAt?: string | null;
  autoActAt?: string | null;
  blockRemoteImagesAt?: string | null;
  loadTrackingPixelsAt?: string | null;
  blockAutoUnsubscribeAt?: string | null;
  foldersEnabledAt?: string | null;
  folderMailboxesOff?: Record<string, string>;
  signatures?: Record<string, string>;
  signaturesHtml?: Record<string, string>;
  signatureSources?: Record<string, "organizer" | "local">;
  signatureChanges?: Record<string, TravelledChangeWire>;
  dormancyChange?: TravelledChangeWire;
  locale?: string | null;
  themeFace?: string | null;
  resurfaceTime?: string | null;
  onboardingCompletedAt?: string | null;
  screeningScope?: "window" | "all_time";
  screeningByMailbox?: unknown;
}
