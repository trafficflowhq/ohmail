import { useState } from "react";
import type { CalendarPort, ZoneSource } from "@ohmail/app-logic/calendar";
import { Button } from "@ohmail/ui/base";
import type { PanelVerb } from "@ohmail/ui/mail";
import { useFrame } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import type { InvitationActions } from "../invitations/EventAnswers.js";
import { useText } from "../text/index.js";
import { EventContextMenu } from "./CalendarMenus.js";
import { hasGuests, type removableEvent } from "./editable-event.js";
import type { CalendarEventFace } from "./faces.js";
import type { EventActions } from "./use-event-actions.js";

type EventCardMenuProps = {
  event: CalendarEventFace;
  port: CalendarPort | typeof NONE;
  zones: ZoneSource;
  actions: EventActions;
  reply?: InvitationActions;
  edit: { label: string; onPress: () => void } | null;
  removal?: PanelVerb;
  removable: ReturnType<typeof removableEvent>;
  blocked: boolean;
  otherActions: boolean;
};

export function useEventCardMenu({
  event,
  port,
  zones,
  actions,
  reply,
  edit,
  removal,
  removable,
  blocked,
  otherActions,
}: EventCardMenuProps) {
  const { plan, commands } = useFrame();
  const t = useText("calendar");
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const answer = !event.viewOnly && reply?.invitation(event.recordId);
  if (port === NONE || !reply || !(edit || removal || removable || otherActions || answer)) return {};
  const removeLabel =
    removal?.label ??
    (removable
      ? t(hasGuests(removable.record) ? "actions.cancelMeeting" : "actions.deleteEvent")
      : undefined);
  const head = (
    <>
      {edit && (
        <Button
          kind="two"
          size="s"
          icon="write"
          label={edit.label}
          disabled={blocked}
          onPress={edit.onPress}
        />
      )}
      {removeLabel && (
        <Button
          kind="two"
          size="s"
          icon="trash"
          label={removeLabel}
          disabled={blocked}
          onPress={({ currentTarget }) => {
            if (removal) removal.onPress?.(currentTarget);
            else actions.start(event, { kind: "delete" }, currentTarget);
          }}
        />
      )}
      <Button
        kind="two"
        size="s"
        icon="more"
        label={t(plan.device === "phone" ? "more" : "actions.panel")}
        opens="menu"
        expanded={anchor !== null}
        disabled={blocked}
        onPress={({ currentTarget }) => setAnchor(currentTarget)}
      />
    </>
  );
  const overlay = anchor && (
    <EventContextMenu
      event={event}
      opener={anchor}
      at={anchor}
      port={port}
      actions={actions}
      reply={reply}
      zones={zones}
      close={() => setAnchor(null)}
      openEvent={() => commands.event(event.ref)}
      edit={edit?.onPress}
    />
  );
  return { head, overlay };
}
