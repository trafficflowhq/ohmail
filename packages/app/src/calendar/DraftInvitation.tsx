import { useState, type RefObject } from "react";
import { Button } from "@ohmail/ui/base";
import { QuestionBeforeAct } from "@ohmail/ui/calendar";
import { draftWhen, guestNames } from "./event-words.js";
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
  anchor: RefObject<HTMLDivElement | null>,
  draft: EventDraft,
  selected: readonly CalendarGuest[],
  canAdd: () => boolean,
  create: (draft: EventDraft) => void,
  iCloud: boolean,
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
  const names = guestNames(
    (confirm ?? []).map((guest) => guest.name || guest.address),
    locale,
    t,
  );
  const add = () => {
    if (!canAdd()) return;
    if (guests.length > 0) setConfirm(guests);
    else create(draft);
  };
  const close = () => setConfirm(undefined);
  const confirmation = confirm && guests.length > 0 && (
    <QuestionBeforeAct
      open
      anchor={anchor}
      question={
        fromLetter
          ? mail(confirm.length > 1 ? "confirmGuests" : "confirmGuest", { name: names })
          : t("edit.confirmInvite", { guests: names })
      }
      follows={
        iCloud
          ? t("edit.iCloudSends")
          : fromLetter
            ? undefined
            : t("edit.inviteFollows", { title: draft.title.trim(), when: draftWhen(draft, locale) })
      }
      focusCancel
      onClose={close}
      cancel={fromLetter ? mail("cancelGuest") : t("edit.cancel")}
      answers={[
        {
          id: "send",
          label: iCloud
            ? t("edit.saveAndInvite")
            : fromLetter
              ? mail(confirm.length > 1 ? "sendGuests" : "sendGuest")
              : t("edit.sendInvitation", { count: confirm.length }),
          keyHint: "↵",
          onPress: () => {
            close();
            if (canAdd()) create({ ...draft, invitees: confirm });
          },
        },
      ]}
    />
  );
  return { add, confirmation };
}
