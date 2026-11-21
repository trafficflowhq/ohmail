import type { HeldEdge, RangeActs, RangeInput } from "@ohmail/app-logic/calendar";
import { AgendaView } from "../agenda/index.js";
import { useFrame } from "../frame/commands.js";
import type { PaneProps } from "../frame/contract.js";
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
}: PaneProps & {
  where: Where;
  input: RangeInput;
  acts: RangeActs;
  edge: HeldEdge;
  onClose: () => void;
  onAgendaRow: (id: string, day: string) => void;
}) {
  const entry = useFrame().host.features.calendar;
  const Invitations = entry === NONE ? NONE : entry.panels.invitations;
  if (route.words.panel === "invitations" && Invitations !== NONE) {
    return <Invitations route={route} plan={plan} keysHere={false} onClose={onClose} />;
  }
  if (route.words.panel !== "agenda" || plan.device === "phone" || where.place === "agenda") return null;
  return (
    <div className="cal-body-panel">
      <AgendaView
        input={input}
        acts={acts}
        edge={edge}
        from={where.agenda.first}
        days={where.agenda.days}
        onMore={where.agenda.more}
        onClose={onClose}
        onRow={onAgendaRow}
        keysHere={keysHere && route.open === null}
      />
    </div>
  );
}
