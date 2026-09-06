/**
 * THE LANGUAGE, WIRED — the boot read, the Settings control, and the hook that makes a switch
 * appear on screen.
 *
 * ── WHY A SCREEN HAS TO ASK, AND WHY THAT IS NOT A DEFECT ─────────────────────────────────────
 *
 * `Copy` is a table of getters over the active deck (`src/copy.ts`), so every one of the ~300 call
 * sites already reads the current language. Nothing about that tells React to render again: a
 * screen that drew "Settings" holds an element tree React has no reason to rebuild, and a screen's
 * children arrive as props from a parent that did not re-render either — which is why subscribing
 * inside a shared wrapper (`Screen`, `Gated`, `ThemeProvider`) would not reach them.
 *
 * So each SCREEN calls {@link useLocale}. It is one line per screen, it re-renders that screen and
 * everything it builds, and it keeps the navigation stack exactly where it was — which the other
 * candidate, remounting the tree under a changing `key`, does not: switching language from Settings
 * would have thrown the reader back to the Ohbox.
 *
 * ── THE PROVIDER OWNS THE ANSWER; THE REGISTER PUBLISHES IT ───────────────────────────────────
 *
 * Two pieces of state that must not disagree: the stored override (durable, async, in the
 * keystore) and the module register the getters read (synchronous, and read before any provider
 * mounts). The provider is the only writer of both — it reads the store once on mount, resolves it
 * against the device, and points the register. Everything else reads.
 *
 * The FIRST FRAME is the device's language, not English: {@link deviceLocale} is synchronous, so
 * the register is pointed at it during the module's own evaluation, before React renders anything.
 * The stored override lands a tick later and re-points the register if it differs, which repaints
 * through the same subscription a Settings press uses. A phone whose override matches its device
 * language — the common case — therefore never flickers, because `setActiveLocale` is a no-op when
 * nothing changed.
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
   * THE THREE ORDERINGS LIVE IN `sequencer.ts`, NOT HERE.
   *
   * A boot read that resolves after a choice, two presses in one render, and a foreground wake
   * that must see the current choice — each has been wrong once, and each used to be tested by a
   * model written inside the test file and tied to this one by regexes over the source. That model
   * could stay green while this code changed, which is what review found. The rules are shipped
   * code now and the tests drive them; this component is the wiring.
   *
   * Built once per mount. `deps` closes over the state setters, which are stable, and reads `kv`
   * through the ref so a caller passing a fresh object each render does not rebuild it.
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
