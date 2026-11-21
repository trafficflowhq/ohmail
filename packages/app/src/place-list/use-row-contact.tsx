import { useOpenCard } from "../reader/contact/Contact.js";
import { Contact } from "../reader/contact/Screening.js";
import { useText } from "../text/index.js";

export function useRowContact() {
  const [person, show, close] = useOpenCard();
  const t = useText("message");
  const rowProps = (from: { address: string; name?: string | null }, id: string) => {
    if (!from.address) return {};
    const name = from.name || from.address;
    const onPress = (anchor: HTMLElement) =>
      show({
        name,
        address: from.address,
        displayName: from.name,
        messageId: id,
        slot: `${id} from`,
        anchor,
      });
    return { nameAction: { label: t("contactAria", { who: name }), onPress }, addressAction: onPress };
  };
  return { rowProps, card: person?.anchor.isConnected ? <Contact person={person} onClose={close} /> : null };
}

export type RowContact = ReturnType<typeof useRowContact>;
