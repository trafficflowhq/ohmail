/**
 * THE OHBOX'S LIST: its head, its own scroller with the three groups (Resurfaced, New, Earlier), the end of the
 * list, the way back to the top, and the selection's verbs at its foot. New and Earlier are a window over one index
 * space (the headings are items in it), so a list of thousands mounts only what is on screen.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEngineOrNull, useLocalCopyPending, useMirrorReplacing } from "@ohmail/app-logic/engine/context";
import { useOhboxModel } from "@ohmail/app-logic/ohbox";
import { JumpBack } from "@ohmail/ui/base";
import { ListTail, Sheet } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { useMovingRows } from "../place-list/use-moving-rows.js";
import { SelectionStatus } from "../place-list/SelectionFoot.js";
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
export function OhboxList(props: PaneProps) {
  if (useLocalCopyPending()) return null;
  return <OhboxListContents {...props} />;
}

function useListPresentation() {
  const liveModel = useOhboxModel();
  const liveBeside = useOhboxBeside();
  const engine = useEngineOrNull();
  const replacing = useMirrorReplacing();
  const last = useRef({ engine, model: liveModel, beside: liveBeside });
  useLayoutEffect(() => {
    if (!replacing || last.current.engine !== engine) {
      last.current = { engine, model: liveModel, beside: liveBeside };
    }
  }, [engine, replacing, liveModel, liveBeside]);
  const held = replacing && last.current.engine === engine ? last.current : null;
  return { model: held?.model ?? liveModel, beside: held?.beside ?? liveBeside, replacing };
}

function useJumpBack(scroller: ReturnType<typeof useOhboxModel>["listScrollerRef"]): boolean {
  const [far, setFar] = useState(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const look = () => setFar(el.scrollTop > Math.max(BACK_FROM_PX, el.clientHeight / 2));
    look();
    el.addEventListener("scroll", look, { passive: true });
    return () => el.removeEventListener("scroll", look);
  }, [scroller]);
  return far;
}

function OhboxListContents({ plan }: PaneProps) {
  const presentation = useListPresentation();
  if (presentation.replacing && presentation.model.all.length === 0) return null;
  return <OhboxPresentation plan={plan} {...presentation} />;
}

function OhboxPresentation({
  plan,
  model,
  beside,
  replacing,
}: Pick<PaneProps, "plan"> & ReturnType<typeof useListPresentation>) {
  const t = useText("ohbox");
  const scroller = model.listScrollerRef;
  const far = useJumpBack(scroller);
  useMovingRows(scroller, rowVersion(model));
  const room = useSquaresRoom(scroller);
  const rows = <OhboxRows {...{ plan, model, beside, replacing }} />;
  return (
    <div
      className="ob-list"
      inert={replacing || undefined}
      onClickCapture={model.pointer.onClickCapture}
      onPointerDownCapture={model.pointer.onPointerDownCapture}
      onPointerMoveCapture={model.pointer.onPointerMoveCapture}
      onPointerUpCapture={model.pointer.onPointerUpCapture}
      onPointerCancelCapture={model.pointer.onPointerCancelCapture}
      onContextMenuCapture={model.pointer.onContextMenuCapture}
    >
      <MailboxProfileOffer />
      {beside.over}
      <OhboxHead
        model={model}
        beside={beside}
        plan={plan}
        onMarkAllRead={model.markAllRead}
        displayOnly={replacing}
      />
      {/* Focusable by the shell only (never a tab stop): where the keyboard stands when a verb left no row. */}
      <div
        className="ob-scroll"
        data-keep-row-date=""
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
      <SelectionStatus count={model.pickedRowCount} />
      {model.picked.size > 0 ? <OhboxSelection model={model} beside={beside} /> : null}
    </div>
  );
}

function OhboxRows({
  plan,
  model,
  beside,
  replacing,
}: Pick<PaneProps, "plan"> & ReturnType<typeof useListPresentation>) {
  const t = useText("ohbox");
  const showTaggedByline = plan.device === "phone";

  return (
    <>
      {model.groupedResurfaced.length > 0 ? (
        <OhboxGroup
          model={model}
          displayOnly={replacing}
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
          displayOnly={replacing}
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
          displayOnly={replacing}
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
}
