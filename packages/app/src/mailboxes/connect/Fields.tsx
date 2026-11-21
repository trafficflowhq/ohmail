import type { ReactNode } from "react";
import { Field, FieldStack } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { Consents } from "./Consents.js";
import type { Drawn } from "./drawn.js";
import { PasswordField } from "./PasswordField.js";
import { ProviderNote } from "./ProviderNote.js";
import { ProviderTiles } from "./ProviderTiles.js";
import { ServerFields } from "./ServerFields.js";
import { SignInWay } from "./SignInWay.js";
import { EDIT_WORDS } from "./words.js";

/**
 * WHAT STANDS OVER THE FIELDS. A new connection: the address first, whose domain preselects a tile; the tiles; what
 * the chosen provider needs. An edit: which mailbox, and what to type. A stored setting is never shown.
 */
export function Head({ d }: { d: Drawn }): ReactNode {
  const { form, subject, words, say, text } = d;
  const picker = text("providerPicker");
  if (subject !== null)
    return (
      <>
        <SettingNote>{say(words.address, { address: displayAddress(subject.address) })}</SettingNote>
        {form.way === null && words.lead ? (
          <SettingNote>{say(form.appPasswordSubject ? EDIT_WORDS.leadAppPassword : words.lead)}</SettingNote>
        ) : null}
      </>
    );
  const { typed } = form.state;
  const instead =
    form.way !== null
      ? text("mailboxes")("microsoftOauthNote")
      : form.codeElsewhere && words.codeElsewhere
        ? say(words.codeElsewhere)
        : null;
  return (
    <>
      {words.lead ? <SettingNote>{say(words.lead)}</SettingNote> : null}
      {words.note ? <SettingNote>{say(words.note)}</SettingNote> : null}
      {/* Leaving the field, or Enter in it, looks its domain up at once, as a pause in typing does. */}
      <div
        onBlur={form.lookUp}
        onKeyDown={(event) => {
          if (event.key === "Enter") form.lookUp();
        }}
      >
        <FieldStack>
          <Field
            label={say(words.address)}
            type="email"
            value={typed.address}
            onChange={(v) => form.type("address", v)}
          />
        </FieldStack>
      </div>
      {form.looking ? (
        <SettingNote>
          {picker("lookingUp", { domain: typed.address.trim().split("@").pop() ?? "" })}
        </SettingNote>
      ) : null}
      <ProviderTiles form={form} picker={picker} bridgeHere={d.door.localServerWait} />
      {form.preset ? (
        <ProviderNote preset={form.preset} picker={picker} instead={instead} help={form.way === null} />
      ) : null}
    </>
  );
}

/** An edit's fields: the password, then the corrections, each of which may stay blank. */
function EditFields({ d }: { d: Drawn }): ReactNode {
  const { form, words, say } = d;
  return (
    <>
      <PasswordField label={say(words.password)} handle={form.password} onChange={form.passwordChanged} />
      <ServerFields
        form={form}
        labels={{ imap: say(words.imapHost), smtp: say(words.smtpHost) }}
        ports={{ imap: say(EDIT_WORDS.imapPort), smtp: say(EDIT_WORDS.smtpPort), keep: say(EDIT_WORDS.keep) }}
      />
      {words.user ? (
        <Field
          label={say(words.user)}
          value={form.state.typed.user}
          placeholder={say(EDIT_WORDS.keep)}
          onChange={(v) => form.type("user", v)}
        />
      ) : null}
    </>
  );
}

/**
 * A new connection's fields: the two servers on the manual entry, the username if it is not the address, the
 * password; and, where the mount asks for one, the name the mailbox's letters carry.
 */
function NewFields({ d }: { d: Drawn }): ReactNode {
  const { form, words, say } = d;
  const { typed } = form.state;
  return (
    <>
      {form.preset?.manual ? (
        <ServerFields
          form={form}
          labels={{ imap: say(words.imapHost), smtp: say(words.smtpHost) }}
          ports={null}
        />
      ) : null}
      {words.user ? (
        <Field
          label={say(words.user)}
          value={typed.user}
          placeholder={typed.address || (words.userPlaceholder ? say(words.userPlaceholder) : undefined)}
          onChange={(v) => form.type("user", v)}
        />
      ) : null}
      <PasswordField
        label={say(words.password)}
        hint={words.passwordHint ? say(words.passwordHint) : undefined}
        handle={form.password}
        onChange={form.passwordChanged}
      />
      {words.name ? (
        <Field
          label={say(words.name.label)}
          hint={say(words.name.hint)}
          value={typed.displayName ?? ""}
          onChange={(v) => form.type("displayName", v)}
        />
      ) : null}
    </>
  );
}

/**
 * HOW THIS MAILBOX SIGNS IN: at its provider, where the shell runs that and the password way was not taken; else by
 * the credential fields, with the consents the server offered under them. Until a tile is chosen there is neither.
 */
export function Credentials({ d }: { d: Drawn }): ReactNode {
  const { form, subject, words, say, text } = d;
  const mailboxes = text("mailboxes");
  if (form.way !== null)
    return (
      <SignInWay
        form={form}
        words={mailboxes}
        press={mailboxes(subject !== null ? "oauthReconnect" : "oauthContinue")}
        working={say(words.signInWorking)}
        secondWay={subject === null}
      />
    );
  if (subject === null && form.preset === null) return null;
  return (
    <FieldStack>
      {subject !== null ? <EditFields d={d} /> : <NewFields d={d} />}
      <Consents form={form} words={mailboxes} />
    </FieldStack>
  );
}
