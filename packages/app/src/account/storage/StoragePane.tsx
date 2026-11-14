import { Fragment } from "react";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText, type Text } from "../../text/index.js";
import type { FactorSlot } from "../contract.js";
import type { StorageFigures, StorageModel } from "./model.js";
import { plain, planSaid, roomSaid, tagSaid } from "./said.js";
import { StoragePlans } from "./StoragePlans.js";

export interface StoragePaneProps {
  readonly model: StorageModel;
  /**
   * What this build may show, as `accountBodies` answers it: `pane` links out, so the plans carry their amounts and
   * the plan can be changed; `facts` says what is stored and why, with no figure, no verb, and where the plan is
   * managed.
   */
  readonly body: "pane" | "facts";
  /** The factor's dialog, filled by the shell: drawn while the change waits for it. */
  readonly factor: FactorSlot;
}

/**
 * Settings › Storage: what is stored against the limit and why the limit is what it is, per mailbox, what the mail is
 * expected to need, from which month text is kept, the plans, the way to change the plan and the storage mails'
 * switch. It holds no state and reaches nothing: it draws its model, and its verbs are the model's.
 */
export function StoragePane({ model, body, factor }: StoragePaneProps) {
  const t = useText("settings");
  const { figures } = model;
  if (figures === null) return null;
  return (
    <>
      <Figures t={t} figures={figures} />
      <SettingsSheet title={t("storageWhatCountsHead")}>
        <SettingNote>{t("storageWhatCountsBody")}</SettingNote>
      </SettingsSheet>
      <SettingsSheet title={t("storageWhyHead")}>
        <SettingNote>{t("storageWhyBody")}</SettingNote>
      </SettingsSheet>
      <SettingsSheet title={t("storagePlanHead")}>
        <SettingNote>{planSaid(t, figures.plan)}</SettingNote>
      </SettingsSheet>
      {figures.plans === null ? null : (
        <StoragePlans model={model} plans={figures.plans} linksOut={body === "pane"} />
      )}
      {body === "facts" ? (
        <SettingsSheet>
          <SettingNote>{t("storageManageAtSite")}</SettingNote>
        </SettingsSheet>
      ) : null}
      <SettingsSheet
        wants={model.mail.failed ? { word: t("notSaved"), line: t("storageMailFailed") } : undefined}
      >
        <SettingLine
          label={t("storageMail")}
          toggle={{ on: model.mail.on, onChange: model.setMail }}
          off={model.mail.busy}
        />
        <SettingNote>{t("storageMailSub")}</SettingNote>
      </SettingsSheet>
      {model.ask === null ? null : factor(model.ask)}
    </>
  );
}

/** Used of the limit with the room left in words and the tag; then per mailbox; then what the mail needs and what is kept. */
function Figures({ t, figures }: { readonly t: Text; readonly figures: StorageFigures }) {
  const { needs, kept } = figures;
  return (
    <SettingsSheet>
      <SettingLine
        label={t("storageOf", { used: figures.used, limit: figures.limit })}
        tag={tagSaid(t, figures.tag)}
        value={t("storageUsed", { room: roomSaid(t, figures.room) })}
      />
      <MailboxLines t={t} figures={figures} />
      {needs === null ? null : (
        <>
          <SettingNote>
            {needs.importing === null
              ? plain(t, "storageNeeds", { letters: needs.letters, size: needs.size })
              : plain(t, "storageImporting", {
                  stored: needs.importing.stored,
                  expected: needs.letters,
                  size: needs.size,
                })}
          </SettingNote>
          <SettingNote>
            {t(needs.average.measured ? "storageAverage" : "storageAverageDefault", {
              size: needs.average.size,
            })}
          </SettingNote>
          {needs.complete ? null : <SettingNote>{t("storageIncomplete")}</SettingNote>}
        </>
      )}
      {kept === null ? null : (
        <>
          <SettingNote>
            {kept.kind === "from"
              ? plain(t, "storageKeptFrom", { month: kept.month })
              : plain(t, "storageKeptSome", { count: kept.count })}
          </SettingNote>
          {kept.refills ? <SettingNote>{t("storageRefill")}</SettingNote> : null}
        </>
      )}
    </SettingsSheet>
  );
}

/**
 * The table per mailbox, until the kit has a table of figures: each mailbox a line, each of its three figures a line
 * under it named by its column, and the total the same way.
 */
function MailboxLines({ t, figures }: { readonly t: Text; readonly figures: StorageFigures }) {
  if (figures.rows.length === 0) return null;
  const cells = (row: { readonly letters: string; readonly kept: string; readonly expected: string }) => (
    <>
      <SettingLine sub label={t("storageColLetters")} value={row.letters} />
      <SettingLine sub label={t("storageColKept")} value={row.kept} />
      <SettingLine sub label={t("storageColExpected")} value={row.expected} />
    </>
  );
  return (
    <>
      {figures.rows.map((row) => (
        <Fragment key={row.id}>
          <SettingLine label={row.mailbox} />
          {cells(row)}
        </Fragment>
      ))}
      {figures.total === null ? null : (
        <>
          <SettingLine label={t("storageTotal")} />
          {cells(figures.total)}
        </>
      )}
    </>
  );
}
