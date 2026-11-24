import { useRef, useState, type MouseEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { calendarInviteeSuggestions } from "@ohmail/app-logic/calendar";
import { parseRecipients } from "@ohmail/app-logic/writing/compose";
import type { CalendarInvitee } from "@ohmail/wire";
import { Avatar, Field, Menu, MenuItem } from "@ohmail/ui/base";
import type { EventFormProps, EventFormRow } from "@ohmail/ui/calendar";
import { useFrame } from "../frame/commands.js";
import { useOwnAddresses } from "../frame/room.js";
import { useText, type Text } from "../text/index.js";
import type { EventDraft } from "./event-draft.js";

export interface EditorRows {
  readonly canInvite: boolean;
  readonly canAddAlert: boolean;
  readonly canAddSecondAlert: boolean;
  readonly showCall: boolean;
  readonly inviteesAbove?: RefObject<HTMLElement | null>;
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
  const call = draft.callLink;
  if (editor.showCall && call != null) {
    beforePlace.push(callRow(call, change, t));
  } else if (editor.showCall) {
    adds.push({
      id: "call",
      word: t("call.label"),
      label: t("call.video"),
      icon: "video",
      onPress: () => change({ callLink: "" }),
    });
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
      <InviteePicker
        anchor={picker.anchor}
        guests={guests}
        change={change}
        close={close}
        above={editor.inviteesAbove}
      />
    ) : (
      picker && <EditorPicker picker={picker} guests={guests} alarms={alarms} change={change} close={close} />
    );
  return { beforePlace, afterPlace, adds, menu };
}

function callRow(call: string, change: Change, t: Text): EventFormRow {
  return {
    id: "call",
    icon: "video",
    items: [
      {
        kind: "text",
        label: t("call.link"),
        placeholder: t("call.paste"),
        value: call,
        onChange: (callLink) => change({ callLink }),
      },
      { kind: "remove", label: t("call.remove"), onPress: () => change({ callLink: null }) },
    ],
  };
}

function InviteePicker({
  anchor,
  guests,
  change,
  close,
  above,
}: {
  anchor: HTMLElement;
  guests: readonly CalendarInvitee[];
  change: Change;
  close: () => void;
  above?: RefObject<HTMLElement | null>;
}) {
  const { host, plan } = useFrame();
  const own = useOwnAddresses();
  const t = useText("calendar");
  const [typed, type] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const exclude = [...own, ...guests.map((guest) => guest.address)].map((address) =>
    address.trim().toLowerCase(),
  );
  const parsed = parseRecipients(typed);
  const typedOne =
    parsed.addresses.length === 1 && parsed.invalid.length === 0 ? parsed.addresses[0] : undefined;
  const found = calendarInviteeSuggestions(host.engine.read(), typedOne?.address ?? typed, exclude);
  const address = typedOne?.address.toLowerCase();
  const known = address ? found.find((person) => person.address.toLowerCase() === address) : undefined;
  const offered = address && !exclude.includes(address) && !known ? typedOne : undefined;
  const label = t("edit.inviteeAddress");
  const card = plan.device === "phone" ? null : above?.current;
  function add({ address, name }: { address: string; name: string | null }) {
    if (exclude.includes(address.toLowerCase())) return;
    change({ invitees: [...guests, { address, name: name || null, role: "required", answer: "none" }] });
    close();
  }
  const menu = (
    <Menu
      open
      up
      upFrom={card ?? undefined}
      anchor={anchor}
      kind="picker"
      label={t("edit.addInvitees")}
      onClose={close}
      initialFocus={plan.device === "phone" ? undefined : input}
      fit="beside"
      onKey={(event) => {
        if (event.target !== input.current || event.nativeEvent.isComposing) return false;
        if (event.key === "Home" || event.key === "End") return true;
        if (event.key !== "Enter") return false;
        event.preventDefault();
        /* A typed address takes a name only one its owner or the account gave it; a pick takes the row as shown. */
        const typedKnown = known && { address: known.address, name: known.nameUnchecked ? null : known.name };
        const person = address ? (typedKnown ?? offered) : typed.trim() ? found[0] : undefined;
        if (person) add(person);
        return true;
      }}
    >
      <div className="cal-invitee-search">
        <Field ref={input} label={label} placeholder={label} value={typed} onChange={type} bare />
      </div>
      {found.map((person) => (
        <MenuItem
          key={person.address}
          leading={<Avatar name={person.name} address={person.address} size="s" />}
          note={person.name ? person.address.slice(person.address.lastIndexOf("@") + 1) : undefined}
          onPress={() => add(person)}
        >
          {person.name || person.address}
        </MenuItem>
      ))}
      {offered && (
        <MenuItem
          leading={<Avatar name={offered.name ?? ""} address={offered.address} size="s" />}
          note={offered.name ? offered.address : undefined}
          onPress={() => add(offered)}
        >
          {offered.name || offered.address}
        </MenuItem>
      )}
      {found.length === 0 && !offered && <p className="oh-menu-note">{t("edit.noInviteesFound")}</p>}
    </Menu>
  );
  // Quick Add's arrival animation contains fixed-position descendants. Keep the menu in the wrapper.
  return card?.parentElement ? createPortal(menu, card.parentElement) : menu;
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
        <MenuItem
          checked={guests[index]?.role === "optional"}
          many
          onPress={() => {
            change({
              invitees: guests.map((guest, i) =>
                i !== index
                  ? guest
                  : {
                      ...guest,
                      role: guest.role === "optional" ? "required" : "optional",
                    },
              ),
            });
            close();
          }}
        >
          {t("edit.optionalAction")}
        </MenuItem>
        <MenuItem
          icon="x"
          onPress={() => {
            change({ invitees: guests.filter((_, i) => i !== index) });
            close();
          }}
        >
          {t("edit.remove")}
        </MenuItem>
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
