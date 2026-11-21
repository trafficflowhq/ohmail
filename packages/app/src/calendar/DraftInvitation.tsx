import { useState } from "react";
import { Button, Dialog } from "@ohmail/ui/base";
import type { CalendarGuest } from "../frame/commands.js";
import { useLocale, useText } from "../text/index.js";
import type { EventDraft } from "./event-draft.js";

export function useDraftInvitation(suggestions: readonly CalendarGuest[]) {
  const [guests] = useState(() => suggestions);
  const [selected, setSelected] = useState<readonly CalendarGuest[]>([]);
  const select = (guest: CalendarGuest) =>
    setSelected((current) =>
      current.includes(guest) ? current.filter((item) => item !== guest) : [...current, guest],
    );
  return { guests, selected, select };
}

export function DraftInvitation({
  invitation: { guests, selected, select },
}: {
  invitation: ReturnType<typeof useDraftInvitation>;
}) {
  const t = useText("calmail");
  return (
    <>
      {guests.map((guest) => {
        const name = guest.name || guest.address;
        return selected.includes(guest) ? (
          <p key={guest.address}>
            {t("guest", { name })}
            <Button kind="quiet" size="s" icon="x" label={t("removeGuest")} onPress={() => select(guest)} />
          </p>
        ) : (
          <Button key={guest.address} kind="two" size="s" onPress={() => select(guest)}>
            {t("inviteGuest", { name })}
          </Button>
        );
      })}
    </>
  );
}

export function useGuestConfirmation(
  draft: EventDraft,
  selected: readonly CalendarGuest[],
  canAdd: () => boolean,
  create: (draft: EventDraft) => void,
) {
  const t = useText("calendar");
  const mail = useText("calmail");
  const locale = useLocale();
  const [confirm, setConfirm] = useState<EventDraft["invitees"]>(undefined);
  const guestsByAddress = new Map(
    (draft.invitees ?? []).map((guest) => [guest.address.toLowerCase(), guest]),
  );
  for (const guest of selected) {
    if (!guestsByAddress.has(guest.address.toLowerCase())) {
      guestsByAddress.set(guest.address.toLowerCase(), { ...guest, role: "required", answer: "none" });
    }
  }
  const guests = [...guestsByAddress.values()];
  const fromLetter = selected.length > 0;
  const names = new Intl.ListFormat(locale).format(
    (confirm ?? []).map((guest) => guest.name || guest.address),
  );
  const add = () => {
    if (!canAdd()) return;
    if (guests.length > 0) setConfirm(guests);
    else create(draft);
  };
  const close = () => setConfirm(undefined);
  const confirmation = confirm && (
    <Dialog
      open
      product="cal"
      title={
        fromLetter
          ? mail(confirm.length > 1 ? "confirmGuests" : "confirmGuest", { name: names })
          : t("edit.confirmInvite", { guests: names })
      }
      keysOn="cancel"
      onClose={close}
      cancel={{ label: fromLetter ? mail("cancelGuest") : t("edit.cancel") }}
      confirm={{
        label: fromLetter ? mail(confirm.length > 1 ? "sendGuests" : "sendGuest") : t("edit.invite"),
        onPress: () => {
          close();
          create({ ...draft, invitees: confirm });
        },
      }}
    >
      {fromLetter ? null : t("edit.inviteFollows", { title: draft.title.trim() })}
    </Dialog>
  );
  return { add, confirmation };
}
