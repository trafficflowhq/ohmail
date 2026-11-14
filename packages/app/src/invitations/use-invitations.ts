/**
 * THE INVITATIONS ON THIS VERSION: the occurrences from today to the last day the device holds, worked into the three
 * groups again whenever the mirror moves. Nothing is kept: a cancel that arrives while a row is open is drawn at once.
 */
import { useEffect, useMemo, useState } from "react";
import {
  addDays,
  dayOfIso,
  isoOfDay,
  nowIn,
  occurrencesIn,
  readerZones,
  type CalendarPort,
} from "@ohmail/app-logic/calendar";
import { invitationsOf, type InvitationGroups } from "@ohmail/app-logic/calendar/invitations";
import { ownAddressesOf } from "@ohmail/app-logic/mail-state";
import { useFrame } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useTimeZone } from "../text/index.js";
import { useSources } from "../calendar/where.js";

/** A mailbox's facts as far as an address is read from them: the host hands them in untyped. */
function hasAddress(f: unknown): f is { address: string; addressIsOwn?: boolean } {
  return typeof f === "object" && f !== null && typeof (f as { address?: unknown }).address === "string";
}

/** The account's own addresses, as the server counts them; none while the host cannot say. */
export function useOwnAddresses(): readonly string[] {
  const { host } = useFrame();
  const read = host.reads.mailboxes;
  const [own, setOwn] = useState<readonly string[]>([]);
  useEffect(() => {
    if (read === NONE) return;
    let live = true;
    read().then(
      (facts) => live && setOwn(ownAddressesOf(facts.filter(hasAddress))),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [read]);
  return own;
}

export interface Invitations {
  readonly groups: InvitationGroups;
  readonly today: string;
  readonly sources: ReturnType<typeof useSources>;
}

export function useInvitations(port: CalendarPort | typeof NONE): Invitations | null {
  const sources = useSources(port);
  const own = useOwnAddresses();
  const zone = useTimeZone();
  const zones = readerZones();
  const now = nowIn(Date.now(), zone, zones);
  const today = now === null ? null : isoOfDay(now.day);
  return useMemo(() => {
    if (port === NONE || today === null) return null;
    const from = dayOfIso(today);
    const to = dayOfIso(addDays(today, port.held().window.daysAhead));
    if (from === null || to === null) return null;
    const occurrences = occurrencesIn({ ...sources, query: { from, to }, zone, zones }).shown;
    const groups = invitationsOf({
      occurrences,
      connections: sources.connections,
      ownAddresses: own,
      todayKey: today,
      zone,
      zones,
    });
    return { groups, today, sources };
  }, [sources, own, today, zone, zones, port]);
}
