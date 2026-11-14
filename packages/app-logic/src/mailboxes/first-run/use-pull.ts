/**
 * THE PULL'S NUMBERS: how fast the first import goes and how long is left, said only once two minutes of samples
 * stand (`pull-rate.ts` refuses rather than guesses), and the import's connection while it is open: a drop in plain
 * words, its return once, until it drops again.
 */
import { useEffect, useRef, useState } from "react";
import { pullEtaMs, pullRate, pullRemaining, pullSampleStep, type PullSample } from "./pull-rate.js";

export interface PullInput {
  /** The import's own numerator. */
  readonly pulled: number;
  /** How much mail the server says is in the mailbox, once it has said. */
  readonly serverMessageCount: number | undefined;
  /** This install cannot reach the mailbox's server now. */
  readonly unreachable: boolean;
  /** The import's own end, before the stage's hold narrows it. */
  readonly importOver: boolean;
}

export interface Pull {
  /** Still to read, or `null` before the server has counted: no "0 still to read" over a running pull. */
  readonly remaining: number | null;
  readonly rate: number | null;
  readonly etaMs: number | null;
  /** Everything the server counted is in: no estimate is worked out any more. */
  readonly readAll: boolean;
  readonly reconnecting: boolean;
  readonly cameBack: boolean;
}

export function usePull({ pulled, serverMessageCount, unreachable, importOver }: PullInput): Pull {
  const [samples, setSamples] = useState<PullSample[]>([]);
  /* Sampled when the count MOVED, never on a timer: a timer fills the window with duplicate observations. */
  const lastSampled = useRef<number | null>(null);
  useEffect(() => {
    if (lastSampled.current === pulled) return;
    lastSampled.current = pulled;
    setSamples((prev) => pullSampleStep(prev, pulled, Date.now()));
  }, [pulled]);
  const wasUnreachable = useRef(false);
  const [cameBack, setCameBack] = useState(false);
  useEffect(() => {
    if (unreachable) setCameBack(false);
    else if (wasUnreachable.current) setCameBack(true);
    wasUnreachable.current = unreachable;
  }, [unreachable]);
  const rate = pullRate(samples);
  const remaining = pullRemaining(serverMessageCount, pulled);
  return {
    remaining,
    rate,
    etaMs: pullEtaMs(remaining, rate),
    readAll: typeof serverMessageCount === "number" && remaining === null,
    reconnecting: unreachable && !importOver,
    cameBack: cameBack && !importOver,
  };
}
