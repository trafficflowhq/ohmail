import { useId, type ReactNode } from "react";
import { Button, Field, RadioLines, RefusalLine } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import type { RowProps } from "./Row.js";
import { useSay } from "./say.js";

/**
 * THE REMOVAL'S CONFIRMATION, in place: what the server does, said as consequences rather than "are you sure"; what
 * happens to ohmail's copy, the person's choice; the address typed for an erasure, never filled in; the safe answer
 * first. A refusal is said here, with what was typed kept. The press is tried first and asks the second factor only
 * on the server's refusal.
 */
export function Removal(props: RowProps): ReactNode {
  const { model, verbs } = props;
  const say = useSay();
  const heading = useId();
  const removing = model.removal.removing;
  if (removing === null) return null;
  const { erase, typed, address } = removing;
  const gate = model.gated.state;
  const mine = gate.at !== "idle" && gate.act.verb !== "organize" && gate.act.id === removing.id;
  const refusal =
    model.refused !== null && model.refused.act.verb !== "organize" && model.refused.act.id === removing.id
      ? model.refused.refusal
      : null;
  const said =
    refusal === null
      ? null
      : refusal.word === "sign_in"
        ? say({ ns: "devices", key: "stepUpExpired" })
        : refusal.word === "mismatch"
          ? say({ key: "removeEraseMismatch" })
          : refusal.word === "said"
            ? refusal.said
            : say({ key: "probe_unknown" });
  const working = mine && gate.at === "trying";
  return (
    <div className="mbx-row-lines" role="alertdialog" aria-labelledby={heading}>
      <h3 className="oh-text" id={heading}>
        {say({ key: "removeTitle", values: { address } })}
      </h3>
      <SettingNote>{say({ key: "removeStops" })}</SettingNote>
      <SettingNote>{say({ key: "removeMailSafe" })}</SettingNote>
      <SettingNote>{say({ key: "removeCredential" })}</SettingNote>
      <SettingNote>{say({ key: "removeScheduled" })}</SettingNote>
      <SettingNote>{say({ key: erase ? "removeCopyErased" : "removeCopyStays" })}</SettingNote>
      {verbs.erase ? (
        <>
          <RadioLines
            label={say({ key: "removeTitle", values: { address } })}
            value={erase ? "erase" : "keep"}
            options={[
              { value: "keep", label: say({ key: "removeKeepChoice" }) },
              { value: "erase", label: say({ key: "removeEraseChoice" }) },
            ]}
            onChange={(v) => model.removal.choose(v === "erase")}
          />
          <SettingNote>{say({ key: "removeEraseWhat" })}</SettingNote>
          {erase ? (
            <Field
              label={say({ key: "removeEraseTypeLabel" })}
              value={typed}
              onChange={model.removal.type}
              autoComplete="off"
            />
          ) : null}
        </>
      ) : null}
      <SettingNote>{say({ key: "removeReconnect" })}</SettingNote>
      {said !== null ? <RefusalLine alert>{said}</RefusalLine> : null}
      <div className="mbx-pane-acts">
        <Button kind="two" onPress={model.removal.close}>
          {say({ key: "removeCancel" })}
        </Button>
        <Button disabled={working || (erase && typed.trim() === "")} onPress={model.removal.confirm}>
          {say({ key: erase ? "removeEraseConfirm" : "removeConfirm" })}
        </Button>
      </div>
    </div>
  );
}
