import { useRef, useState } from "react";
import { design, InfoMark, Menu } from "@ohmail/ui/base";
import { FigureLine, FigureTable, ScaleBar, SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText, type Text } from "../../text/index.js";
import type { FactorSlot } from "../contract.js";
import type { StorageFigures, StorageModel } from "./model.js";
import { tagSaid } from "./said.js";
import type { PaneSheet } from "../../settings/contract.js";
import { StoragePlanActions, StoragePlans } from "./StoragePlans.js";

export interface StoragePaneProps {
  readonly model: StorageModel;
  readonly sheet?: PaneSheet;
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
export function StoragePane({ model, body, factor, sheet }: StoragePaneProps) {
  const t = useText("settings");
  const { figures } = model;
  if (figures === null) return sheet ? sheet(null) : null;
  const content = (
    <>
      <Figures t={t} figures={figures} />
      <StorageExplanation plan={figures.plan} t={t} />
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
          description={t("storageMailSub")}
          toggle={{ on: model.mail.on, onChange: model.setMail }}
          off={model.mail.busy}
        />
      </SettingsSheet>
      {model.ask === null ? null : factor(model.ask)}
    </>
  );
  const foot =
    body === "pane" && figures.plans?.mayChange ? (
      <StoragePlanActions model={model} add={figures.plans.addon !== null} />
    ) : null;
  return sheet ? (
    sheet(content, foot)
  ) : (
    <>
      {content}
      {foot}
    </>
  );
}

export function StorageInfo() {
  const t = useText("settings");
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <InfoMark
        ref={anchor}
        label={t("storageWhatCountsHead")}
        expanded={open}
        onPress={() => setOpen(!open)}
      />
      <Menu
        anchor={anchor}
        kind="card"
        label={t("storage")}
        title={t("storage")}
        open={open}
        onClose={() => setOpen(false)}
      >
        <SettingNote>{t("storageInfoCounts")}</SettingNote>
        <SettingNote>{t("storageInfoPurpose")}</SettingNote>
        <SettingNote>{t("storageInfoOriginals")}</SettingNote>
      </Menu>
    </>
  );
}

const hues = Object.values(design.tagHues);

function Figures({ t, figures }: { readonly t: Text; readonly figures: StorageFigures }) {
  const { needs, kept, bar, room } = figures;
  const hueById = new Map(figures.rows.map((row, index) => [row.id, hues[index % hues.length]]));
  const parts = bar.parts.map((part) => ({
    from: part.from * 100,
    share: part.width * 100,
    hue: hueById.get(part.id),
  }));
  const marks = [bar.limit, bar.plan].flatMap((mark) =>
    mark ? [{ at: mark.at * 100, label: mark.said }] : [],
  );
  const scale = [
    { label: t("storageScaleStart") },
    ...(bar.rest
      ? [{ label: t(bar.rest.kind === "toCome" ? "storageBarImporting" : "storageBarOut"), rest: true }]
      : []),
    { label: bar.expected ? t("storageBarExpected", { size: bar.expected.said }) : bar.scale },
  ];
  const of =
    room.kind === "held"
      ? t("storageFigureHeld", { date: room.until })
      : t(room.kind === "trial" ? "storageFigureTrial" : "storageFigureOf", { limit: figures.limit });
  return (
    <SettingsSheet>
      <FigureLine figure={figures.used} of={of} info={<StorageInfo />} tag={tagSaid(t, figures.tag)} />
      <ScaleBar
        label={t("storageOf", { used: figures.used, limit: figures.limit })}
        parts={
          bar.rest
            ? [...parts, { from: bar.rest.from * 100, share: bar.rest.width * 100, kind: "rest" }]
            : parts
        }
        marks={marks}
        scale={scale}
      />
      {figures.rows.length > 0 ? (
        <FigureTable
          label={t("mailboxes")}
          columns={["storageColMailbox", "storageColLetters", "storageColKept", "storageColExpected"].map(
            (key) => t(key),
          )}
          rows={figures.rows.map((row) => ({
            id: row.id,
            name: row.mailbox,
            hue: hueById.get(row.id),
            figures: [row.letters, row.kept, row.expected],
          }))}
          sum={
            figures.total
              ? {
                  name: t("storageTotal"),
                  figures: [figures.total.letters, figures.total.kept, figures.total.expected],
                }
              : undefined
          }
        />
      ) : null}
      {needs &&
      (bar.expected !== null || bar.rest !== null || needs.importing !== null || !needs.complete) ? (
        <>
          <SettingNote>
            {needs.importing
              ? t("storageImportProgress", {
                  stored: needs.importing.stored,
                  expected: needs.letters,
                  size: needs.size,
                  average: needs.average.size,
                })
              : t("storageNeedsAverage", {
                  count: needs.letters,
                  size: needs.size,
                  average: needs.average.size,
                })}
          </SettingNote>
          {needs.complete ? null : <SettingNote>{t("storageIncomplete")}</SettingNote>}
        </>
      ) : null}
      {kept?.kind === "from" ? <SettingLine label={t("storageKeptFromLabel")} value={kept.month} /> : null}
      {kept?.kind === "some" ? (
        <SettingNote>{t("storageKeptSome", { count: kept.count })}</SettingNote>
      ) : null}
      {kept?.refills ? <SettingNote>{t("storageRefill")}</SettingNote> : null}
    </SettingsSheet>
  );
}

export function StorageExplanation({ plan, t }: { plan: StorageFigures["plan"]; t: Text }) {
  const name = plan.kind === "keeps" && plan.plan ? t("storagePlanName", { plan: plan.plan }) : null;
  return (
    <SettingsSheet>
      <SettingLine label={t("storageWhatCountsHead")} value={t("storageCountsText")} />
      <SettingLine label={t("storageAttachments")} value={t("storageNeverCounted")} />
      {plan.kind === "until" ? (
        <SettingLine
          label={t("storageYouKeep")}
          value={t("storageLimitUntil", { limit: plan.limit, date: plan.date })}
        />
      ) : null}
      <SettingLine
        label={name ? t("storageNamedPlanKeeps", { plan: name }) : t("storageYourPlanKeeps")}
        value={
          plan.kind === "until"
            ? t("storageFromThen", { limit: plan.cap })
            : plan.kind === "trial"
              ? plan.cap
              : plan.limit
        }
      />
    </SettingsSheet>
  );
}
