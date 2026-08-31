/**
 * App-local preferences — the one piece of client state that is not the mirror.
 *
 * Today that is the two APPEARANCE choices, and only those: the light/dark preference and the
 * face pin (paper / ohmarchy, "only this device" — OHMARCHY-PLAN.md §3a). Both are held in
 * memory: a relaunch returns the scheme to "system" and drops the face pin, after which the
 * ACCOUNT's face governs again (it arrives on every boot's `GET /consent`, so the durable scope
 * really is durable). Persisting either is a later, deliberate change, not a side effect of some
 * other store existing — **and it has to be BOTH.** The two are one class of decision, this
 * app's only two, and persisting one of them while the other resets is an incoherence somebody
 * would report as a bug. A phone also has no pre-paint stamp to protect (the browser client
 * mirrors the account's answer to storage precisely so its boot script can stamp before first
 * paint; React Native has no paint before JS), so a store here would buy nothing but a second
 * copy of an answer the server already gives.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { FaceName } from "../theme/face";
import type { ThemePref } from "./model";

export interface Prefs {
  themePref: ThemePref;
  setTheme: (pref: ThemePref) => void;
  /**
   * THIS DEVICE's explicit face choice, or `null` when it has made none. Outranks the account's
   * synced face on this device, because that is what the "only this device" scope promised when
   * it was chosen — `resolveFace` in `src/theme/face.ts` is the whole of the order.
   */
  facePin: FaceName | null;
  /** Pin this device's face, or pass `null` to hand it back to the account. Instant, local. */
  setFacePin: (face: FaceName | null) => void;
}

const PrefsContext = createContext<Prefs | null>(null);

export function usePrefs(): Prefs {
  const prefs = useContext(PrefsContext);
  if (!prefs) throw new Error("usePrefs() outside <PrefsProvider>");
  return prefs;
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [themePref, setTheme] = useState<ThemePref>("system");
  const [facePin, setFacePinState] = useState<FaceName | null>(null);
  /* Stable identity: the face scope machine in the world layer closes over this to drop the pin
     after a confirmed account write, and it is rebuilt per SESSION, not per render. */
  const setFacePin = useCallback((face: FaceName | null) => setFacePinState(face), []);
  const value = useMemo<Prefs>(
    () => ({ themePref, setTheme, facePin, setFacePin }),
    [themePref, facePin, setFacePin],
  );
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}
