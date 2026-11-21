import { useRef, useState, type ReactNode, type Ref } from "react";
import { Button, EndDot, Field, FieldStack, Icon, Menu, MenuItem, StepDots } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { SaidWith } from "../../doors/stage/Said.js";
import { SentenceBlank } from "../../doors/stage/SentenceBlank.js";
import { Consents } from "./Consents.js";
import type { Drawn } from "./drawn.js";
import { PasswordField } from "./PasswordField.js";
import { helpFacts } from "@ohmail/app-logic/mailboxes/connect/use-connect-form";
import { ProviderNote } from "./ProviderNote.js";
import { ProviderTiles } from "./ProviderTiles.js";
import { ServerFields } from "./ServerFields.js";
import { SignInWay } from "./SignInWay.js";
import { EDIT_WORDS } from "./words.js";

function Address({ d }: { d: Drawn }) {
  const { form, words, say } = d;
  return (
    <Field
      label={say(words.address)}
      type="email"
      value={form.state.typed.address}
      onChange={(value) => form.type("address", value)}
      onLeave={form.lookUp}
      onEnter={form.lookUp}
    />
  );
}

function ManualProgress({ d, back }: { d: Drawn; back: () => void }) {
  const t = d.text("onboarding");
  const join = d.text("join");
  const { setup, later, help } = d.ask;
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div data-page-form-progress="">
      <StepDots label={join("manualProgress")} steps={4} at={0} sub="2/3" />
      <Button
        ref={anchor}
        kind="quiet"
        size="s"
        icon="more"
        label={t("setupMenu")}
        opens="menu"
        expanded={open}
        onPress={() => setOpen(!open)}
      />
      <Menu open={open} anchor={anchor} label={t("setupMenu")} onClose={close} right>
        <MenuItem
          onPress={() => {
            close();
            (setup?.restart ?? back)();
          }}
        >
          {setup ? t("restart") : join("manualBack")}
        </MenuItem>
        {setup || later ? (
          <MenuItem
            onPress={() => {
              close();
              (setup?.close ?? later)?.();
            }}
          >
            {t("cancel")}
          </MenuItem>
        ) : null}
        {help ? (
          <MenuItem
            onPress={() => {
              close();
              help(helpFacts(d.form));
            }}
          >
            {join("mailboxWriteUs")}
          </MenuItem>
        ) : null}
      </Menu>
    </div>
  );
}

export function ManualSignIn({
  d,
  back,
  heading,
}: {
  d: Drawn;
  back: () => void;
  heading: Ref<HTMLHeadingElement>;
}) {
  const { form, words, say, text } = d;
  const join = text("join");
  return (
    <>
      <ManualProgress d={d} back={back} />
      <div data-page-form-back="">
        <Button kind="two" icon="back" label={join("manualBack")} onPress={back} />
      </div>
      <h1 ref={heading} tabIndex={-1} className="oh-text mbx-manual-title">
        <EndDot kind="ink">{join("manualTitle")}</EndDot>
      </h1>
      <div data-page-form-sentence="">
        <SaidWith
          parts={join.rich("manualSignIn", {
            address: () => (
              <span onBlur={form.lookUp}>
                <SentenceBlank
                  label={say(words.address)}
                  placeholder={join("manualAddress")}
                  type="email"
                  inputMode="email"
                  value={form.state.typed.address}
                  onChange={(value) => form.type("address", value)}
                  onEnter={form.lookUp}
                />
              </span>
            ),
            password: () => (
              <PasswordField
                label={say(words.password)}
                handle={form.password}
                onChange={form.passwordChanged}
                blank={join("manualSignInBlank")}
              />
            ),
          })}
        />
      </div>
      <details className="mbx-manual-ports">
        <summary className="mbx-manual-disclosure">
          {join("manualPorts")} <Icon name="down" size={16} className="mbx-manual-arrow" />
        </summary>
        <FieldStack>
          <ServerFields
            form={form}
            labels={{ imap: say(words.imapHost), smtp: say(words.smtpHost) }}
            ports={{ imap: say(EDIT_WORDS.imapPort), smtp: say(EDIT_WORDS.smtpPort), keep: undefined }}
          />
          <Username d={d} />
        </FieldStack>
      </details>
      <Consents lines={form.lines} tick={form.tick} words={text("mailboxes")} />
    </>
  );
}

function Username({ d }: { d: Drawn }) {
  const { form, words, say } = d;
  const { typed } = form.state;
  return words.user ? (
    <Field
      label={say(words.user)}
      value={typed.user}
      placeholder={typed.address || (words.userPlaceholder ? say(words.userPlaceholder) : undefined)}
      onChange={(value) => form.type("user", value)}
    />
  ) : null;
}

/**
 * WHAT STANDS OVER THE FIELDS. A new connection: the address first, whose domain preselects a tile; the tiles; what
 * the chosen provider needs. An edit: which mailbox, and what to type. A stored setting is never shown.
 */
export function Head({
  d,
  hideProviders = false,
  onManual,
}: {
  d: Drawn;
  hideProviders?: boolean;
  onManual?: (() => void) | undefined;
}): ReactNode {
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
      <FieldStack>
        <Address d={d} />
      </FieldStack>
      {form.looking ? (
        <SettingNote>
          {picker("lookingUp", { domain: typed.address.trim().split("@").pop() ?? "" })}
        </SettingNote>
      ) : null}
      {hideProviders ? null : (
        <ProviderTiles form={form} picker={picker} bridgeHere={d.door.localServerWait} onManual={onManual} />
      )}
      {hideProviders && form.bridged ? (
        <SettingNote>
          {picker(d.door.localServerWait ? "protonNoteDesktop" : "protonNote", {
            other: picker("otherLabel"),
          })}
        </SettingNote>
      ) : null}
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
  return (
    <>
      {form.preset?.manual ? (
        <ServerFields
          form={form}
          labels={{ imap: say(words.imapHost), smtp: say(words.smtpHost) }}
          ports={null}
        />
      ) : null}
      <Username d={d} />
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
          value={form.state.typed.displayName ?? ""}
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
      <Consents lines={form.lines} tick={form.tick} words={mailboxes} />
    </FieldStack>
  );
}
