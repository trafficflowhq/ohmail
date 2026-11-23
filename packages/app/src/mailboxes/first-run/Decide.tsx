import { useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Avatar, Button, Menu, MenuItem, Page, Seg, Slot, Tag } from "@ohmail/ui/base";
import { SaidWith } from "../../text/Said.js";
import { useText } from "../../text/index.js";
import { StepForm, stepTop, type StepProps } from "./parts.js";
import { PLACES } from "./words.js";

export function Decide({ run, say }: StepProps): ReactNode {
  const sender = run.about.sender;
  const onboarding = useText("onboarding");
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<(typeof PLACES)[number]>(PLACES[0]);
  const other = place.to === "screened" ? PLACES[0] : PLACES[3];
  if (sender === null) {
    return (
      <StepForm run={run} submit={run.acts.away}>
        <Page
          {...stepTop(run, say)}
          acts={
            <Button kind="two" type="submit">
              {say("onboarding.pullLeave")}
            </Button>
          }
        >
          <p className="mbx-run-status" role="status">
            {say("onboarding.decideLoading")}
          </p>
        </Page>
      </StepForm>
    );
  }

  const { decide } = run;
  const here = decide.hereCount;
  const waiting = !sender.many
    ? Math.max(1, sender.waiting)
    : here === null
      ? null
      : Math.max(1, Math.min(here, sender.waiting));
  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const choice = PLACES.find((p) => p.key === event.key);
    if (choice === undefined) return;
    event.preventDefault();
    run.acts.decide(choice.to, false);
  };
  const top = stepTop(run, say);
  return (
    <Page
      {...top}
      aside={
        <span className="mbx-run-row">
          {waiting === null ? null : <Tag>{say("onboarding.decideLeft", { count: waiting })}</Tag>}
          {top.aside}
        </span>
      }
      material={
        <div className="mbx-run-material" role="group" aria-label={sender.name} tabIndex={0} onKeyDown={keys}>
          <div className="mbx-run-row">
            <Avatar name={sender.name} address={sender.address} size="s" /> <span>{sender.address}</span>
          </div>
          <p>{say("onboarding.decideHeld", { count: sender.held })}</p>
          {decide.sharedDomain ? null : (
            <Seg<"sender" | "domain">
              label={say("screener.barScopeAria")}
              value={decide.scope}
              onChange={decide.setScope}
              options={[
                { value: "sender", label: say("screener.barScopeSender") },
                { value: "domain", label: say("screener.barScopeDomain") },
              ]}
            />
          )}
        </div>
      }
      acts={
        <>
          <Button size="l" onPress={() => run.acts.decide(place.to, false)}>
            {say(place.name)}
          </Button>
          <Button
            kind="two"
            size="l"
            keyHint={other.key}
            shortcut={other.key}
            onPress={() => run.acts.decide(other.to, false)}
          >
            {say(other.name)}
          </Button>
        </>
      }
    >
      <SaidWith
        level={1}
        parts={onboarding.rich("decideGoes", {
          name: sender.name,
          place: () => (
            <Slot kind="fill" ref={anchor} expanded={open} onPress={() => setOpen(!open)}>
              {say(place.name)}
            </Slot>
          ),
        })}
      />
      <DestinationMenu
        anchor={anchor}
        open={open}
        close={() => setOpen(false)}
        place={place}
        choose={setPlace}
        say={say}
      />
    </Page>
  );
}

/** Choosing a destination changes the sentence. The action below it files the sender. */
function DestinationMenu({
  anchor,
  open,
  close,
  place,
  choose,
  say,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  open: boolean;
  close: () => void;
  place: (typeof PLACES)[number];
  choose: (place: (typeof PLACES)[number]) => void;
  say: StepProps["say"];
}): ReactNode {
  const pick = (choice: (typeof PLACES)[number]): void => {
    choose(choice);
    close();
  };
  return (
    <Menu
      anchor={anchor}
      open={open}
      label={say("onboarding.decidePlace")}
      onClose={close}
      onKey={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return false;
        const choice = PLACES.find(({ key }) => key === event.key);
        if (choice === undefined) return false;
        event.preventDefault();
        pick(choice);
        return true;
      }}
    >
      {PLACES.map((choice) => (
        <MenuItem
          key={choice.to}
          checked={choice.to === place.to}
          keyHint={choice.key}
          onPress={() => pick(choice)}
        >
          {say(choice.name)}
        </MenuItem>
      ))}
    </Menu>
  );
}
