import { useEffect, useState, type ReactNode } from "react";
import { FieldStack, Icon, Switch, Tag } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import { splitHostPort } from "@ohmail/app-logic/mailboxes/connect/body";
import { portMeansImplicitTls } from "@ohmail/app-logic/mailboxes/connect/providers";
import { SaidWith } from "../../text/Said.js";
import { SentenceBlank } from "../../text/SentenceBlank.js";
import { Consents } from "./Consents.js";
import type { Drawn } from "./drawn.js";
import { Outcome } from "./Lines.js";
import { PasswordField } from "./PasswordField.js";
import { ProviderHelp } from "./ProviderNote.js";
import { ServerFields } from "./ServerFields.js";

const credentialSentences = { ordinary: "form.iAm", app: "form.iAmAppPassword" } as const;

export function StandaloneCredentials({ d }: { d: Drawn }): ReactNode {
  const { form, text } = d;
  const t = text("phoneDoor");
  const picker = text("providerPicker");
  const { preset } = form;
  const { address, displayName } = form.state.typed;
  const appPassword = preset?.appPassword === true;
  const sentence = credentialSentences[appPassword ? "app" : "ordinary"];
  return (
    <>
      <div className="mbx-standalone-sentences" data-page-form-sentence="">
        {preset && !preset.manual ? (
          <p className="mbx-manual-title">{t("form.providerChosen", { provider: preset.label })}</p>
        ) : null}
        <SaidWith
          level={1}
          compact={preset?.manual === true}
          parts={t.rich(sentence, {
            address: () => (
              <span onBlur={form.lookUp}>
                <SentenceBlank
                  label={t("form.addressLabel")}
                  placeholder={t("form.addressBlank")}
                  type="email"
                  inputMode="email"
                  value={address}
                  onChange={(value) => form.type("address", value)}
                  onEnter={form.lookUp}
                />
              </span>
            ),
            password: () => (
              <PasswordField
                label={t("form.passwordLabel")}
                blank={t(appPassword ? "form.appHiddenBlank" : "form.hiddenBlank")}
                handle={form.password}
                onChange={form.passwordChanged}
              />
            ),
          })}
        />
        <SaidWith
          dot="ink"
          compact={preset?.manual === true}
          parts={t.rich("form.seenAs", {
            name: () => (
              <SentenceBlank
                label={t("form.nameLabel")}
                placeholder={t("form.nameBlank")}
                value={displayName ?? ""}
                onChange={(value) => form.type("displayName", value)}
              />
            ),
          })}
        />
      </div>
      <Outcome d={d} />
      {form.looking ? (
        <SettingNote>{picker("lookingUp", { domain: address.trim().split("@").pop() ?? "" })}</SettingNote>
      ) : null}
      {preset?.manual === true ? (
        <StandaloneServerSettings d={d} />
      ) : preset ? (
        <div className="mbx-connect-part">
          <div className="mbx-standalone-hints">
            {preset.prereqUrl ? <Tag>{t("form.twoStep")}</Tag> : null}
            <details className="mbx-manual-ports">
              <summary className="mbx-manual-disclosure">
                {t(appPassword ? "form.whereToMake" : "form.passwordHelp")}{" "}
                <Icon name="down" size={16} className="mbx-manual-arrow" />
              </summary>
              <SettingNote>{picker(`need_${preset.id}`)}</SettingNote>
              <SettingNote>{picker(`note_${preset.id}`)}</SettingNote>
              <ProviderHelp preset={preset} picker={picker} />
            </details>
          </div>
        </div>
      ) : null}
      <Consents lines={form.lines} tick={form.tick} words={text("mailboxes")} />
    </>
  );
}

function StandaloneServerSettings({ d }: { d: Drawn }): ReactNode {
  const { form, text } = d;
  const t = text("phoneDoor");
  const { preset } = form;
  const { imapHost, imapPort } = form.state.typed;
  const [open, setOpen] = useState(false);
  const refusal = form.state.shown;
  useEffect(() => {
    if (refusal !== null && !refusal.calm) setOpen(true);
  }, [refusal]);
  if (preset?.manual !== true) return null;
  const port = imapPort.trim() ? Number(imapPort) : (splitHostPort(imapHost).port ?? preset.imap.port);
  return (
    <div className="mbx-connect-part">
      <button
        type="button"
        className="oh-control mbx-manual-disclosure"
        aria-expanded={open}
        aria-label={t("form.serverSettings")}
        onClick={() => setOpen(!open)}
      >
        {imapHost || t("form.hostPorts")} <Icon name="down" size={16} className="mbx-manual-arrow" />
      </button>
      {open ? (
        <FieldStack>
          <ServerFields
            form={form}
            labels={{ imap: t("form.imapHost"), smtp: t("form.smtpHost") }}
            ports={{
              imap: t("form.imapPort"),
              smtp: t("form.smtpPort"),
              keep: undefined,
              defaults: { imap: String(preset.imap.port), smtp: String(preset.smtp.port) },
            }}
          />
          <Switch
            label={t("form.tls")}
            description={t("form.tlsPorts")}
            labelled
            on={portMeansImplicitTls(port)}
            onChange={(on) => form.type("imapPort", on ? "993" : "143")}
          />
        </FieldStack>
      ) : null}
    </div>
  );
}
