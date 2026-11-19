/**
 * THE SENT-MAIL REVIEW — "you have written to these people; shall I let them through?" — as the shipped review did it,
 * over the host's `seedReview` wire. The list is shown before it acts: everyone starts ticked but whoever a rule
 * already stands for; a filter narrows the list and the two bulk presses act on what it shows and nothing past it; a
 * refused confirm keeps the review and every tick, says why above the list, and one press tries again. Each press
 * carries a key of its own, so a retry is told from a second press. It writes rules and moves nothing.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { refusalOfThrown } from "../connect/thrown.js";
import { seedReviewOf, type SeedCandidate, type SeedReviewRead } from "./answers.js";

export interface SeedReviewWireLike {
  read(): Promise<unknown>;
  confirm(addresses: string[], opts?: { idempotencyKey?: string }): Promise<unknown>;
}

export interface SeedReviewInput {
  /**
   * The host's wire, or `null` while the review is not owed: nothing is read, and the review rests at its start (the
   * next wire handed in reads afresh, as a review mounted anew did).
   */
  readonly wire: SeedReviewWireLike | null;
  /** The consent event landed: the caller reads the world again. */
  onDone(): void;
  /** Found nobody to decide about. Given: the review draws nothing and hands back; absent, it says so. */
  readonly onNothingToDecide?: () => void;
}

/** A refusal's sentence: the server's own, or `null` for the review's general one. */
export type SeedSaid = string | null;

export type SeedPhase =
  | { readonly at: "loading" }
  | { readonly at: "ready"; readonly review: SeedReviewRead; readonly error?: SeedSaid }
  | { readonly at: "confirming"; readonly review: SeedReviewRead }
  | { readonly at: "unavailable"; readonly said: SeedSaid };

const newKey = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `seed-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** What a refused call said: the server's sentence, this client's own where it reached no server, else none. */
function saidOf(thrown: unknown): SeedSaid {
  const r = refusalOfThrown(thrown);
  if (r.message !== "") return r.message;
  const own = thrown as { status?: unknown; message?: unknown } | null;
  return own?.status === 0 && typeof own.message === "string" && own.message !== ""
    ? own.message.slice(0, 600)
    : null;
}

export interface SeedReview {
  readonly phase: SeedPhase;
  /** Nobody to decide about: no one written to, or everyone decided already. */
  readonly nothing: boolean;
  readonly filter: string;
  setFilter(next: string): void;
  /** What the filter shows, and of it, who may be ticked. */
  readonly shown: readonly SeedCandidate[];
  readonly actionable: readonly SeedCandidate[];
  readonly shownChecked: number;
  /** The two bulk presses are offered: a question about the whole list, so they do not come and go under a filter. */
  readonly bulkOffered: boolean;
  readonly checked: ReadonlySet<string>;
  toggle(address: string): void;
  setShown(on: boolean): void;
  confirm(): void;
}

const LOADING: SeedPhase = { at: "loading" };

export function useSeedReview({ wire, onDone, onNothingToDecide }: SeedReviewInput): SeedReview {
  const [phase, setPhase] = useState<SeedPhase>(LOADING);
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  useEffect(() => {
    if (wire === null) {
      setPhase(LOADING);
      setChecked((s) => (s.size === 0 ? s : new Set()));
      setFilter("");
      return;
    }
    let live = true;
    wire.read().then(
      (answer) => {
        if (!live) return;
        const review = seedReviewOf(answer);
        if (review === null) {
          setPhase({ at: "unavailable", said: null });
          return;
        }
        setPhase({ at: "ready", review });
        /* EVERYONE STARTS TICKED but whoever is decided already: they are shown, never written again. */
        setChecked(new Set(review.candidates.filter((c) => !c.alreadyDecided).map((c) => c.address)));
      },
      (thrown: unknown) => {
        if (live) setPhase({ at: "unavailable", said: saidOf(thrown) });
      },
    );
    return () => {
      live = false;
    };
  }, [wire]);
  const review = phase.at === "ready" || phase.at === "confirming" ? phase.review : null;
  const nothing = phase.at === "ready" && phase.review.candidates.every((c) => c.alreadyDecided);
  const handBack = useRef(onNothingToDecide);
  handBack.current = onNothingToDecide;
  useEffect(() => {
    if (nothing) handBack.current?.();
  }, [nothing]);
  const shown = useMemo(() => {
    if (review === null) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return review.candidates;
    return review.candidates.filter((c) => c.address.includes(q) || (c.name ?? "").toLowerCase().includes(q));
  }, [review, filter]);
  const actionable = useMemo(() => shown.filter((c) => !c.alreadyDecided), [shown]);
  const confirm = useCallback(() => {
    if (wire === null || review === null || phase.at !== "ready") return;
    setPhase({ at: "confirming", review });
    wire.confirm([...checked], { idempotencyKey: newKey() }).then(onDone, (thrown: unknown) => {
      /* THE REVIEW AND THE TICKS SURVIVE: the retry sends the same curated list the refused press did. */
      setPhase({ at: "ready", review, error: saidOf(thrown) });
    });
  }, [review, phase.at, wire, checked, onDone]);
  return {
    phase,
    nothing,
    filter,
    setFilter,
    shown,
    actionable,
    shownChecked: actionable.filter((c) => checked.has(c.address)).length,
    bulkOffered: (review?.candidates.filter((c) => !c.alreadyDecided).length ?? 0) > 1,
    checked,
    toggle: (address) =>
      setChecked((s) => {
        const next = new Set(s);
        if (next.has(address)) next.delete(address);
        else next.add(address);
        return next;
      }),
    setShown: (on) =>
      setChecked((s) => {
        const next = new Set(s);
        for (const c of actionable) {
          if (on) next.add(c.address);
          else next.delete(c.address);
        }
        return next;
      }),
    confirm,
  };
}

/**
 * The frame's one sent-mail review, read where its offer is worked out and provided once by whoever reads it: the
 * stage draws this one, so the read the stage waited on is never made twice.
 */
export const SeedReviewContext = createContext<SeedReview | null>(null);

/** The frame's sent-mail review, or `null` where nobody provides one. */
export function useSeedReviewHere(): SeedReview | null {
  return useContext(SeedReviewContext);
}
