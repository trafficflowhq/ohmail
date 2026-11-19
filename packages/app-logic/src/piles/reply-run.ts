"use client";

/**
 * THE REPLY RUN: Answer Later answered one letter at a time in the reading column. The run never sends: Done is the
 * column's own Send through the frame's one sender, and the run steps when the letter it stands on leaves Answer
 * Later, which a sent reply does. An Undo that brings that letter back ends the run on it. Skip and Exit change the
 * run alone and write nothing. Opening another letter, or leaving the place, ends it.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type Context } from "react";

/** What the column's owner draws from: the count line above the subject and the three verbs in the panel. */
export interface ReplyRunState {
  /** The letter the run stands on. */
  readonly at: string;
  /** 1-based. */
  readonly step: number;
  readonly total: number;
  skip(): void;
  exit(): void;
}

export const ReplyRunContext: Context<ReplyRunState | null> = createContext<ReplyRunState | null>(null);

/** The run the column stands in, or null. */
export function useReplyRunState(): ReplyRunState | null {
  return useContext(ReplyRunContext);
}

export interface ReplyRunPorts {
  /** The letter open in the column (the route's). */
  readonly openId: string | null;
  /** Open a letter in the column. */
  readonly open: (id: string) => void;
  /** Open the reply to it in the column; the column's Send is Done. */
  readonly write: (id: string) => void;
  /** Close this run's reply, keeping its draft. */
  readonly close?: (id: string) => void;
}

export interface ReplyRun {
  readonly state: ReplyRunState | null;
  readonly canStart: boolean;
  /** `f` and the head's button: from the first letter of the pile. */
  start(): void;
}

interface Run {
  readonly order: readonly string[];
  readonly index: number;
  /** Letters the run passed by a send: one coming back ends the run on it. */
  readonly sent: readonly string[];
}

/** `ids`: Answer Later's letters, in the pile's order. */
export function useReplyRun(ids: readonly string[], ports: ReplyRunPorts): ReplyRun {
  const [run, setRun] = useState<Run | null>(null);
  const portsRef = useRef(ports);
  const opened = useRef<string | null>(null);
  portsRef.current = ports;

  const stand = useCallback((id: string) => {
    opened.current = portsRef.current.openId === id ? id : null;
    portsRef.current.open(id);
    portsRef.current.write(id);
  }, []);
  const nextFrom = (r: Run, from: number, pile: ReadonlySet<string>): number => {
    for (let i = from; i < r.order.length; i++) if (pile.has(r.order[i]!)) return i;
    return -1;
  };

  /* Observation: the pile changed under the run. A new array of the same letters is no change. */
  const pileKey = ids.join("\n");
  const idsRef = useRef(ids);
  idsRef.current = ids;
  useEffect(() => {
    if (run === null) return;
    const pile = new Set(idsRef.current);
    const back = run.sent.find((id) => pile.has(id));
    if (back !== undefined) {
      setRun(null);
      portsRef.current.open(back);
      return;
    }
    const at = run.order[run.index]!;
    if (pile.has(at)) return;
    const next = nextFrom(run, run.index + 1, pile);
    if (next < 0) {
      setRun(null);
      return;
    }
    setRun({ ...run, index: next, sent: [...run.sent, at] });
    stand(run.order[next]!);
  }, [pileKey, run, stand]);

  /* Opening another letter or closing this step ends the run. An address that has not landed yet can still be empty. */
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const r = runRef.current;
    if (r === null) return;
    const at = r.order[r.index]!;
    if (ports.openId === at) opened.current = at;
    // Navigation leaves the reply's ordinary draft and any pending send with their existing owners.
    else if (ports.openId !== null || opened.current === at) setRun(null);
  }, [ports.openId]);

  /* Leaving the place ends it: the run lives with the place. */
  const start = useCallback(() => {
    if (ids.length === 0) return;
    setRun({ order: [...ids], index: 0, sent: [] });
    stand(ids[0]!);
  }, [ids, stand]);

  const finish = (id: string) => {
    portsRef.current.close?.(id);
    setRun(null);
  };
  const state: ReplyRunState | null =
    run === null
      ? null
      : {
          at: run.order[run.index]!,
          step: run.index + 1,
          total: run.order.length,
          skip: () => {
            const pile = new Set(ids);
            const next = nextFrom(run, run.index + 1, pile);
            if (next < 0) {
              finish(run.order[run.index]!);
              return;
            }
            setRun({ ...run, index: next });
            stand(run.order[next]!);
          },
          exit: () => finish(run.order[run.index]!),
        };
  return { state, canStart: ids.length > 0 && state === null, start };
}
