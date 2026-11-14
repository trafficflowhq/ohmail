/**
 * WHO THE LETTER GOES FROM, in the people's first line: a word to choose by when there is a choice (the sendable
 * mailboxes alone; the value is a mailbox id, never an address), the address as plain words when there is one,
 * and nothing when no mailbox can be named (a From line is a claim). Said in place: a sender switched to match the
 * recipient's domain, and a draft's own mailbox that cannot send, with the one it goes from instead.
 */
import { useRef, useState } from "react";
import { Menu, MenuItem, Slot } from "@ohmail/ui/base";
import type { RecipientsProps } from "@ohmail/ui/mail";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { useText } from "../../text/index.js";
import type { WriteFrom } from "../ports.js";

export function useFromLine(
  from: WriteFrom,
  locked: boolean,
  onPick: (mailboxId: string) => void,
): RecipientsProps["from"] {
  const t = useText("write");
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  if (from.address === null) return undefined;
  const state = from.domainMatched
    ? t("from.matched")
    : from.substituted && from.substitutedFrom !== null
      ? t("from.substituted", { was: displayAddress(from.substitutedFrom) })
      : undefined;
  const shown = displayAddress(from.address);
  const value =
    from.choices.length > 1 ? (
      <>
        <Slot
          ref={anchor}
          label={t("from.choose", { address: shown })}
          expanded={open}
          onPress={locked ? undefined : () => setOpen(true)}
        >
          {shown}
        </Slot>
        <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} label={t("from.label")}>
          {from.choices.map((o) => (
            <MenuItem
              key={o.id}
              checked={o.id === from.mailboxId}
              onPress={() => {
                setOpen(false);
                if (o.id !== from.mailboxId) onPick(o.id);
              }}
            >
              {displayAddress(o.address)}
            </MenuItem>
          ))}
        </Menu>
      </>
    ) : (
      shown
    );
  return { label: t("from.label"), value, ...(state !== undefined ? { state } : {}) };
}
