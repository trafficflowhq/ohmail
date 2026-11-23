import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@ohmail/ui/base";
import {
  useConnectForm,
  type ConnectForm as ConnectModel,
} from "@ohmail/app-logic/mailboxes/connect/use-connect-form";
import { NONE } from "../../host/contract.js";
import { useDraftLeave } from "../../host/use-draft-leave.js";
import { useTextLookup } from "../../text/index.js";
import type { ConnectFormProps, ConnectSubject } from "./contract.js";
import type { Drawn } from "./drawn.js";
import { DeviceSignIn } from "./DeviceSignIn.js";
import { Credentials, Head, ManualSignIn } from "./Fields.js";
import { Acts, Outcome, WaysOut } from "./Lines.js";
import { ProviderChoice } from "./ProviderChoice.js";
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
  page,
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
  const step = useConnectStep(form, kind, page !== undefined);
  const { manual, hasManualStep, title, formNode } = step;
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

  if (page && step.choosing)
    return <ProviderChoice drawn={d} page={page} onPick={step.pick} returning={step.returning} />;
  if (form.code?.kind === "shown" || form.code?.kind === "checking") {
    const code = <DeviceSignIn result={form.code} stop={form.stopCode} />;
    return page ? page(code, form.stopCode) : code;
  }
  const asking = form.asking;
  const material = (
    <div className="mbx-connect-part" data-page-filling-form={manual ? "" : undefined}>
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
        ref={formNode}
        onSubmit={(event) => {
          event.preventDefault();
          if (!hasManualStep || !form.preset?.manual || manual) form.submit();
        }}
      >
        {manual ? (
          <ManualSignIn d={d} back={step.back} heading={title} />
        ) : (
          <>
            <Head
              d={d}
              hideProviders={page !== undefined}
              onManual={hasManualStep ? step.openManual : undefined}
            />
            {hasManualStep && form.preset?.manual ? null : <Credentials d={d} />}
          </>
        )}
        <Outcome d={d} />
        {form.code?.kind === "ended" ? <DeviceSignIn result={form.code} stop={form.stopCode} /> : null}
        {hasManualStep && form.preset?.manual && !manual ? null : <Acts d={d} manual={manual} />}
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
      {manual ? null : <WaysOut d={d} />}
    </div>
  );
  return page ? page(material, step.back) : material;
}

function useConnectStep(
  form: ConnectModel,
  kind: ConnectFormProps["ask"]["purpose"]["kind"],
  paged: boolean,
) {
  const [showCredentials, setShowCredentials] = useState(form.signInReturnedWithoutConnection);
  const [manualOpen, setManualOpen] = useState(() => form.state.typed.byHand);
  const hasManualStep = kind === "join" || kind === "firstRun";
  const manual = manualOpen && form.preset?.manual === true;
  const choosing = !showCredentials || (manualOpen && !manual);
  const title = useRef<HTMLHeadingElement>(null);
  const returning = useRef(false);
  const formNode = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    if (paged && choosing) return;
    if (manual) title.current?.focus();
    else if (returning.current) {
      returning.current = false;
      formNode.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
    } else if (paged) formNode.current?.querySelector("input")?.focus();
  }, [choosing, manual, paged]);
  const back = () => {
    if (paged && (form.busy || form.state.leaving || form.asking)) return;
    form.password.current?.clear();
    form.passwordChanged(false);
    returning.current = true;
    setManualOpen(false);
    setShowCredentials(false);
  };
  return {
    manual,
    hasManualStep,
    title,
    formNode,
    back,
    choosing,
    returning,
    openManual: () => setManualOpen(true),
    pick: (isManual: boolean) => {
      setManualOpen(hasManualStep && isManual);
      setShowCredentials(true);
    },
  };
}
