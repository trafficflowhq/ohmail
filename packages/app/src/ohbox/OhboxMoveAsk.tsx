/**
 * WHERE THE PICKED ROWS GO, asked over the selection's bar: the places to move them to (Move), the same places for
 * their senders (Screening), and Screening's confirmation, which says how many senders and letters, and the rules,
 * before anything moves. Which question stands is the model's (`pickPanel`).
 */
import type { RefObject } from "react";
import type { OhboxListModel } from "@ohmail/app-logic/ohbox";
import { MOVE_TARGETS, type MoveTarget } from "@ohmail/app-logic/press/actions";
import { Menu, MenuItem, MenuNote } from "@ohmail/ui/base";
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
  /* One menu of places for both questions, titled for the one asked: Move's "move to", Screening's "screen to". */
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
            {place(to)}
          </MenuItem>
        ))}
      </Menu>
      <Menu
        open={panel?.kind === "confirm"}
        onClose={close}
        anchor={foot}
        up
        kind="ask"
        label={t("bar.screen")}
      >
        {plan && panel?.kind === "confirm" ? (
          <>
            <MenuNote>
              {plan.senders === 0
                ? t("bar.screenNothing", { place: place(panel.dest) })
                : plan.rules > 0
                  ? t("bar.screenConfirmRules", {
                      place: place(panel.dest),
                      senders: plan.senders,
                      count: plan.messages,
                      rules: plan.rules,
                    })
                  : t("bar.screenConfirm", {
                      place: place(panel.dest),
                      senders: plan.senders,
                      count: plan.messages,
                    })}
            </MenuNote>
            <MenuItem onPress={close}>{t("moveCancel")}</MenuItem>
            <MenuItem dot="hot" disabled={plan.senders === 0} onPress={() => model.screenPicked(panel.dest)}>
              {t("bar.screenCommit")}
            </MenuItem>
          </>
        ) : null}
      </Menu>
    </>
  );
}
