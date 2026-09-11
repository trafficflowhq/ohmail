/**
 * The ordering rules for the language, as shipped code rather than a diagram. Three orderings,
 * each once wrong: the keystore read that starts at mount can resolve after somebody has
 * chosen and must not publish what it found; two presses in one render both see a `busy` flag
 * React has not committed, so the older write can settle last; a foreground wake must resolve
 * against the choice as of now, not the last render. Testing them by a model — a second state
 * machine tied to the source by regexes — preserved nothing, and a renderer is not available
 * (`react-test-renderer` absent, `AppState` unloadable under node). So the rules live here,
 * the provider wires state setters in, and the tests drive THIS — no second copy to drift.
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
   * The provider is going away. Everything still in flight finishes its keystore work — a
   * press accepted before the unmount must persist — and then publishes nothing and calls no
   * callback. Without this, a boot read or write settling after unmount points the module
   * register from a provider that no longer exists; where a second one has since mounted, the
   * dead one's late answer lands on top of the live one's and the language changes for a
   * reason nothing on screen explains. `onChosen`/`onBusy` are React state setters — the
   * visible half; the register is the half that outlives the component.
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
        /* The store is a decision too, and it is gated on the same ticket. As a bare
           `await deps.write(next)` with only the publish gated, two presses in one render
           issued two concurrent keystore writes, and whichever finished last was the value on
           the device: the app showed the newer language and the next launch came back in the
           older one — a screen/disk disagreement that survives the relaunch. Awaiting the
           queue orders the writes; re-reading the ticket after the turn arrives drops a
           superseded press, so the store never holds a value nobody chose, and a failed
           newest write leaves the store as it was. One press, one decision, one write. */
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
 * The provider's wiring, as a value. `LocaleProvider` is a React component in an app with no
 * renderer in its suite, so the four lines connecting the sequencer to the keystore were the
 * one part nothing could look at — a provider wired to the wrong store, or a stale one, would
 * have satisfied every case. They are this function instead: the provider calls it and does
 * nothing else with `deps`, so a test holding the same value holds the wiring rather than a
 * description of it. `kv` is a function on purpose: the provider reads it through a ref, so a
 * fresh keystore object per render neither rebuilds the sequencer nor keeps writing to the
 * object the first render saw.
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
