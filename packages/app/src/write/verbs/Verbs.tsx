/**
 * THE LETTER'S VERBS at the sheet's foot: Send (the ink), Send later and Discard. A reply's are Send and Discard, shown
 * by the reading sheet's one panel (`ReaderReply.useVerbs`). Send presses the composition's send, which
 * alone decides whether the letter may go; a send on its way or a letter Send may not take leaves it resting.
 * Discard asks nothing and goes, with its Undo.
 */
import { ActionPanel, type PanelVerb } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";

export function Verbs({
  canSend,
  going,
  onSend,
  later,
  onDiscard,
}: {
  canSend: boolean;
  going: boolean;
  onSend: () => void;
  /** Send later: a verb of its own, pressed while its card is open. */
  later: { open: boolean; onPress: () => void };
  onDiscard: () => void;
}) {
  const t = useText("write");
  const send = sendVerb(t("send"), canSend, going, onSend);
  const items: PanelVerb[] = [
    send,
    {
      id: "later",
      label: t("later.verb"),
      icon: "clock",
      pressed: later.open,
      disabled: send.disabled,
      onPress: later.onPress,
    },
    discardVerb(t("discard"), going, onDiscard),
  ];
  return <ActionPanel label={t("verbs")} items={items} />;
}

/** Send, the ink: it rests while the composition's gate refuses the letter or a send is on its way. */
export function sendVerb(label: string, canSend: boolean, going: boolean, onPress: () => void): PanelVerb {
  return { id: "send", label, icon: "send", kind: "ink", disabled: !canSend || going, onPress };
}

/** Discard: asks nothing, with its Undo; never while the letter goes. */
export function discardVerb(label: string, going: boolean, onPress: () => void): PanelVerb {
  return { id: "discard", label, icon: "trash", disabled: going, onPress };
}
