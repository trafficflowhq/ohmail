/**
 * THE SECTION'S ROWS: first the letters their provider failed that no sender's decision covers, each opened and
 * decided alone with its own two answers; then one row per sender, an option of one listbox, the open one selected; under the
 * queue, the senders decided here that the organizer has not carried out yet. Opening a row reads nothing and marks nothing read.
 */
import type { ScreenerSenderDTO } from "@ohmail/client-engine";
import {
  acceptDestOf,
  PILE_VERB_KEY,
  refused,
  viewRowId,
  viewSender,
  type ScreenerView,
} from "@ohmail/app-logic/screener";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { useState, type RefObject } from "react";
import type { Point } from "@ohmail/ui/base";
import { GroupHeading, Row, Rows as KitRows, type RowPlace } from "@ohmail/ui/mail";
import { useText, type Text } from "../../text/index.js";
import { useScreener } from "../contract.js";
import { PlaceMenu } from "../sender/PlaceMenu.js";

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
  const labels = [
    ...(note !== null ? [note] : []),
    ...(sender.held.length > 1 ? [t("place.heldLabel", { count: sender.held.length })] : []),
  ];
  const c = sender.checked;
  const flag =
    c?.reason === "impersonation"
      ? {
          label: t("place.lookalike"),
          word: t("senderCheck.chip", { brand: c.brand }),
        }
      : undefined;
  return { labels, flag };
}

function SenderRow({
  sender,
  open,
  stop,
  labels,
  flag,
  where,
  place,
  onOpen,
  onMenu,
}: {
  sender: ScreenerSenderDTO;
  open: boolean;
  stop: boolean;
  labels?: readonly string[];
  flag?: { label: string; word: string };
  where?: string;
  place?: RowPlace;
  onOpen: () => void;
  onMenu?: (at: { x: number; y: number }) => void;
}) {
  /* `held` is oldest first: the row speaks for the newest letter, the one its time is. */
  const newest = sender.held[sender.held.length - 1];
  const who = sender.from.name?.trim() || sender.from.address;
  const subject = newest?.subject ?? "";
  return (
    <Row
      who={who}
      address={sender.from.name ? sender.from.address : undefined}
      people={[{ name: who, address: sender.from.address }]}
      subject={subject}
      preview={newest?.snippet}
      when={sender.time}
      labels={labels}
      flag={flag}
      where={where}
      place={place}
      unread={sender.held.some((h) => h.unread === true)}
      open={open}
      cursor={open}
      listing={{ name: subject ? `${who}: ${subject}` : who, selected: open, stop }}
      mark={{ id: sender.id }}
      onOpen={onOpen}
      onMenu={onMenu}
    />
  );
}

export function Rows({ view }: { view: ScreenerView }) {
  const t = useText("screener");
  const model = useScreener();
  const waiting = view.segment === "waiting";
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
   * press would also send an unsubscribe request its word says so (a touch has no title), and it asks first.
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
    const word = unsub
      ? t(dest === "spam" ? "place.unsub.spam" : "place.unsub.screened")
      : t(PILE_VERB_KEY[dest]);
    return { word, accept: { label: word, onPress: () => view.acceptRow(sender.id) }, choose };
  };
  return (
    <>
      {failed.length > 0 ? (
        <>
          <GroupHeading count={String(failed.length)}>{t("failedAria")}</GroupHeading>
          <KitRows label={t("failedAria")}>
            {failed.map((f) => {
              const who = f.from.name?.trim() || displayAddress(f.from.address);
              const open = view.failedOpen?.id === f.id;
              return (
                <Row
                  key={f.id}
                  who={who}
                  people={[{ name: who, address: f.from.address }]}
                  subject={f.subject}
                  when={f.time}
                  labels={[t("place.checkFailed")]}
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
      {view.rows.length > 0 ? (
        <KitRows label={t("title")}>
          {view.rows.map((row) => {
            const sender = viewSender(row);
            const id = viewRowId(row);
            return (
              <SenderRow
                key={id}
                sender={sender}
                open={view.openId === id}
                stop={view.openId === null ? id === viewRowId(view.rows[0]!) : view.openId === id}
                {...(waiting ? rowFacts(sender, t, model) : {})}
                place={waiting ? placeOf(sender) : undefined}
                onOpen={() => view.select(id)}
                onMenu={menuFor?.(id)}
              />
            );
          })}
        </KitRows>
      ) : null}
      {view.decided.length > 0 ? (
        <>
          <GroupHeading count={t("pendingCount", { count: view.decided.length })}>
            {t("pendingHeading")}
          </GroupHeading>
          <KitRows label={t("pendingHeading")}>
            {view.decided.map(({ sender }) => (
              <SenderRow
                key={sender.id}
                sender={sender}
                open={view.openId === sender.id}
                stop={view.openId === sender.id}
                where={t("rowWaiting")}
                onOpen={() => view.select(sender.id)}
              />
            ))}
          </KitRows>
        </>
      ) : null}
      {open !== null && menuAt !== null ? (
        <PlaceMenu view={view} sender={open} open={view.shown === "row"} anchor={menuAt} card />
      ) : null}
    </>
  );
}
