import { useMemo, type ReactNode } from "react";
import { Dialog } from "@ohmail/ui/base";
import { useConnectForm } from "@ohmail/app-logic/mailboxes/connect/use-connect-form";
import { NONE } from "../../host/contract.js";
import { useDraftLeave } from "../../host/use-draft-leave.js";
import { useTextLookup } from "../../text/index.js";
import type { ConnectFormProps, ConnectSubject } from "./contract.js";
import type { Drawn } from "./drawn.js";
import { DeviceSignIn } from "./DeviceSignIn.js";
import { Credentials, Head } from "./Fields.js";
import { Acts, Outcome, WaysOut } from "./Lines.js";
import { FORM_WORDS } from "./words.js";
import "./placement.css";

/**
 * THE ONE CONNECT FORM. It stands where five forms stood: the join's mailbox step, the first run's, a further
 * mailbox, an edit of a connected one and its reconnect. What it sends and what it says are what those forms sent
 * and said; it draws them from the kit's parts alone.
 *
 * It is keyed by what it is opened for and by its mailbox: a changed mailbox is another form, and everything typed,
 * ticked and parked goes with the old one.
 */
export function ConnectForm(props: ConnectFormProps): ReactNode {
  const { purpose } = props.ask;
  const subject = purpose.kind === "edit" || purpose.kind === "reconnect" ? purpose.mailbox : null;
  return <Opened key={`${purpose.kind}:${subject?.id ?? ""}`} {...props} subject={subject} />;
}

function Opened({
  ask,
  door,
  factor,
  subject,
}: ConnectFormProps & { subject: ConnectSubject | null }): ReactNode {
  const text = useTextLookup();
  const kind = ask.purpose.kind;
  const words = FORM_WORDS[kind];
  const form = useConnectForm({
    purpose: kind,
    subject,
    door,
    factor: factor !== NONE,
    kept: ask.kept,
    guard: ask.guard,
    onDone: ask.onDone,
    ...(ask.onCodeStarted ? { onCodeStarted: ask.onCodeStarted } : {}),
  });
  const { typed } = form.state;
  const { imapHost, imapPort, smtpHost, smtpPort, user } = typed;
  const { filled, revision: passwordRevision } = form.passwordInput;
  const dirty = filled || [imapHost, imapPort, smtpHost, smtpPort, user].some((value) => value !== "");
  const revision = useMemo(() => [typed, passwordRevision], [typed, passwordRevision]);
  const holdLeave = ask.holdLeave;
  const leave = useDraftLeave(
    kind === "edit" && holdLeave !== undefined && dirty,
    (question) => holdLeave!(question),
    revision,
  );
  const leaveWords = text("away");
  const d: Drawn = {
    form,
    ask,
    door,
    subject,
    words,
    text,
    say: (word, values) => text(word.ns)(word.key, values),
  };

  /* An edit a shell cannot store, and a mailbox that signs in at its provider where no sign-in runs: nothing to draw. */
  if (subject !== null && form.way === null && (door.edit === NONE || subject.signsIn === "provider"))
    return null;

  if (form.code?.kind === "shown" || form.code?.kind === "checking") {
    return <DeviceSignIn result={form.code} stop={form.stopCode} />;
  }
  const asking = form.asking;
  return (
    <div className="mbx-connect-part">
      {leave.leaving ? (
        <Dialog
          open
          alert
          hot
          keysOn="cancel"
          title={leaveWords("leaveAsk")}
          onClose={leave.keep}
          confirm={{
            label: leaveWords("leaveDiscard"),
            onPress: () =>
              leave.discard(() => {
                form.password.current?.clear();
                ask.onDone({ kind: "left" });
              }),
          }}
          cancel={{ label: leaveWords("leaveKeep") }}
        />
      ) : null}
      {/* No address to post to and no named field: a press before the page's script sends nothing typed. */}
      <form
        className="mbx-connect-form"
        onSubmit={(event) => {
          event.preventDefault();
          form.submit();
        }}
      >
        <Head d={d} />
        <Credentials d={d} />
        <Outcome d={d} />
        {form.code?.kind === "ended" ? <DeviceSignIn result={form.code} stop={form.stopCode} /> : null}
        <Acts d={d} />
      </form>
      {/* The second factor, asked beside the form it unblocks and outside it: the dialog is a form of its own. */}
      {asking !== null && factor !== NONE
        ? factor({
            line: d.say(asking.verb === "test" && words.test ? words.test.factorLine : words.factorLine),
            onVerified: asking.onVerified,
            onCancel: asking.onCancel,
            onDiscarded: asking.onDiscarded,
          })
        : null}
      <WaysOut d={d} />
    </div>
  );
}
