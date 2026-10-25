"use client";

/**
 * ADDRESS FIRST — the one helper behind every connect form that asks for the address before the provider
 * (the /join mailbox step, Settings → Mailboxes, the first run's add form, the desktop's own door).
 *
 * An address at a preset's own domain, or Proton's, is answered from the table at once. Any other domain
 * is looked up after a pause in typing or when the address field is left, through `POST /mailboxes/discover`
 * where the surface has it: the domain only, never the part before the @. The answer preselects a tile the
 * person can change; a tile chosen by hand is never overridden, except the manual tile pressed before the
 * answer came, which gives way to a preset the answer names. A slow or failed lookup is no answer, so
 * nothing waits on it. The guess only ever fills fields: the surface's own choose runs `hostsFor`, and the
 * probe decides what is dialled.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  discoveryRequestFor, isProtonAddress, presetForAddress, providerById, readDiscovery, type DiscoveredServer, type Discovery,
} from "./providers";

/** Asks `POST /mailboxes/discover` about one domain. Absent where the surface has no lookup. */
export type DiscoverLookup = (body: { domain: string }, signal: AbortSignal) => Promise<unknown>;

/** How long a form listens for a lookup: the server's 2 s budget and the trip. Later is no answer. */
export const LOOKUP_WAIT_MS = 4_000;

/** The pause in typing after which the domain is looked up without the field being left. */
export const LOOKUP_PAUSE_MS = 800;

/** A domain worth asking about: dotted, with a top-level label of two or more characters. */
const ASKABLE = /^[^.\s@]+(?:\.[^.\s@]+)*\.[a-z0-9-]{2,}$/i;

/** What the address says with no lookup: a preset's own domain, or Proton's. `null` for anything else. */
export function tableGuess(address: string): Discovery | null {
  if (isProtonAddress(address)) return { preset: null, proton: true, imap: null, smtp: null };
  const preset = presetForAddress(address);
  return preset ? { preset, proton: false, imap: null, smtp: null } : null;
}

export interface AddressFirst {
  /** What is known about the typed address's domain, or `null`. */
  guess: Discovery | null;
  /** A lookup for this domain is out. The form stays usable meanwhile. */
  looking: boolean;
  /** The address field was left: look the domain up, once, if the table does not know it. */
  lookUp: () => void;
  /** A tile chosen by the person: from now on the guess no longer chooses. */
  pick: (id: string) => void;
}

export function useAddressFirst({ address, lookup, chosen, choose, chosenByHand = chosen !== null }: {
  address: string;
  lookup?: DiscoverLookup;
  /** The tile on screen, or `null`. */
  chosen: string | null;
  /** Whether the tile on screen at mount is the person's: by default any is (a form kept across steps). */
  chosenByHand?: boolean;
  /** Select a preset (`id`), or withdraw this helper's own preselection (`null`). Not called for a hand choice. */
  choose: (id: string | null) => void;
}): AddressFirst {
  const domain = discoveryRequestFor(address)?.domain ?? null;
  const [answers, setAnswers] = useState<ReadonlyMap<string, Discovery | null>>(() => new Map());
  const [looking, setLooking] = useState<string | null>(null);
  const asked = useRef(new Set<string>());
  const byHand = useRef(chosenByHand);
  /** The domain whose answer was still out when the manual tile was pressed: a preset it names still chooses. */
  const manualBefore = useRef<string | null>(null);
  /** The id this helper chose last, so it withdraws only its own choice. */
  const auto = useRef<string | null>(null);
  const live = useRef({ address, domain, lookup, answers });
  live.current = { address, domain, lookup, answers };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const guess = tableGuess(address) ?? (domain !== null ? answers.get(domain) ?? null : null);
  const want = guess?.preset?.id ?? null;

  // No tile on screen means no hand choice stands (a reset form, a withdrawn guess).
  if (chosen === null) byHand.current = false;

  useEffect(() => {
    if (byHand.current) return;
    if (want !== null) {
      auto.current = want;
      if (want !== chosen) choose(want);
    } else if (auto.current !== null) {
      if (chosen === auto.current) choose(null);
      auto.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the guess decides; `chosen` is read, not watched
  }, [want]);

  const lookUp = useCallback((): void => {
    const { address: typed, domain: d, lookup: ask } = live.current;
    if (!ask || d === null || !ASKABLE.test(d) || tableGuess(typed) !== null || asked.current.has(d)) return;
    asked.current.add(d);
    setLooking(d);
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => { stop.abort(); resolve(null); }, LOOKUP_WAIT_MS);
    });
    void Promise.race([ask({ domain: d }, stop.signal).then(readDiscovery, () => null), late]).then((found) => {
      clearTimeout(timer);
      if (!mounted.current) return;
      if (manualBefore.current === d) {
        manualBefore.current = null;
        if (found?.preset && live.current.domain === d) byHand.current = false;
      }
      setAnswers((m) => new Map(m).set(d, found));
      setLooking((l) => (l === d ? null : l));
    });
  }, []);

  useEffect(() => {
    if (domain === null || !ASKABLE.test(domain)) return;
    const timer = setTimeout(lookUp, LOOKUP_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [domain, lookUp]);

  const pick = useCallback((id: string): void => {
    byHand.current = true;
    const { address: typed, domain: d, answers: known } = live.current;
    const open = d !== null && tableGuess(typed) === null && !known.has(d);
    manualBefore.current = providerById(id).manual && open ? d : null;
  }, []);

  return { guess, looking: domain !== null && looking === domain, lookUp, pick };
}

/** A discovered server as one host field holds it: the bare name on its protocol's usual ports. */
export function hostFieldOf(server: DiscoveredServer, kind: "imap" | "smtp"): string {
  const usual = kind === "imap" ? [993, 143] : [465, 587];
  return usual.includes(server.port) ? server.host : `${server.host}:${server.port}`;
}

/**
 * THE HOSTS THE LOOKUP FOUND, offered after a refusal for an unreachable host on the manual tile. The press
 * fills the fields and nothing else; the next connect proves them. Nothing when nothing was found, or when
 * the fields already hold it.
 */
export function DiscoveredHostsOffer({ guess, imapHost, smtpHost, onUse }: {
  guess: Discovery | null;
  imapHost: string;
  smtpHost: string;
  onUse: (servers: { imap: DiscoveredServer | null; smtp: DiscoveredServer | null }) => void;
}) {
  const t = useTranslations("providerPicker");
  const imap = guess?.imap ?? null;
  const smtp = guess?.smtp ?? null;
  if (!imap && !smtp) return null;
  const same = (!imap || hostFieldOf(imap, "imap") === imapHost.trim())
    && (!smtp || hostFieldOf(smtp, "smtp") === smtpHost.trim());
  if (same) return null;
  const servers = [imap ? `IMAP ${hostFieldOf(imap, "imap")}` : null, smtp ? `SMTP ${hostFieldOf(smtp, "smtp")}` : null]
    .filter(Boolean).join(", ");
  return (
    <p className="join-hint" role="status">
      {t("discoveredHosts", { servers })}{" "}
      <button type="button" className="join-alt" onClick={() => onUse({ imap, smtp })}>{t("discoveredUse")}</button>
    </p>
  );
}
