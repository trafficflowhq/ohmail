import { useLayoutEffect, useRef, useState } from "react";
import { ActionPanel } from "@ohmail/ui/mail";
import { Button } from "@ohmail/ui/base";

import type { Text } from "../text/index.js";
import type { CalendarEventFace } from "./faces.js";
import type { EventActions } from "./use-event-actions.js";
import type { MessageDTO } from "@ohmail/wire";

export function proposalDetails(
  actions: EventActions,
  event: CalendarEventFace,
  letters: readonly MessageDTO[],
  today: string,
  canEdit: boolean,
  t: Text,
) {
  const { outgoing, incoming } = actions.proposal.card(event, letters);
  const proposed = incoming?.invitation?.proposal;
  const proposedWhen = proposed && actions.proposal.shortWhen(event, proposed, today);
  const sentWhen = outgoing && actions.proposal.when(event, outgoing, today);
  const row = sentWhen ? { label: t("proposal.proposed"), children: sentWhen } : null;
  const propose = actions.proposal.baseOf(event)
    ? { label: t("proposal.action"), onPress: () => actions.proposal.open(event) }
    : undefined;
  const answers =
    canEdit && incoming && proposed && proposedWhen ? (
      <div className="cal-proposal-answers">
        <Button
          kind="ink"
          size="s"
          onPress={(eventTarget) =>
            actions.start(
              event,
              { kind: "accept-time", start: proposed.start, end: proposed.end },
              eventTarget.currentTarget,
            )
          }
        >
          {t("proposal.accept", { time: proposedWhen })}
        </Button>
        {actions.proposal.canKeep && (
          <KeepTime
            key={incoming.id}
            t={t}
            name={incoming.from.name?.trim() || incoming.from.address}
            time={actions.proposal.currentTime(event)}
            send={() => actions.proposal.keep(event, incoming.id)}
          />
        )}
      </div>
    ) : null;
  const tags =
    incoming && proposedWhen
      ? [
          {
            text: t("proposal.incoming", {
              name: incoming.from.name?.trim().split(/\s+/)[0] || incoming.from.address,
              when: proposedWhen,
            }),
            hot: true,
          },
        ]
      : [];
  return { row, propose, tags, answers };
}

function KeepTime({ t, name, time, send }: { t: Text; name: string; time: string; send: () => void }) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const restore = useRef(false);
  useLayoutEffect(() => {
    if (open) panel.current?.querySelector("button")?.focus();
    else if (restore.current) button.current?.focus();
  }, [open]);
  const close = () => {
    restore.current = true;
    setOpen(false);
  };
  const question = t("proposal.keepQuestion", { name });
  return open ? (
    <div
      ref={panel}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <ActionPanel
        label={question}
        items={[
          { note: question, keep: true },
          {
            id: "confirm",
            label: t("proposal.keepConfirm"),
            icon: "check",
            kind: "ink",
            rank: 0,
            onPress: () => {
              close();
              send();
            },
          },
          { id: "cancel", label: t("edit.cancel"), icon: "x", rank: 0, onPress: close },
        ]}
      />
    </div>
  ) : (
    <Button ref={button} kind="two" size="s" onPress={() => setOpen(true)}>
      {t("proposal.keep", { time })}
    </Button>
  );
}
