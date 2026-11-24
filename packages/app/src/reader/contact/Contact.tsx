/**
 * THE CONTACT CARD: who someone is, their whole address (it wraps and is never cut), and what today's card offered
 * with them: Copy the address (its stored form) where the host hands the reader a clipboard, everything from and to them
 * where the host mounts the address place, and a letter to them. Its data is the letter's own, read off the mounted
 * engine: no wire, no read, no picture of a person. The reader may also hand it the screening controls.
 */
import { useCallback, useState, type ReactNode } from "react";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { formatRecipientLine } from "@ohmail/app-logic/writing/compose-from";
import { MenuItem } from "@ohmail/ui/base";
import { ContactCard, type ContactCardProps } from "@ohmail/ui/mail";
import { useFrame } from "../../frame/commands.js";
import { NONE } from "../../host/index.js";
import { ContactEvents, ContactNewEvent } from "../../calmail/contact.js";
import { useText } from "../../text/index.js";

export interface ContactOf {
  readonly name: string;
  readonly address: string;
  readonly displayName?: string | null;
  readonly messageId?: string;
  readonly onSender?: boolean;
  readonly direct?: boolean;
  readonly anchor: HTMLElement;
  readonly cardId?: string;
  /** Which name in which head opened it (`<letter> from`, `<letter> to <n>`): that name says its card is open. */
  readonly slot: string;
}

/**
 * The card that stands open, and the press on a name: a press on the name whose card stands open closes it, any other
 * name opens its own. The third member closes it.
 */
export function useOpenCard(): readonly [ContactOf | null, (next: ContactOf) => void, () => void] {
  const [open, setOpen] = useState<ContactOf | null>(null);
  const press = useCallback(
    (next: ContactOf) => setOpen((now) => (now?.slot === next.slot ? null : next)),
    [],
  );
  const close = useCallback(() => setOpen(null), []);
  return [open, press, close] as const;
}

export interface ContactScreeningProps {
  readonly person: ContactOf;
  readonly direct?: boolean;
  readonly onClose: () => void;
  readonly children: (subjectRule?: ReactNode, card?: ContactCardProps, showAddress?: boolean) => ReactNode;
}

type ContactProps = { person: ContactOf | null; onClose: () => void };

export function ContactDetails({
  person,
  onClose,
  clipboard,
  screening,
  subjectRule,
  organizerNote,
  card,
  showAddress = true,
}: ContactProps & {
  clipboard: "none" | ((text: string) => Promise<boolean>);
  screening?: Pick<ContactCardProps, "scope" | "now" | "goes" | "rules" | "switches">;
  subjectRule?: ReactNode;
  organizerNote?: string;
  card?: ContactCardProps;
  showAddress?: boolean;
}) {
  const t = useText("message");
  const { host, commands } = useFrame();
  if (person === null) return null;
  const copy =
    clipboard === "none"
      ? undefined
      : {
          label: t("copyAddress"),
          onPress: () => {
            /* The stored form: a decoded domain pasted into another client resolves nowhere. A refused write
               closes the card as a taken one does: nothing is left waiting on it. */
            void clipboard(person.address).catch(() => false);
            onClose();
          },
        };
  return (
    <ContactCard
      open
      onClose={onClose}
      label={t("contactAria", { who: person.name })}
      person={{ name: person.name, address: displayAddress(person.address) }}
      {...screening}
      {...card}
      anchor={person.anchor}
      id={person.cardId}
      copy={copy}
      more={
        <>
          {card?.more}
          <ContactEvents person={person} onClose={onClose} />
        </>
      }
    >
      {host.features.places.write === NONE ? null : (
        <MenuItem
          icon="write"
          onPress={() => {
            const recipient = formatRecipientLine([
              { name: person.displayName ?? null, address: person.address },
            ]);
            onClose();
            commands.write({ to: [recipient], cc: [], bcc: [], subject: "", body: "" });
          }}
        >
          {t("write")}
        </MenuItem>
      )}
      <ContactNewEvent person={person} onClose={onClose} />
      {showAddress && host.features.places.address !== NONE ? (
        <MenuItem
          icon="go"
          onPress={() => {
            onClose();
            commands.go({ place: "address", sub: person.address });
          }}
        >
          {card ? t("contactAllMail") : t("addressOpen")}
        </MenuItem>
      ) : null}
      {subjectRule}
      {organizerNote ? <p>{organizerNote}</p> : null}
    </ContactCard>
  );
}
