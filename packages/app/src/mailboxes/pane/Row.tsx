import type { Dispatch, ReactNode, SetStateAction } from "react";
import { AccountRow } from "@ohmail/ui/mail";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { drawsTakeover } from "@ohmail/app-logic/mailboxes/pane/organizer";
import { statusKey } from "@ohmail/app-logic/mailboxes/pane/rows";
import { providerName, rowStateOf, standingOf } from "@ohmail/app-logic/mailboxes/pane/said";
import type { MailboxRow } from "@ohmail/app-logic/mailboxes/pane/types";
import type { PaneModel } from "@ohmail/app-logic/mailboxes/pane/use-pane";
import type { PaneVerbs } from "@ohmail/app-logic/mailboxes/pane/verbs";
import { NONE, type ConnectWire, type None } from "../../host/index.js";
import { useText } from "../../text/index.js";
import type { CalendarHalfSlot, FactorSlot } from "../connect/contract.js";
import { RowLines } from "./RowLines.js";
import { useFigure, useSay, useStamps } from "./say.js";

export interface RowProps {
  readonly m: MailboxRow;
  /** Disabled entries of the same address it stands in front of. */
  readonly superseded: number;
  readonly model: PaneModel;
  readonly verbs: PaneVerbs;
  readonly connect: ConnectWire | None;
  readonly factor: FactorSlot | None;
  readonly calendar: CalendarHalfSlot | None;
  readonly filer: "cloud" | "server";
  readonly importingSole: boolean;
  readonly open: boolean;
  onToggle(): void;
  /** The one row whose connect form stands, if any. */
  readonly editing: readonly [string | null, Dispatch<SetStateAction<string | null>>];
}

/**
 * ONE MAILBOX: its address, what is true of it now, its provider and how much of its mail ohmail holds; its state as
 * one word; and a released mailbox's one press. A press on the row opens its lines in place and shuts them again.
 */
export function Row(props: RowProps): ReactNode {
  const { m, model, verbs } = props;
  const say = useSay();
  const picker = useText("providerPicker");
  const stamps = useStamps();
  const figure = useFigure();
  const state = rowStateOf(m, {
    now: model.list.now,
    stamps,
    say,
    figure,
    filer: props.filer,
    queued: model.acts.queued.has(m.id),
    importingSole: props.importingSole,
  });
  const provider = providerName(m) ?? picker("otherLabel");
  const counted = typeof m.messageCount === "number" && !m.erasure;
  const facts = [
    ...(state.kind === "none" ? [] : [state.text]),
    provider,
    ...(counted ? [say({ key: "messageCount", values: { count: m.messageCount! } })] : []),
  ];
  const standing = standingOf(m);
  const released = standing.standDown === "released" && verbs.organize && drawsTakeover(m);
  const name = displayAddress(m.address);
  const gate = model.gated.state;
  /* The take-over is under way after its own press; once the server took it, the press is spent until the row's role moves. */
  const running = gate.at === "trying" && gate.act.verb === "organize" && gate.act.id === m.id;
  const takeover = (): void => model.takeover(m.id);
  const offer = running
    ? { label: say({ key: "working" }), onPress: takeover, busy: true }
    : model.takingOver.has(m.id)
      ? { label: say({ key: "organizeHere" }), disabled: true }
      : { label: say({ key: "organizeHere" }), onPress: takeover };
  return (
    <AccountRow
      name={name}
      address={m.address}
      facts={facts}
      state={say({ key: statusKey(m) })}
      {...(released ? { offer } : {})}
      expanded={props.open}
      onToggle={props.onToggle}
    >
      <RowLines {...props} standing={standing} state={state} />
    </AccountRow>
  );
}

/** Whether a row's connect form can stand: an edit the shell can store, or a sign-in the shell can run. */
export function formOf(
  m: MailboxRow,
  verbs: PaneVerbs,
  connect: ConnectWire | None,
): "edit" | "reconnect" | null {
  if (connect === NONE) return null;
  if (m.status === "disabled") return null;
  if (m.authKind === "oauth") return verbs.reconnect ? "reconnect" : null;
  return verbs.edit ? "edit" : null;
}
