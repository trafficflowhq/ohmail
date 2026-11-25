/**
 * THE VERBS OVER THE PICKED ROWS, at the list's foot: the count that lets go, Read, Unread, Later, Park, Move,
 * Screening, and Delete behind More. A verb the bar has no room for (a phone's width, a narrow list column) stands
 * behind More too, before Delete. Move, Screening and Delete ask first, in the kit's one menu; which question
 * stands is the model's (`pickPanel`), so the keys m, s and d open the same ones and Escape closes them.
 */
import { useRef, useState } from "react";
import type { OhboxListModel } from "@ohmail/app-logic/ohbox";
import { EndDot, Menu, MenuItem } from "@ohmail/ui/base";
import { SelectionBar } from "@ohmail/ui/mail";
import { useText } from "../text/index.js";
import type { OhboxBeside } from "./beside.js";
import { OhboxMoveAsk } from "./OhboxMoveAsk.js";
import { pickVerbs } from "./selection-verbs.js";

export function OhboxSelection({ model, beside }: { model: OhboxListModel; beside: OhboxBeside }) {
  const t = useText("ohbox");
  const foot = useRef<HTMLDivElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const [more, setMore] = useState(false);
  /* The verbs the bar had no room for (the kit says which, whenever that changes): they stand behind More. */
  const [folded, setFolded] = useState<readonly string[]>([]);
  const verbs = pickVerbs(model, t, foot);
  /* The rows picked, as the person picked them: a folded conversation is one. Delete asks over the letters. */
  const count = model.pickedRowCount;
  const letters = model.pickedIds.length;
  const panel = model.pickPanel;
  const close = () => model.setPickPanel(null);
  return (
    /* The foot takes the keyboard where a menu anchored on it closes: the kit gives it back to its anchor, and a shell
       hands it on to the control that opened the menu (More, Move, Tag) rather than losing it to the page. */
    <div className="ob-foot" ref={foot} tabIndex={-1}>
      <SelectionBar
        label={t("bar.label")}
        announceCount={false}
        count={{
          count: String(count),
          word: t("pickedWord"),
          label: t("pickedAria", { count }),
          onClear: model.clearPicked,
        }}
        verbs={verbs}
        onFold={setFolded}
        more={{
          label: t("actionMore"),
          behind: true,
          expanded: more,
          onPress: () => setMore((open) => !open),
        }}
        keysShown={beside.keysShown}
      />
      <OhboxMoveAsk model={model} foot={foot} />
      <Menu open={more} onClose={() => setMore(false)} anchor={foot} up right label={t("actionMore")}>
        {/* What folded out of the bar, in the bar's order, then what only ever stands here. */}
        {verbs
          .filter((verb) => folded.includes(verb.id))
          .map((verb) => (
            <MenuItem
              key={verb.id}
              icon={verb.icon}
              keyHint={verb.keyHint}
              onPress={() => {
                setMore(false);
                if (foot.current) verb.onPress?.(foot.current);
              }}
            >
              {verb.label}
            </MenuItem>
          ))}
        <MenuItem
          icon="trash"
          keyHint="d"
          onPress={() => {
            setMore(false);
            model.requestDeletePicked();
          }}
        >
          {t("actionDelete")}
        </MenuItem>
      </Menu>
      <Menu
        open={panel?.kind === "delete"}
        onClose={close}
        anchor={foot}
        up
        kind="ask"
        initialFocus={cancelDelete}
        label={t("bulkDeleteAsk", { count: letters })}
      >
        <h4 className="oh-text oh-menu-title">
          <EndDot kind="hot">{t("bulkDeleteAsk", { count: letters }).slice(0, -1)}</EndDot>
        </h4>
        <MenuItem onPress={model.confirmDeletePicked}>{t("deleteConfirm")}</MenuItem>
        <MenuItem ref={cancelDelete} onPress={close}>
          {t("moveCancel")}
        </MenuItem>
      </Menu>
    </div>
  );
}
