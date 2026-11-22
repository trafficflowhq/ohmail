/**
 * THE ACCOUNT, DELETED IN FULL. The page says what is erased and when, what is kept and why (on this server), and that
 * the mail stays on the person's own mail server; the address is typed back, every press asks the second factor with
 * the one dialog, whose line names the act and the address, and the erase runs only once the factor verifies. Then
 * the outcome: erased, with what became of the subscription and of the copy in this browser. Its words are outside
 * the document's first cut, so until they have arrived it waits wordless.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Blank, Button, Page, type BlankProps } from "@ohmail/ui/base";
import { NONE, type None } from "../../host/contract.js";
import { useText, type Text } from "../../text/index.js";
import { Break, DoorLine, Fact, Heavy, Note } from "../stage/DoorLine.js";
import { Facts } from "../stage/DoorSheet.js";
import { Said, SaidWith } from "../stage/Said.js";
import { StepUpDialog } from "../step-up/StepUpDialog.js";
import type { DeleteAccountDoor, DeleteAccountState } from "./door.js";
import "./placement.css";

/** The type scale's steps under the sentence's own, largest first (placement.css sets each from its token). */
const STEPS = ["head", "title", "read", "ui"] as const;
type Step = (typeof STEPS)[number];

/** The room the closing dot takes after the address, in the sentence's own size. */
const DOT_ROOM = 0.6;

/**
 * THE ADDRESS TO TYPE BACK, READ WHOLE. The blank's hint is the session's own address, and a person types what they
 * read. Where its line cannot hold it after the sentence's words, it goes to a line of its own, as the reference's
 * does; where that line cannot hold it either (a long address, a narrow window), the blank takes the scale's next
 * step down until it fits, as the reference sets the sentence a step smaller on a phone. A ruler laid out for nobody
 * reads the address at each step against the line, again whenever the line's room changes. An address that fits
 * keeps the sentence's own size.
 */
function AddressBlank(p: BlankProps & { address: string }): ReactNode {
  const ruler = useRef<HTMLSpanElement | null>(null);
  const [step, setStep] = useState<Step | undefined>(undefined);
  useLayoutEffect(() => {
    const read = ruler.current;
    const line = read?.closest("p");
    if (!read || !line) return;
    const width = (at?: Step): number => {
      if (at) read.dataset.step = at;
      else delete read.dataset.step;
      return read.getBoundingClientRect().width;
    };
    const measure = (): void => {
      const room = line.clientWidth - DOT_ROOM * (Number.parseFloat(getComputedStyle(line).fontSize) || 0);
      /* Nothing laid out (a document without layout) says nothing about the room. */
      if (width() <= 0 || room <= 0) return;
      const fits = (at?: Step): boolean => width(at) <= room;
      setStep(fits() ? undefined : (STEPS.find(fits) ?? STEPS[STEPS.length - 1]));
    };
    measure();
    /* The line's room changes with the window; a document without layout has no observer of sizes. */
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(line);
    return () => watch.disconnect();
  }, [p.address]);
  const { address, ...blank } = p;
  return (
    <>
      <span className="way-ruler-room" aria-hidden="true">
        <span ref={ruler} className="way-fit way-ruler">
          {address}
        </span>
      </span>
      <span className="way-fit" data-step={step}>
        <Blank {...blank} />
      </span>
    </>
  );
}

/** One or two sentences under the page's sentence, as the kit's page takes them. */
const refusalOf = (said: (string | null)[]): readonly [string] | readonly [string, string] | undefined => {
  const [first, second] = said.filter((s): s is string => s !== null);
  if (first === undefined) return undefined;
  return second === undefined ? [first] : [first, second];
};

function FormPage({
  door,
  state,
  t,
}: {
  door: DeleteAccountDoor;
  state: Extract<DeleteAccountState, { at: "form" }>;
  t: Text;
}): ReactNode {
  const self = door.service === "self";
  /* The address typed back, trimmed and in any case: the press is off until it is the session's own. */
  const ready = state.typed.trim().toLowerCase() === state.email.toLowerCase();
  const begin = (): void => {
    if (ready && !state.busy) door.begin();
  };
  const kept = self
    ? [t("keptSelfHost")]
    : [t("kept1"), t("kept2"), t("kept3"), ...(state.subscription ? [t("keptSub")] : [])];
  return (
    <>
      <Page
        back={<Button kind="quiet" icon="back" label={t("back")} onPress={door.back} />}
        columns={2}
        /* Two sheets beside the sentence: the page starts higher so both stand whole; on the upright fold they stand
           under the buttons and the sentence takes the width; on a phone the sentence is a step smaller, so the
           address to type back is read whole. */
        high
        stack
        smaller
        lineFirst
        refusal={refusalOf([state.refusal, state.cancelled ? t("cancelledNothingErased") : null])}
        material={
          <>
            {/* Both lists stand before the address is typed, never behind a press. */}
            <Facts
              tight
              title={t("goneTitle")}
              items={[t("gone1"), t("gone2"), t("gone3"), t("gone4")]}
              fine={t("goneWhen")}
            />
            <Facts
              tight
              title={t("keptTitle")}
              items={kept}
              fine={
                <>
                  {t("backups")}
                  {/* The hosted service's policy; a self-hosted server's backups are its own to describe. */}
                  {self ? null : (
                    <>
                      {" "}
                      <Button kind="quiet" size="s" onPress={door.privacy}>
                        {t("backupsLink")}
                      </Button>
                    </>
                  )}
                </>
              }
            />
          </>
        }
        line={t("lead")}
        note={t("mail")}
        acts={
          <Button size="l" onPress={door.begin} disabled={!ready || state.busy}>
            {state.busy ? t("erasing") : t("begin")}
          </Button>
        }
      >
        {/* The session's own address, typed back into the sentence; nothing fills it but the person. */}
        <SaidWith
          parts={t.rich("of", {
            blank: () => (
              <AddressBlank
                address={state.email}
                label={t("typeLabel", { email: state.email })}
                placeholder={state.email}
                size={state.email.length}
                value={state.typed}
                onChange={door.type}
                onEnter={begin}
              />
            ),
          })}
        />
      </Page>
      {state.factor ? (
        <StepUpDialog door={door.stepUp} {...door.factor} line={t("factorBody", { email: state.email })} />
      ) : null}
    </>
  );
}

/** The outcome: erased, with what became of the subscription and of the copy in this browser. */
function DonePage({
  door,
  state,
  t,
}: {
  door: DeleteAccountDoor;
  state: Extract<DeleteAccountState, { at: "done" }>;
  t: Text;
}): ReactNode {
  const cancelled = state.subscription === "cancelled";
  return (
    <Page
      refusal={refusalOf([
        state.subscription === "cancel_failed" ? t("doneSubFailed") : null,
        state.unclean ? t("erasedMirrorBlocked") : null,
      ])}
      material={
        cancelled ? (
          <DoorLine>
            <Fact>{t("doneSubCancelled")}</Fact>
            <Break />
            <Heavy>{t("doneBody")}</Heavy>
            <Note>{t("doneNote")}</Note>
          </DoorLine>
        ) : undefined
      }
      line={cancelled ? undefined : t("doneBody")}
      note={cancelled ? undefined : t("doneNote")}
      afterLine={state.retained ? <Note>{state.retained}</Note> : undefined}
      acts={
        <Button size="l" onPress={door.home}>
          {t(door.service === "self" ? "doneHomeSelfHost" : "doneHome")}
        </Button>
      }
    >
      <Said text={t("doneTitle")} dot="ink" />
    </Page>
  );
}

export function DeleteAccountPage({ door }: { door: DeleteAccountDoor | None }): ReactNode {
  const t = useText("deleteAccount");
  const approve = useText("approve");
  /* Its sentences are not in the first cut: wordless until they have arrived. */
  if (!t.has("title")) return <div className="way-live" aria-busy="true" />;
  const title = <Said text={t("title")} />;
  if (door === NONE)
    return (
      <Page line={t("unavailableBody")} acts={null}>
        {title}
      </Page>
    );
  const { state } = door;
  switch (state.at) {
    case "checking":
      return (
        <div className="way-live" aria-busy="true" aria-live="polite">
          <Page line={t("loading")} acts={null}>
            {title}
          </Page>
        </div>
      );
    case "signedout":
      return (
        <Page
          line={t("signedOutBody")}
          acts={
            <Button size="l" onPress={door.signIn}>
              {t("signIn")}
            </Button>
          }
        >
          <Said text={t("begin")} />
        </Page>
      );
    case "unchecked":
      return (
        <Page refusal={[approve("signInUnchecked")]} acts={null}>
          {title}
        </Page>
      );
    case "refused":
      return (
        <Page refusal={[state.said]} acts={null}>
          {title}
        </Page>
      );
    case "form":
      return <FormPage door={door} state={state} t={t} />;
    case "done":
      return <DonePage door={door} state={state} t={t} />;
  }
}
