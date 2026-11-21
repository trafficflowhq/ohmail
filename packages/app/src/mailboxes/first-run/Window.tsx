import { useRef, useState, type ReactNode } from "react";
import { Counters, Menu, MenuItem, Page, Slot, Tag } from "@ohmail/ui/base";
import { decisionCountSentence } from "@ohmail/app-logic/mailboxes/first-run/rules";
import { SaidWith } from "../../doors/stage/Said.js";
import { useLocale, useText } from "../../text/index.js";
import { FolderMap, HolderWait } from "./Consent.js";
import { Next, StepForm, refusalOf, stepTop, type StepProps } from "./parts.js";
import { RUNGS } from "./words.js";

export function Window({ run, say }: StepProps): ReactNode {
  const { agree, wait, writes } = run;
  const onboarding = useText("onboarding");
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale);
  const count = agree.count;
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const title = say("onboarding.windowTitle");
  const word =
    agree.win === "365"
      ? "onboarding.windowYear"
      : agree.win === "all"
        ? "onboarding.windowEverything"
        : agree.win === "90"
          ? "onboarding.win90"
          : "onboarding.win180";
  const name = say(word);
  const exact = count !== null && count.complete && count.mirrored && count.total === count.letters;
  const blocked = wait.awaiting || writes.busy;
  return (
    <StepForm run={run} submit={run.acts.agree}>
      <Page
        {...stepTop(run, say, { back: true })}
        columns={2}
        line={run.facts.mailbox?.organizeConsentedAt ? undefined : [{ note: say("onboarding.nothingMoves") }]}
        refusal={refusalOf(run, say)}
        material={<FolderMap say={say} history={agree.win !== "all"} />}
        acts={
          <Next label={say(writes.busy ? "onboarding.agreeing" : "onboarding.agree")} disabled={blocked} />
        }
      >
        <SaidWith
          level={1}
          parts={onboarding.rich(agree.win === "all" ? "organizeAll" : "organizeLast", {
            window: () => (
              <Slot
                kind="fill"
                ref={anchor}
                expanded={open}
                disabled={blocked}
                onPress={() => setOpen(!open)}
              >
                {name}
              </Slot>
            ),
          })}
        />
        <Menu anchor={anchor} open={open} label={title} onClose={() => setOpen(false)}>
          {RUNGS.map(({ value, label }) => (
            <MenuItem
              key={value}
              checked={value === agree.win}
              note={value === "365" ? say("onboarding.winDefault") : undefined}
              onPress={() => {
                if (!blocked) agree.setWin(value);
                setOpen(false);
              }}
            >
              {say(label)}
            </MenuItem>
          ))}
        </Menu>
        <div role="status" aria-atomic="true">
          {exact ? (
            <Counters
              rows={[
                {
                  figure: number.format(count.letters),
                  words: say(count.letters === 1 ? "onboarding.countMessage" : "onboarding.countMessages"),
                },
                {
                  figure: number.format(count.senders),
                  words: say(count.senders === 1 ? "onboarding.countSender" : "onboarding.countSenders"),
                },
              ]}
            />
          ) : count === null ? null : (
            <p className="mbx-run-status">
              {decisionCountSentence((key, values) => say(`onboarding.${key}`, values), count)}
            </p>
          )}
        </div>
        {run.pull.reconnecting ? <Tag>{say("onboarding.pullReconnecting")}</Tag> : null}
        {wait.awaiting ? <HolderWait run={run} say={say} /> : null}
      </Page>
    </StepForm>
  );
}
