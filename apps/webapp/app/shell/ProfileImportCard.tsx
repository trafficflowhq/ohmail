"use client";

import { useEffect, useRef, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import {
  askableMailboxes, asDeclined, SavedProfileRows, useSavedProfileActions,
  ProfileImportCard as SharedProfileImportCard,
  useProfileImport as useProfileOffer,
  type ProfileImportCardProps,
  type ProfileImportState, type ProfileImportTransport, type SavedProfileActions, type SavedRow, type UnkeptRow,
} from "@ohmail/app/profile-import";
import { apiConfigured } from "../api-client";
import { HOSTED } from "../profile-import-wire";

export { HOSTED } from "../profile-import-wire";
export {
  askableMailboxes, PROFILE_IMPORT_RECHECK_MS, PROFILE_IMPORT_STATUS_BEAT_MS, queueOffer, settingsDoorbell,
  type ProfileImportOffer, type ProfileImportPhase, type ProfileImportState, type ProfileImportTransport, type SavedRow, type UnkeptRow,
} from "@ohmail/app/profile-import";

export function ProfileImportCard(props: Omit<ProfileImportCardProps, "words">) {
  const profile = useTranslations("profileImport");
  const mailbox = useTranslations("mailboxes");
  const locale = useLocale();
  const format = useFormatter();
  return <SharedProfileImportCard {...props} words={{ profile, mailbox, locale, longDate: (date) => format.dateTime(date, { dateStyle: "long" }) }} />;
}

export function useProfileImport(
  active: boolean,
  listed: readonly { id: string; address: string; status?: string; legacyStandDown?: boolean }[] | null,
  transport?: ProfileImportTransport,
  recheckMs?: number,
  doorbell?: number | null,
): ProfileImportState {
  return useProfileOffer(active, listed, active ? transport ?? (apiConfigured() ? HOSTED : null) : null, recheckMs, doorbell);
}

/**
 * THE DECLINED DOCUMENTS STANDING IN THE MAILBOXES, read once per mailbox set over the card's
 * transport. The SHELL holds the answer, so a surface with no Mailboxes pane of its own (the
 * desktop's served host client) still has a pane while a row exists. A failed ask is no row;
 * `null` mailboxes asks nothing.
 */
export function useSavedProfiles(
  listed: ReadonlyArray<{ id: string; address: string; status?: string | null }> | null,
  transport?: ProfileImportTransport,
): SavedRow[] {
  const mailboxes = askableMailboxes(listed);
  const [rows, setRows] = useState<SavedRow[]>([]);
  const held = useRef(transport);
  held.current = transport;
  const list = useRef(mailboxes);
  list.current = mailboxes;
  const idsKey = mailboxes === null ? null : mailboxes.map((m) => m.id).sort().join(",");

  useEffect(() => {
    const via = held.current ?? (apiConfigured() ? HOSTED : null);
    const boxes = list.current;
    if (!via || boxes === null) return;
    let live = true;
    void Promise.all(boxes.map(async (m): Promise<SavedRow | null> => {
      try {
        const candidate = asDeclined(await via.candidate(m.id));
        return candidate ? { mailboxId: m.id, address: m.address, candidate } : null;
      } catch {
        return null;
      }
    })).then((found) => {
      if (live) setRows(found.filter((r): r is SavedRow => r !== null));
    });
    return () => { live = false; };
  }, [idsKey]);
  return rows;
}

/**
 * SETTINGS → MAILBOXES: THE DECLINED DOCUMENTS. "Not now" keeps the found settings in the mailbox
 * and this install's own off it; this is where the person later imports them, or replaces them
 * with this ohmail's. `rows` is the shell's own read ({@link useSavedProfiles}); without it the
 * section reads for itself. Each row keeps its buttons through a refused press.
 */
export function SavedProfileSection({
  mailboxes: listed, transport, rows: given, unkept = [], actions,
}: {
  mailboxes?: ReadonlyArray<{ id: string; address: string; status?: string | null }> | null;
  transport?: ProfileImportTransport;
  rows?: SavedRow[];
  actions?: SavedProfileActions;
  /** Mailboxes whose organizer cannot keep its settings copy there ({@link useProfileImport}'s `unkept`). */
  unkept?: ReadonlyArray<UnkeptRow>;
}) {
  const t = useTranslations("profileImport");
  const locale = useLocale();
  const format = useFormatter();
  const read = useSavedProfiles(given === undefined ? listed ?? null : null, transport);
  const rows = given ?? read;
  const localActions = useSavedProfileActions(actions === undefined ? transport ?? (apiConfigured() ? HOSTED : null) : null);
  return <SavedProfileRows rows={rows} unkept={unkept} actions={actions ?? localActions}
    t={t} locale={locale} longDate={(date) => format.dateTime(date, { dateStyle: "long" })} />;
}
