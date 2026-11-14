import type { ReactNode } from "react";
import { Button } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import { filerKey } from "@ohmail/app-logic/mail-state/mail-state";
import { notCheckedOf, quietSaid, type RowState, type Standing } from "@ohmail/app-logic/mailboxes/pane/said";
import { NONE } from "../../host/index.js";
import { ConnectForm } from "../connect/index.js";
import type { ConnectResult, ConnectSubject } from "../connect/contract.js";
import { Checks } from "./Checks.js";
import { Organizing, StandDown } from "./Organizer.js";
import { Removal } from "./Removal.js";
import { formOf, type RowProps } from "./Row.js";
import { useSay, useStamps } from "./say.js";

/**
 * AN OPENED ROW'S LINES, in the shipped pane's order: an earlier entry it stands in front of; who holds it and the
 * one remedy there is; who files it here and the way to stop that; the quiet facts; then its verbs, the connect form
 * for an edit or a reconnect, the removal's confirmation, the check against its server, its filings that wait, and
 * the calendar's half where a shell has one.
 */
export function RowLines(
  props: RowProps & { readonly standing: Standing; readonly state: RowState },
): ReactNode {
  const { m, model, verbs, standing, filer } = props;
  const say = useSay();
  const stamps = useStamps();
  const now = model.list.now;
  const quiet = verbs.dismissQuiet ? quietSaid(m, { now, stamps }) : null;
  const late = notCheckedOf(m, { now, stamps });
  const [editing, setEditing] = props.editing;
  const form = formOf(m, verbs, props.connect);
  const removing = model.removal.removing?.id === m.id;
  const erasing = Boolean(m.erasure);
  return (
    <div className="mbx-row-lines">
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
      {m.status === "disabled" || erasing ? null : (
        <div className="mbx-pane-acts">
          {verbs.resync ? (
            <Button
              kind="two"
              size="s"
              disabled={model.acts.queued.has(m.id)}
              onPress={() => model.acts.resync(m.id)}
            >
              {say({ key: "syncNow" })}
            </Button>
          ) : null}
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
            onDone: (result) => done(result, props, () => setEditing((e) => (e === m.id ? null : e))),
          }}
          door={props.connect}
          factor={props.factor}
        />
      ) : null}
      {removing ? <Removal {...props} /> : null}
      {verbs.check && !erasing && m.status !== "disabled" ? <Checks {...props} /> : null}
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
