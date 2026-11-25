import { useFrame } from "../../frame/commands.js";
import { MailRow } from "../../place-list/MailRowMenu.js";
/**
 * THE SECTION'S ROWS: first the letters their provider failed that no sender's decision covers, each opened and
 * decided alone with its own two answers; then one row per sender, an option of one listbox, the open one selected; under the
 * queue, the senders decided here that the organizer has not carried out yet. Opening a row reads nothing and marks nothing read.
 */
import type { ScreenerSenderDTO } from "@ohmail/wire";
import {
  acceptDestOf,
  PILE_VERB_KEY,
  refused,
  viewRowId,
  viewSender,
  type ScreenerView,
} from "@ohmail/app-logic/screener";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { revealInScroller, useListWindow } from "@ohmail/app-logic/lists/list-window";
import { Tag, type Point } from "@ohmail/ui/base";
import { GroupHeading, Rows as KitRows, type RowPlace } from "@ohmail/ui/mail";
import { useMovingRows } from "../../place-list/use-moving-rows.js";
import { useText, type Text } from "../../text/index.js";
import { useScreener, useScreenerBeside } from "../contract.js";
import { PlaceMenu } from "../sender/PlaceMenu.js";

type SenderSlot = { index: number; at: number; of: number };

/**
 * What a waiting row says before its time: a decision of it that did not land, then how many letters it holds (a
 * row of one says nothing of it). A sender whose letter claims a company it does not belong to carries the warning.
 */
function rowFacts(sender: ScreenerSenderDTO, t: Text, model: ReturnType<typeof useScreener>) {
  const note = model.refused(sender.id)
    ? t("rowNotSaved")
    : model.notApplied.some((d) => d.sender.id === sender.id)
      ? t("rowNotApplied")
      : null;
  const count = sender.held.length;
  const labels = note === null ? [] : [note];
  if (count > 1) {
    const inbox = model.reachOf(sender, "sender").inboxIds.length > 0;
    labels.push(t(inbox ? "place.messageCount" : "place.heldLabel", { count }));
  }
  const checked = sender.checked;
  const advice = sender.ai;
  const impersonation = checked?.reason === "impersonation";
  const flag = impersonation
    ? { label: t("place.lookalike"), word: t("senderCheck.chip", { brand: checked.brand }) }
    : undefined;
  if (advice?.noAnswer === "model_unavailable" || advice?.noAnswer === "model_declined") {
    labels.push(t("suggest.couldNot"));
  } else if (advice?.dest === "screener" && !advice.noAnswer) {
    labels.push(t("aiHoldChip"));
  }
  let explanation: string | undefined;
  if (impersonation) {
    explanation = t(checked.domainShared ? "senderCheck.impersonationShared" : "senderCheck.impersonation", {
      brand: checked.brand,
      domain: checked.domain,
    });
  } else if (advice?.reasonCode) {
    const values = { brand: advice.reasonBrand ?? "", count: advice.reasonCount ?? 0 };
    labels.push(t(`aiReasonChip.${advice.reasonCode}`, values));
  }
  const spoken = [...labels, ...(explanation === undefined ? [] : [explanation])].join(" · ");
  return { labels, flag, spoken: spoken || undefined };
}

import type { RowContact } from "../../place-list/use-row-contact.js";
import type { RowSelection } from "../../place-list/use-row-selection.js";

export function SenderRow({
  sender,
  open,
  stop,
  labels,
  spoken,
  flag,
  where,
  place,
  slot,
  leaving,
  decided = false,
  onOpen,
  onMenu,
  selection,
  contact,
}: {
  sender: ScreenerSenderDTO;
  open: boolean;
  stop: boolean;
  labels?: readonly string[];
  spoken?: string;
  flag?: { label: string; word: string };
  where?: string;
  place?: RowPlace;
  slot?: SenderSlot;
  leaving?: "rail" | "fade";
  decided?: boolean;
  onOpen: () => void;
  selection?: RowSelection;
  contact?: RowContact;
  onMenu?: (at: { x: number; y: number }) => void;
}) {
  /* `held` is oldest first: the row speaks for the newest letter, the one its time is. */
  const t = useText("screener");
  const ohbox = useText("ohbox");
  const { plan } = useFrame();
  const { mailboxWord } = useScreenerBeside();
  const mailbox = sender.mailboxId ? mailboxWord(sender.mailboxId, "short") : null;
  const deliveredTo = mailbox ? t("place.deliveredTo", { label: mailbox }) : undefined;
  const newest = sender.held[sender.held.length - 1];
  const name = sender.from.name?.trim();
  const who = name || sender.from.address;
  const subject = newest?.subject ?? "";
  const unread = !decided && sender.held.some((h) => h.unread === true);
  const pick = selection?.rowProps(sender.id);
  return (
    <MailRow
      {...pick}
      {...contact?.rowProps(sender.from, newest?.id ?? sender.id)}
      who={who}
      address={name ? sender.from.address : undefined}
      keepAddressDomain={plan.device !== "phone" || sender.segment !== "screened_out"}
      people={[{ name: who, address: sender.from.address }]}
      subject={subject}
      preview={newest?.snippet}
      when={sender.time}
      labels={labels}
      tag={
        mailbox ? (
          <span className="sc-mailbox-badge" title={deliveredTo}>
            <Tag truncateOnPhone>{mailbox}</Tag>
          </span>
        ) : undefined
      }
      flag={flag}
      where={where}
      place={place}
      leaving={leaving}
      unread={unread}
      open={open && plan.device !== "phone"}
      cursor={open}
      listing={{
        name: subject ? `${who}: ${subject}` : who,
        spoken: [ohbox(unread ? "row.unread" : "row.read"), spoken, deliveredTo].filter(Boolean).join(" · "),
        selected: selection?.ids.length ? pick?.picked === true : open,
        place: slot,
        stop,
      }}
      mark={{ id: sender.id, index: slot?.index }}
      onOpen={onOpen}
      onMenu={onMenu}
    />
  );
}

/** Waiting and pending share one option set. The heading takes a measured slot but has no option position. */
const NO_DECISIONS: ScreenerView["decided"] = [];

function SenderRowsWindow({
  view,
  label,
  scroller,
  renderRow,
}: {
  view: ScreenerView;
  label: string;
  scroller: RefObject<HTMLDivElement | null>;
  renderRow: (row: ScreenerView["rows"][number], slot?: SenderSlot) => ReactNode;
}) {
  const t = useText("screener");
  const { rows, openId } = view;
  const decided = view.segment === "waiting" ? view.decided : NO_DECISIONS;
  const size = rows.length + decided.length;
  const pendingStart = rows.length + 1;
  const win = useListWindow({ scrollerRef: scroller, count: size + Number(decided.length > 0) });
  const waitingRows = rows.slice(win.start, Math.min(win.end, rows.length));
  const pendingFrom = Math.max(0, win.start - pendingStart);
  const pendingRows = decided.slice(pendingFrom, Math.max(0, win.end - pendingStart));
  const holder = decided[0]?.decision.holder;
  const pendingHeading = t("pendingHeading", {
    name:
      holder && decided.every(({ decision }) => decision.holder === holder)
        ? holder
        : t("pendingHolderUnknown"),
  });
  const showHeading = decided.length > 0 && win.start <= rows.length && rows.length < win.end;

  /* A cursor move may address an unmounted option. A scroll by hand leaves the cursor where it was. */
  const revealed = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null || openId === revealed.current) return;
    revealed.current = openId;
    if (openId === null) return;
    const mounted = Array.from(el.querySelectorAll<HTMLElement>('[role="option"][data-id]')).find(
      (row) => row.dataset.id === openId,
    );
    if (mounted) {
      revealInScroller(el, mounted);
      return;
    }
    const waitingIndex = rows.findIndex((row) => viewRowId(row) === openId);
    const pendingIndex = decided.findIndex(({ sender }) => sender.id === openId);
    const index = waitingIndex >= 0 ? waitingIndex : pendingIndex >= 0 ? pendingStart + pendingIndex : -1;
    if (index >= 0) {
      el.scrollTop = Math.max(0, win.offsetOf(index) - win.rowHeight);
      el.dispatchEvent(new Event("scroll"));
    }
  }, [scroller, openId, rows, decided, pendingStart, win]);

  return (
    <div role="listbox" aria-label={label}>
      <div aria-hidden data-window-top="" style={{ height: win.padTop }} />
      {waitingRows.length > 0 ? (
        <KitRows group>
          {waitingRows.map((row, i) => {
            const index = win.start + i;
            return renderRow(row, { index, at: index + 1, of: size });
          })}
        </KitRows>
      ) : null}
      {showHeading ? (
        <div data-index={rows.length}>
          <GroupHeading count={t("pendingCount", { count: decided.length })}>{pendingHeading}</GroupHeading>
        </div>
      ) : null}
      {pendingRows.length > 0 ? (
        <KitRows group label={pendingHeading}>
          {pendingRows.map(({ sender }, i) => {
            const index = pendingStart + pendingFrom + i;
            return (
              <SenderRow
                key={sender.id}
                sender={sender}
                open={openId === sender.id}
                stop={openId === sender.id}
                slot={{ index, at: index, of: size }}
                where={t("rowWaiting")}
                onOpen={() => view.select(sender.id)}
              />
            );
          })}
        </KitRows>
      ) : null}
      {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
    </div>
  );
}

function useQueueMotion(view: ScreenerView, scroller?: RefObject<HTMLDivElement | null>) {
  const waiting = view.segment === "waiting";
  const rowIds = view.rows.map(viewRowId);
  useMovingRows(
    scroller,
    JSON.stringify([rowIds, waiting ? view.decided.map(({ sender }) => sender.id) : []]),
    waiting ? { scope: view.filter.active, ids: rowIds } : undefined,
  );
}

function shelfFacts(
  row: ScreenerView["rows"][number],
  segment: ScreenerView["segment"],
  model: ReturnType<typeof useScreener>,
  t: Text,
) {
  const sender = viewSender(row);
  const labels = model.refused(viewRowId(row)) ? [t("rowNotSaved")] : [];
  if (segment === "screened") labels.push(t("place.heldLabel", { count: sender.held.length }));
  else if ("pinned" in row && row.pinned) labels.push(t("markedByYou"));
  else {
    const newest = sender.held.at(-1);
    if (sender.detection || (newest && model.wasAutoFiledSpam?.(newest.id))) labels.push(t("autoDetected"));
  }
  if (segment === "spam" && sender.held.length > 1)
    labels.push(t("place.heldLabel", { count: sender.held.length }));
  return { labels };
}

export function Rows({
  view,
  label,
  scroller,
  selection,
  contact,
}: {
  view: ScreenerView;
  label?: string;
  scroller?: RefObject<HTMLDivElement | null>;
  selection?: RowSelection;
  contact?: RowContact;
}) {
  const t = useText("screener");
  const model = useScreener();
  const { mailboxWord } = useScreenerBeside();
  const waiting = view.segment === "waiting";
  useQueueMotion(view, scroller);
  const failed = waiting ? (model.failedAtGate ?? []) : [];
  /* A right click opens that sender with its menu where the pointer is; only a sender this install may decide. */
  const [menuAt, setMenuAt] = useState<Point | RefObject<Element | null> | null>(null);
  const deciding = waiting && !refused(model.role);
  const menuFor = deciding
    ? (id: string) => (at: Point) => {
        setMenuAt(at);
        view.select(id, "row");
      }
    : null;
  const open = view.open === null || view.segment !== "waiting" ? null : viewSender(view.open);
  /*
   * The place at the row's end: the suggestion accepted in one press, another chosen from the row's menu. Where the
   * press would also send an unsubscribe request its accessible name says so, and it asks first.
   */
  const placeOf = (sender: ScreenerSenderDTO): RowPlace | undefined => {
    if (!deciding) return undefined;
    const choose = {
      label: t("place.choose"),
      expanded: view.shown === "row" && view.openId === sender.id,
      onPress: (at: HTMLElement) => {
        setMenuAt({ current: at });
        view.select(sender.id, "row");
      },
    };
    const dest = acceptDestOf(sender);
    if (dest === null) return { word: t("place.chooseWord"), choose };
    const demoting = dest === "screened" || dest === "spam";
    const unsub = demoting && model.unsubClaimOf(sender, view.scopeOf(sender)) !== "none";
    const word = t(PILE_VERB_KEY[dest]);
    const label = unsub ? t(dest === "spam" ? "place.unsub.spam" : "place.unsub.screened") : word;
    return { word, accept: { label, onPress: () => view.acceptRow(sender.id) }, choose };
  };
  const renderRow = (row: ScreenerView["rows"][number], slot?: SenderSlot) => {
    const sender = viewSender(row);
    const id = viewRowId(row);
    return (
      <SenderRow
        key={id}
        sender={sender}
        selection={selection}
        contact={contact}
        open={view.openId === id}
        stop={view.openId === null ? id === viewRowId(view.rows[0]!) : view.openId === id}
        {...(waiting ? rowFacts(sender, t, model) : shelfFacts(row, view.segment, model, t))}
        decided={!waiting}
        place={waiting ? placeOf(sender) : undefined}
        leaving={waiting ? model.leavingOf?.(id) : undefined}
        slot={slot}
        onOpen={() => view.select(id)}
        onMenu={menuFor?.(id)}
      />
    );
  };
  const name = label ?? t("title");
  return (
    <>
      {failed.length > 0 ? (
        <>
          <GroupHeading count={String(failed.length)}>{t("place.failedHeading")}</GroupHeading>
          <KitRows label={t("failedAria")}>
            {failed.map((f) => {
              const who = f.from.name?.trim() || displayAddress(f.from.address);
              const open = view.failedOpen?.id === f.id;
              const mailbox = f.mailboxId ? mailboxWord(f.mailboxId, "short") : null;
              return (
                <MailRow
                  key={f.id}
                  who={who}
                  people={[{ name: who, address: f.from.address }]}
                  subject={f.subject}
                  when={f.time}
                  labels={mailbox ? [t("place.checkFailed"), mailbox] : [t("place.checkFailed")]}
                  open={open}
                  cursor={open}
                  listing={{ name: `${who}: ${f.subject}`, selected: open, stop: open }}
                  mark={{ id: f.id }}
                  onOpen={() => view.openFailed(f.id)}
                />
              );
            })}
          </KitRows>
        </>
      ) : null}
      {scroller && (view.rows.length > 0 || (waiting && view.decided.length > 0)) ? (
        <SenderRowsWindow view={view} label={name} scroller={scroller} renderRow={renderRow} />
      ) : view.rows.length > 0 ? (
        <KitRows label={name}>{view.rows.map((row) => renderRow(row))}</KitRows>
      ) : null}
      {open !== null && menuAt !== null ? (
        <PlaceMenu view={view} sender={open} open={view.shown === "row"} anchor={menuAt} card />
      ) : null}
    </>
  );
}
