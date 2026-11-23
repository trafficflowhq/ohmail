import type { ReactNode } from "react";
import { Button, RefusalLine } from "@ohmail/ui/base";
import { SettingActs, SettingNote } from "@ohmail/ui/mail";
import { authHintPreset, authHintWantsLinks } from "@ohmail/app-logic/mailboxes/connect/providers";
import { helpFacts } from "@ohmail/app-logic/mailboxes/connect/use-connect-form";
import { useRefusalAtThePress } from "@ohmail/app-logic/press/refusal-at-the-press";
import { NONE } from "../../host/contract.js";
import type { Drawn } from "./drawn.js";
import { ProviderHelp } from "./ProviderNote.js";
import { sentenceOf } from "./sentence.js";
import { Tested } from "./Tested.js";
import { EDIT_WORDS } from "./words.js";

/**
 * WHAT THE LAST PRESS CAME BACK WITH: what a test proved; the refusal, standing at the press with everything typed
 * above it; a settled outcome that is no fault, said calmly; and the two offers a refusal can carry, each one press
 * that fills fields and sends nothing. The caller's own sentence (whose browser this is) stands before the form's.
 */
export function Outcome({ d }: { d: Drawn }): ReactNode {
  const { form, ask, words, say, text } = d;
  const { state } = form;
  const guarded = ask.guard?.said ?? null;
  const shown = guarded ?? (state.shown === null ? null : sentenceOf(state.shown.said, text));
  const calm = guarded === null && state.shown?.calm === true;
  /* The refusal is brought into view and takes the keys. */
  const saidAt = useRefusalAtThePress<HTMLParagraphElement>(shown !== null && !calm ? shown : null);
  const picker = text("providerPicker");
  const suggestion = guarded === null ? state.suggestion : null;
  const servers = form.found
    ? [form.found.imap ? `IMAP ${form.found.imap}` : null, form.found.smtp ? `SMTP ${form.found.smtp}` : null]
        .filter(Boolean)
        .join(", ")
    : null;
  return (
    <>
      {state.tested !== null ? <Tested ok={state.tested} onboarding={text("onboarding")} /> : null}
      {form.longWait && words.test ? <SettingNote>{say(words.test.waitingLong)}</SettingNote> : null}
      {shown === null ? null : calm ? (
        /* A settled outcome that is no fault is a status; a refusal is an alert, as the shipped forms said both. */
        <div role="status">
          <SettingNote>{shown}</SettingNote>
        </div>
      ) : (
        <>
          {suggestion !== null ? (
            <RefusalLine
              alert
              ref={saidAt}
              way={{
                label: text("mailboxes")("useSuggestedHost", { host: suggestion.host }),
                onPress: form.takeSuggestion,
              }}
            >
              {shown}
            </RefusalLine>
          ) : (
            <RefusalLine alert ref={saidAt}>
              {shown}
            </RefusalLine>
          )}
          {state.authHint !== null && authHintWantsLinks(state.authHint) ? (
            <ProviderHelp preset={authHintPreset()} picker={picker} />
          ) : null}
          {/* The provider refused the password where its own sign-in runs: the way that works, one press. */}
          {form.signInInstead && words.signInInstead ? (
            <SettingActs>
              <Button kind="two" disabled={form.busy !== null || state.leaving} onPress={form.signIn}>
                {say(words.signInInstead)}
              </Button>
            </SettingActs>
          ) : null}
        </>
      )}
      {servers !== null ? (
        <>
          <SettingNote>{picker("discoveredHosts", { servers })}</SettingNote>
          <SettingActs>
            <Button kind="two" size="s" onPress={form.takeFound}>
              {picker("discoveredUse")}
            </Button>
          </SettingActs>
        </>
      ) : null}
    </>
  );
}

/** The presses of the credential fields: the one that sends, the test where this mount has one, an edit's way back. */
export function Acts({ d, manual }: { d: Drawn; manual?: boolean }): ReactNode {
  const { form, ask, subject, words, say } = d;
  if (form.way !== null || (subject === null && form.preset === null)) return null;
  const { busy } = form;
  const submit =
    busy === "connect" || busy === "edit"
      ? say(words.working)
      : manual
        ? d.text("join")("manualConnect")
        : say(words.submit);
  const off = !form.ready || busy !== null || form.asking !== null;
  const actions = (
    <SettingActs>
      <Button
        type="submit"
        size="l"
        disabled={off}
        label={manual ? submit : undefined}
        keyHint={manual ? "↵" : undefined}
      >
        {submit}
      </Button>
      {words.test && d.door.probe !== NONE ? (
        <Button kind="two" disabled={off} onPress={form.test}>
          {busy === "test" && !form.state.moved
            ? say(words.test.waiting, { host: form.hosts.imap })
            : say(form.state.tested !== null ? words.test.again : words.test.press)}
        </Button>
      ) : null}
      {subject !== null ? (
        <Button kind="quiet" onPress={() => ask.onDone({ kind: "left" })}>
          {say(EDIT_WORDS.cancel)}
        </Button>
      ) : null}
    </SettingActs>
  );
  return manual ? <div data-page-form-submit="">{actions}</div> : actions;
}

/** The ways out a mount hands in: later, and a mail to support that carries the tile's id and a closed word alone. */
export function WaysOut({ d, showLater = true }: { d: Drawn; showLater?: boolean }): ReactNode {
  const { ask, form, text } = d;
  const later = showLater ? ask.later : undefined;
  if (!later && !ask.help) return null;
  const join = text("join");
  return (
    <SettingActs>
      {later ? (
        <Button kind="quiet" onPress={later}>
          {join("later")}
        </Button>
      ) : null}
      {ask.help ? (
        <Button kind="quiet" onPress={() => ask.help?.(helpFacts(form))}>
          {join("mailboxWriteUs")}
        </Button>
      ) : null}
    </SettingActs>
  );
}
