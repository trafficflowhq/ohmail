import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@ohmail/ui/base";
import { GroupHeading, SettingLine, SettingNote } from "@ohmail/ui/mail";
import { filerKey } from "@ohmail/app-logic/mail-state/mail-state";
import { subjectOf } from "@ohmail/app-logic/mailboxes/connect/subject";
import { FILER_OF_SERVICE, webFilerOf } from "@ohmail/app-logic/mailboxes/pane/organizer";
import { connectBlock, groupByAddress } from "@ohmail/app-logic/mailboxes/pane/rows";
import { usePane, type PaneGround, type PaneModel } from "@ohmail/app-logic/mailboxes/pane/use-pane";
import { verbsOf, type PaneVerbs } from "@ohmail/app-logic/mailboxes/pane/verbs";
import {
  NONE,
  type ConnectWire,
  type HostCapabilities,
  type MailboxesWire,
  type None,
} from "../../host/index.js";
import type { CalendarHalfSlot, FactorSlot } from "../connect/contract.js";
import { PaneLines } from "./Lines.js";
import { Removal } from "./Removal.js";
import { Row } from "./Row.js";
import { useSay } from "./say.js";
import "./placement.css";

export interface MailboxesPaneProps {
  /** The pane's own calls: the shell's `wires.mailboxes`. */
  readonly wire: MailboxesWire | None;
  /** The connect form's calls, for an edit or a reconnect in a row: the shell's `wires.connect`. */
  readonly connect: ConnectWire | None;
  readonly capability: HostCapabilities["mailboxes"];
  /** Whose service this is: who files a mailbox it organizes, in words. */
  readonly service: HostCapabilities["service"];
  /** The doors' second-factor dialog, as the shell fills it. */
  readonly factor: FactorSlot | None;
  /** The calendar's half of a mailbox, where a shell has one. */
  readonly calendar: CalendarHalfSlot | None;
  /** The route's word for a mailbox: a claim, opened only where the account's own rows hold it. */
  readonly opened: string | null;
  /** The first run can open: its add run and its run again. */
  readonly stage: boolean;
  /** Settings lists the Subscription pane beside this one: the refusal's pointer names it. */
  readonly subscriptionPane: boolean;
  /** To the first run's add run, or its run again. */
  go(run: "add" | "again"): void;
  /** The mail state's reading and re-read, and the engine's sync. */
  readonly ground: PaneGround & { readonly importing: boolean };
  /** Nobody is looking: the tick reads nothing. */
  readonly hidden: () => boolean;
}

/** The line the dialog is handed: which write the factor authorises. */
const FACTOR_LINE = {
  remove: "factorBodyRemove",
  erase: "factorBodyErase",
  organize: "factorBodyTakeover",
} as const;

/**
 * SETTINGS › MAILBOXES. One row per mailbox, on the kit's account row, that opens in place; what it may change follows
 * the shell's answers alone. Connecting goes to the first run's add run; an edit or a reconnect is the one connect
 * form, in the opened row. A shell with no wire draws nothing.
 */
export function MailboxesPane(props: MailboxesPaneProps): ReactNode {
  const verbs = verbsOf({
    capability: props.capability,
    wire: props.wire,
    connect: props.connect,
    stage: props.stage,
  });
  if (!verbs.listed || props.wire === NONE) return null;
  return <Listed {...props} wire={props.wire} verbs={verbs} />;
}

function Listed(
  props: MailboxesPaneProps & { readonly wire: MailboxesWire; readonly verbs: PaneVerbs },
): ReactNode {
  const { wire, connect, factor, verbs, ground } = props;
  const say = useSay();
  const filer = FILER_OF_SERVICE[props.service];
  const signIn = connect === NONE ? NONE : connect.signIn;
  const model = usePane({
    wire,
    factor: factor !== NONE,
    hidden: props.hidden,
    ground,
    returned: signIn === NONE ? NONE : signIn.returned,
    filer: webFilerOf(filer),
  });
  const open = useOpenRows(model, props.opened);
  const rows = model.list.rows;
  const editing = useState<string | null>(null);

  // Whether another may be connected is read again whenever the pane comes back to rest.
  const resting = model.gated.state.at !== "trying" && model.removal.removing === null && editing[0] === null;
  const { readAllowance } = model.list;
  useEffect(() => {
    if (resting) readAllowance();
  }, [readAllowance, resting]);

  const groups = useMemo(
    () => (model.list.behind || rows === null ? [] : groupByAddress(rows)),
    [model.list.behind, rows],
  );
  const live = rows === null ? null : rows.filter((m) => m.status !== "disabled").length;
  const allowance = model.list.allowance;
  const block = connectBlock({
    emailVerified: allowance?.emailVerified ?? null,
    access: allowance?.access ?? null,
    enabledCount: live,
  });
  const importingSole = ground.importing && live === 1;

  return (
    <div className="mbx-pane">
      <GroupHeading>{say({ key: filerKey("heading", filer) })}</GroupHeading>
      <PaneLines model={model} />
      {groups.map(({ shown, superseded }) => (
        <Row
          key={shown.id}
          m={shown}
          superseded={superseded}
          model={model}
          verbs={verbs}
          connect={connect}
          factor={factor}
          calendar={props.calendar}
          filer={webFilerOf(filer)}
          importingSole={importingSole}
          open={open.has(shown.id)}
          onToggle={() => open.toggle(shown.id)}
          editing={editing}
        />
      ))}
      {model.list.allowanceRead && verbs.connect ? (
        block !== null ? (
          <>
            <SettingNote>{say({ key: `blocked_${block}` })}</SettingNote>
            {block === "email_unverified" || !props.subscriptionPane ? null : (
              <SettingNote>{say({ key: "blocked_where" })}</SettingNote>
            )}
          </>
        ) : (
          <div className="mbx-pane-acts">
            <Button icon="plus" onPress={() => props.go("add")}>
              {say({ key: "connect" })}
            </Button>
          </div>
        )
      ) : null}
      {verbs.out && wire.out !== NONE ? (
        <div className="mbx-pane-acts">
          <Button kind="two" icon="go" onPress={wire.out}>
            {say({ key: "desktopOpenSetup" })}
          </Button>
        </div>
      ) : null}
      {verbs.connect ? <SettingNote>{say({ key: "inPlace" })}</SettingNote> : null}
      {verbs.setupAgain && rows !== null && rows.length > 0 ? (
        <>
          <SettingLine label={say({ key: "setupAgain" })}>
            <Button kind="two" size="s" onPress={() => props.go("again")}>
              {say({ key: "setupAgainAction" })}
            </Button>
          </SettingLine>
          <SettingNote>{say({ key: "setupAgainWhy" })}</SettingNote>
        </>
      ) : null}
      {/* The removal's confirmation over the window, for the row it was opened on; the factor's dialog over it. */}
      <Removal model={model} verbs={verbs} />
      {/* The one second-factor dialog, for the press the server parked; its line names which write it authorises. */}
      {model.gated.asking !== null && factor !== NONE && model.gated.state.at === "asking"
        ? factor({ ...model.gated.asking, line: say({ key: FACTOR_LINE[model.gated.state.act.verb] }) })
        : null}
    </div>
  );
}

/**
 * WHICH ROWS STAND OPEN: those the person opened, kept while the pane stands, and the one the route's word names
 * where the account's own rows hold it. The word opens; it never presses.
 */
function useOpenRows(model: PaneModel, word: string | null) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const rows = model.list.rows;
  const named = word === null ? null : subjectOf(rows, word, "run");
  const id = named?.state === "mailbox" ? (named.mailbox?.id ?? null) : null;
  useEffect(() => {
    if (id !== null) setOpen((s) => (s.has(id) ? s : new Set(s).add(id)));
  }, [id]);
  return {
    has: (rowId: string) => open.has(rowId),
    toggle: (rowId: string) =>
      setOpen((s) => {
        const next = new Set(s);
        if (next.has(rowId)) next.delete(rowId);
        else next.add(rowId);
        return next;
      }),
  };
}
