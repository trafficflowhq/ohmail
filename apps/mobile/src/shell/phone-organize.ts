import { Platform } from "react-native";
import { CLAIM_LAPSES_AFTER_MINUTES } from "../engine/standalone-door";
import { Copy } from "../copy";
import {
  answerLeavesNotificationsOff, markOrganizerNotificationAsked, recordLiveNotificationState,
  requestOrganizerNotification, shouldAskForOrganizerNotification,
} from "../engine/notification-permission";
import { nativeNotificationPermission, openNotificationSettings } from "../engine/notification-permission-native";
import {
  organizerHandBackLateSaid, organizerHandedBack, organizerInstruction, organizerNotificationsOffSaid,
  organizerRestrictedSaid, organizerSettingsLeft, organizeRefusal, pressOrganizeHere, sayNotificationsOff,
  sayNotificationsOn, standaloneHereFor,
} from "../engine/organizer-session";
import { liveMailboxRows, type PhoneMailbox } from "../net/mailboxes";
import type { ShellSession } from "../net/pairing";
import {
  claimChipLabel, claimFrom, claimHere, claimHolderOf, claimNoteLine, mayStartHere, mayStopHere,
  pressSaidLine, pressSaidOf, settingsLeftLine, type PhoneClaim, type PressSaid,
} from "../ui/standalone-form";
import { sayRefusal } from "../refusal";
import type { PhoneOrganizerRequest, PhoneOrganizerRow, Refused } from "./bridge-kinds";

function tagOf(claim: PhoneClaim): PhoneOrganizerRow["tag"] {
  switch (claim.k) {
    case "unknown": return null;
    case "ours": return claim.stopping ? "stopping" : claim.releasePending ? "stopPending" : "organizing";
    case "free": return claim.starting ? "starting" : "notOrganized";
    case "handedBack": return "handedBack";
    case "parked": return "paused";
    case "blocked": return claim.holding ? "organizing" : "notOrganized";
    default: return "reader";
  }
}

export function phoneOrganizerOf(
  session: ShellSession, live: () => boolean, readRoster: (signal: AbortSignal) => Promise<PhoneMailbox[] | null>,
) {
  let said: PressSaid = null;
  let busy = false;
  const permission = nativeNotificationPermission();
  const notice = { off: sayNotificationsOff, on: sayNotificationsOn };
  const current = () => {
    const here = standaloneHereFor(session);
    return here && { here, claim: claimHere(here, organizerInstruction(), organizerHandedBack()) };
  };
  return async (
    request: PhoneOrganizerRequest,
    signal: AbortSignal,
  ): Promise<{ rows: readonly PhoneOrganizerRow[] } | { refused: Refused }> => {
    const allowed = () => !signal.aborted && live();
    if (!allowed()) return { refused: "cancelled" };
    if (session.boundAccount() !== session.profile.accountId) return { refused: "notReady" };
    if (!session.standalone) {
      if (request.do !== "read") return { refused: "notReady" };
      const roster = await readRoster(signal);
      if (!allowed()) return { refused: "cancelled" };
      if (roster === null) return { refused: "notReady" };
      return { rows: liveMailboxRows(roster).map((row) => {
        const claim = claimFrom({
          known: true, role: row.organizerRole, serverHolds: row.organizedByThisInstall,
          parked: (row.organizerParkedAt ?? null) !== null, organizer: claimHolderOf(row),
        });
        const note = claim.k === "parked" ? Copy.phoneStateParked : claimNoteLine(claim, Platform.OS);
        return {
          id: row.id, address: row.address, tag: tagOf(claim), notes: note ? [note] : [],
          warnings: [], start: false, stop: false, explainBackground: false, notifications: false,
        };
      }) };
    }
    if (request.do !== "read") {
      const found = current();
      if (found === null || found.here.id !== request.mailboxId) return { refused: "foreignScope" };
      if (busy) return { refused: "notReady" };
      if (request.do === "start" && !mayStartHere(found.claim)) return { refused: "notReady" };
      if (request.do === "stop" && !mayStopHere(found.claim)) return { refused: "notReady" };
      busy = true;
      try {
        if (request.do === "notifications") {
          if (organizerNotificationsOffSaid()) await openNotificationSettings();
        } else {
          const outcome = await pressOrganizeHere(request.do);
          if (!allowed()) return { refused: "cancelled" };
          said = request.do === "start" ? pressSaidOf(outcome) : outcome === "refused" ? "stopRefused" : null;
          if (request.do === "start" && outcome === "started" && await shouldAskForOrganizerNotification(permission)) {
            if (!allowed()) return { refused: "cancelled" };
            await markOrganizerNotificationAsked(permission);
            if (!allowed()) return { refused: "cancelled" };
            const answer = request.background ? await requestOrganizerNotification(permission) : "denied";
            if (!allowed()) return { refused: "cancelled" };
            if (answerLeavesNotificationsOff(answer)) notice.off();
            else notice.on();
          }
        }
      } finally {
        busy = false;
      }
    } else {
      await recordLiveNotificationState(permission, {
        off: () => { if (allowed()) notice.off(); },
        on: () => { if (allowed()) notice.on(); },
      });
    }
    if (!allowed()) return { refused: "cancelled" };
    const found = current();
    if (found === null) return { rows: [] };
    const { here, claim } = found;
    const start = here.id !== null && mayStartHere(claim);
    const explainBackground = start && await shouldAskForOrganizerNotification(permission);
    if (!allowed()) return { refused: "cancelled" };
    // The permission read may have outlived the organizer state that made Start available.
    const afterPermission = current();
    if (afterPermission === null || afterPermission.here.id !== here.id) return { refused: "notReady" };
    const now = afterPermission.claim;
    const restricted = organizerRestrictedSaid();
    const notifications = organizerNotificationsOffSaid();
    const consent = organizeRefusal();
    const notes = [
      mayStartHere(now) ? Copy.phoneFreeOffer : claimNoteLine(now, Platform.OS, { declined: restricted || notifications }),
      restricted ? Copy.organizerRestricted : null,
      notifications ? Copy.organizerNotificationsOff : null,
      organizerHandBackLateSaid() ? Copy.organizerHandBackLate(CLAIM_LAPSES_AFTER_MINUTES) : null,
    ].filter((line): line is string => line !== null);
    const warnings = [
      now.k === "blocked" || (now.k === "ours" && now.settingsBlocked) ? claimChipLabel(now) : null,
      consent === null ? null : sayRefusal(consent),
      pressSaidLine(said, now),
      settingsLeftLine(organizerSettingsLeft(), now),
    ].filter((line): line is string => line !== null);
    return { rows: [{
      id: here.id ?? "", address: here.address, tag: tagOf(now), notes, warnings,
      start: here.id !== null && mayStartHere(now), stop: here.id !== null && mayStopHere(now),
      explainBackground, notifications,
    }] };
  };
}
