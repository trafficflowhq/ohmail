/**
 * WHERE THE PICKED ROWS GO, asked over the selection's bar: the places to move them to (Move), the same places for
 * their senders (Screening), and Screening's confirmation, which says how many senders and letters, and the rules,
 * before anything moves. Which question stands is the model's (`pickPanel`).
 */
import type { RefObject } from "react";
import type { OhboxListModel } from "@ohmail/app-logic/ohbox";
import { MOVE_TARGETS, type MoveTarget } from "@ohmail/app-logic/press/actions";
import { EndDot, Menu, MenuItem, MenuNote } from "@ohmail/ui/base";
import { useText } from "../text/index.js";

const ICON = {
  ohbox: "ohbox",
  reads: "news",
  receipts: "receipts",
  screened: "screenout",
  spam: "spam",
} as const;

export function OhboxMoveAsk({
  model,
  foot,
}: {
  model: OhboxListModel;
  foot: RefObject<HTMLDivElement | null>;
}) {
  const t = useText("ohbox");
  const places = useText("place");
  const panel = model.pickPanel;
  const close = () => model.setPickPanel(null);
  const place = (to: MoveTarget) => places(to);
  const plan = panel?.kind === "confirm" ? model.screenPreview(panel.dest) : null;
  const title =
    plan && panel?.kind === "confirm"
      ? t("bar.screenTitle", { senders: plan.senders, place: place(panel.dest) })
      : undefined;
  const asked = panel?.kind === "screen" ? t("bar.screenTo") : t("moveLabel");
  return (
    <>
      <Menu
        open={panel?.kind === "move" || panel?.kind === "screen"}
        onClose={close}
        anchor={foot}
        up
        kind="card"
        label={asked}
        title={asked}
      >
        {MOVE_TARGETS.map((to) => (
          <MenuItem
            key={to}
            icon={ICON[to]}
            onPress={() =>
              panel?.kind === "screen"
                ? model.setPickPanel({ kind: "confirm", dest: to })
                : model.runBulk(`move:${to}`)
            }
          >
            {panel?.kind === "screen" && to === "screened" ? t("bar.screenOut") : place(to)}
          </MenuItem>
        ))}
      </Menu>
      <Menu
        open={panel?.kind === "confirm"}
        onClose={close}
        anchor={foot}
        up
        kind="ask"
        label={title ?? t("bar.screen")}
      >
        {plan && panel?.kind === "confirm" && title ? (
          <>
            <h4 className="oh-text oh-menu-title">
              <EndDot kind="hot">{title.slice(0, -1)}</EndDot>
            </h4>
            <MenuNote>
              {plan.senders === 0
                ? t("bar.screenNothing")
                : t(plan.rules > 0 ? "bar.screenConfirmRules" : "bar.screenConfirm", {
                    count: plan.messages,
                  })}
            </MenuNote>
            <MenuItem disabled={plan.senders === 0} onPress={() => model.screenPicked(panel.dest)}>
              {t("bar.screenCommit")}
            </MenuItem>
            <MenuItem onPress={close}>{t("moveCancel")}</MenuItem>
          </>
        ) : null}
      </Menu>
    </>
  );
}
