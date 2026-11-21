import { useState, type MouseEvent } from "react";
import { calendarInviteeSuggestions } from "@ohmail/app-logic/calendar";
import { parseRecipients } from "@ohmail/app-logic/writing/compose";
import type { CalendarInvitee } from "@ohmail/wire";
import { Button, Field, Menu, MenuItem } from "@ohmail/ui/base";
import type { EventFormProps, EventFormRow } from "@ohmail/ui/calendar";
import { useFrame } from "../frame/commands.js";
import { useOwnAddresses } from "../frame/room.js";
import { useText } from "../text/index.js";
import type { EventDraft } from "./event-draft.js";

export interface EditorRows {
  readonly canInvite: boolean;
  readonly canAddAlert: boolean;
  readonly canAddSecondAlert: boolean;
}

type Picker = { anchor: HTMLElement; kind: "invitees" | "alert" | "role"; index: number };
type Change = (edit: Partial<EventDraft>) => void;
const REMINDERS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];

export function useEditorRows(draft: EventDraft, change: Change, editor?: EditorRows) {
  const t = useText("calendar");
  const [picker, setPicker] = useState<Picker | null>(null);
  const [alertsShown, showAlerts] = useState(false);
  const beforePlace: EventFormRow[] = [];
  const afterPlace: EventFormRow[] = [];
  const adds: NonNullable<EventFormProps["adds"]>[number][] = [];
  if (!editor) return { beforePlace, afterPlace, adds, menu: null };
  const guests = draft.invitees ?? [];
  const alarms = draft.alarms ?? [];
  const open =
    (kind: Picker["kind"], index = 0) =>
    (event: MouseEvent<HTMLButtonElement>) =>
      setPicker({ anchor: event.currentTarget, kind, index });
  const close = () => setPicker(null);
  if (guests.length) {
    beforePlace.push({
      id: "invitees",
      icon: "people",
      items: [
        ...guests.map((guest, index) => {
          const name = guest.name || guest.address;
          const note = [
            guest.role === "optional" ? t("edit.optional") : null,
            t("edit.guestAnswer", { answer: guest.answer }),
          ]
            .filter(Boolean)
            .join(" · ");
          return {
            kind: "person" as const,
            name,
            address: guest.address,
            note,
            declined: guest.answer === "declined",
            expanded: picker?.kind === "role" && picker.index === index,
            onPress: editor.canInvite ? open("role", index) : undefined,
            remove: editor.canInvite
              ? {
                  label: t("edit.removePerson", { name }),
                  onPress: () => change({ invitees: guests.filter((_, i) => i !== index) }),
                }
              : undefined,
          };
        }),
        ...(editor.canInvite
          ? [
              {
                kind: "slot" as const,
                label: t("edit.addInvitees"),
                value: t("create.add"),
                expanded: picker?.kind === "invitees",
                state: "none" as const,
                onPress: open("invitees"),
              },
            ]
          : []),
      ],
    });
  } else if (editor.canInvite) {
    adds.push({ id: "invitees", word: t("edit.invitees"), icon: "people", onPress: open("invitees") });
  }
  if (alarms.length || alertsShown) {
    const slots = editor.canAddSecondAlert ? Math.max(2, alarms.length) : Math.max(1, alarms.length);
    afterPlace.push({
      id: "alert",
      icon: "bell",
      items: Array.from({ length: slots }, (_, index) => {
        const minutes = alarms[index];
        return {
          kind: "slot",
          label: t(index ? "edit.anotherAlert" : "edit.alert"),
          value:
            minutes === undefined
              ? t(index ? "edit.anotherAlert" : "edit.noAlert")
              : t("edit.alertMinutes", { minutes }),
          state: minutes === undefined ? "none" : undefined,
          disabled:
            !editor.canAddAlert || (index > 0 && (!editor.canAddSecondAlert || alarms.length < index)),
          expanded: picker?.kind === "alert" && picker.index === index,
          onPress: open("alert", index),
        };
      }),
    });
  } else if (editor.canAddAlert) {
    adds.push({ id: "alert", word: t("edit.alert"), icon: "bell", onPress: () => showAlerts(true) });
  }

  const menu =
    picker?.kind === "invitees" ? (
      <InviteePicker anchor={picker.anchor} guests={guests} change={change} close={close} />
    ) : (
      picker && <EditorPicker picker={picker} guests={guests} alarms={alarms} change={change} close={close} />
    );
  return { beforePlace, afterPlace, adds, menu };
}

function InviteePicker({
  anchor,
  guests,
  change,
  close,
}: {
  anchor: HTMLElement;
  guests: readonly CalendarInvitee[];
  change: Change;
  close: () => void;
}) {
  const { host } = useFrame();
  const own = useOwnAddresses();
  const t = useText("calendar");
  const [typed, type] = useState("");
  const exclude = [...own, ...guests.map((guest) => guest.address)].map((address) => address.toLowerCase());
  const found = calendarInviteeSuggestions(host.engine.read(), typed, exclude);
  const parsed = parseRecipients(typed);
  const typedOne =
    parsed.addresses.length === 1 && parsed.invalid.length === 0 ? parsed.addresses[0] : undefined;
  function add(person: { address: string; name: string | null }) {
    if (exclude.includes(person.address.toLowerCase())) return;
    change({ invitees: [...guests, { ...person, role: "required", answer: "none" }] });
    close();
  }
  return (
    <Menu
      open
      anchor={anchor}
      kind="card"
      label={t("edit.addInvitees")}
      onClose={close}
      onKey={(event) => {
        if (
          event.key !== "Enter" ||
          event.nativeEvent.isComposing ||
          !(event.target instanceof HTMLInputElement)
        )
          return false;
        event.preventDefault();
        if (typedOne) add(typedOne);
        return true;
      }}
    >
      <Field label={t("edit.inviteeAddress")} value={typed} onChange={type} bare sign="search" />
      {found.map((person) => (
        <MenuItem key={person.address} onPress={() => add(person)}>
          {person.name || person.address}
        </MenuItem>
      ))}
      <Button
        kind="two"
        size="s"
        disabled={!typedOne || exclude.includes(typedOne.address.toLowerCase())}
        onPress={() => typedOne && add(typedOne)}
      >
        {t("edit.addPerson")}
      </Button>
    </Menu>
  );
}

function EditorPicker({
  picker,
  guests,
  alarms,
  change,
  close,
}: {
  picker: Picker;
  guests: readonly CalendarInvitee[];
  alarms: readonly number[];
  change: Change;
  close: () => void;
}) {
  const t = useText("calendar");
  const index = picker.index;
  if (picker.kind === "role") {
    return (
      <Menu open anchor={picker.anchor} label={t("edit.invitees")} onClose={close}>
        {(["required", "optional"] as const).map((role) => (
          <MenuItem
            key={role}
            checked={guests[index]?.role === role}
            onPress={() => {
              change({ invitees: guests.map((guest, i) => (i === index ? { ...guest, role } : guest)) });
              close();
            }}
          >
            {t(`edit.${role}`)}
          </MenuItem>
        ))}
      </Menu>
    );
  }
  const pick = (minutes: number | null) => {
    const next = [...alarms];
    if (minutes === null) next.splice(index, 1);
    else next[index] = minutes;
    change({ alarms: next });
    close();
  };
  return (
    <Menu open anchor={picker.anchor} label={t(index ? "edit.anotherAlert" : "edit.alert")} onClose={close}>
      <MenuItem checked={alarms[index] === undefined} onPress={() => pick(null)}>
        {t("edit.noAlert")}
      </MenuItem>
      {[...new Set([...REMINDERS, ...alarms])]
        .filter((minutes) => !alarms.includes(minutes) || alarms[index] === minutes)
        .map((minutes) => (
          <MenuItem key={minutes} checked={alarms[index] === minutes} onPress={() => pick(minutes)}>
            {t("edit.alertMinutes", { minutes })}
          </MenuItem>
        ))}
    </Menu>
  );
}
