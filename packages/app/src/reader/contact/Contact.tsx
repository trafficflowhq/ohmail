/**
 * THE CONTACT CARD: who someone is, their whole address (it wraps and is never cut), and what today's card offered
 * with them: Copy the address (its stored form) where the host hands the reader a clipboard, everything from and to them
 * where the host mounts the address place, and a letter to them. Its data is the letter's own, read off the mounted
 * engine: no wire, no read, no picture of a person. Where their mail goes is the Screener's to add.
 */
import { useCallback, useState } from "react";
import { MenuItem } from "@ohmail/ui/base";
import { ContactCard } from "@ohmail/ui/mail";
import { useFrame } from "../../frame/commands.js";
import { NONE } from "../../host/index.js";
import { useText } from "../../text/index.js";
import { useParts } from "../parts.js";

export interface ContactOf {
  readonly name: string;
  readonly address: string;
  readonly anchor: HTMLElement;
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

export function Contact({ person, onClose }: { person: ContactOf | null; onClose: () => void }) {
  const t = useText("message");
  const { host, commands } = useFrame();
  const clipboard = useParts().copy ?? "none";
  if (person === null) return null;
  const copy =
    clipboard === "none"
      ? undefined
      : {
          label: t("copyAddress"),
          onPress: () => {
            /* The stored form: a decoded domain pasted into another client resolves nowhere. A refused write
               closes the card as a taken one does: nothing is left waiting on it. */
            void clipboard(person.address);
            onClose();
          },
        };
  return (
    <ContactCard
      open
      onClose={onClose}
      anchor={person.anchor}
      label={t("contactAria", { who: person.name })}
      person={{ name: person.name, address: person.address }}
      {...(copy ? { copy } : {})}
    >
      {host.features.places.address === NONE ? null : (
        <MenuItem
          icon="search"
          onPress={() => {
            onClose();
            commands.go({ place: "address", sub: person.address });
          }}
        >
          {t("addressOpen")}
        </MenuItem>
      )}
      <MenuItem
        icon="write"
        onPress={() => {
          onClose();
          commands.write({ to: [person.address], cc: [], bcc: [], subject: "", body: "" });
        }}
      >
        {t("write")}
      </MenuItem>
    </ContactCard>
  );
}
