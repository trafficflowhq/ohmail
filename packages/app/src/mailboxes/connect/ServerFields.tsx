import type { ReactNode } from "react";
import { Field, FieldPair } from "@ohmail/ui/base";
import type { ConnectForm } from "@ohmail/app-logic/mailboxes/connect/use-connect-form";

/**
 * The two server names, with separate port fields where the form offers them.
 * On an edit, blank fields keep the stored settings.
 */
export function ServerFields({
  form,
  labels,
  ports,
}: {
  form: ConnectForm;
  labels: { readonly imap: string; readonly smtp: string };
  /** Optional port fields and their placeholders. */
  ports: {
    readonly imap: string;
    readonly smtp: string;
    readonly keep: string | undefined;
    readonly defaults?: Readonly<{ imap: string; smtp: string }>;
  } | null;
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
          placeholder={ports.defaults?.imap ?? ports.keep}
          inputMode="numeric"
          onChange={(v) => form.type("imapPort", v)}
        />
      </FieldPair>
      <FieldPair>
        {smtp}
        <Field
          label={ports.smtp}
          value={typed.smtpPort}
          placeholder={ports.defaults?.smtp ?? ports.keep}
          inputMode="numeric"
          onChange={(v) => form.type("smtpPort", v)}
        />
      </FieldPair>
    </>
  );
}
