/**
 * A LIST PLACE'S MENU: the list's own verbs behind one quiet button at the head's end, as every place's head has it.
 * Pull new mail comes first where the frame holds one (the rail's one pull, as the host hands it); then the place's
 * own verbs (Mark all read on a stream, Rename and Delete on a tag). With nothing to offer, no button stands.
 */
import { useContext, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { Button, Menu, MenuItem, MenuRule, type IconName } from "@ohmail/ui/base";
import { useLastMailCheck } from "@ohmail/app-logic/mail-state/mail-state-binding";
import { usePull } from "@ohmail/app-logic/session/pull-new-mail";
import { clockOf } from "@ohmail/app-logic/text/format";
import { FrameContext } from "../frame/commands.js";
import type { RailModel } from "../frame/contract.js";
import { useText, useTimeZone } from "../text/index.js";

export interface ListMenuItem {
  readonly label: string;
  readonly spoken?: string;
  readonly icon?: IconName;
  /** A note at the right: how many. */
  readonly note?: string;
  readonly keyHint?: string;
  readonly disabled?: boolean;
  /** A rule stands above it: a group of its own (a tag's verbs under the pull). */
  readonly apart?: boolean;
  readonly onPress: () => void;
}

const NO_RAIL = { read: (): RailModel | null => null, subscribe: (_told: () => void) => () => {} };

/** The frame's one pull, as the host's rail model holds it; null outside a frame or where the host has none. */
export function useFramePull(): RailModel["pull"] {
  const rail = useContext(FrameContext)?.rail ?? NO_RAIL;
  return useSyncExternalStore(rail.subscribe, rail.read, rail.read)?.pull ?? null;
}

export function ListMenu({
  label,
  items = [],
  mail = false,
  anchorRef,
  size,
}: {
  label: string;
  size?: "s";
  items?: readonly ListMenuItem[];
  /** Use the mail ground's pull in registered places that offer it. */
  mail?: boolean;
  /** The button, handed out: a question one of its verbs asks stands where the menu stood. */
  anchorRef?: RefObject<HTMLButtonElement | null>;
}) {
  const railPull = useFramePull();
  const frame = useContext(FrameContext)?.api;
  const groundPull = usePull();
  const t = useText("ohbox");
  const ts = useText("sync");
  const mailbox = groundPull?.result?.mailboxId;
  const pull =
    railPull ??
    (mail && groundPull
      ? {
          label: groundPull.result ? ts(groundPull.result.key) : t("list.pull"),
          keyHint: "p",
          busy: groundPull.pulling,
          onPress:
            mailbox && frame
              ? () => frame.commands.go({ place: "settings", sub: "mailboxes", words: { mailbox } })
              : groundPull.pull,
        }
      : null);
  const [open, setOpen] = useState(false);
  const checked = useLastMailCheckLabel(open && pull !== null);
  const own = useRef<HTMLButtonElement>(null);
  const anchor = anchorRef ?? own;
  const all: ListMenuItem[] = [
    ...(pull
      ? [
          {
            label: pull.label,
            icon: "pull" as const,
            keyHint: mail ? pull.keyHint : undefined,
            disabled: pull.busy,
            onPress: pull.onPress,
          },
        ]
      : []),
    ...items,
  ];
  if (all.length === 0) return null;
  return (
    <>
      <Button
        ref={anchor}
        kind="quiet"
        size={size}
        icon="more"
        label={label}
        opens="menu"
        expanded={open}
        onPress={() => setOpen((was) => !was)}
      />
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        anchored={mail}
        right
        label={label}
        title={checked}
      >
        {all.map((item, index) => (
          <MenuGroup key={index} rule={index > 0 && item.apart === true}>
            <MenuItem
              label={item.spoken}
              icon={item.icon}
              note={item.note}
              keyHint={item.keyHint}
              disabled={item.disabled}
              onPress={() => {
                setOpen(false);
                item.onPress();
              }}
            >
              {item.label}
            </MenuItem>
          </MenuGroup>
        ))}
      </Menu>
    </>
  );
}

function MenuGroup({ rule, children }: { rule: boolean; children: ReactNode }) {
  return (
    <>
      {rule ? <MenuRule /> : null}
      {children}
    </>
  );
}

export function useLastMailCheckLabel(shown: boolean): string | undefined {
  const checked = useLastMailCheck();
  const t = useText("ohbox");
  const timeZone = useTimeZone();
  if (!shown || checked === null) return undefined;
  const when = clockOf(checked, timeZone);
  return t("list.checked", { when });
}
