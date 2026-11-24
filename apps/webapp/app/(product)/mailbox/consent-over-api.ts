/**
 * THE WEB'S OWN CONSENT WIRES, over this page's client: the consent row's, and the review of who you write to.
 * The web host hands them in (`web-supplies.tsx`), and no other product file takes them: a shell that names no
 * wire has none. Every call stands inside an arrow, so importing this file touches no member of the client.
 */
import type { SeedReviewWire } from "@ohmail/app/host";
import { consent as consentApi } from "../../api-client";
import type { ConsentTransport } from "@ohmail/app-logic/consent/consent-state";

/** The hosted transport — the browser talking to the API this app was written against. */
export function cloudConsent(expectedOwner?: string): ConsentTransport {
  return {
    /* True for every server this tab may reach, and the READ decides: a self-hosted
       server inherits `withoutFoldersFlag`, whose consent read carries no
       `foldersEnabledAt`, so the hook withholds the pane there. */
    foldersStorable: true,
    state: () => consentApi.state(expectedOwner),
    setAutoSuggest: (enabled) => consentApi.setAutoSuggest(enabled, expectedOwner),
    setAutoAct: (enabled) => consentApi.setAutoAct(enabled, expectedOwner),
    setDormancyDays: (days, scope) => consentApi.setDormancyDays(days, scope, expectedOwner),
    setBlockRemoteImages: (blocked) => consentApi.setBlockRemoteImages(blocked, expectedOwner),
    setBlockTrackingPixels: (blocked) => consentApi.setBlockTrackingPixels(blocked, expectedOwner),
    setBlockAutoUnsubscribe: (blocked) => consentApi.setBlockAutoUnsubscribe(blocked, expectedOwner),
    setFoldersEnabled: (enabled) => consentApi.setFoldersEnabled(enabled, expectedOwner),
    setMailboxFoldersEnabled: (mailboxId, enabled) =>
      consentApi.setMailboxFoldersEnabled(mailboxId, enabled, expectedOwner),
    // The markup rides its own argument; dropped, a formatted save was sent as "clear the signature".
    setMailboxSignature: (mailboxId, signature, signatureHtml) =>
      consentApi.setMailboxSignature(mailboxId, signature, signatureHtml, expectedOwner),
    setThemeFace: (themeFace) =>
      consentApi.setThemeFace(themeFace, expectedOwner).then((stored) => ({ themeFace: stored })),
    acknowledgeScreener: (kind) => consentApi.acknowledgeScreener(kind, expectedOwner),
    setDraftReplies: (next) => consentApi.setDraftReplies(next, expectedOwner),
    setResurfaceTime: (resurfaceTime) =>
      consentApi.setResurfaceTime(resurfaceTime, expectedOwner).then((stored) => ({ resurfaceTime: stored })),
  };
}

export const CLOUD_CONSENT = cloudConsent();

/** The review of who you write to, on the same client: its list, and the one press that answers it. */
export function cloudSeedReview(expectedOwner?: string): SeedReviewWire {
  return {
    read: () => consentApi.seedReview(expectedOwner),
    confirm: (addresses, opts) => consentApi.confirmSeed(addresses, opts, expectedOwner),
  };
}

export const CLOUD_SEED_REVIEW = cloudSeedReview();
