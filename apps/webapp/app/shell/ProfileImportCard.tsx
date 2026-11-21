"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Button } from "@ohmail/ui/base";
import { SettingActs, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import {
  askableMailboxes, asDeclined, countOf, detailsOf, PROFILE_IMPORT_STATUS_BEAT_MS, useSavedProfileActions,
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

function SavedProfilePending({
  row, reason, readStatus,
}: {
  row: SavedRow;
  reason: "slow" | "unreachable" | null;
  readStatus: SavedProfileActions["readStatus"];
}) {
  const t = useTranslations("profileImport");
  useLayoutEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    function later() {
      timer = setTimeout(async () => {
        if (!mounted) return;
        await readStatus(row);
        if (mounted) later();
      }, PROFILE_IMPORT_STATUS_BEAT_MS);
    }
    later();
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [row, readStatus]);
  return (
    <p className="set-note-inline" role="status">
      {reason === "unreachable" ? t("importingUnreachable") : t("importingSlow")}
    </p>
  );
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
  const { phaseOf, press, readStatus } = actions ?? localActions;

  if (rows.length === 0 && unkept.length === 0) return null;
  return (
    <>
      {unkept.map((row) => (
        <SettingsSheet key={`unkept-${row.mailboxId}`}>
          <SettingNote said>{t("copyUnkept", { address: displayAddress(row.address) })}</SettingNote>
        </SettingsSheet>
      ))}
      {rows.map((row) => {
        const phase = phaseOf(row);
        const { counts, updatedAt, producer } = row.candidate;
        const details = detailsOf(t, locale, counts);
        const savedDate = new Date(updatedAt);
        const when = Number.isNaN(savedDate.getTime()) ? null : format.dateTime(savedDate, { dateStyle: "long" });
        const busy = phase.kind === "busy" || phase.kind === "importing";
        const imported = phase.kind === "imported" ? detailsOf(t, locale, phase.applied.imported) : "";
        const done = [
          imported ? t("doneDetails", { details: imported }) : "",
          phase.kind === "imported" && phase.applied.imported.signatureKept === true ? t("doneSignatureKept") : "",
          phase.kind === "imported" && countOf(phase.applied.retiredRules) > 0 ? t("doneRetired", { count: countOf(phase.applied.retiredRules) }) : "",
        ].filter((line) => line.length > 0).join(" ");
        const plain = detailsOf(t, locale, counts, false);
        return (
          <SettingsSheet key={row.mailboxId} title={t("savedTitle", { address: displayAddress(row.address) })}>
            {details ? <SettingNote>{t("holds", { details })}</SettingNote> : null}
            {when !== null ? (
              <SettingNote>
                {producer.kind === "cloud" ? t("savedByCloud", { when })
                  : producer.kind === "local" ? t("savedByLocal", { when })
                    : t("savedBy", { when })}
              </SettingNote>
            ) : null}
            <SettingNote>{t("savedBody")}</SettingNote>
            {phase.kind === "imported" ? (
              <div role="status" aria-live="polite">
                <SettingNote>{[{ strong: t("doneTitle") }]}</SettingNote>
                {done ? <SettingNote>{done}</SettingNote> : null}
              </div>
            ) : phase.kind === "replaced" ? (
              <SettingNote said>{[{ strong: t("replacedTitle") }]}</SettingNote>
            ) : (
              <>
                {phase.kind === "failed" ? (
                  <div role="status" aria-live="polite">
                    <SettingNote>{[{ strong: t("errorTitle") }]}</SettingNote>
                    <SettingNote>{phase.message ?? t("errorGeneric")}</SettingNote>
                    {phase.message === null ? <SettingNote>{t("errorRetry")}</SettingNote> : null}
                  </div>
                ) : null}
                {phase.kind === "importing" ? (
                  <SavedProfilePending row={row} reason={phase.reason} readStatus={readStatus} />
                ) : null}
                <SettingNote>
                  {plain ? t("replaceNote", { details: plain }) : t("replaceNoteBare")}
                </SettingNote>
                <SettingActs>
                  <Button kind="ink" onPress={() => press(row, "import")} disabled={busy}>
                    {phase.kind === "importing" || (phase.kind === "busy" && phase.verb === "import") ? t("importing") : t("import")}
                  </Button>
                  <Button kind="quiet" onPress={() => press(row, "replace")} disabled={busy}>
                    {phase.kind === "busy" && phase.verb === "replace" ? t("replacing") : t("replace")}
                  </Button>
                </SettingActs>
              </>
            )}
          </SettingsSheet>
        );
      })}
    </>
  );
}
