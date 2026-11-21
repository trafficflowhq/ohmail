import { useLayoutEffect } from "react";
import { Button } from "@ohmail/ui/base";
import { SettingActs, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { longDateStamp } from "@ohmail/app-logic/text/format";
import { useLocale, useText, useTimeZone } from "../text/index.js";
import { useProfileImportState } from "./ground.js";
import { countOf, detailsOf, PROFILE_IMPORT_STATUS_BEAT_MS, type SavedRow, type UnkeptRow } from "./model.js";
import type { SavedProfileActions } from "./saved-profile-actions.js";

function SavedProfilePending({
  row,
  word,
  readStatus,
}: {
  row: SavedRow;
  word: string;
  readStatus: SavedProfileActions["readStatus"];
}) {
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
  return <SettingNote said>{word}</SettingNote>;
}

/** Declined settings remain available in Mailboxes, including on hosts that cannot manage mailboxes. */
export function SavedProfileSettings() {
  const t = useText("profileImport");
  const locale = useLocale();
  const zone = useTimeZone();
  const state = useProfileImportState();
  if (!state) return null;
  return (
    <SavedProfileRows
      rows={state.declined}
      unkept={state.unkept}
      actions={state.saved}
      t={t}
      locale={locale}
      longDate={(date) => longDateStamp(date, zone, locale)}
    />
  );
}

export function SavedProfileRows({
  rows,
  unkept,
  actions,
  t,
  locale,
  longDate,
}: {
  rows: readonly SavedRow[];
  unkept: readonly UnkeptRow[];
  actions: SavedProfileActions;
  t: Parameters<typeof detailsOf>[0];
  locale: string;
  longDate: (date: Date) => string;
}) {
  const { phaseOf, press, readStatus } = actions;
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
        const when = Number.isNaN(savedDate.getTime()) ? null : longDate(savedDate);
        const busy = phase.kind === "busy" || phase.kind === "importing";
        const imported = phase.kind === "imported" ? detailsOf(t, locale, phase.applied.imported) : "";
        const done = [
          imported ? t("doneDetails", { details: imported }) : "",
          phase.kind === "imported" && phase.applied.imported.signatureKept === true
            ? t("doneSignatureKept")
            : "",
          phase.kind === "imported" && countOf(phase.applied.retiredRules) > 0
            ? t("doneRetired", { count: countOf(phase.applied.retiredRules) })
            : "",
        ]
          .filter((line) => line.length > 0)
          .join(" ");
        const plain = detailsOf(t, locale, counts, false);
        return (
          <SettingsSheet
            key={row.mailboxId}
            title={t("savedTitle", { address: displayAddress(row.address) })}
          >
            {details ? <SettingNote>{t("holds", { details })}</SettingNote> : null}
            {when !== null ? (
              <SettingNote>
                {producer.kind === "cloud"
                  ? t("savedByCloud", { when })
                  : producer.kind === "local"
                    ? t("savedByLocal", { when })
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
                  <SavedProfilePending
                    row={row}
                    word={phase.reason === "unreachable" ? t("importingUnreachable") : t("importingSlow")}
                    readStatus={readStatus}
                  />
                ) : null}
                <SettingNote>
                  {plain ? t("replaceNote", { details: plain }) : t("replaceNoteBare")}
                </SettingNote>
                <SettingActs>
                  <Button kind="ink" onPress={() => press(row, "import")} disabled={busy}>
                    {phase.kind === "importing" || (phase.kind === "busy" && phase.verb === "import")
                      ? t("importing")
                      : t("import")}
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
