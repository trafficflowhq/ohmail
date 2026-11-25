import { Fragment } from "react";
import { Menu, MenuItem, MenuRule, type IconName, type Point } from "@ohmail/ui/base";
import { useText } from "../text/index.js";

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

export interface MenuTarget {
  at: Point | Element;
  anchor: HTMLElement;
}

export type ContextItem = ListMenuItem & { keepOpen?: boolean };

export function MailRowMenu({
  target,
  items,
  onClose,
  label,
}: {
  target: MenuTarget;
  items: readonly ContextItem[];
  onClose: () => void;
  label?: string;
}) {
  const t = useText("ohbox");
  return (
    <Menu
      open
      onClose={onClose}
      anchor={target.at}
      returnFocus={target.anchor}
      kind="context"
      label={label ?? t("row.menu")}
    >
      {items.map(({ apart, keepOpen, onPress, spoken, label, ...item }, index) => (
        <Fragment key={index}>
          {index > 0 && apart ? <MenuRule /> : null}
          <MenuItem
            {...item}
            label={spoken}
            onPress={() => {
              if (!keepOpen) onClose();
              onPress();
            }}
          >
            {label}
          </MenuItem>
        </Fragment>
      ))}
    </Menu>
  );
}
