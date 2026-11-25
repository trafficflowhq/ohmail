import type { HeldEdge, RangeActs, RangeInput } from "@ohmail/app-logic/calendar";
import { AgendaView } from "../agenda/index.js";
import { useFrame } from "../frame/commands.js";
import type { CalendarPanelProps, PaneProps } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import type { Where } from "./where.js";

export function CalendarPanels({
  where,
  route,
  plan,
  keysHere,
  input,
  acts,
  edge,
  onClose,
  onAgendaRow,
  agendaPanel,
  compact,
}: PaneProps & {
  where: Where;
  agendaPanel: { visible: boolean; compact: boolean; toggle: () => void };
  input: RangeInput;
  acts: RangeActs;
  edge: HeldEdge;
  onClose: () => void;
  compact?: CalendarPanelProps["compact"];
  onAgendaRow: (id: string, day: string) => void;
}) {
  const entry = useFrame().host.features.calendar;
  const Invitations = entry === NONE ? NONE : entry.panels.invitations;
  if (route.words.panel === "invitations" && Invitations !== NONE) {
    const panel = (
      <Invitations route={route} plan={plan} keysHere={false} onClose={onClose} compact={compact} />
    );
    return plan.device === "phone" ? <div className="cal-invitations">{panel}</div> : panel;
  }
  if (!agendaPanel.visible || where.place === "agenda") return null;
  return (
    <div className="cal-body-panel" data-compact-agenda={agendaPanel.compact || undefined}>
      <AgendaView
        input={input}
        acts={acts}
        edge={edge}
        from={where.agenda.first}
        days={where.agenda.days}
        onMore={where.agenda.more}
        onClose={agendaPanel.toggle}
        onRow={onAgendaRow}
        keysHere={keysHere && route.open === null}
      />
    </div>
  );
}
