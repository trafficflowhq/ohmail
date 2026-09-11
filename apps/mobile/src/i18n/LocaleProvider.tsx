/**
 * The language, wired — the boot read, the Settings control, and the hook that makes a switch appear on screen.
 * `Copy` is a table of getters, so every call site already reads the current language; nothing about that tells React
 * to render again, and subscribing inside a shared wrapper would not reach children that arrive as props. So each
 * screen calls {@link useLocale}: one line per screen, re-rendering that screen and keeping the navigation stack
 * where it was (remounting under a changing `key` would throw the reader back to the Ohbox). The provider is the only
 * writer of the stored override and the module register; everything else reads. The first frame is the device's
 * language, not English: {@link deviceLocale} is synchronous, the stored override lands a tick later, and
 * `setActiveLocale` is a no-op when nothing changed — the common case never flickers.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  useSyncExternalStore, type ReactNode,
} from "react";
import { AppState } from "react-native";
import {
  activeLocale, deviceLocale, DEFAULT_LOCALE, LOCALES, resolveLocale, setActiveLocale,
  subscribeLocale, type AppLocale,
} from "./locale";
import { keystoreDeps, localeSequencer } from "./sequencer";
import type { SecureKV } from "../state/servers";

/**
 * POINT THE REGISTER AT THE DEVICE AT IMPORT TIME.
 *
 * Not in an effect and not in a render: a module-scope call runs before the first component does,
 * which is what makes the first frame of a German phone German. It is safe to run twice (the
 * register is idempotent) and safe to run in a node test (`deviceLocale` answers from `Intl`, and
 * its failure arm is `null`).
 */
setActiveLocale(resolveLocale(null, deviceLocale()));

export interface LocaleControls {
  /** The language being rendered right now — what the selector shows as chosen. */
  locale: AppLocale;
  /** The offered set, in the order the selector draws them. */
  locales: readonly AppLocale[];
  /**
   * The explicit choice, or `null` when this device is following its own language. The selector
   * needs the distinction the resolved `locale` cannot carry: an English phone with no choice
   * stored and an English phone that chose English are the same rendering and different states.
   */
  chosen: AppLocale | null;
  /**
   * Switch, or pass `null` to hand the app back to the phone's own language.
   *
   * REJECTS when the store refused, in which case the language has NOT changed — the same contract
   * the webapp's language row keeps, and the same reason: a control that silently did nothing is a
   * failure nobody can report. The register is pointed only after the write settles.
   */
  setLocale: (next: AppLocale | null) => Promise<void>;
  /** A switch is in flight — the selector disables itself rather than queueing two. */
  busy: boolean;
}

const LocaleContext = createContext<LocaleControls | null>(null);

/**
 * SUBSCRIBE A SCREEN TO THE LANGUAGE. Call it once at the top of any component that renders copy.
 *
 * Returns the active language, so a caller that needs it for `Intl` (the send-later day rows) has
 * it without a second import — but the RETURN VALUE IS NOT THE POINT. The subscription is: a
 * component that calls this re-renders when the language changes, and one that does not, does not.
 *
 * Works with no provider above it, which is what keeps the node suite's bare component renders
 * unchanged — it reads the module register directly and the provider is only ever a writer of it.
 */
export function useLocale(): AppLocale {
  return useSyncExternalStore(subscribeLocale, activeLocale, () => DEFAULT_LOCALE);
}

/**
 * The Settings control, or `null` where no provider is mounted — the bare panes a unit test
 * renders. The language ROW draws nothing in that case, exactly as the webapp's does, rather than
 * offering a selector that cannot select.
 */
export function useLocaleControls(): LocaleControls | null {
  return useContext(LocaleContext);
}

export function LocaleProvider(
  { kv, children }: { kv: SecureKV; children: ReactNode },
) {
  const [chosen, setChosen] = useState<AppLocale | null>(null);
  const [busy, setBusy] = useState(false);
  const locale = useLocale();
  /* The store is read once per mount. `kv` is a stable binding in the app (one module-level
     keystore) and an injected double in tests. */
  const kvRef = useRef(kv);
  kvRef.current = kv;

  /**
   * The three orderings live in `sequencer.ts`, not here: a boot read that resolves after a
   * choice, two presses in one render, and a foreground wake that must see the current choice
   * — each has been wrong once, and each used to be tested by a model tied to this file by
   * regexes that could stay green while the code changed. The rules are shipped code now and
   * the tests drive them; this component is the wiring. Built once per mount: `deps` closes
   * over the state setters (stable) and reads `kv` through the ref, so a caller passing a
   * fresh object each render does not rebuild it.
   */
  const seq = useMemo(
    () => localeSequencer(keystoreDeps(() => kvRef.current, setChosen, setBusy)),
    [],
  );

  /* Boot, and hand the sequencer back on the way out: anything still in flight then finishes its
     keystore work and publishes nothing. See `LocaleSequencer.dispose`. */
  useEffect(() => {
    void seq.boot();
    return () => { seq.dispose(); };
  }, [seq]);

  /**
   * A DEVICE LANGUAGE CHANGE, PICKED UP WITHOUT A RELAUNCH.
   *
   * `deviceLocale()`'s header says it is deliberately uncached because a phone's language can
   * change under a running app. That was true of the function and false of this provider, which
   * read it once on mount. There is no locale-change event in React Native and the settings app
   * has to come to the foreground for the change to be made, so the return to `active` is the
   * moment to re-read — the same listener shape `app/(tabs)/reads.tsx` already uses.
   */
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") seq.wake();
    });
    return () => { sub.remove(); };
  }, [seq]);

  const setLocale = useCallback((next: AppLocale | null) => seq.set(next), [seq]);

  const value = useMemo<LocaleControls>(
    () => ({ locale, locales: LOCALES, chosen, setLocale, busy }),
    [locale, chosen, setLocale, busy],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
