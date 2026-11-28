import { useEffect, useState, type ReactNode } from "react";
import { Dialog, Field, RadioLines } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import type { RowProps } from "./Row.js";
import { useSay } from "./say.js";

/**
 * THE REMOVAL'S CONFIRMATION, as the kit's dialog over the window: what the server does, said as consequences rather
 * than "are you sure"; what happens to ohmail's copy, the person's choice; the address typed for an erasure, never
 * filled in; the safe answer has the keys. A refusal is said in it, with what was typed kept. The press is tried
 * first and asks the second factor only on the server's refusal; Escape and the scrim are Keep it.
 */
export function Removal({
  model,
  verbs,
  calendarReuse,
}: Pick<RowProps, "model" | "verbs"> & { calendarReuse?: (id: string) => Promise<boolean> }): ReactNode {
  const say = useSay();
  const removing = model.removal.removing;
  const id = removing?.id;
  const [calendar, setCalendar] = useState<{
    id: string;
    read: typeof calendarReuse;
    linked: boolean;
  } | null>(null);
  useEffect(() => {
    if (id === undefined || calendarReuse === undefined) {
      setCalendar(null);
      return;
    }
    let live = true;
    void calendarReuse(id).then(
      (yes) => {
        if (live) setCalendar({ id, read: calendarReuse, linked: yes });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [id, calendarReuse]);
  if (removing === null) return null;
  const linked =
    calendar && calendar.id === removing.id && calendar.read === calendarReuse ? calendar.linked : undefined;
  const mayHaveCalendar =
    calendarReuse !== undefined && model.list.rows?.some((row) => row.id === id && row.provider === "icloud");
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
    <Dialog
      open
      onClose={model.removal.close}
      title={say({ key: "removeTitle", values: { address } })}
      keysOn="cancel"
      confirm={{
        label: say({ key: erase ? "removeEraseConfirm" : "removeConfirm" }),
        onPress: model.removal.confirm,
        disabled: working || (erase && typed.trim() === ""),
      }}
      cancel={{ label: say({ key: "removeCancel" }) }}
      {...(said !== null ? { said: { line: said, refused: true } } : {})}
    >
      <SettingNote>{say({ key: "removeStops" })}</SettingNote>
      <SettingNote>{say({ key: "removeMailSafe" })}</SettingNote>
      <SettingNote>{say({ key: "removeCredential" })}</SettingNote>
      {linked === true ? (
        <SettingNote>{say({ key: "removeCalendarConnection" })}</SettingNote>
      ) : linked === undefined && mayHaveCalendar ? (
        <SettingNote>{say({ key: "removeCalendarPossible" })}</SettingNote>
      ) : null}
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
          {erase ? (
            <>
              <SettingNote>{say({ key: "removeEraseWhat" })}</SettingNote>
              <Field
                label={say({ key: "removeEraseTypeLabel" })}
                value={typed}
                onChange={model.removal.type}
                autoComplete="off"
              />
            </>
          ) : null}
        </>
      ) : null}
      <SettingNote>{say({ key: "removeReconnect" })}</SettingNote>
    </Dialog>
  );
}
