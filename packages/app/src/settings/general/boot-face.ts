"use client";

/**
 * THE ACCOUNT'S LOOK, FOLLOWED FROM THE BOOT: the paper or ohmarchy face the account holds, adopted on this device from
 * the consent read the ground already makes, and mirrored for the next boot's pre-paint stamp. Moved from the web
 * shell as it stood (`FaceRow.tsx`, `useFaceFollowsAccount`, and its one caller's fold of the account write in
 * `AppShell.tsx`). What it read of the web shell beside the theme is read here from the frame: the words from the
 * text reader, a refused write said in the frame's one report slot, and whose a refusal is (the storage owner then,
 * the frame's own scope here: a sign-out ends the frame, and a refusal after it is no longer this frame's to say).
 *
 * The theme is the host's (`useOptionalTheme`): a host that stands no theme provider has no look to follow into, and
 * nothing is adopted or written there.
 *
 * WHAT IT RETURNS, the hold a device press is reported to (a look chosen before the account answered, written to the
 * account once it can be), is read by Settings' General section when a look is chosen before the account answers.
 */
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { useConsent } from "@ohmail/app-logic/consent";
import { useDemoMode } from "@ohmail/app-logic/engine";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";
import { useOptionalTheme, type FaceName, type ThemeContextValue } from "@ohmail/ui/theme";
import { useFrame } from "../../frame/commands.js";
import { useText } from "../../text/index.js";

/** The account write — the consent row's `setThemeFace`, or null where no wire can store one. */
export type ApplyFaceAllDevices = (face: FaceName) => Promise<FaceName | null>;

/** Consecutive look choices share their write and last confirmed value as the person visits other panes. */
export interface FaceEdits {
  pending: Promise<void> | null;
  chosen: FaceName | null;
  confirmed: FaceName | null;
  pin: FaceName | null;
}

export const newFaceEdits = (): FaceEdits => ({ pending: null, chosen: null, confirmed: null, pin: null });

interface AccountLook {
  hold(face: FaceName): void;
  edits: FaceEdits;
}

export const FaceHoldContext = createContext<AccountLook | undefined>(undefined);
export const useAccountLook = () => useContext(FaceHoldContext);

/** What the ground's consent read says about the look. */
type ConsentFace = { themeFace: FaceName | null; themeFaceKnown: boolean; standalone: boolean };

/** What is followed where the host stands no theme: nothing to adopt into, and nothing pinned. */
const NO_THEME: Pick<ThemeContextValue, "adoptAccountFace" | "accountFace" | "facePreference" | "setFace"> = {
  adoptAccountFace: () => undefined,
  accountFace: null,
  facePreference: null,
  setFace: () => undefined,
};

/**
 * The account's face, adopted from the `GET /consent` the ground already makes (and re-makes on
 * the settings doorbell) into `adoptAccountFace`, which mirrors it for the next boot's pre-paint
 * stamp. Never a write: PATCHing back a value read from the account is the loop `adoptLocale`
 * warns about. Null IS adopted once known — it clears the mirror of a revoked choice. Where the
 * account holds a look and this device can write it, the account governs: a pin an older build's
 * control left retires. A press made before the account answered is the newest choice, so it is
 * written to the account once it can be (a refused write keeps it as this device's pin). Returns
 * the hold a face control reports such a press to.
 */
function useFaceFollowsAccount(
  consent: ConsentFace,
  apply: ApplyFaceAllDevices | null,
  edits: FaceEdits,
): (face: FaceName) => void {
  const t = useText("settings");
  const { report: toast, host } = useFrame();
  const { scope, mirrorAccount, account } = host.session;
  const awaitingWebConsent =
    host.device.build.surface === "web" && mirrorAccount !== null && mirrorAccount !== account;
  const { adoptAccountFace, accountFace, facePreference, setFace } = useOptionalTheme() ?? NO_THEME;
  const { themeFace, themeFaceKnown, standalone } = consent;
  /** Whose frame this still is: the mount's own scope, and nobody's once the frame has gone (a sign-out ends it). */
  const whose = useRef<string | null>(scope);
  useEffect(() => {
    whose.current = scope;
    return () => {
      whose.current = null;
    };
  }, [scope]);
  useEffect(() => {
    /* The web host withholds the wire until the confirmed session owns the engine's mirror.
       Keep the boot face while it waits. The desktop's provider outlives a switch to a
       standalone mailbox, so clear the departed account's face there. The boot cache can
       fill `known` before the live face answers, so only `themeFaceKnown` settles the look. */
    if (awaitingWebConsent) return;
    if (standalone) adoptAccountFace(null);
    else if (themeFaceKnown) adoptAccountFace(edits.chosen ?? themeFace);
  }, [adoptAccountFace, themeFace, themeFaceKnown, standalone, awaitingWebConsent, edits]);
  /** A press while the account could not be written, owed to it. */
  const held = useRef<FaceName | null>(null);
  /** That press after its write was refused: a pin that stays. */
  const kept = useRef<FaceName | null>(null);
  const latestAccount = useRef(accountFace);
  latestAccount.current = accountFace;
  const standaloneRef = useRef(standalone);
  standaloneRef.current = standalone;
  const hold = useStableCallback((face: FaceName) => {
    held.current = standaloneRef.current ? null : face;
  });
  useEffect(() => {
    if (apply === null || awaitingWebConsent) return;
    const owed = held.current;
    held.current = null;
    if (owed !== null && owed === facePreference) {
      setFace(null);
      if (owed === themeFace) return;
      const owner = whose.current;
      adoptAccountFace(owed);
      apply(owed).catch(() => {
        // A sign-out or a newer press since makes this refusal stale.
        if (whose.current !== owner || latestAccount.current !== owed) return;
        adoptAccountFace(themeFace);
        kept.current = owed;
        setFace(owed);
        toast(t("faceFailed"));
      });
      return;
    }
    if (facePreference === null) kept.current = null;
    else if (themeFace !== null && facePreference !== kept.current) setFace(null);
  }, [apply, awaitingWebConsent, themeFace, facePreference, setFace, adoptAccountFace, toast, t]);
  return hold;
}

/**
 * The boot duty: the account write folded to one nullable callback, as the old shell folded it. Null on the demo (no
 * session), before the first live consent answer (a press racing the boot read would write over an unknown stance),
 * and on a transport that cannot store an account-wide face: each null withholds the write structurally.
 */
export function useFaceAtBoot(): AccountLook {
  // Keep pending choices for the life of this mount, including across render-cache eviction.
  const editsRef = useRef<FaceEdits | null>(null);
  if (editsRef.current === null) editsRef.current = newFaceEdits();
  const edits = editsRef.current;
  useEffect(
    () => () => {
      edits.pending = null;
      edits.chosen = null;
    },
    [edits],
  );
  const demo = useDemoMode();
  const consent = useConsent();
  const apply: ApplyFaceAllDevices | null =
    !demo && consent.themeFaceKnown && consent.setThemeFace !== null ? consent.setThemeFace : null;
  const hold = useFaceFollowsAccount(consent, apply, edits);
  return useMemo(() => ({ hold, edits }), [hold, edits]);
}
