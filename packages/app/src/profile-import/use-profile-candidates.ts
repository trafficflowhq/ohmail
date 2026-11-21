"use client";

import { useEffect, type RefObject } from "react";
import { asDeclined, asOffer, copyUnkept, placeRow, queueOffer } from "./model.js";
import { currentOwner, type Runtime, type Timing } from "./runtime.js";
import type { OfferChanges } from "./use-profile-import.js";

interface CandidateChecks {
  lifetime: object | null;
  idsKey: string;
  beat: number;
  recheckMs: number;
  doorbell: number | null;
  nudge: number;
  runtime: RefObject<Runtime>;
  timing: RefObject<Timing>;
  set: OfferChanges;
}

/** Refresh the queue on roster change, sync, or the slow clock. */
export function useCandidateChecks({
  lifetime,
  idsKey,
  beat,
  recheckMs,
  doorbell,
  nudge,
  runtime,
  timing,
  set,
}: CandidateChecks): void {
  const { setOffers, setDeclined, setUnkept, setPhase, setNudge } = set;
  useEffect(() => {
    /* An unavailable account has no profile calls. */
    if (!currentOwner(runtime.current, lifetime)) return;
    const clock = timing.current;
    // An authoritative roster prunes offers, except the one still finishing its answer.
    const boxes = runtime.current.roster;
    if (boxes !== null) {
      const known = new Set(boxes.map((m) => m.id));
      setOffers((prev) => {
        const current = prev[0];
        const keep = prev.filter(
          (o) =>
            known.has(o.mailboxId) ||
            (o === current &&
              (runtime.current.phase.kind === "applying" || runtime.current.phase.kind === "importing")),
        );
        if (keep.length === prev.length) return prev;
        // The card's lifecycle state belongs to the offer ON SCREEN: pruning it must not leave
        // a stale `failed`/`done` phase to dress the NEXT offer's card.
        if (current !== undefined && !keep.includes(current)) setPhase({ kind: "offer" });
        return keep;
      });
      setDeclined((prev) =>
        prev.every((r) => known.has(r.mailboxId)) ? prev : prev.filter((r) => known.has(r.mailboxId)),
      );
      setUnkept((prev) =>
        prev.every((r) => known.has(r.mailboxId)) ? prev : prev.filter((r) => known.has(r.mailboxId)),
      );
    }
    const via = runtime.current.wire;
    if (!via) return;
    const rang = clock.rung !== doorbell;
    clock.rung = doorbell;
    const now = Date.now();
    for (const m of runtime.current.roster ?? []) {
      const last = clock.lastChecked.get(m.id);
      if (clock.inFlight.has(m.id)) {
        if (rang) clock.owed.add(m.id);
        continue;
      }
      const wasOwed = clock.owed.delete(m.id);
      if (!rang && !wasOwed && last !== undefined && now - last < recheckMs) continue;
      clock.inFlight.add(m.id);
      clock.lastChecked.set(m.id, now);
      const epoch = clock.answered.get(m.id) ?? 0;
      void (async () => {
        try {
          const dto = await via.candidate(m.id);
          if (
            !currentOwner(runtime.current, lifetime) ||
            runtime.current.wire !== via ||
            !runtime.current.roster?.some((box) => box.id === m.id)
          )
            return;
          // Answered here while this ask flew: its answer predates the person's, so it is stale.
          if ((clock.answered.get(m.id) ?? 0) !== epoch) return;
          /* The same answer says whether a "Not now" stands: a `declined` document is a row. */
          const saved = asDeclined(dto);
          setDeclined((prev) =>
            placeRow(prev, m.id, saved ? { mailboxId: m.id, address: m.address, candidate: saved } : null),
          );
          setUnkept((prev) =>
            placeRow(prev, m.id, copyUnkept(dto) ? { mailboxId: m.id, address: m.address } : null),
          );
          const candidate = asOffer(dto); // unrecognised answers — including `none` — are no offer
          if (candidate === null) {
            // A settled or replaced question is withdrawn, except during its own answer.
            setOffers((prev) => {
              const current = prev[0];
              if (current && current.mailboxId === m.id && runtime.current.phase.kind !== "offer")
                return prev;
              return prev.filter((o) => o.mailboxId !== m.id);
            });
            return;
          }
          setOffers((prev) =>
            queueOffer(
              prev,
              { mailboxId: m.id, address: m.address, candidate },
              (runtime.current.roster ?? []).map((b) => b.id),
              runtime.current.phase.kind !== "offer",
            ),
          );
        } catch {
          // The next beat retries. An unavailable answer is no reason to show a new offer.
        } finally {
          clock.inFlight.delete(m.id);
          if (currentOwner(runtime.current, lifetime) && clock.owed.has(m.id)) setNudge((n) => n + 1);
        }
      })();
    }
  }, [
    lifetime,
    idsKey,
    beat,
    recheckMs,
    doorbell,
    nudge,
    runtime,
    timing,
    setDeclined,
    setNudge,
    setOffers,
    setPhase,
    setUnkept,
  ]);
}
