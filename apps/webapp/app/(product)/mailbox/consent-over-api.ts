/**
 * THE WEB'S OWN CONSENT WIRES, over this page's client: the consent row's, and the review of who you write to.
 * The web host hands them in (`web-supplies.tsx`), and no other product file takes them: a shell that names no
 * wire has none. Every call stands inside an arrow, so importing this file touches no member of the client.
 */
import type { SeedReviewWire } from "@ohmail/app/host";
import { consent as consentApi } from "../../api-client";
import type { ConsentTransport } from "@ohmail/app-logic/consent/consent-state";

/** The hosted transport — the browser talking to the API this app was written against. */
export const CLOUD_CONSENT: ConsentTransport = {
  /* True for every server this tab may reach, and the READ decides: a self-hosted
     server inherits `withoutFoldersFlag`, whose consent read carries no
     `foldersEnabledAt`, so the hook withholds the pane there. */
  foldersStorable: true,
  state: () => consentApi.state(),
  setAutoSuggest: (enabled) => consentApi.setAutoSuggest(enabled),
  setAutoAct: (enabled) => consentApi.setAutoAct(enabled),
  setDormancyDays: (days, scope) => consentApi.setDormancyDays(days, scope),
  setBlockRemoteImages: (blocked) => consentApi.setBlockRemoteImages(blocked),
  setBlockTrackingPixels: (blocked) => consentApi.setBlockTrackingPixels(blocked),
  setBlockAutoUnsubscribe: (blocked) => consentApi.setBlockAutoUnsubscribe(blocked),
  setFoldersEnabled: (enabled) => consentApi.setFoldersEnabled(enabled),
  setMailboxFoldersEnabled: (mailboxId, enabled) =>
    consentApi.setMailboxFoldersEnabled(mailboxId, enabled),
  // The markup rides its own argument; dropped, a formatted save was sent as "clear the signature".
  setMailboxSignature: (mailboxId, signature, signatureHtml) =>
    consentApi.setMailboxSignature(mailboxId, signature, signatureHtml),
  setThemeFace: (themeFace) =>
    consentApi.setThemeFace(themeFace).then((stored) => ({ themeFace: stored })),
  setResurfaceTime: (resurfaceTime) =>
    consentApi.setResurfaceTime(resurfaceTime).then((stored) => ({ resurfaceTime: stored })),
};

/** The review of who you write to, on the same client: its list, and the one press that answers it. */
export const CLOUD_SEED_REVIEW: SeedReviewWire = {
  read: () => consentApi.seedReview(),
  confirm: (addresses, opts) => consentApi.confirmSeed(addresses, opts),
};
