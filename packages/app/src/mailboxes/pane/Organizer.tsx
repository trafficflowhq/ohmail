import type { ReactNode } from "react";
import { Button } from "@ohmail/ui/base";
import { SettingLine, SettingNote } from "@ohmail/ui/mail";
import { filerKey } from "@ohmail/app-logic/mail-state/mail-state";
import { drawsTakeover, organizerSaid } from "@ohmail/app-logic/mailboxes/pane/organizer";
import { organizingSaid, standDownSaid, type Standing } from "@ohmail/app-logic/mailboxes/pane/said";
import type { RowProps } from "./Row.js";
import { useSay, useStamps } from "./say.js";

type Props = RowProps & { readonly standing: Standing };

/**
 * WHO HOLDS IT, WHEN THIS INSTALL DOES NOT. Paused by the account's wall: no press. Released here: the date, and the
 * one press on the row. Held elsewhere or by nobody: why, and the check that reads the mailbox before a take-over is
 * offered; confirming it asks to organize here, which the worker decides on its next pass.
 */
export function StandDown(props: Props): ReactNode {
  const { m, model, verbs, standing, filer } = props;
  const say = useSay();
  const stamps = useStamps();
  if (standing.standDown === "parked") return <SettingNote>{say({ key: "stateParked" })}</SettingNote>;
  if (standing.standDown === "released")
    return (
      <SettingNote>
        {say({ key: "stateReleased", values: { when: stamps.day(m.organizerReleasedAt) } })}
      </SettingNote>
    );
  const why = standDownSaid(standing, filer);
  if (why === null) return null;
  const checking = model.peek.checking?.id === m.id ? model.peek.checking : null;
  const offers = verbs.peek && verbs.organize && drawsTakeover(m);
  return (
    <>
      <SettingNote warn>{say(why)}</SettingNote>
      {!offers ? null : checking === null ? (
        <div className="mbx-pane-acts">
          <SettingNote>
            {say({ key: filerKey(standing.lapsed ? "takeoverHowLapsed" : "takeoverHow", filer) })}
          </SettingNote>
          <Button
            kind="two"
            size="s"
            disabled={model.peek.checking !== null}
            onPress={() => {
              model.lines.clear();
              model.peek.check(m.id);
            }}
          >
            {say({ key: filerKey("takeoverCheck", filer) })}
          </Button>
        </div>
      ) : checking.peek === null ? (
        <SettingNote>{say({ key: "organizerChecking" })}</SettingNote>
      ) : (
        <Found {...props} />
      )}
    </>
  );
}

/** What the check found, what taking over does, and the confirm: spent while its answer is read back. */
function Found(props: Props): ReactNode {
  const { m, model, filer } = props;
  const say = useSay();
  const stamps = useStamps();
  const peek = model.peek.checking?.peek;
  if (!peek) return null;
  const said = organizerSaid(peek, (iso) => stamps.ago(iso, model.list.now).rel, filer);
  const spent = model.gated.state.at === "trying" && model.gated.state.act.id === m.id;
  return (
    <>
      <SettingNote>{say(said.found)}</SettingNote>
      <SettingNote>{say(said.effect)}</SettingNote>
      <div className="mbx-pane-acts">
        <Button size="s" disabled={spent} onPress={() => model.takeover(m.id)}>
          {say({ key: "organizerConfirm" })}
        </Button>
        <Button kind="quiet" size="s" onPress={model.peek.close}>
          {say({ key: "organizerCancel" })}
        </Button>
      </div>
    </>
  );
}

/**
 * WHO FILES IT HERE, AND THE VERB THAT CHANGES IT: organizing, a stop on its way, a refused stop, or a claim of this
 * install's own left behind. What it costs is said before it is done: nothing is removed, the password is kept, and
 * any install can take it afterwards.
 */
export function Organizing(props: Props): ReactNode {
  const { m, model, verbs, standing, filer } = props;
  const say = useSay();
  const { acts } = model;
  const asked = acts.releaseFor === m.id;
  const stranded = standing.stranded;
  const offered = verbs.stop && !asked && (stranded || !m.releaseRequestedAt);
  return (
    <>
      <SettingLine label={say({ key: stranded ? "stateReading" : "stateOrganizing" })}>
        {offered ? (
          <Button kind="quiet" size="s" onPress={() => acts.askRelease(m.id)}>
            {say({ key: stranded ? "releaseClaim" : "stopOrganizingHandBack" })}
          </Button>
        ) : null}
      </SettingLine>
      <SettingNote>{say(organizingSaid(m, standing, filer))}</SettingNote>
      {asked ? (
        <>
          <SettingNote>
            {say({ key: filerKey(stranded ? "releaseClaimWhat" : "stopWhat", filer) })}
          </SettingNote>
          <div className="mbx-pane-acts">
            <Button size="s" disabled={acts.releasing.has(m.id)} onPress={() => acts.release(m.id)}>
              {say({ key: stranded ? "releaseClaimConfirm" : "stopOrganizingConfirm" })}
            </Button>
            <Button kind="quiet" size="s" onPress={() => acts.askRelease(null)}>
              {say({ key: "cancel" })}
            </Button>
          </div>
        </>
      ) : null}
    </>
  );
}
