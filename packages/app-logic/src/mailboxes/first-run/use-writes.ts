/**
 * EVERY WRITE OF THE STAGE GOES THROUGH HERE, and every write clears the cursor: the derivation, not the stage, says
 * where the flow stands. Record, then paint: the facts are read again BEFORE the cursor clears and `busy` drops, and
 * that wait is bounded, so a read that fails or never answers cannot hold a screen whose every control is off.
 *
 * Except on a re-run, where a cleared cursor is a loop (a finished account derives to "nothing to do"): a re-run's
 * success names its next screen, and a refusal stays on the screen with its sentence.
 */
import { useCallback, useState } from "react";
import type { OnboardingStep } from "../../doors/onboarding.js";
import type { Said } from "../connect/refusal.js";
import { saidOfThrown } from "./thrown.js";

/** How long a write waits for the read that makes it visible. Past it the stage paints over what the facts say. */
export const SETTLE_MS = 4_000;

export interface WritesInput {
  readonly step: OnboardingStep | null;
  readonly rerun: boolean;
  setAt(next: OnboardingStep | null): void;
  /** Read the facts again. */
  refresh(): Promise<void>;
  /** A second-factor dialog can be asked here: a factor refusal is then not "sign in again". */
  readonly factor: boolean;
}

export interface Writes {
  readonly busy: boolean;
  /** What the last refused write said; cleared by the next attempt and by a move. */
  readonly problem: Said | null;
  clear(): void;
  run(
    write: () => Promise<void>,
    keepCursor?: OnboardingStep,
    opts?: { readonly stayOnFailure?: boolean },
  ): Promise<boolean>;
}

export function useWrites({ step, rerun, setAt, refresh, factor }: WritesInput): Writes {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Said | null>(null);
  const run = useCallback(
    async (
      write: () => Promise<void>,
      keepCursor?: OnboardingStep,
      opts: { stayOnFailure?: boolean } = {},
    ) => {
      /* Where a failed write leaves a re-run: here, captured before the wait, so a screen left meanwhile is not restored. */
      const here = step;
      setBusy(true);
      setProblem(null);
      const settle = async (): Promise<void> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([refresh(), new Promise<void>((done) => (timer = setTimeout(done, SETTLE_MS)))]);
        } catch {
          /* a read that failed is not a write that failed */
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        await write();
        await settle();
        setAt(keepCursor ?? null);
        return true;
      } catch (thrown) {
        setProblem(saidOfThrown(thrown, factor));
        await settle();
        setAt(rerun || opts.stayOnFailure === true ? here : null);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [factor, refresh, rerun, setAt, step],
  );
  return { busy, problem, clear: () => setProblem(null), run };
}
