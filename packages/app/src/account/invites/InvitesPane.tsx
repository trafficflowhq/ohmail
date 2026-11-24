import { type KeyboardEvent, type ReactNode } from "react";
import { Button, Empty, Field } from "@ohmail/ui/base";
import {
  ActionPanel,
  SettingLine,
  SettingNote,
  SettingsSheet,
  type SettingsSheetProps,
} from "@ohmail/ui/mail";
import type { PaneSheet } from "../../settings/contract.js";
import { useText } from "../../text/index.js";
import { ACCOUNT_REFUSALS, type FactorSlot, type QrSlot } from "../contract.js";
import type { InvitesModel } from "./model.js";
import "./placement.css";

export interface InvitesPaneProps {
  readonly model: InvitesModel;
  /** The factor's dialog, filled by the shell: drawn while a verb is parked behind it. */
  readonly factor: FactorSlot;
  /** The picture of the invite link to scan, filled by the shell. */
  readonly qr: QrSlot;
  readonly sheet?: PaneSheet;
}

type Wants = NonNullable<SettingsSheetProps["wants"]>;

/**
 * Settings › Invites: an invite made for somebody as a link that is shown once, and the open invites, each with
 * its way back. It holds no state and reaches nothing: it draws its model, and its verbs are the model's.
 */
export function InvitesPane({ model, factor, qr, sheet }: InvitesPaneProps) {
  const t = useText("invites");
  const body = (
    <>
      {model.made === null ? <NewInvite model={model} /> : <MadeInvite model={model} qr={qr} />}
      <OpenInvites model={model} />
      {model.ask ? factor(model.ask) : null}
    </>
  );
  const foot = (
    <ActionPanel
      label={t("title")}
      items={[
        model.made === null
          ? {
              id: "make",
              icon: "plus",
              label: model.working?.kind === "make" ? t("working") : t("mintAction"),
              kind: "ink",
              disabled: model.working !== null,
              onPress: model.make,
            }
          : { id: "done", icon: "check", label: t("mintedDone"), kind: "ink", onPress: model.done },
      ]}
    />
  );
  return sheet ? (
    sheet(body, foot)
  ) : (
    <>
      {body}
      {foot}
    </>
  );
}

/**
 * The pane's first sheet. What the last read, verb or copy left to say stands on it: why it did not go through, by
 * the sentence it has today, or that nothing ran; and under its lines what the last verb did.
 */
function FirstSheet(p: {
  readonly model: InvitesModel;
  readonly title?: string;
  readonly aside?: string;
  readonly children: ReactNode;
}) {
  const t = useText("invites");
  const own = useText("accountInvites");
  const steps = useText("devices");
  const { problem, nothingRan, told } = p.model;
  const nothingRanSaid = steps("stepUpCancelledNothingRan");
  let wants: Wants | undefined;
  if (problem === null) wants = nothingRan ? { word: own("cancelled"), line: nothingRanSaid } : undefined;
  else if (problem.with === "copy") wants = { word: own("notCopied"), line: t("copyFailed") };
  else {
    const word = own(problem.with === "read" ? "notRead" : "notDone");
    const line = problem.why.word === "said" ? problem.why.said : t(ACCOUNT_REFUSALS.invites.sign_in.key);
    wants = line === "" ? { word } : { word, line };
  }
  return (
    <SettingsSheet title={p.title} aside={p.aside} hot={p.title !== undefined} wants={wants}>
      {problem !== null && nothingRan ? <SettingNote>{nothingRanSaid}</SettingNote> : null}
      {p.children}
      {/* What the last verb did, where a screen reader hears it arrive. */}
      <div role="status">{told === null ? null : <SettingNote>{t(told.kind)}</SettingNote>}</div>
    </SettingsSheet>
  );
}

/** Whom the invite is for, or nobody, and the verb that makes its link. Enter in the name presses it. */
function NewInvite({ model }: { readonly model: InvitesModel }) {
  const t = useText("invites");
  const off = model.working !== null;
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!off) model.make();
  };
  return (
    <FirstSheet model={model}>
      <div className="account-invite-name" onKeyDown={onKey}>
        <Field
          label={t("mintFor")}
          placeholder={t("namePlaceholder")}
          value={model.name}
          onChange={model.type}
          maxLength={100}
        />
      </div>
    </FirstSheet>
  );
}

/**
 * The invite link, shown once: its picture to scan and the verb that copies it, with the name it was made for. The
 * link itself is never printed: it is scanned or copied. Copy says "copied" only through the model; Done takes it
 * down.
 */
function MadeInvite({ model, qr }: { readonly model: InvitesModel; readonly qr: QrSlot }) {
  const t = useText("invites");
  const { made } = model;
  if (made === null) return null;
  const openInvite = model.invites?.find((invite) => invite.id === made.id);
  return (
    <FirstSheet model={model} title={made.name || t("rowFallback")} aside={t("onceSevenDays")}>
      {qr(made.link, t("qrAria"))}
      {made.expires ? <SettingLine label={t("expires")} value={made.expires} /> : null}
      <Button kind="two" size="s" onPress={model.copy}>
        {t("copyLink")}
      </Button>
      {openInvite ? (
        <Button
          kind="quiet"
          size="s"
          disabled={model.working !== null}
          onPress={() => model.revoke(openInvite.id)}
        >
          {t("revoke")}
        </Button>
      ) : null}
    </FirstSheet>
  );
}

/**
 * The open invites, each with the day it was made, the day it expires and its way back. Nothing is drawn before
 * the list is read: a list that could not be read is not an empty one.
 */
function OpenInvites({ model }: { readonly model: InvitesModel }) {
  const t = useText("invites");
  const own = useText("accountInvites");
  const { invites, working } = model;
  if (invites === null) return null;
  return (
    <SettingsSheet title={t("liveTitle")} aside={String(invites.length)}>
      {invites.length === 0 ? <Empty label={own("none")} /> : null}
      {invites.map((invite) => (
        <SettingLine
          key={invite.id}
          label={invite.name ?? t("rowFallback")}
          icon="invite"
          value={t("rowMeta", { created: invite.made, expires: invite.expires })}
        >
          <Button kind="two" size="s" disabled={working !== null} onPress={() => model.revoke(invite.id)}>
            {working?.kind === "revoke" && working.id === invite.id ? t("working") : t("revoke")}
          </Button>
        </SettingLine>
      ))}
    </SettingsSheet>
  );
}
