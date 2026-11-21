/**
 * THE OHBOX'S HEAD: its name with the hot dot while something waits, and its own tools: the Screener's doorbell,
 * Mark all read, and the list's menu with Pull new mail and Mark all read.
 */
import { useRef, useState } from "react";
import type { OhboxListModel } from "@ohmail/app-logic/ohbox";
import { sharedNotOrganizedWhy } from "@ohmail/app-logic/mail-state/mail-state";
import { Button, Menu, MenuItem } from "@ohmail/ui/base";
import { ProductSwitch } from "../frame/ProductSwitch.js";
import { Doorbell, ListHead } from "@ohmail/ui/mail";
import type { FrameNotice, LayoutPlan } from "../frame/contract.js";
import { useNotice } from "../frame/index.js";
import { useLastMailCheckLabel } from "../place-list/ListMenu.js";
import { NONE } from "../host/index.js";
import { useLocale, useText } from "../text/index.js";
import type { OhboxBeside } from "./beside.js";

export function OhboxHead({
  model,
  beside,
  plan,
  onMarkAllRead,
  displayOnly = false,
}: {
  model: OhboxListModel;
  beside: OhboxBeside;
  plan: LayoutPlan;
  displayOnly?: boolean;
  /** Mark every unread letter of the Ohbox read; absent where the shell has no such verb. */
  onMarkAllRead: ((ids: string[]) => void) | null;
}) {
  const t = useText("ohbox");
  const locale = useLocale();
  const all = useText("markAll");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  if (displayOnly && menuOpen) setMenuOpen(false);
  /* The engine's unread letters: Mark all read names them as soon as rows stand, as the shipped head did. The hot
     dot is a claim about the mailbox and waits until the Ohbox may say it. */
  const unread = model.unreadIds.length;
  const pull = beside.pull;
  const checked = useLastMailCheckLabel(menuOpen && pull !== NONE);
  const markAll = onMarkAllRead && unread > 0 ? () => onMarkAllRead(model.unreadIds) : null;
  return (
    <>
      {!displayOnly ? <NotOrganizingNotice beside={beside} /> : null}
      <ListHead
        title={t("title")}
        hot={model.mayState && unread > 0}
        lead={plan.rail === "dock" ? <ProductSwitch kind="round" /> : undefined}
        aside={
          <>
            <OhboxDoor model={model} beside={beside} />
            {markAll !== null && plan.pointer !== "coarse" ? (
              <Button kind="quiet" size="s" onPress={markAll} label={all("aria", { count: unread })}>
                {all("label")}
              </Button>
            ) : null}
            <Button
              ref={menuButton}
              kind="quiet"
              icon="more"
              label={t("list.menu")}
              opens="menu"
              expanded={menuOpen}
              onPress={() => setMenuOpen((open) => !open)}
            />
          </>
        }
      />
      <Menu
        open={!displayOnly && menuOpen}
        onClose={() => setMenuOpen(false)}
        anchor={menuButton}
        right
        label={t("list.menu")}
        title={checked}
      >
        {pull !== NONE ? (
          <MenuItem
            icon="pull"
            keyHint="p"
            disabled={pull.busy}
            onPress={() => {
              setMenuOpen(false);
              pull.run();
            }}
          >
            {t("list.pull")}
          </MenuItem>
        ) : null}
        {onMarkAllRead !== null ? (
          <MenuItem
            icon="read"
            disabled={markAll === null}
            note={model.mayState && unread > 0 ? unread.toLocaleString(locale) : undefined}
            onPress={() => {
              setMenuOpen(false);
              markAll?.();
            }}
          >
            {all("label")}
          </MenuItem>
        ) : null}
      </Menu>
    </>
  );
}

function NotOrganizingNotice({ beside }: { beside: OhboxBeside }): null {
  const t = useText("ohbox");
  const [dismissed, dismiss] = useState<string | null>(null);
  const no = beside.notOrganizing;
  const first = no?.mailboxes[0];
  let notice: FrameNotice | null = null;
  if (no && first) {
    const why = no.every ? sharedNotOrganizedWhy(no) : (first.why ?? "never_agreed");
    const setup = why === "never_agreed";
    const address = beside.words.mailbox(first.address);
    const one = no.mailboxes.length === 1;
    const id = JSON.stringify([why, no.every, no.mailboxes.map(({ id }) => id)]);
    if (dismissed !== id) {
      const title =
        no.every && setup
          ? t("organizingNotice.notYet")
          : why === "handed_back" && one
            ? t("organizingNotice.handedBack", { address })
            : no.every
              ? t("organizingNotice.mailboxes")
              : one
                ? t("organizingNotice.mailbox", { address })
                : t("organizingNotice.someMailboxes", { count: no.mailboxes.length });
      const line =
        why === "handed_back" && one
          ? t("organizingNotice.handedBackLine")
          : no.every
            ? t("organizingNotice.line")
            : one
              ? t("organizingNotice.mailboxLine")
              : t("organizingNotice.someMailboxesLine");
      notice = {
        kind: "notOrganizing",
        id,
        title,
        line,
        hot: true,
        acts: [
          {
            label: t(setup ? "organizingNotice.setup" : "organizingNotice.manage"),
            onPress: () => (setup ? beside.go.organize(first.id) : beside.go.mailboxes()),
          },
          { label: t("organizingNotice.dismiss"), onPress: () => dismiss(id) },
        ],
      };
    }
  }
  useNotice(notice);
  return null;
}

/** The number it prints is grouped as its accessible name groups it. */
function OhboxDoor({ model, beside }: { model: OhboxListModel; beside: OhboxBeside }) {
  const t = useText("ohbox");
  const locale = useLocale();
  if (!model.mayState || !beside.doorbell.settled || beside.doorbell.count === 0) return null;
  /* The number it prints is the number its name says, grouped as the name groups it ("1,042"), as the shipped head
     printed it: a raw figure beside a grouped name reads as two numbers. */
  return (
    <Doorbell
      count={beside.doorbell.count.toLocaleString(locale)}
      label={t("doorbellAria", { count: beside.doorbell.count })}
      onPress={beside.go.screener}
    />
  );
}
