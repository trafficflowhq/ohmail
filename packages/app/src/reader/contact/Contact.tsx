/**
 * THE CONTACT CARD: who someone is, their whole address (it wraps and is never cut), and a letter to them. A copy
 * of the address waits for the host's clipboard door. Its data is the letter's own, read off the mounted engine: no wire, no read, no picture of a person.
 */
import { MenuItem } from "@ohmail/ui/base";
import { ContactCard } from "@ohmail/ui/mail";
import { useFrame } from "../../frame/commands.js";
import { useText } from "../../text/index.js";

export interface ContactOf {
  readonly name: string;
  readonly address: string;
  readonly anchor: HTMLElement;
}

export function Contact({ person, onClose }: { person: ContactOf | null; onClose: () => void }) {
  const t = useText("message");
  const { commands } = useFrame();
  if (person === null) return null;
  return (
    <ContactCard
      open
      onClose={onClose}
      anchor={person.anchor}
      label={t("contactAria", { who: person.name })}
      person={{ name: person.name, address: person.address }}
    >
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
