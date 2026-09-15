/**
 * App-local preferences — the one piece of client state that is not the mirror: the light/dark
 * preference and the face pin (paper / ohmarchy, "only this device"). Both are DEVICE-LOCAL and
 * both survive relaunch, in one record, because persisting one while the other reset is an
 * incoherence. The scheme stays device-only for the reason the face does not: a face is a taste
 * that follows the person, a scheme belongs to the machine in front of you.
 *
 * The ordering and the keystore live in `appearance-store.ts`; this component is the wiring.
 * With no `kv` nothing is persisted and the choice holds for the session.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { FaceName } from "../theme/face";
import type { ThemePref } from "./model";
import type { SecureKV } from "./servers";
import { appearanceStore, DEFAULT_APPEARANCE, type StoredAppearance } from "./appearance-store";

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

export function PrefsProvider({ kv, children }: { kv?: SecureKV; children: ReactNode }) {
  const [state, setState] = useState<StoredAppearance>(DEFAULT_APPEARANCE);
  /* Built once per mount, like the locale provider's sequencer, so a caller passing a fresh
     keystore binding each render does not rebuild it. */
  const store = useMemo(() => appearanceStore(kv, setState), []);

  useEffect(() => {
    void store.boot();
    return () => { store.dispose(); };
  }, [store]);

  const setTheme = useCallback((pref: ThemePref) => store.setTheme(pref), [store]);
  /* Stable identity: the face scope machine in the world layer closes over this to drop the pin
     after a confirmed account write, and it is rebuilt per SESSION, not per render. */
  const setFacePin = useCallback((face: FaceName | null) => store.setFacePin(face), [store]);

  const value = useMemo<Prefs>(
    () => ({ themePref: state.themePref, setTheme, facePin: state.facePin, setFacePin }),
    [state, setTheme, setFacePin],
  );
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}
