"use client";

/**
 * Moved beside the first run's rules (`@ohmail/app-logic/mailboxes/first-run/seed-offer`); this path re-exports it. The
 * shell hands the hook its own scope (the scope switch), so the old path holds no call of its own.
 */
export { hasLiveMailbox, seedNotNowKey, useSeedOffer, type SeedOffer } from "@ohmail/app-logic/mailboxes/moved";
