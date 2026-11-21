/**
 * THE OHBOX'S LIST: its head, its own scroller with the three groups (Resurfaced, New, Earlier), the end of the
 * list, the way back to the top, and the selection's verbs at its foot. New and Earlier are a window over one index
 * space (the headings are items in it), so a list of thousands mounts only what is on screen.
 */
import { useEffect, useState } from "react";
import { useOhboxModel } from "@ohmail/app-logic/ohbox";
import { JumpBack } from "@ohmail/ui/base";
import { ListTail, Sheet } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { useMovingRows } from "../place-list/use-moving-rows.js";
import { MailboxProfileOffer } from "../profile-import/ground.js";
import { useText } from "../text/index.js";
import { ListTouch } from "../touch/index.js";
import { useOhboxBeside } from "./beside.js";
import { OhboxEmpty } from "./OhboxEmpty.js";
import { OhboxGroup } from "./OhboxGroup.js";
import { OhboxHead } from "./OhboxHead.js";
import { OhboxSelection } from "./OhboxSelection.js";
import { SquaresRoomContext, useSquaresRoom } from "./squares-run.js";
import "./ohbox.css";

/** The way back stands once the list is this far from its top, or half a screen where that is more. */
const BACK_FROM_PX = 240;
const rowVersion = (model: ReturnType<typeof useOhboxModel>) =>
  JSON.stringify([
    model.groupedResurfaced.map((row) => row.key),
    model.groupedNew.map((row) => row.key),
    model.groupedPrev.map((row) => row.key),
  ]);

/** A pane of the frame: it takes `PaneProps` only. What a shell stands over it or first in it is `beside`'s. */
export function OhboxList({ plan }: PaneProps) {
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
  useMovingRows(scroller, rowVersion(model));
  const room = useSquaresRoom(scroller);
  const showTaggedByline = plan.device === "phone";

  const rows = (
    <>
      {model.groupedResurfaced.length > 0 ? (
        <OhboxGroup
          model={model}
          beside={beside}
          showTaggedByline={showTaggedByline}
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
          showTaggedByline={showTaggedByline}
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
          showTaggedByline={showTaggedByline}
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
      <MailboxProfileOffer />
      {beside.over}
      <OhboxHead model={model} beside={beside} plan={plan} onMarkAllRead={model.markAllRead} />
      {/* Focusable by the shell only (never a tab stop): where the keyboard stands when a verb left no row. */}
      <div
        className="ob-scroll"
        ref={scroller}
        tabIndex={-1}
        data-phone={plan.device === "phone" ? "" : undefined}
      >
        <ListTouch scroller={scroller} off={model.picked.size > 0} pull={beside.pull}>
          {beside.first}
          <SquaresRoomContext.Provider value={room}>
            {plan.device === "phone" ? (
              <Sheet kind="plain" phoneListPadding={model.picked.size > 0 ? "top" : "dock"}>
                {rows}
              </Sheet>
            ) : (
              rows
            )}
          </SquaresRoomContext.Provider>
        </ListTouch>
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
