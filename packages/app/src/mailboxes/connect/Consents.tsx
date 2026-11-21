import { Fragment, type ReactNode } from "react";
import { CheckLine, Switch } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import type { ConsentLine } from "@ohmail/app-logic/mailboxes/connect/consents";

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

type Word =
  | (typeof PLAIN)[keyof typeof PLAIN]
  | (typeof TRUST)[keyof typeof TRUST]
  | "insecureConsentWarning"
  | "trustCertificateNote";

interface ConsentsProps {
  lines: readonly ConsentLine[];
  tick(line: ConsentLine, on: boolean): void;
  words(key: Word, values?: { fingerprint: string }): string;
  /** The existing inline sign-in form uses native checkboxes. The connect sheet uses switches. */
  checkboxId?: (line: ConsentLine) => string;
}

/** The inline choices drawn under the connection fields that received the offer. */
export function Consents({ lines, tick, words, checkboxId }: ConsentsProps): ReactNode {
  if (lines.length === 0) return null;
  const label = (line: ConsentLine): string =>
    line.kind === "plain" ? words(PLAIN[line.legs]) : words(TRUST[line.legs]);
  const plain = lines.filter((line) => line.kind === "plain");
  const cert = lines.filter((line) => line.kind === "certificate");
  const renderLine = (line: ConsentLine) => {
    const key = `${line.kind}-${line.legs}`;
    const printId = `${checkboxId?.(line) ?? key}-print`;
    const control = checkboxId ? (
      <CheckLine
        key={key}
        id={checkboxId(line)}
        describedBy={printId}
        checked={line.on}
        onChange={(on) => tick(line, on)}
      >
        {label(line)}
      </CheckLine>
    ) : (
      <Switch
        key={key}
        label={label(line)}
        describedBy={printId}
        labelled
        on={line.on}
        onChange={(on) => tick(line, on)}
      />
    );
    if (line.kind !== "certificate") return control;
    /* The fingerprint the tick claims, on its own line under the line that asks for it:
      plain text, readable whole by a reader, never an image. Tied to the control, so the
      consent says out loud which certificate it trusts. */
    return (
      <Fragment key={key}>
        {control}
        <p id={printId} className="mbx-cert-fingerprint">
          {line.sha256}
        </p>
      </Fragment>
    );
  };
  return (
    <>
      {plain.map(renderLine)}
      {plain.length > 0 ? (
        <SettingNote warn silent={checkboxId !== undefined}>
          {words("insecureConsentWarning")}
        </SettingNote>
      ) : null}
      {cert.map(renderLine)}
      {cert.length > 0 ? <SettingNote sign="info">{words("trustCertificateNote")}</SettingNote> : null}
    </>
  );
}
