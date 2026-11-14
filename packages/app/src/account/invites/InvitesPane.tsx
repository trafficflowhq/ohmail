import { Fragment, type KeyboardEvent, type ReactNode } from "react";
import { Button, Empty, Field } from "@ohmail/ui/base";
import { SettingLine, SettingNote, SettingsSheet, type SettingsSheetProps } from "@ohmail/ui/mail";
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
}

type Wants = NonNullable<SettingsSheetProps["wants"]>;

/**
 * Settings › Invites: an invite made for somebody as a link that is shown once, and the open invites, each with
 * its way back. It holds no state and reaches nothing: it draws its model, and its verbs are the model's.
 */
export function InvitesPane({ model, factor, qr }: InvitesPaneProps) {
  return (
    <>
      {model.made === null ? <NewInvite model={model} /> : <MadeInvite model={model} qr={qr} />}
      <OpenInvites model={model} />
      {model.ask ? factor(model.ask) : null}
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
    <SettingsSheet title={p.title} hot={p.title !== undefined} wants={wants}>
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
      <SettingNote>{t("intro")}</SettingNote>
      <div className="account-invite-name" onKeyDown={onKey}>
        <Field label={t("mintFor")} value={model.name} onChange={model.type} maxLength={100} />
      </div>
      <SettingNote>{t("mintHint")}</SettingNote>
      <Button kind="ink" size="s" disabled={off} onPress={model.make}>
        {model.working?.kind === "make" ? t("working") : t("mintAction")}
      </Button>
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
  return (
    <FirstSheet model={model} title={made.name === "" ? t("rowFallback") : made.name}>
      <SettingNote>
        {made.name === "" ? t("mintedLead") : t("mintedLeadFor", { name: made.name })}
      </SettingNote>
      {qr(made.link, t("qrAria"))}
      <Button kind="two" size="s" onPress={model.copy}>
        {t("copyLink")}
      </Button>
      <Button kind="ink" size="s" onPress={model.done}>
        {t("mintedDone")}
      </Button>
      <SettingNote>{t("mintedOnce")}</SettingNote>
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
        <Fragment key={invite.id}>
          <SettingLine label={invite.name ?? t("rowFallback")} icon="invite">
            <Button kind="two" size="s" disabled={working !== null} onPress={() => model.revoke(invite.id)}>
              {working?.kind === "revoke" && working.id === invite.id ? t("working") : t("revoke")}
            </Button>
          </SettingLine>
          <SettingNote>{t("rowMeta", { created: invite.made, expires: invite.expires })}</SettingNote>
        </Fragment>
      ))}
    </SettingsSheet>
  );
}
