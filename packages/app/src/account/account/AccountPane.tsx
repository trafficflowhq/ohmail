import { useState } from "react";
import { Button, Dialog, Tag } from "@ohmail/ui/base";
import {
  ActionPanel,
  SettingLine,
  SettingNote,
  SettingsSheet,
  type SettingsSheetProps,
} from "@ohmail/ui/mail";
import type { HostCapabilities } from "../../host/index.js";
import type { PaneSheet } from "../../settings/contract.js";
import { useText } from "../../text/index.js";
import { ACCOUNT_REFUSALS, type FactorSlot } from "../contract.js";
import type { AccountModel } from "./model.js";
import type { PasswordModel } from "./password.js";
import { PasswordForm } from "./PasswordForm.js";

export type AccountPaneProps =
  | {
      /** The whole pane: who is signed in, the password, sign-out, and the way to the page that deletes the account. */
      readonly body: "pane";
      readonly model: AccountModel;
      readonly password: PasswordModel;
      /** The factor's dialog, filled by the shell: the password form draws it while its change is parked. */
      readonly factor: FactorSlot;
      /** The page of states only, never handed by a shell: the password form stands open as the pane is drawn. */
      readonly formOpen?: boolean;
      readonly onPhone?: boolean;
      readonly service?: HostCapabilities["service"];
      readonly sheet?: PaneSheet;
    }
  | {
      /** The sign-out alone, where a host has nothing else of the account to show. */
      readonly body: "signOutOnly";
      readonly model: AccountModel;
    };

type Wants = SettingsSheetProps["wants"];

/** Why the last sign-out stayed on the page, as what its sheet wants: each by the sentence it has today. */
function useStayed(model: AccountModel): Wants {
  const t = useText("account");
  const own = useText("accountOwn");
  if (model.stayed === null) return undefined;
  return {
    word: own(model.stayed === "blocked" ? "stillHere" : "notConfirmed"),
    line: t(ACCOUNT_REFUSALS.account[model.stayed].key),
  };
}

/**
 * Settings › Account. The whole pane says who is signed in, changes the password, signs this browser out and
 * leads to the page that deletes the account; the other body is the sign-out alone. Sign-out is one press with
 * no factor before it. Nothing is erased here: the one verb about erasure leaves for its page.
 */
export function AccountPane(props: AccountPaneProps) {
  return props.body === "pane" ? <Whole {...props} /> : <SignOutAlone model={props.model} />;
}

function Whole({
  model,
  password,
  factor,
  formOpen,
  onPhone,
  service,
  sheet,
}: Extract<AccountPaneProps, { body: "pane" }>) {
  const t = useText("account");
  const own = useText("accountOwn");
  const { who } = model;
  const stayed = useStayed(model);
  const unread =
    who.at !== "failed"
      ? undefined
      : who.said === ""
        ? { word: own("notRead"), alert: true }
        : { word: own("notRead"), line: who.said, alert: true };
  const person =
    who.at === "signedIn"
      ? { name: who.displayName?.trim() || who.address, address: who.address }
      : undefined;
  const content = (
    <>
      <SettingsSheet
        title={person?.name}
        person={person}
        aside={who.at === "signedIn" && service ? <Tag>{own(service)}</Tag> : undefined}
        wants={stayed ?? unread}
      >
        {who.at === "loading" ? <SettingNote>{t("loading")}</SettingNote> : null}
        {who.at === "signedOut" ? (
          <>
            <SettingNote>{t(ACCOUNT_REFUSALS.account.signed_out.key)}</SettingNote>
            <Button kind="two" size="s" onPress={model.toSignIn}>
              {t("signIn")}
            </Button>
          </>
        ) : null}
        {who.at === "signedIn" ? <SettingLine label={own("signedInLabel")} value={who.address} /> : null}
        <Password model={password} factor={factor} formOpen={formOpen === true} />
      </SettingsSheet>
      {who.at === "signedIn" ? (
        <SettingsSheet
          title={t("title")}
          note={{
            line: t("lead"),
            acts: (
              <Button kind="quiet" size="s" onPress={model.toErase}>
                {t("begin")}
              </Button>
            ),
          }}
        />
      ) : null}
      {who.at === "signedIn" ? (
        <p className="oh-vh">{onPhone ? own("signOutOnPhone") : t("signOutBody")}</p>
      ) : null}
    </>
  );
  const foot =
    who.at === "signedIn" ? (
      <ActionPanel
        label={own(onPhone ? "thisPhone" : "thisBrowser")}
        items={[
          {
            id: "sign-out",
            label: model.signingOut ? t("signOutBusy") : t("signOut"),
            icon: "go",
            kind: "ink",
            rank: 0,
            disabled: model.signingOut,
            busy: model.signingOut,
            onPress: model.signOut,
          },
        ]}
      />
    ) : undefined;
  return sheet ? (
    sheet(content, foot)
  ) : (
    <>
      {content}
      {foot}
    </>
  );
}

/** The verb that signs this browser out, with what it does said under it. It is off while a sign-out is on its way. */
function SignOutLine(p: {
  readonly verb: string;
  readonly off: boolean;
  readonly press: () => void;
  readonly said: string;
}) {
  const own = useText("accountOwn");
  return (
    <>
      <SettingLine label={own("thisBrowser")} narrow="detail">
        <Button kind="two" size="s" disabled={p.off} onPress={p.press}>
          {p.verb}
        </Button>
      </SettingLine>
      <SettingNote>{p.said}</SettingNote>
    </>
  );
}

/**
 * The password: a line with the verb that opens its form, or the form. A change that landed closes the form and is
 * said on the line; Cancel closes it and what was typed goes with it.
 */
function Password(p: {
  readonly model: PasswordModel;
  readonly factor: FactorSlot;
  readonly formOpen: boolean;
}) {
  const t = useText("passwordChange");
  const own = useText("accountOwn");
  const [open, setOpen] = useState(p.formOpen);
  const { changed } = p.model;
  // A change that has just landed closes the form: read while drawing, so the form is never drawn once more.
  const [seen, setSeen] = useState(changed);
  if (seen !== changed) {
    setSeen(changed);
    if (changed !== null) setOpen(false);
  }
  if (open) return <PasswordForm model={p.model} factor={p.factor} onCancel={() => setOpen(false)} />;
  return (
    <>
      <SettingLine label={own("changeLabel")}>
        <Button kind="quiet" size="s" onPress={() => setOpen(true)}>
          {t("submit")}
        </Button>
      </SettingLine>
      {changed === null ? null : <SettingNote>{t("done", { count: changed.ended })}</SettingNote>}
    </>
  );
}

/**
 * The sign-out alone, on a browser signed in to somebody's own computer. What this browser kept for that goes with
 * it, so the press asks first, and only the question's own Confirm signs out.
 */
function SignOutAlone({ model }: { readonly model: AccountModel }) {
  const t = useText("pairLanding");
  const stayed = useStayed(model);
  return (
    <>
      <SettingsSheet wants={stayed}>
        <SignOutLine
          verb={t("signOut")}
          off={model.signingOut}
          press={model.signOut}
          said={t("signOutBody")}
        />
      </SettingsSheet>
      <Dialog
        open={model.asked}
        onClose={model.cancelSignOut}
        title={t("signOut")}
        hot
        line={t("signOutConfirm")}
        confirm={{ label: t("signOut"), onPress: model.confirmSignOut, disabled: model.signingOut }}
        cancel={{ label: t("signOutCancel") }}
      />
    </>
  );
}
