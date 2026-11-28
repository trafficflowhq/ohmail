/**
 * THE OHBOX'S LIST: its head, its own scroller with the three groups (Resurfaced, New, Earlier), the end of the
 * list, the way back to the top, and the selection's verbs at its foot. New and Earlier are a window over one index
 * space (the headings are items in it), so a list of thousands mounts only what is on screen.
 */
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  useEngineOrNull,
  useLocalCopyPending,
  useMirrorReplacing,
  useSyncStatus,
} from "@ohmail/app-logic/engine/context";
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
import {
  OhboxStartupContext,
  SavedOhboxList,
  takeSavedOhbox,
  type OhboxStartup,
  type SavedOhbox,
} from "./SavedOhbox.js";
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
  const startup = useContext(OhboxStartupContext);
  if (startup) return <OhboxHandoff plan={plan} {...presentation} startup={startup} />;
  if (presentation.replacing && presentation.model.all.length === 0) return null;
  return <OhboxPresentation plan={plan} {...presentation} />;
}

type ListModel = ReturnType<typeof useOhboxModel>;
const positionOf = (model: ListModel, id: string) =>
  model.navRows.findIndex(({ members }) => members.some((message) => message.id === id));

/** Match the old position by message even if the conversation is now folded under another row. */
function handoffAnchor(model: ListModel, saved: SavedOhbox) {
  const { anchor } = saved;
  const at = positionOf(model, anchor.id);
  if (at >= 0) return { at, offset: anchor.offset };
  const rows = saved.groups.flatMap((group) => group.rows);
  const original = rows.findIndex((row) => row.id === anchor.id);
  const shift = anchor.offset - (rows[original]?.offset ?? anchor.offset);
  for (let distance = 1; distance < rows.length; distance++) {
    for (const index of [original + distance, original - distance]) {
      const row = rows[index];
      if (!row) continue;
      const at = positionOf(model, row.id);
      if (at >= 0) return { at, offset: row.offset === undefined ? anchor.offset : row.offset + shift };
    }
  }
  return null;
}

function OhboxHandoff({
  startup,
  ...presentation
}: Pick<PaneProps, "plan"> & ReturnType<typeof useListPresentation> & { startup: OhboxStartup }) {
  const t = useText("ohbox");
  const { model, replacing } = presentation;
  const saved = startup.launch.saved;
  const restored = useRef(saved !== null);
  const sync = useSyncStatus();
  const printed = !replacing && (model.surface === "content" || model.surface === "empty");
  const pressed = startup.launch.pressed;
  const position = saved ? positionOf(model, saved.anchor.id) : -1;
  const settled = model.listInput.settled;
  // With an open pending, wait for the conversation's current target to be known. Without one,
  // an anchor already in the live rows lets us reveal those rows while the read continues.
  const ready = printed && (!saved || settled || sync.failures > 0 || (position >= 0 && pressed === null));
  const [revealed, setRevealed] = useState(false);
  const seeking = useRef(false);

  useLayoutEffect(() => {
    if (!ready) return;
    const el = model.listScrollerRef.current;
    if (el && saved) {
      const target = saved.atTop ? null : handoffAnchor(model, saved);
      const row = target && model.navRows[target.at];
      const node =
        row &&
        Array.from(el.querySelectorAll<HTMLElement>(".oh-row[data-id]")).find(
          (node) => node.dataset.id === row.openTarget.id,
        );
      if (node && target) {
        const preview = el.parentElement?.querySelector(".ob-held .ob-scroll");
        const top = (preview ?? el).getBoundingClientRect().top;
        el.scrollTop += node.getBoundingClientRect().top - top - target.offset;
      } else if (target && !seeking.current) {
        const index = target.at - model.groupedResurfaced.length;
        if (index >= 0) {
          seeking.current = true;
          model.win.scrollTo(
            index < model.newCount ? model.newBase + index : model.prevBase + index - model.newCount,
          );
          return;
        }
      }
      startup.launch.saved = null;
      setRevealed(true);
    }
    if (settled && startup.launch.pressed !== null) {
      const at = positionOf(model, startup.launch.pressed);
      startup.launch.pressed = null;
      const row = model.navRows[at];
      if (row) model.pressRow(row);
    }
  }, [model, ready, saved, settled, startup.launch]);

  const held = revealed ? null : saved;

  useEffect(() => {
    if (!ready || held) return;
    const scroller = model.listScrollerRef.current;
    if (!scroller) return;
    const save = () => {
      const snapshot = takeSavedOhbox(scroller);
      if (snapshot || model.surface === "empty") startup.save(snapshot);
    };
    let timer: ReturnType<typeof setTimeout>;
    const queue = () => {
      clearTimeout(timer);
      timer = setTimeout(save, 250);
    };
    queue();
    scroller.addEventListener("scroll", queue, { passive: true });
    const off = startup.onLeave?.(save);
    return () => {
      off?.();
      clearTimeout(timer);
      scroller.removeEventListener("scroll", queue);
    };
  }, [startup, ready, held, model.surface, model.listScrollerRef, model.all]);

  if (replacing && model.all.length === 0 && !held) return null;
  return (
    <OhboxPresentation
      {...presentation}
      preparing={Boolean(held && ready)}
      restored={restored.current}
      counts={model.mayState}
      held={held && <SavedOhboxList saved={held} title={t("title")} startup={startup} />}
    />
  );
}

function OhboxPresentation({
  plan,
  model,
  beside,
  replacing,
  held,
  preparing = false,
  restored = false,
  counts = true,
}: Pick<PaneProps, "plan"> &
  ReturnType<typeof useListPresentation> & {
    held?: React.ReactNode;
    preparing?: boolean;
    restored?: boolean;
    counts?: boolean;
  }) {
  const t = useText("ohbox");
  const scroller = model.listScrollerRef;
  const far = useJumpBack(scroller);
  useMovingRows(scroller, held ? "" : rowVersion(model));
  const room = useSquaresRoom(scroller);
  const rows = <OhboxRows {...{ model, beside, replacing, counts }} />;
  const waiting = held && !preparing;
  return (
    <div
      className="ob-list"
      data-preparing={preparing ? "" : undefined}
      data-restored-viewport={restored ? "" : undefined}
      inert={(replacing && !held) || undefined}
      onClickCapture={held ? undefined : model.pointer.onClickCapture}
      onPointerDownCapture={held ? undefined : model.pointer.onPointerDownCapture}
      onPointerMoveCapture={held ? undefined : model.pointer.onPointerMoveCapture}
      onPointerUpCapture={held ? undefined : model.pointer.onPointerUpCapture}
      onPointerCancelCapture={held ? undefined : model.pointer.onPointerCancelCapture}
      onContextMenuCapture={held ? undefined : model.pointer.onContextMenuCapture}
    >
      {held ? <div className="ob-held">{held}</div> : null}
      {waiting ? null : <MailboxProfileOffer />}
      {waiting ? null : beside.over}
      {waiting ? null : (
        <OhboxHead
          model={model}
          beside={beside}
          plan={plan}
          onMarkAllRead={model.markAllRead}
          displayOnly={replacing}
          counts={counts}
        />
      )}
      {/* Focusable by the shell only (never a tab stop): where the keyboard stands when a verb left no row. */}
      <div
        className="ob-scroll"
        data-keep-row-date=""
        ref={scroller}
        hidden={waiting ? true : undefined}
        inert={held ? true : undefined}
        tabIndex={-1}
        data-phone={plan.device === "phone" ? "" : undefined}
      >
        {!waiting && (
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
        )}
      </div>
      {held ? null : (
        <JumpBack
          label={t("end.top")}
          to="top"
          shown={far}
          lifted={model.picked.size > 0}
          onPress={() => {
            if (scroller.current) scroller.current.scrollTop = 0;
          }}
        />
      )}
      {held ? null : <SelectionStatus count={model.pickedRowCount} />}
      {!held && model.picked.size > 0 ? (
        <OhboxSelection model={model} beside={beside} phone={plan.device === "phone"} />
      ) : null}
    </div>
  );
}

function OhboxRows({
  model,
  beside,
  replacing,
  counts,
}: ReturnType<typeof useListPresentation> & { counts: boolean }) {
  const t = useText("ohbox");
  return (
    <>
      {model.groupedResurfaced.length > 0 ? (
        <OhboxGroup
          model={model}
          displayOnly={replacing}
          counts={counts}
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
          displayOnly={replacing}
          counts={counts}
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
          displayOnly={replacing}
          counts={counts}
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
}
