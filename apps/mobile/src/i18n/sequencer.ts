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

  return {
    chosen: () => chosen,

    async boot() {
      const startedAt = decisions;
      const stored = await deps.read();
      /* THE WRITE WINS. A choice made while this read was in flight is newer than anything the
         keystore held when it started, and republishing the stored value would undo it. */
      if (decisions !== startedAt) return;
      chosen = stored;
      deps.onChosen(stored);
      publish(resolveLocale(stored, device()));
    },

    async set(next) {
      /* The ticket is taken BEFORE the await, so two presses in one render are already ordered. */
      const ticket = ++decisions;
      deps.onBusy(true);
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
        if (decisions !== ticket) return;
        chosen = next;
        deps.onChosen(next);
        publish(resolveLocale(next, device()));
      } finally {
        /* An older press finishing late must not unlock a control the newer one is still using. */
        if (decisions === ticket) deps.onBusy(false);
      }
    },

    wake() {
      /* An explicit choice OUTRANKS the device, so walking through the phone's settings does not
         reset somebody who picked German on an English phone. */
      publish(resolveLocale(chosen, device()));
    },
  };
}
