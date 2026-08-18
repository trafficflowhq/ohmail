"use client";

/**
 * "WE FOUND YOUR OHMAIL SETTINGS ON THIS MAILBOX" — the confirm half of the portable profile.
 *
 * A mailbox can arrive carrying its own ohmail configuration: screener decisions, rules,
 * notification choices, the away reply and tag names, saved as a small document in the mailbox
 * itself by whichever ohmail organized it before. The organizer that finds one NEVER applies it —
 * it records the fact and waits — and this card is where the person answers. It is the
 * restore-your-settings moment: one quiet floating card, the counts of what would come back in
 * plain words, and two honest buttons. Never a wall of JSON, never a "migration".
 *
 * ── WHAT THE SHELL ASKS, AND WHAT THAT COSTS ────────────────────────────────────────────────
 *
 * {@link useProfileImport} asks `GET /mailboxes/:id/profile-import` once per mailbox when the
 * shell mounts, again when a mailbox APPEARS in the account (the just-connected case — the
 * organizer needs a first pass over the new mailbox before there is anything to find, so the
 * answer arrives on a later beat), and then on a slow beat ({@link PROFILE_IMPORT_RECHECK_MS})
 * while the tab is visible. That cadence is affordable because the server's resting answer is
 * one indexed read of its own durable record — it dials the mailbox only when a found document
 * is actually waiting on an answer.
 *
 * A failed check stays silent and the card stays absent — no card is the resting surface, never
 * a prompt built on a guess. The direction matters the same way the away notice's does: this
 * card claims somebody's settings are waiting, and that claim may only come from the server.
 *
 * ── THE ANSWERS ARE DURABLE, AND EXACT ──────────────────────────────────────────────────────
 *
 * *Import settings* sends back the `fingerprint` of the exact content the person was shown; the
 * server re-reads the mailbox and refuses if the document changed in between, so nothing is ever
 * applied that nobody confirmed. *Not now* is recorded once, server-side, keyed to that same
 * content — the identical document never asks again, on any device, while a genuinely different
 * one legitimately may. A document written by a NEWER ohmail offers no import at all: this build
 * cannot read all of it, and a partial import would be a silent loss dressed as a restore.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";
import {
  ApiError, apiConfigured, profileImport as profileImportApi,
  type ProfileImportAppliedWire, type ProfileImportCandidateWire, type ProfileImportCountsWire,
} from "../api-client";
import { displayAddress } from "./idn";

/** How often an unanswered mailbox is re-asked, at most. The connect case rides the first beat. */
export const PROFILE_IMPORT_RECHECK_MS = 5 * 60 * 1000;

/** The two shapes worth a card. `none` never leaves the hook. */
type OfferCandidate = Exclude<ProfileImportCandidateWire, { state: "none" }>;

export interface ProfileImportOffer {
  mailboxId: string;
  /** The mailbox the settings travelled with — named on the card, because accounts have several. */
  address: string;
  candidate: OfferCandidate;
}

/**
 * The card's lifecycle around ONE offer. `failed` keeps the offer and the buttons — the person's
 * answer survives a refused request, exactly as the seed review keeps its curation.
 */
export type ProfileImportPhase =
  | { kind: "offer" }
  | { kind: "applying" }
  | { kind: "failed"; message: string | null }
  | { kind: "done"; applied: ProfileImportAppliedWire };

/**
 * The same seam the away notice takes ({@link AwayTransport}'s shape, this feature's verbs), and
 * for the same install: the desktop, whose window is forbidden the Cloud client but whose engine
 * serves these routes locally. Absent ⇒ the hosted client, which is what a browser tab has.
 *
 * THE REJECTION CONTRACT, which {@link failureSentence} relies on: an injected transport that
 * rejects with an `Error` is promising that error's `message` is the SERVER's own sentence, fit
 * to put on the card verbatim (`apps/desktop/src/local-profile-import.ts` keeps it by reading
 * the engine's error body, the same shape every desktop wire uses). A transport that cannot
 * say anything true should reject with an empty message and take the generic line.
 */
export interface ProfileImportTransport {
  candidate(mailboxId: string): Promise<ProfileImportCandidateWire>;
  apply(mailboxId: string, fingerprint: string): Promise<ProfileImportAppliedWire>;
  decline(mailboxId: string, subject: { fingerprint?: string; v?: number }): Promise<unknown>;
}

export interface ProfileImportState {
  /** The offer on screen — the oldest unanswered one; the next queues behind it. */
  offer: ProfileImportOffer | null;
  phase: ProfileImportPhase;
  importNow: () => void;
  notNow: () => void;
  /** Leave the `done` confirmation. */
  acknowledge: () => void;
}

const HOSTED: ProfileImportTransport = {
  candidate: (id) => profileImportApi.candidate(id),
  apply: (id, fingerprint) => profileImportApi.apply(id, fingerprint),
  decline: (id, subject) => profileImportApi.decline(id, subject),
};

/**
 * The sentence a refused request may put on the card, or null for the generic line.
 *
 * Two ways a failure carries the SERVER's own words, and only two: the hosted client's
 * {@link ApiError}, and a HOST-INJECTED transport's rejection — whose message is the engine's
 * sentence by the contract on {@link ProfileImportTransport}. A browser tab never takes the
 * second branch: its transport is {@link HOSTED}, so a network-level `TypeError` still reads as
 * the generic sentence rather than "Failed to fetch" dressed up as advice.
 */
function failureSentence(err: unknown, injected: boolean): string | null {
  if (err instanceof ApiError) return err.message;
  if (injected && err instanceof Error && err.message.length > 0) return err.message;
  return null;
}

/**
 * THE TOLERANT READER over the candidate wire — an answer this build does not RECOGNISE is not
 * an offer. The claim "your settings are waiting" may only be made from a fully-formed `found`
 * (fingerprint and every count present) or a well-formed `newer`; anything else — an older or
 * different server build, a proxy answering 200 `{}`, a test harness's catch-all — reads as
 * `none`. Measured, not hypothetical: a catch-all mock's `{}` reached the card as a "found"
 * offer with no counts and the render crash took the whole shell down with it.
 */
function asOffer(dto: unknown): OfferCandidate | null {
  if (typeof dto !== "object" || dto === null) return null;
  const d = dto as Record<string, unknown>;
  if (d.state === "newer" && typeof d.v === "number" && Number.isInteger(d.v)) {
    return { state: "newer", v: d.v };
  }
  if (d.state !== "found") return null;
  if (typeof d.fingerprint !== "string" || d.fingerprint.length === 0) return null;
  if (typeof d.updatedAt !== "string") return null;
  const producer = d.producer as Record<string, unknown> | null | undefined;
  if (typeof producer !== "object" || producer === null) return null;
  const counts = d.counts as Record<string, unknown> | null | undefined;
  if (typeof counts !== "object" || counts === null) return null;
  for (const k of ["screener", "rules", "notifyRules", "tags"] as const) {
    if (typeof counts[k] !== "number") return null;
  }
  if (typeof counts.awayResponder !== "boolean") return null;
  return {
    state: "found",
    fingerprint: d.fingerprint,
    updatedAt: d.updatedAt,
    producer: {
      kind: typeof producer.kind === "string" ? producer.kind : "unknown",
      version: typeof producer.version === "string" ? producer.version : "",
    },
    counts: counts as unknown as ProfileImportCountsWire,
  };
}

export function useProfileImport(
  active: boolean,
  mailboxes: ReadonlyArray<{ id: string; address: string }> | null,
  transport?: ProfileImportTransport,
  /** The beat, injectable so a test does not wait five minutes for the second look. */
  recheckMs: number = PROFILE_IMPORT_RECHECK_MS,
): ProfileImportState {
  const [offers, setOffers] = useState<ProfileImportOffer[]>([]);
  const [phase, setPhase] = useState<ProfileImportPhase>({ kind: "offer" });
  const [beat, setBeat] = useState(0);

  /* Refs, so the check effect's deps stay the three things that mean "ask again" — activation,
     the mailbox SET, the beat — and nothing re-fires it spuriously. */
  const held = useRef(transport);
  held.current = transport;
  const list = useRef(mailboxes);
  list.current = mailboxes;
  const lastChecked = useRef(new Map<string, number>());
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const idsKey = (mailboxes ?? []).map((m) => m.id).sort().join(",");

  useEffect(() => {
    /* `active` FIRST — the away notice's load-bearing order: an inactive shell must not so much
       as name the Cloud client, whose stub throws on the read in a standalone bundle. */
    if (!active) return;
    const via = held.current ?? (apiConfigured() ? HOSTED : null);
    if (!via) return;
    const now = Date.now();
    for (const m of list.current ?? []) {
      const last = lastChecked.current.get(m.id);
      if (inFlight.current.has(m.id)) continue;
      if (last !== undefined && now - last < recheckMs) continue;
      inFlight.current.add(m.id);
      lastChecked.current.set(m.id, now);
      void (async () => {
        try {
          const dto = await via.candidate(m.id);
          if (!mounted.current) return;
          const candidate = asOffer(dto); // unrecognised answers — including `none` — are no offer
          if (candidate === null) {
            // An authoritative non-offer RETIRES a standing card for this mailbox: another
            // device answered, and a card left up would offer an Import button for a question
            // that is already settled. Never mid-answer, though — the person pressing a button
            // right now keeps their card until their own request resolves.
            setOffers((prev) => {
              const current = prev[0];
              if (current && current.mailboxId === m.id && phaseRef.current.kind !== "offer") return prev;
              return prev.filter((o) => o.mailboxId !== m.id);
            });
            return;
          }
          setOffers((prev) => [
            ...prev.filter((o) => o.mailboxId !== m.id),
            { mailboxId: m.id, address: m.address, candidate },
          ]);
        } catch {
          // Could not ask: the card stays absent, and the next beat asks again. Never a prompt
          // built on a guess — the claim "your settings are waiting" is the server's to make.
        } finally {
          inFlight.current.delete(m.id);
        }
      })();
    }
  }, [active, idsKey, beat, recheckMs]);

  // The slow beat. Visibility-gated like every other poll: nobody looking, nothing asked.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      setBeat(Date.now());
    }, recheckMs);
    return () => clearInterval(id);
  }, [active, recheckMs]);

  const offer = offers[0] ?? null;

  /** Retire the current offer — answered, or acknowledged. The next queued one takes the card. */
  const retire = useCallback((mailboxId: string) => {
    lastChecked.current.set(mailboxId, Date.now());
    setOffers((prev) => prev.filter((o) => o.mailboxId !== mailboxId));
    setPhase({ kind: "offer" });
  }, []);

  const importNow = useCallback(() => {
    if (!offer || offer.candidate.state !== "found") return;
    const via = held.current ?? (apiConfigured() ? HOSTED : null);
    if (!via) return;
    const { mailboxId, candidate } = offer;
    setPhase({ kind: "applying" });
    void (async () => {
      try {
        const applied = await via.apply(mailboxId, candidate.fingerprint);
        if (mounted.current) setPhase({ kind: "done", applied });
      } catch (err) {
        // The offer and both buttons survive — the SERVER's sentence, verbatim, above them.
        if (mounted.current) setPhase({ kind: "failed", message: failureSentence(err, held.current !== undefined) });
      }
    })();
  }, [offer]);

  const notNow = useCallback(() => {
    if (!offer) return;
    const via = held.current ?? (apiConfigured() ? HOSTED : null);
    if (!via) return;
    const { mailboxId, candidate } = offer;
    const subject = candidate.state === "found" ? { fingerprint: candidate.fingerprint } : { v: candidate.v };
    setPhase({ kind: "applying" });
    void (async () => {
      try {
        // The dismissal is DURABLE and server-side before the card goes: a card that only hid
        // locally would re-ask on the next tab, which is the nagging this record exists to end.
        await via.decline(mailboxId, subject);
        if (mounted.current) retire(mailboxId);
      } catch (err) {
        if (mounted.current) setPhase({ kind: "failed", message: failureSentence(err, held.current !== undefined) });
      }
    })();
  }, [offer, retire]);

  const acknowledge = useCallback(() => {
    if (offer) retire(offer.mailboxId);
  }, [offer, retire]);

  return { offer, phase, importNow, notNow, acknowledge };
}

/** The counts, in plain words, joined the way the locale joins a list. Zero-count parts vanish. */
function detailsOf(
  t: (key: string, values?: Record<string, string | number | Date>) => string,
  locale: string,
  counts: ProfileImportCountsWire,
): string {
  const parts: string[] = [];
  if (counts.screener > 0) parts.push(t("screenerPart", { count: counts.screener }));
  if (counts.rules > 0) parts.push(t("rulesPart", { count: counts.rules }));
  if (counts.notifyRules > 0) parts.push(t("notifyPart", { count: counts.notifyRules }));
  if (counts.tags > 0) parts.push(t("tagsPart", { count: counts.tags }));
  if (counts.awayResponder) parts.push(t("awayPart"));
  if (parts.length === 0) return "";
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(parts);
  } catch {
    return parts.join(", ");
  }
}

/**
 * The card. Presentational: whether there is anything to say is the shell's call through
 * {@link useProfileImport}, so this renders what it is handed and holds no state of its own.
 * `role="region"`, named, so a screen reader can land on it and leave it — it is an offer,
 * not an interruption, and nothing here traps focus.
 */
export function ProfileImportCard({
  offer, phase, onImport, onNotNow, onAcknowledge,
}: {
  offer: ProfileImportOffer;
  phase: ProfileImportPhase;
  onImport: () => void;
  onNotNow: () => void;
  onAcknowledge: () => void;
}) {
  const t = useTranslations("profileImport");
  const locale = useLocale();
  const format = useFormatter();
  const busy = phase.kind === "applying";
  const failure = phase.kind === "failed" ? phase.message : undefined;

  const errorLine = failure !== undefined ? (
    <p className="pfi-error" role="alert">
      <strong>{t("errorTitle")}</strong> {failure ?? t("errorGeneric")} {t("errorRetry")}
    </p>
  ) : null;

  if (phase.kind === "done") {
    const details = detailsOf(t, locale, phase.applied.imported);
    return (
      <section className="pfi-card" role="region" aria-label={t("doneTitle")}>
        <h2>{t("doneTitle")}</h2>
        {details ? <p className="pfi-lede">{t("doneDetails", { details })}</p> : null}
        {/* Disclosed, not hidden: a rule this build's own validation refuses is left out, and
            the count of what did NOT arrive is part of an honest confirmation. */}
        {phase.applied.skippedRules > 0
          ? <p className="pfi-note">{t("doneSkipped", { count: phase.applied.skippedRules })}</p>
          : null}
        <div className="pfi-actions">
          <Button onClick={onAcknowledge}>{t("doneAction")}</Button>
        </div>
      </section>
    );
  }

  if (offer.candidate.state === "newer") {
    return (
      <section className="pfi-card" role="region" aria-label={t("newerTitle")}>
        <h2>{t("newerTitle")}</h2>
        {/* No import button, deliberately: this build cannot read all of a newer document, and a
            lossy import offered anyway would be a restore that quietly drops settings. */}
        <p className="pfi-lede">{t("newerBody", { address: displayAddress(offer.address) })}</p>
        {errorLine}
        <div className="pfi-actions">
          <Button variant="ghost" onClick={onNotNow} disabled={busy}>{t("newerDismiss")}</Button>
        </div>
      </section>
    );
  }

  const { counts, updatedAt, producer } = offer.candidate;
  const details = detailsOf(t, locale, counts);
  const savedDate = new Date(updatedAt);
  const when = Number.isNaN(savedDate.getTime())
    ? null
    : format.dateTime(savedDate, { dateStyle: "long" });

  return (
    <section className="pfi-card" role="region" aria-label={t("title")}>
      <h2>{t("title")}</h2>
      <p className="pfi-lede">{t("lede", { address: displayAddress(offer.address) })}</p>
      {details ? <p className="pfi-holds">{t("holds", { details })}</p> : null}
      {when !== null ? (
        <p className="pfi-meta">
          {producer.kind === "cloud" ? t("savedByCloud", { when })
            : producer.kind === "local" ? t("savedByLocal", { when })
              : t("savedBy", { when })}
        </p>
      ) : null}
      {errorLine}
      {/* What the button will do, before it is pressed — including what it will not do. */}
      <p className="pfi-note">{t("willDo")}</p>
      <div className="pfi-actions">
        <Button onClick={onImport} disabled={busy}>
          {busy ? t("importing") : t("import")}
        </Button>
        <Button variant="ghost" onClick={onNotNow} disabled={busy}>{t("later")}</Button>
      </div>
    </section>
  );
}
