/**
 * WHAT A CURSOR ROW's KEY ASKS, where one column stands and no letter is over the list (`m` and `d`,
 * `@ohmail/app-logic/ohbox` cursor-verbs): the places to move its letter to, or whether to delete it, at the row.
 * Each answer runs the list's own path for that letter; Delete then holds its delete for the Undo window, as `⌫`
 * does. The same kit menus and words as the picked rows' questions (`OhboxMoveAsk`, `OhboxSelection`).
 */
import type { RowAsk } from "@ohmail/app-logic/ohbox";
import { MOVE_TARGETS } from "@ohmail/app-logic/press/actions";
import { Menu, MenuItem, MenuNote } from "@ohmail/ui/base";
import { useText } from "../text/index.js";

const ICON = {
  ohbox: "ohbox",
  reads: "news",
  receipts: "receipts",
  screened: "screenout",
  spam: "spam",
} as const;

export function OhboxRowAsk({
  ask,
  row,
  onClose,
}: {
  ask: RowAsk | null;
  /** The cursor row's element, where the question stands. */
  row: (id: string) => Element | null;
  onClose: () => void;
}) {
  const t = useText("ohbox");
  const places = useText("place");
  const anchor = ask === null ? undefined : (row(ask.letter.id) ?? undefined);
  const answer = (run: () => void) => () => {
    onClose();
    run();
  };
  return (
    <>
      <Menu
        open={ask?.kind === "move"}
        onClose={onClose}
        anchor={anchor}
        anchored
        kind="card"
        label={t("moveLabel")}
        title={t("moveLabel")}
      >
        {MOVE_TARGETS.filter((to) => to !== "ohbox").map((to) => (
          <MenuItem key={to} icon={ICON[to]} onPress={answer(() => ask?.act(`move:${to}`))}>
            {places(to)}
          </MenuItem>
        ))}
      </Menu>
      <Menu
        open={ask?.kind === "delete"}
        onClose={onClose}
        anchor={anchor}
        anchored
        kind="ask"
        label={t("deleteAsk")}
        title={t("deleteAsk")}
      >
        {/* Where the letter goes, said before it goes, as the picked rows' ask says it. */}
        <MenuNote>{t("deleteNote")}</MenuNote>
        <MenuItem onPress={onClose}>{t("moveCancel")}</MenuItem>
        <MenuItem dot="hot" onPress={answer(() => ask?.act("delete"))}>
          {t("actionDelete")}
        </MenuItem>
      </Menu>
    </>
  );
}
