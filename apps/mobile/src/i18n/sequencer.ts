/**
 * THE ORDERING RULES FOR THE LANGUAGE, AS SHIPPED CODE RATHER THAN AS A DIAGRAM.
 *
 * ── WHY THIS IS ITS OWN FILE ──────────────────────────────────────────────────────────────────
 *
 * There are three orderings here and every one of them has been wrong at some point:
 *
 *  · the keystore read that starts at mount can resolve AFTER somebody has chosen a language, and
 *    must not publish the value it found;
 *  · two presses in one render both see a `busy` flag React has not committed yet, so the older
 *    write can settle last and publish a language the person already moved off;
 *  · a foreground wake must resolve against the choice as of NOW, not as of the last render.
 *
 * They were fixed inside `LocaleProvider.tsx` and tested by a MODEL — a second little state machine
 * written in the test file, tied to the real thing by regexes over the source. Review's verdict was
 * exact: "the locale race tests exercise a duplicate state machine; the source regexes do not
 * preserve the claimed ordering." Move the boot guard after publishing and the model stays green
 * while the tokens the regexes look for are all still present.
 *
 * A renderer would be the other answer, and this app has none: nothing in `apps/mobile/test`
 * mounts a React tree, `react-test-renderer` is not a dependency, and `AppState` does not resolve
 * under node. Adding a renderer to test three orderings is the larger change and the worse one.
 *
 * So the rules live here, the provider wires state setters into them, and the tests drive THIS.
 * There is no second copy to drift.
 */
import { deviceLocale, resolveLocale, setActiveLocale, type AppLocale } from "./locale";
import { readStoredLocale, writeStoredLocale } from "./store";
import type { SecureKV } from "../state/servers";

export interface LocaleSequencerDeps {
  /** The stored override. Resolves `null` for "nothing chosen"; never rejects — see `store.ts`. */
  read(): Promise<AppLocale | null>;
  /** Persist a choice. REJECTS when the store refused, which is what the Settings row reports. */
  write(next: AppLocale | null): Promise<void>;
  /** What language the phone itself is in. Injectable so a test need not own the platform. */
  device?(): AppLocale | null;
  /** Publish the resolved language. Defaults to the module register the copy deck reads. */
  publish?(locale: AppLocale): void;
  /** Tell the view what is stored, so the selector can show it. */
  onChosen(next: AppLocale | null): void;
  /** Tell the view a switch is in flight. */
  onBusy(busy: boolean): void;
}

export interface LocaleSequencer {
  /** The mount read. Applies nothing if a choice was made while it was in flight. */
  boot(): Promise<void>;
  /** A press. The newest one wins, whatever order the writes settle in. */
  set(next: AppLocale | null): Promise<void>;
  /** A return to the foreground: re-resolve, because the phone's language can change under us. */
  wake(): void;
  /** The choice as of now — not as of the last render. */
  chosen(): AppLocale | null;
  /**
   * THE PROVIDER IS GOING AWAY. Everything still in flight finishes its keystore work — a press
   * accepted before the unmount is a press that must persist — and then publishes NOTHING and
   * calls no callback.
   *
   * Without this, a boot read or a write settling after the unmount points the module register
   * from a provider that no longer exists. Where a second one has since mounted (a re-mount, a
   * test's next case, a screen swapped under a fast refresh) the dead one's late answer lands on
   * top of the live one's, and the language changes for a reason nothing on screen explains.
   * `onChosen`/`onBusy` are React state setters, so they are the visible half; the register is
   * the half that outlives the component.
   */
  dispose(): void;
}

export function localeSequencer(deps: LocaleSequencerDeps): LocaleSequencer {
  const device = deps.device ?? deviceLocale;
  const publish = deps.publish ?? setActiveLocale;
  /**
   * HOW MANY DECISIONS HAVE BEEN TAKEN. A ref-like counter rather than React state, because it has
   * to be true the instant a press happens: state does not exist until React commits, and both
   * races above are decided in the window before that.
   */
  let decisions = 0;
  let chosen: AppLocale | null = null;
  /**
   * THE KEYSTORE QUEUE. A press awaits its turn here before it writes, so writes reach the store
   * in the order the presses happened rather than in the order two independent promises settle.
   * See {@link LocaleSequencer.set} for what went wrong without it.
   */
  let queue: Promise<void> = Promise.resolve();
  /** Set by {@link LocaleSequencer.dispose}. Read at every point that leaves this module. */
  let disposed = false;

  return {
    chosen: () => chosen,

    dispose() { disposed = true; },

    async boot() {
      const startedAt = decisions;
      const stored = await deps.read();
      /* THE WRITE WINS. A choice made while this read was in flight is newer than anything the
         keystore held when it started, and republishing the stored value would undo it. */
      if (decisions !== startedAt || disposed) return;
      chosen = stored;
      deps.onChosen(stored);
      publish(resolveLocale(stored, device()));
    },

    async set(next) {
      /* The ticket is taken BEFORE the await, so two presses in one render are already ordered. */
      const ticket = ++decisions;
      if (!disposed) deps.onBusy(true);
      try {
        /* ── THE STORE IS A DECISION TOO, AND IT IS GATED ON THE SAME TICKET ─────────────────
           This used to be a bare `await deps.write(next)`, with only the PUBLISH gated. Two
           presses in one render therefore issued two concurrent keystore writes, and whichever
           the keystore happened to finish LAST was the value left on the device. The publish was
           correctly ordered, so the app showed the newer language and the next launch came back
           in the older one — a disagreement between the screen and the disk that no screen can
           show you, and that survives the relaunch which is the only thing a person would try.

           Awaiting the queue orders the writes. Re-reading the ticket AFTER the turn arrives
           drops a press that has already been superseded: a keystore the newest press is about to
           overwrite anyway should not first be made to hold a value nobody chose, and if that
           newest write then fails, the store is left as it was rather than at some intermediate
           choice. One press, one decision, one write. */
        const mine = queue.then(() => (decisions === ticket ? deps.write(next) : undefined));
        /* A refusal belongs to the press that caused it; it must not poison the presses behind. */
        queue = mine.then(() => undefined, () => undefined);
        await mine;
        /* The write above is deliberately NOT gated on `disposed`: a press accepted before the
           unmount must still reach the device. Only what leaves this module stops. */
        if (decisions !== ticket || disposed) return;
        chosen = next;
        deps.onChosen(next);
        publish(resolveLocale(next, device()));
      } finally {
        /* An older press finishing late must not unlock a control the newer one is still using. */
        if (decisions === ticket && !disposed) deps.onBusy(false);
      }
    },

    wake() {
      if (disposed) return;
      /* An explicit choice OUTRANKS the device, so walking through the phone's settings does not
         reset somebody who picked German on an English phone. */
      publish(resolveLocale(chosen, device()));
    },
  };
}

/**
 * THE PROVIDER'S WIRING, AS A VALUE.
 *
 * `LocaleProvider` is a React component in an app with no renderer in its test suite — nothing in
 * `apps/mobile/test` mounts a tree, `react-test-renderer` is not a dependency, and `AppState` does
 * not resolve under node. So the four lines that connect the sequencer to the keystore were the
 * one part of this feature nothing could look at: the orderings were driven directly, and a
 * provider wired to the wrong store, or to a stale one, would have satisfied every case.
 *
 * They are this function instead. The provider calls it and does nothing else with `deps`, so a
 * test holding the same value is holding the wiring rather than a description of it.
 *
 * `kv` is a FUNCTION on purpose: the provider reads it through a ref, so a caller passing a fresh
 * keystore object on each render does not rebuild the sequencer and does not keep writing to the
 * object the first render happened to see.
 */
export function keystoreDeps(
  kv: () => SecureKV,
  onChosen: (next: AppLocale | null) => void,
  onBusy: (busy: boolean) => void,
): LocaleSequencerDeps {
  return {
    read: () => readStoredLocale(kv()),
    write: (next) => writeStoredLocale(kv(), next),
    onChosen,
    onBusy,
  };
}
