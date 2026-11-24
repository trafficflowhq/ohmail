import { useContext } from "react";
import type { EngineMessage } from "@ohmail/wire";
import { FrameContext } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useOwnAddresses } from "../frame/room.js";
import { useOpenCard } from "../reader/contact/Contact.js";
import { Contact } from "../reader/contact/Screening.js";
import { useText } from "../text/index.js";

export function useRowContact() {
  const [person, show, close] = useOpenCard();
  const t = useText("message");
  const reader = useContext(FrameContext)?.api.host.features.reader;
  const own = useOwnAddresses();
  const screen = (m: EngineMessage) => {
    const { address, name } = m.from;
    if (
      !address ||
      !reader ||
      reader === NONE ||
      !reader.Screening ||
      own.some((mine) => mine.toLowerCase() === address.toLowerCase())
    )
      return undefined;
    return (anchor: HTMLElement) =>
      show({
        name: name || address,
        address,
        displayName: name,
        messageId: m.id,
        slot: `${m.id} from`,
        anchor,
        onSender: true,
        direct: true,
      });
  };
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
  return {
    rowProps,
    screen,
    card: person?.anchor.isConnected ? <Contact person={person} onClose={close} /> : null,
  };
}

export type RowContact = ReturnType<typeof useRowContact>;
