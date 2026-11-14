/**
 * THE OHBOX'S LIST: its head, its own scroller with the three groups (Resurfaced, New, Earlier), the end of the
 * list, the way back to the top, and the selection's verbs at its foot. New and Earlier are a window over one index
 * space (the headings are items in it), so a list of thousands mounts only what is on screen.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useOhboxModel } from "@ohmail/app-logic/ohbox";
import { JumpBack } from "@ohmail/ui/base";
import { ListTail, Sheet } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { useText } from "../text/index.js";
import { useOhboxBeside } from "./beside.js";
import { OhboxEmpty } from "./OhboxEmpty.js";
import { OhboxGroup } from "./OhboxGroup.js";
import { OhboxHead } from "./OhboxHead.js";
import { OhboxSelection } from "./OhboxSelection.js";
import { SquaresRoomContext, useSquaresRoom } from "./squares-run.js";
import "./ohbox.css";

/** The way back stands once the list is this far from its top, or half a screen where that is more. */
const BACK_FROM_PX = 240;

/**
 * `notice`: what a shell stands at the head of the list's flow (today's away line and storage card). It is the
 * scroller's first block, so a line that pins itself sticks under nothing and the rest scrolls with the rows.
 */
export function OhboxList({ plan, notice }: PaneProps & { notice?: ReactNode }) {
  const model = useOhboxModel();
  const beside = useOhboxBeside();
  const t = useText("ohbox");
  const [far, setFar] = useState(false);
  const scroller = model.listScrollerRef;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const look = () => setFar(el.scrollTop > Math.max(BACK_FROM_PX, el.clientHeight / 2));
    look();
    el.addEventListener("scroll", look, { passive: true });
    return () => el.removeEventListener("scroll", look);
  }, [scroller]);
  const room = useSquaresRoom(scroller);

  const rows = (
    <>
      {model.groupedResurfaced.length > 0 ? (
        <OhboxGroup
          model={model}
          beside={beside}
          name={t("resurfacedGroup")}
          rows={model.groupedResurfaced}
          from={0}
          to={model.groupedResurfaced.length}
          heading
        />
      ) : null}
      <div aria-hidden data-window-top="" style={{ height: model.win.padTop }} />
      {model.newCount > 0 ? (
        <OhboxGroup
          model={model}
          beside={beside}
          name={t("newForYou")}
          rows={model.groupedNew}
          from={model.newFrom}
          to={model.newTo}
          heading={model.showNewLabel}
          headingIndex={0}
          rowBase={model.newBase}
        />
      ) : null}
      {model.prevCount > 0 ? (
        <OhboxGroup
          model={model}
          beside={beside}
          name={t("previouslySeen")}
          rows={model.groupedPrev}
          from={model.prevFrom}
          to={model.prevTo}
          heading={model.showPrevLabel}
          headingIndex={model.prevLabelAt}
          rowBase={model.prevBase}
        />
      ) : null}
      {model.win.padBottom > 0 ? <div aria-hidden style={{ height: model.win.padBottom }} /> : null}
      {model.all.length === 0 ? (
        <OhboxEmpty model={model} beside={beside} />
      ) : (
        <ListTail way={{ label: t("end.history"), onPress: beside.go.history }}>{t("end.older")}</ListTail>
      )}
    </>
  );
  return (
    <div
      className="ob-list"
      onClickCapture={model.pointer.onClickCapture}
      onPointerDownCapture={model.pointer.onPointerDownCapture}
      onPointerMoveCapture={model.pointer.onPointerMoveCapture}
      onPointerUpCapture={model.pointer.onPointerUpCapture}
      onPointerCancelCapture={model.pointer.onPointerCancelCapture}
      onContextMenuCapture={model.pointer.onContextMenuCapture}
    >
      <OhboxHead model={model} beside={beside} plan={plan} onMarkAllRead={model.markAllRead} />
      {/* Focusable by the shell only (never a tab stop): where the keyboard stands when a verb left no row. */}
      <div
        className="ob-scroll"
        ref={scroller}
        tabIndex={-1}
        data-phone={plan.device === "phone" ? "" : undefined}
      >
        {notice}
        <SquaresRoomContext.Provider value={room}>
          {plan.device === "phone" ? <Sheet kind="plain">{rows}</Sheet> : rows}
        </SquaresRoomContext.Provider>
      </div>
      <JumpBack
        label={t("end.top")}
        to="top"
        shown={far}
        lifted={model.picked.size > 0}
        onPress={() => {
          if (scroller.current) scroller.current.scrollTop = 0;
        }}
      />
      {model.picked.size > 0 ? <OhboxSelection model={model} beside={beside} /> : null}
    </div>
  );
}
