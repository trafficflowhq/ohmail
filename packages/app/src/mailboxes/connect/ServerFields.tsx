import type { ReactNode } from "react";
import { Field, FieldPair } from "@ohmail/ui/base";
import type { ConnectForm } from "@ohmail/app-logic/mailboxes/connect/use-connect-form";

/**
 * THE TWO SERVERS. On a new connection each is one field: a name, with a port after it where it is not the usual
 * one. On an edit each has its port beside it, and every field may stay blank: a blank keeps what is stored, which
 * is never shown.
 */
export function ServerFields({
  form,
  labels,
  ports,
}: {
  form: ConnectForm;
  labels: { readonly imap: string; readonly smtp: string };
  /** An edit's port fields, with what a blank keeps. `null`: a new connection. */
  ports: { readonly imap: string; readonly smtp: string; readonly keep: string | undefined } | null;
}): ReactNode {
  const { typed } = form.state;
  const imap = (
    <Field
      label={labels.imap}
      value={typed.imapHost}
      placeholder={ports?.keep}
      onChange={(v) => form.type("imapHost", v)}
    />
  );
  const smtp = (
    <Field
      label={labels.smtp}
      value={typed.smtpHost}
      placeholder={ports?.keep}
      onChange={(v) => form.type("smtpHost", v)}
    />
  );
  if (ports === null)
    return (
      <>
        {imap}
        {smtp}
      </>
    );
  return (
    <>
      <FieldPair>
        {imap}
        <Field
          label={ports.imap}
          value={typed.imapPort}
          placeholder={ports.keep}
          inputMode="numeric"
          onChange={(v) => form.type("imapPort", v)}
        />
      </FieldPair>
      <FieldPair>
        {smtp}
        <Field
          label={ports.smtp}
          value={typed.smtpPort}
          placeholder={ports.keep}
          inputMode="numeric"
          onChange={(v) => form.type("smtpPort", v)}
        />
      </FieldPair>
    </>
  );
}
