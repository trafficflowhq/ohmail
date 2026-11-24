"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { documentHidden } from "@ohmail/app-logic/session/document-hidden";
import { isRemovedMailbox } from "@ohmail/app-logic/mail-state/mail-state";
import {
  askableMailboxes,
  isPending,
  placeRow,
  settledPhase,
  PROFILE_IMPORT_RECHECK_MS,
  PROFILE_IMPORT_STATUS_BEAT_MS,
  type ProfileImportOffer,
  type ProfileImportPhase,
  type ProfileImportState,
  type SavedRow,
  type UnkeptRow,
} from "./model.js";
import type { ProfileImportTransport } from "./wire.js";
import { useCandidateChecks } from "./use-profile-candidates.js";
import { currentOwner, type Mailbox, type Runtime, type Timing } from "./runtime.js";

/** The transport may carry the server's own sentence. A blank or non-error rejection uses the generic line. */
function failureSentence(error: unknown): string | null {
  return error instanceof Error && error.message.length > 0 ? error.message : null;
}

export function useProfileImport(
  active: boolean,
  listed: readonly Mailbox[] | null,
  transport: ProfileImportTransport | null,
  /** The beat, injectable so a test does not wait five minutes for the second look. */
  recheckMs: number = PROFILE_IMPORT_RECHECK_MS,
  /** {@link settingsDoorbell}: a move re-asks every mailbox now, whatever the beat says. */
  doorbell: number | null = null,
  owner: object | null = transport,
): ProfileImportState {
  const mailboxes = askableMailboxes(listed);
  const [offers, setOffers] = useState<ProfileImportOffer[]>([]);
  const [declined, setDeclined] = useState<SavedRow[]>([]);
  const [unkept, setUnkept] = useState<UnkeptRow[]>([]);
  const [phase, setPhase] = useState<ProfileImportPhase>({ kind: "offer" });
  const [beat, setBeat] = useState(0);
  /* A ring that met an ask in flight is OWED: the ask may predate the find, so it runs again. */
  const [nudge, setNudge] = useState(0);

  const scope = mailboxes === null ? null : mailboxes.filter((m) => !isRemovedMailbox(m));
  const lifetime = useMemo(
    () => (active && owner !== null && transport !== null ? {} : null),
    [active, owner, transport],
  );
  const [currentOwner, setCurrentOwner] = useState(lifetime);
  const runtime = useRef<Runtime>({ owner: lifetime, wire: null, roster: null, mounted: false, phase });
  runtime.current.owner = lifetime;
  runtime.current.wire = active ? transport : null;
  runtime.current.roster = scope;
  runtime.current.phase = phase;
  useLayoutEffect(() => {
    runtime.current.mounted = true;
    const current = runtime.current;
    return () => {
      current.mounted = false;
    };
  }, []);
  const timing = useRef<Timing>(freshTiming(doorbell));
  const set = useMemo(() => ({ setDeclined, setNudge, setOffers, setPhase, setUnkept }), []);
  if (currentOwner !== lifetime) {
    // A reconnected native engine can keep its durable scope. Its outstanding offers belong to the old engine.
    setCurrentOwner(lifetime);
    timing.current = freshTiming(doorbell);
    setOffers([]);
    setDeclined([]);
    setUnkept([]);
    setPhase({ kind: "offer" });
  }

  const idsKey = (scope ?? [])
    .map((m) => m.id)
    .sort()
    .join(",");

  useCandidateChecks({ lifetime, idsKey, beat, recheckMs, doorbell, nudge, runtime, timing, set });

  // The slow beat. Visibility-gated like every other poll: nobody looking, nothing asked.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (documentHidden()) return;
      setBeat(Date.now());
    }, recheckMs);
    return () => clearInterval(id);
  }, [active, recheckMs]);

  const offer = offers[0] ?? null;
  const answers = useOfferAnswers(offer, lifetime, runtime, timing, set);
  useImportStatus(
    phase.kind === "importing" ? offer?.mailboxId : undefined,
    phase.kind === "importing" ? phase.fingerprint : undefined,
    doorbell,
    lifetime,
    runtime,
    setPhase,
  );

  return { offer, phase, ...answers, declined, unkept };
}

/** The reviewed offer can be answered once at a time while its mailbox still belongs to the live scope. */
function useOfferAnswers(
  offer: ProfileImportOffer | null,
  lifetime: object | null,
  runtime: RefObject<Runtime>,
  timing: RefObject<Timing>,
  { setDeclined, setOffers, setPhase }: OfferChanges,
) {
  const answerWire = useCallback(
    (mailboxId: string) => {
      const current = runtime.current.phase.kind;
      if (!currentOwner(runtime.current, lifetime) || (current !== "offer" && current !== "failed"))
        return null;
      if (!runtime.current.roster?.some((box) => box.id === mailboxId)) return null;
      const via = runtime.current.wire;
      if (via !== null) {
        runtime.current.phase = { kind: "applying" };
        setPhase(runtime.current.phase);
      }
      return via;
    },
    [lifetime, runtime, setPhase],
  );

  /** Retire the current offer — answered, or acknowledged. The next queued one takes the card. */
  const retire = useCallback(
    (mailboxId: string) => {
      timing.current.lastChecked.set(mailboxId, Date.now());
      timing.current.answered.set(mailboxId, (timing.current.answered.get(mailboxId) ?? 0) + 1);
      setOffers((prev) => prev.filter((o) => o.mailboxId !== mailboxId));
      setPhase({ kind: "offer" });
    },
    [timing, setOffers, setPhase],
  );

  const importNow = useCallback(() => {
    if (!offer || offer.candidate.state !== "found") return;
    const via = answerWire(offer.mailboxId);
    if (!via) return;
    const { mailboxId, candidate } = offer;
    void (async () => {
      try {
        // The receipt goes back only because the card said "replacing the one on this mailbox now".
        const applied = await via.apply(mailboxId, candidate.fingerprint, candidate.counts.signatureReplaces);
        if (!currentOwner(runtime.current, lifetime) || runtime.current.wire !== via) return;
        setPhase(
          isPending(applied)
            ? { kind: "importing", fingerprint: applied.fingerprint, reason: applied.reason ?? null }
            : { kind: "done", applied },
        );
      } catch (err) {
        // The offer and both buttons survive — the SERVER's sentence, verbatim, above them.
        if (currentOwner(runtime.current, lifetime) && runtime.current.wire === via) {
          setPhase({ kind: "failed", message: failureSentence(err) });
        }
      }
    })();
  }, [offer, answerWire, lifetime, runtime, setPhase]);

  const notNow = useCallback(() => {
    if (!offer) return;
    const via = answerWire(offer.mailboxId);
    if (!via) return;
    const { mailboxId, candidate } = offer;
    const subject = candidate.state === "found" ? { fingerprint: candidate.fingerprint } : { v: candidate.v };
    void (async () => {
      try {
        // The dismissal is DURABLE and server-side before the card goes: a card that only hid
        // locally would re-ask on the next tab, which is the nagging this record exists to end.
        await via.decline(mailboxId, subject);
        if (currentOwner(runtime.current, lifetime) && runtime.current.wire === via) {
          retire(mailboxId);
          /* The document just declined IS the row the server now answers, so no ask is needed. */
          if (candidate.state === "found") {
            setDeclined((prev) =>
              placeRow(prev, mailboxId, {
                mailboxId,
                address: offer.address,
                candidate: { ...candidate, state: "declined" },
              }),
            );
          }
        }
      } catch (err) {
        if (currentOwner(runtime.current, lifetime) && runtime.current.wire === via) {
          setPhase({ kind: "failed", message: failureSentence(err) });
        }
      }
    })();
  }, [offer, retire, answerWire, lifetime, runtime, setDeclined, setPhase]);

  const acknowledge = useCallback(() => {
    if (offer && currentOwner(runtime.current, lifetime)) retire(offer.mailboxId);
  }, [offer, retire, runtime, lifetime]);

  return { importNow, notNow, acknowledge };
}

type Setter<T> = Dispatch<SetStateAction<T>>;

function freshTiming(doorbell: number | null): Timing {
  return {
    lastChecked: new Map(),
    inFlight: new Set(),
    rung: doorbell,
    owed: new Set(),
    answered: new Map(),
  };
}

export interface OfferChanges {
  setOffers: Setter<ProfileImportOffer[]>;
  setDeclined: Setter<SavedRow[]>;
  setUnkept: Setter<UnkeptRow[]>;
  setPhase: Setter<ProfileImportPhase>;
  setNudge: Setter<number>;
}

/** A press handed to the organizer settles on its doorbell or the slow status clock. */
function useImportStatus(
  mailboxId: string | undefined,
  fingerprint: string | undefined,
  doorbell: number | null,
  lifetime: object | null,
  runtime: RefObject<Runtime>,
  setPhase: Setter<ProfileImportPhase>,
): void {
  const [statusBeat, setStatusBeat] = useState(0);
  useEffect(() => {
    if (mailboxId === undefined || fingerprint === undefined) return;
    const id = setInterval(() => setStatusBeat((n) => n + 1), PROFILE_IMPORT_STATUS_BEAT_MS);
    return () => clearInterval(id);
  }, [mailboxId, fingerprint]);
  useEffect(() => {
    const via = runtime.current.wire;
    if (mailboxId === undefined || fingerprint === undefined || !via) return;
    let live = true;
    void via
      .status(mailboxId, fingerprint)
      .then((st) => {
        const next = settledPhase(st);
        if (live && currentOwner(runtime.current, lifetime) && runtime.current.wire === via && next !== null)
          setPhase(next);
      })
      .catch(() => {
        /* The next ring or beat can ask again. */
      });
    return () => {
      live = false;
    };
  }, [mailboxId, fingerprint, doorbell, statusBeat, lifetime, runtime, setPhase]);
}
