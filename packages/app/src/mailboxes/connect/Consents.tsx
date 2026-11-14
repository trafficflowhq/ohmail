import type { ReactNode } from "react";
import { Switch } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import type { ConsentLine } from "@ohmail/app-logic/mailboxes/connect/consents";
import type { ConnectForm } from "@ohmail/app-logic/mailboxes/connect/use-connect-form";
import type { Text } from "../../text/index.js";

const PLAIN = {
  imap: "insecureConsentLabel",
  smtp: "insecureConsentLabelSmtp",
  both: "insecureConsentLabelBoth",
} as const;
const TRUST = {
  imap: "trustCertificateLabel",
  smtp: "trustCertificateLabelSmtp",
  both: "trustCertificateLabelBoth",
} as const;

/**
 * THE TWO CONSENTS, one markup for every mount, so the words a person consents over cannot differ between them. A
 * line stands only because the server refused this form's own press for that server, and it stands unticked: a
 * consent is a press. A certificate's line names the fingerprint to compare, whole, as words. Each is a line of the
 * form's stack of fields, under the fields of the server it is about.
 */
export function Consents({ form, words }: { form: ConnectForm; words: Text }): ReactNode {
  const { lines } = form;
  if (lines.length === 0) return null;
  const label = (line: ConsentLine): string =>
    line.kind === "plain" ? words(PLAIN[line.legs]) : words(TRUST[line.legs], { fingerprint: line.sha256 });
  return (
    <>
      {lines.map((line) => (
        <Switch
          key={`${line.kind}-${line.legs}`}
          label={label(line)}
          labelled
          on={line.on}
          onChange={(on) => form.tick(line, on)}
        />
      ))}
      {lines.some((line) => line.kind === "plain") ? (
        <SettingNote warn>{words("insecureConsentWarning")}</SettingNote>
      ) : null}
      {lines.some((line) => line.kind === "certificate") ? (
        <SettingNote>{words("trustCertificateNote")}</SettingNote>
      ) : null}
    </>
  );
}
