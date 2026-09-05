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
import { readStoredLocale, writeStoredLocale } from "./store";
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
     keystore) and an injected double in tests; keying the effect on it would re-read on every
     render if a caller passed a fresh object, and re-reading a preference is not free on a
     keystore. */
  const kvRef = useRef(kv);
  kvRef.current = kv;
  /**
   * THE CHOICE, AS THE LISTENER AND THE BOOT READ MUST SEE IT — written when it CHANGES, never
   * during render.
   *
   * This was assigned in the render body (`chosenRef.current = chosen`), which is a write during
   * render and only lands when React commits. The foreground listener is registered once and can
   * fire between a `setChosen` and its commit, so it could resolve against the previous choice and
   * publish a language the person had just moved away from. It is set in the handler that knows the
   * new value instead, so the ref is correct the moment the write succeeds.
   */
  const chosenRef = useRef<AppLocale | null>(null);
  /**
   * HOW MANY EXPLICIT WRITES HAVE HAPPENED — the boot read's guard.
   *
   * The keystore read is async and the Settings control is live while it is in flight, so somebody
   * can choose German before the read resolves. The read then called `setChosen(stored)` and
   * published the OLD value over the new one — a preference that reverts a second after it is made,
   * which is the worst kind because the second attempt usually works. The read captures this
   * counter when it starts and applies nothing if it has moved: a write that happened later is a
   * decision, and a read that started earlier cannot be news.
   */
  const writes = useRef(0);

  useEffect(() => {
    let live = true;
    const startedAt = writes.current;
    void (async () => {
      const stored = await readStoredLocale(kvRef.current);
      /* THE WRITE WINS. A choice made while this read was in flight is newer than anything the
         keystore held when it started, and republishing the stored value would undo it. */
      if (!live || writes.current !== startedAt) return;
      chosenRef.current = stored;
      setChosen(stored);
      /* Resolved against the DEVICE again rather than against whatever the register happens to
         hold: clearing the override has to fall back to the phone's language, and this is the one
         path that runs for both "a choice was stored" and "none was". */
      setActiveLocale(resolveLocale(stored, deviceLocale()));
    })();
    return () => { live = false; };
  }, []);

  /**
   * A DEVICE LANGUAGE CHANGE, PICKED UP WITHOUT A RELAUNCH.
   *
   * `deviceLocale()`'s own header says it is deliberately not cached because a phone's language can
   * change under a running app — Android applies a system-language change to a live process. That
   * was true of the function and false of this provider, which read it once on mount: somebody who
   * switched their phone to German with ohmail in "System" kept an English app until they killed
   * it. A comment claiming a property the code does not have is worse than no comment.
   *
   * `AppState` is the seam. There is no locale-change event in React Native, and the settings app
   * has to come to the foreground for the change to be made, so the return to `active` is the
   * moment to re-read — the same listener shape `app/(tabs)/reads.tsx` already uses.
   *
   * Guarded on `chosen`: an explicit choice OUTRANKS the device, so a person who picked German on
   * an English phone must not be reset by walking through their own settings. That is
   * {@link resolveLocale}'s order, applied on every wake rather than only on mount.
   */
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      setActiveLocale(resolveLocale(chosenRef.current, deviceLocale()));
    });
    return () => { sub.remove(); };
  }, []);

  const setLocale = useCallback(async (next: AppLocale | null) => {
    setBusy(true);
    try {
      await writeStoredLocale(kvRef.current, next);
      /* Counted and recorded BEFORE the register is published, so a boot read that resolves in
         between finds the counter already moved and stands down, and the foreground listener
         reads the committed choice rather than the one React has not rendered yet. A refused
         write throws above this line and changes neither. */
      writes.current += 1;
      chosenRef.current = next;
      setChosen(next);
      setActiveLocale(resolveLocale(next, deviceLocale()));
    } finally {
      setBusy(false);
    }
  }, []);

  const value = useMemo<LocaleControls>(
    () => ({ locale, locales: LOCALES, chosen, setLocale, busy }),
    [locale, chosen, setLocale, busy],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
