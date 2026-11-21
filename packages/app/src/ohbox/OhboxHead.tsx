/**
 * THE OHBOX'S HEAD: its name with the hot dot while something waits, and its own tools: the Screener's doorbell,
 * Mark all read, and the list's menu with Pull new mail and Mark all read.
 */
import { useRef, useState, type ReactNode } from "react";
import type { OhboxListModel } from "@ohmail/app-logic/ohbox";
import { sharedNotOrganizedWhy } from "@ohmail/app-logic/mail-state/mail-state";
import { Button, Menu, MenuItem } from "@ohmail/ui/base";
import { ProductSwitch } from "../frame/ProductSwitch.js";
import { Doorbell, ListHead } from "@ohmail/ui/mail";
import type { LayoutPlan } from "../frame/contract.js";
import { useLastMailCheckLabel } from "../place-list/ListMenu.js";
import { NONE } from "../host/index.js";
import { useLocale, useText } from "../text/index.js";
import type { OhboxBeside } from "./beside.js";

export function OhboxHead({
  model,
  beside,
  plan,
  onMarkAllRead,
}: {
  model: OhboxListModel;
  beside: OhboxBeside;
  plan: LayoutPlan;
  /** Mark every unread letter of the Ohbox read; absent where the shell has no such verb. */
  onMarkAllRead: ((ids: string[]) => void) | null;
}) {
  const t = useText("ohbox");
  const locale = useLocale();
  const all = useText("markAll");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  /* The engine's unread letters: Mark all read names them as soon as rows stand, as the shipped head did. The hot
     dot is a claim about the mailbox and waits until the Ohbox may say it. */
  const unread = model.unreadIds.length;
  const pull = beside.pull;
  const checked = useLastMailCheckLabel(menuOpen && pull !== NONE);
  const markAll = onMarkAllRead && unread > 0 ? () => onMarkAllRead(model.unreadIds) : null;
  return (
    <>
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
        open={menuOpen}
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

/**
 * THE DOOR TO THE SCREENER, or what is true instead. Withheld until the Screener's queue has been read and the
 * Ohbox may speak; nothing at zero (the kit leaves an empty doorbell out). Where nothing organizes a mailbox the
 * slot says so and leads to the organize decision, whatever the count.
 */
function OhboxDoor({ model, beside }: { model: OhboxListModel; beside: OhboxBeside }) {
  const t = useText("ohbox");
  const locale = useLocale();
  const no = beside.notOrganizing;
  const first = no?.mailboxes[0];
  if (no && first && (no.every || beside.doorbell.count === 0)) {
    const why = no.every ? sharedNotOrganizedWhy(no) : (first.why ?? "never_agreed");
    const never = why === "never_agreed";
    const address = beside.words.mailbox(first.address);
    const bold = { b: (chunks: ReactNode) => <b>{chunks}</b> };
    /* The statement printed for every eye (the shipped head printed it beside its action), the whole of it in the
       control's name. */
    const said = !no.every
      ? t.rich("doorbellNotOrganizingSome", { count: no.mailboxes.length, address, ...bold })
      : t.rich(
          never ? "doorbellNotYet" : why === "handed_back" ? "doorbellHandedBack" : "doorbellNotOrganizing",
          bold,
        );
    const label = !no.every
      ? t("doorbellNotOrganizingSomeAria", {
          count: no.mailboxes.length,
          address,
        })
      : t(
          never
            ? "doorbellNotYetAria"
            : why === "handed_back"
              ? "doorbellHandedBackAria"
              : "doorbellNotOrganizingAria",
        );
    return (
      <span className="ob-door">
        <span className="ob-door-said">{said}</span>
        <Button
          kind="quiet"
          size="s"
          label={label}
          onPress={() => (never ? beside.go.organize(first.id) : beside.go.mailboxes())}
        >
          {t(never ? "doorbellNotYetAction" : "doorbellNotOrganizingAction")}
        </Button>
      </span>
    );
  }
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
