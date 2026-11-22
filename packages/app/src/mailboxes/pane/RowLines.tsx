import type { ReactNode } from "react";
import { Button } from "@ohmail/ui/base";
import { SettingLine, SettingNote } from "@ohmail/ui/mail";
import { filerKey } from "@ohmail/app-logic/mail-state/mail-state";
import {
  notCheckedOf,
  providerName,
  quietSaid,
  type RowState,
  type Standing,
} from "@ohmail/app-logic/mailboxes/pane/said";
import { useText } from "../../text/index.js";
import { NONE } from "../../host/index.js";
import { ConnectForm } from "../connect/index.js";
import type { ConnectResult, ConnectSubject } from "../connect/contract.js";
import { Checks } from "./Checks.js";
import { Organizing, StandDown } from "./Organizer.js";
import { formOf, type RowProps } from "./Row.js";
import { useFigure, useSay, useStamps } from "./say.js";

/**
 * AN OPENED ROW'S LINES: first its state with the exact time (the shipped row's pointer hint), then in the shipped
 * pane's order: an earlier entry it stands in front of; who holds it and the one remedy there is; who files it here
 * and the way to stop that; the quiet facts; then its verbs, the connect form for an edit or a reconnect, the check
 * against its server, its filings that wait, and the calendar's half where a shell has one. The removal's
 * confirmation is the pane's dialog over the window.
 */
export function RowLines(
  props: RowProps & { readonly standing: Standing; readonly state: RowState },
): ReactNode {
  const { m, model, verbs, standing, state, filer } = props;
  const say = useSay();
  const stamps = useStamps();
  const picker = useText("providerPicker");
  const figure = useFigure();
  const now = model.list.now;
  const quiet = verbs.dismissQuiet ? quietSaid(m, { now, stamps }) : null;
  const late = notCheckedOf(m, { now, stamps });
  const [editing, setEditing] = props.editing;
  const form = formOf(m, verbs, props.connect);
  const removing = model.removal.removing?.id === m.id;
  const erasing = Boolean(m.erasure);
  return (
    <div className="mbx-row-lines">
      <SettingLine label={say({ key: "lineProvider" })} value={providerName(m) ?? picker("otherLabel")} />
      {state.kind !== "ok" && "title" in state && state.title ? (
        <SettingLine label={state.text} value={state.title} />
      ) : null}
      {props.superseded > 0 ? <SettingNote>{say({ key: "superseded" })}</SettingNote> : null}
      <StandDown {...props} />
      {standing.organizerBlock ? <Organizing {...props} /> : null}
      {quiet !== null ? (
        <div className="mbx-pane-acts">
          <SettingNote>{say(quiet)}</SettingNote>
          <Button
            kind="two"
            size="s"
            disabled={model.acts.dismissing.has(m.id)}
            onPress={() => model.acts.dismissQuiet(m.id)}
          >
            {say({ key: "inboundQuietDismiss" })}
          </Button>
        </div>
      ) : null}
      {late.on ? (
        <SettingNote>{say({ key: filerKey("notChecked", filer), values: late.values })}</SettingNote>
      ) : null}
      {(m.setAside ?? 0) > 0 ? (
        <SettingNote>{say({ key: "desktopSetAside", values: { n: m.setAside! } })}</SettingNote>
      ) : null}
      <SettingLine
        label={say({ key: "lineSynced" })}
        value={m.lastSyncAt ? stamps.when(m.lastSyncAt, now) : undefined}
      >
        {verbs.resync && m.status !== "disabled" && !erasing ? (
          <Button
            kind="two"
            size="s"
            disabled={model.acts.queued.has(m.id)}
            onPress={() => model.acts.resync(m.id)}
          >
            {say({ key: "syncNow" })}
          </Button>
        ) : null}
      </SettingLine>
      {typeof m.messageCount === "number" && !erasing ? (
        <SettingLine label={say({ key: "lineMessages" })} value={figure(m.messageCount)} />
      ) : null}
      {verbs.check && !erasing && m.status !== "disabled" ? <Checks {...props} /> : null}
      {m.status === "disabled" || erasing ? null : (
        <div className="mbx-pane-acts">
          {form === "edit" && editing !== m.id ? (
            <Button
              kind="quiet"
              size="s"
              onPress={() => {
                // One form at a time, as the shipped pane's stages were: the edit closes the removal.
                model.removal.close();
                setEditing(m.id);
              }}
            >
              {say({ key: "edit" })}
            </Button>
          ) : null}
          {verbs.remove && !removing ? (
            <Button
              kind="quiet"
              size="s"
              onPress={() => {
                setEditing(null);
                model.removal.open(m);
              }}
            >
              {say({ key: "remove" })}
            </Button>
          ) : null}
        </div>
      )}
      {form !== null && props.connect !== NONE && (form === "reconnect" || editing === m.id) ? (
        <ConnectForm
          ask={{
            purpose: { kind: form, mailbox: subjectOf(m) },
            holdLeave: props.holdEdit,
            onDone: (result) => done(result, props, () => setEditing((e) => (e === m.id ? null : e))),
          }}
          door={props.connect}
          factor={props.factor}
        />
      ) : null}
      {props.calendar !== NONE ? props.calendar({ mailboxId: m.id, provider: m.provider }) : null}
    </div>
  );
}

/** The mailbox an edit or a reconnect is about: its own row's id, never a word of the route. */
function subjectOf(m: RowProps["m"]): ConnectSubject {
  return {
    id: m.id,
    address: m.address,
    provider: m.provider,
    signsIn: m.authKind === "oauth" ? "provider" : "password",
  };
}

/** The connect form in a row ended: a write the server took is read back and told; the form leaves. */
function done(result: ConnectResult, props: RowProps, close: () => void): void {
  const { model } = props;
  if (result.kind === "connected") {
    const address = result.address ?? props.m.address;
    model.lines.tell({
      said: { key: result.created ? "oauthConnected" : "oauthReconnected", values: { address } },
    });
  }
  if (result.kind !== "left") model.wrote();
  close();
}
