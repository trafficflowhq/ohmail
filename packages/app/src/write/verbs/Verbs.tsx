/**
 * THE LETTER'S VERBS at the sheet's foot: Send (the ink), Send later and Discard. A reply's are Send, Send + Done where
 * the letter it answers has something to finish, and Discard, shown by the reading sheet's one panel
 * (`ReaderReply.useVerbs`). Send presses the composition's send, which
 * alone decides whether the letter may go; a send on its way or a letter Send may not take leaves it resting.
 * Discard asks nothing and goes, with its Undo; while a send only waits (queued, not on the wire) Discard stays
 * pressable and takes the send back first: its press is the composition's own, which asks the send machine's withdraw.
 */
import { useState } from "react";
import { Menu, MenuItem } from "@ohmail/ui/base";
import { ActionPanel, type PanelVerb } from "@ohmail/ui/mail";
import { useModGlyph } from "@ohmail/app-logic/keys";
import { SEND_IN_FLIGHT_PHASES, type SendPhase, type SendState } from "@ohmail/app-logic/writing/mail-send";
import { useText } from "../../text/index.js";
import { SEND_KEY, writingKey } from "../keys.js";
import { useShortcutsMenu } from "../../keys/ShortcutsMenuItem.js";
import "./verb-style.css";

export function Verbs({
  canSend,
  compact = false,
  forward = false,
  going,
  keysHere,
  discardHeld,
  resting = false,
  said = NOTHING_SAID,
  onSend,
  later,
  discardReason,
  onDiscard,
}: {
  canSend: boolean;
  compact?: boolean;
  forward?: boolean;
  going: boolean;
  keysHere?: boolean;
  discardHeld: boolean;
  /** Send may not take the letter, and its press says why (too long to send): dimmed, still pressable. */
  resting?: boolean;
  /** Send refused for want of content (pressable, its hint the reason), and Send at work. */
  said?: SendSaid;
  onSend: () => void;
  /** Send later: a verb of its own, pressed while its card is open. */
  later: { open: boolean; onPress: (at: HTMLElement) => void };
  discardReason?: string | null;
  onDiscard: () => void;
}) {
  const t = useText("write");
  const mod = useModGlyph();
  const more = useText("frame")("dock.more");
  const [menu, setMenu] = useState<{ anchor: HTMLElement; ids: readonly string[] } | null>(null);
  const [folded, setFolded] = useState<readonly string[]>([]);
  const close = () => setMenu(null);
  const shortcuts = useShortcutsMenu(close);
  const send = sendVerb(t("send"), canSend, going, onSend, resting, said);
  const items: PanelVerb[] = [
    keysHere ? { ...send, ...writingKey(SEND_KEY, mod), shortcutWhileWriting: true } : send,
    {
      id: "later",
      label: t("later.verb"),
      icon: "clock",
      wordFirst: true,
      pressed: later.open,
      /* A letter that may not be sent now may not be scheduled either: Later is off while Send rests. */
      disabled: !canSend || going || forward,
      onPress: later.onPress,
    },
    { ...discardVerb(t("discard"), discardHeld, onDiscard, discardReason), rank: 0 },
  ];
  const overflow = compact ? items.slice(1).map(({ id }) => id) : folded;
  return (
    <div className="write-verbs">
      {discardReason && !compact ? <p className="oh-text write-discard-reason">{discardReason}</p> : null}
      <ActionPanel
        label={t("verbs")}
        items={compact ? items.slice(0, 1) : items}
        folded={folded}
        onFold={setFolded}
        more={{
          label: more,
          behind: compact || menu !== null,
          expanded: menu !== null,
          onPress: (anchor) => setMenu({ anchor, ids: overflow }),
        }}
      />
      {menu ? (
        <Menu
          open
          portal
          anchor={menu.anchor}
          label={more}
          onClose={close}
          onKey={shortcuts.onKey}
          anchored
          up
          right
        >
          {items
            .filter(({ id }) => menu.ids.includes(id))
            .map((item) => (
              <MenuItem
                key={item.id}
                icon={item.icon}
                disabled={item.disabled}
                onPress={() => {
                  close();
                  item.onPress?.(menu.anchor);
                }}
              >
                {item.name ?? item.label}
              </MenuItem>
            ))}
          {shortcuts.item}
        </Menu>
      ) : null}
    </div>
  );
}

/**
 * What Send says beside its gate: `refused`, the reason a letter with nothing to send is refused (Send stays pressable,
 * said as off, its hint the reason, its press told in place); `busy`, the letter going out now.
 */
export interface SendSaid {
  readonly refused?: string;
  readonly busy?: boolean;
}

const NOTHING_SAID: SendSaid = {};

/**
 * Send, the ink: off while the composition's gate refuses the letter or a send is on its way; where the refusal is
 * one its press says in words (`resting`: too long to send; `said.refused`: nothing to send), pressable, the press
 * refused in place.
 */
export function sendVerb(
  label: string,
  canSend: boolean,
  going: boolean,
  onPress: () => void,
  resting = false,
  said: SendSaid = NOTHING_SAID,
): PanelVerb {
  return {
    id: "send",
    label,
    icon: "send",
    kind: "ink",
    rank: 0,
    ...gate(canSend, going, resting, said),
    onPress,
  };
}

function gate(
  canSend: boolean,
  going: boolean,
  resting: boolean,
  said: SendSaid,
): Pick<PanelVerb, "disabled" | "resting" | "refused" | "busy"> {
  const busy = said.busy === true ? { busy: true } : {};
  if (going || (!canSend && !resting && said.refused === undefined)) return { disabled: true, ...busy };
  if (canSend) return { disabled: false, ...busy };
  return resting ? { disabled: false, resting: true } : { disabled: false, refused: said.refused };
}

/**
 * Send + Done, the reply's second send: the same send with the letter it answers filed once the send is confirmed.
 * It wears Send's lock (a reply that may not go may not go and be filed either).
 */
export function sendAndDoneVerb(
  label: string,
  canSend: boolean,
  going: boolean,
  onPress: () => void,
  resting = false,
  said: SendSaid = NOTHING_SAID,
): PanelVerb {
  return { id: "send_done", label, icon: "check", ...gate(canSend, going, resting, said), onPress };
}

/** Discard: asks nothing, with its Undo; `held` while a send is on its way (one that only waits is not held). */
export function discardVerb(
  label: string,
  held: boolean,
  onPress: () => void,
  reason?: string | null,
): PanelVerb {
  return {
    id: "discard",
    label,
    icon: "trash",
    disabled: held,
    onPress,
    ...(reason ? { name: `${label}. ${reason}` } : {}),
  };
}

/** A send that waits (queued, not on the wire yet): the one a Discard may take back, by the send machine's withdraw. */
export function sendWaits(phase: SendPhase): boolean {
  return phase === "queued";
}

export function letterGoing(send: SendState): boolean {
  return send.previous !== true && SEND_IN_FLIGHT_PHASES.has(send.phase);
}

export function letterDiscardHeld(send: SendState): boolean {
  return letterGoing(send) && !sendWaits(send.phase);
}
