import { MailRow } from "../place-list/MailRowMenu.js";
/**
 * DRAFTS' LIST: the sends set for later first, each with Cancel send and when it sends; then the drafts, each with
 * Discard (one press, with Undo). A row that holds a send nobody could confirm says so on its row; its two answers
 * stand in the reading column when it is open. Opening a row is the door's: a reply as that reply, else the composer.
 */
import { useContext, useRef } from "react";
import { useListWindow } from "@ohmail/app-logic/lists";
import type { EngineDraft } from "@ohmail/wire";
import { heldSentence, isHeld, useDraftsModel, type DraftsModel } from "@ohmail/app-logic/drafts";
import { Empty, RefusalLine } from "@ohmail/ui/base";
import { GroupHeading, ListHead, Rows, type RowProps } from "@ohmail/ui/mail";
import { FrameContext } from "../frame/commands.js";
import type { PaneProps } from "../frame/contract.js";
import { ListColumn, ListMenu } from "../place-list/index.js";
import { useText, type Text } from "../text/index.js";
import { useWritingIfMounted } from "../write/above.js";
import type { Writing } from "../write/ports.js";
import { letterDiscardHeld } from "../write/verbs/Verbs.js";
import { DraftOpenedAtContext } from "./DraftsAbove.js";
import { recipientsOf, refusalKey } from "./words.js";
import "./scheduled.css";
import "./list.css";

function focusRefusal(line: HTMLParagraphElement | null): void {
  if (line?.parentElement?.contains(line.ownerDocument.activeElement)) line.focus();
}

export function DraftsList({ route, plan }: PaneProps) {
  const model = useDraftsModel();
  const commands = useContext(FrameContext)?.api.commands;
  const t = useText("drafts");
  const composer = useWritingIfMounted();
  const writing = route.place === "write" ? composer : null;
  const boundDraft = writing?.plan.mutation.draftId;
  const openDraft = boundDraft ?? route.open;
  const unsaved = writing && openDraft == null ? writing : undefined;
  const openedAt = useContext(DraftOpenedAtContext);
  const composerDiscard =
    writing && !letterDiscardHeld(writing.composeSend)
      ? { label: t("discard"), onPress: writing.discardCompose }
      : undefined;
  const unsavedCount = unsaved ? 1 : 0;
  const draftCount = model.drafts.length + unsavedCount;
  const count = draftCount + model.scheduled.length;
  const scroller = useRef<HTMLDivElement>(null);
  const appointments = model.scheduled.length;
  // Each heading that is drawn takes one window slot.
  const hasDraftsHeading = appointments > 0 && draftCount > 0;
  const draftsStart = appointments ? 1 + appointments + Number(hasDraftsHeading) : 0;
  const win = useListWindow({ scrollerRef: scroller, count: draftsStart + draftCount });
  const headingVisible = (index: number) => win.start <= index && index < win.end;
  const scheduledStart = Math.max(0, win.start - 1);
  const savedStart = draftsStart + unsavedCount;
  const draftStart = Math.max(0, win.start - savedStart);
  const showUnsaved = unsaved && headingVisible(draftsStart);
  const showDraftsHeading = hasDraftsHeading && headingVisible(draftsStart - 1);
  const scheduled = model.scheduled.slice(scheduledStart, Math.max(0, win.end - 1));
  const drafts = model.drafts.slice(draftStart, Math.max(0, win.end - savedStart));
  const rows = (
    <>
      <div aria-hidden data-window-top="" style={{ height: win.padTop }} />
      {appointments > 0 && (headingVisible(0) || scheduled.length > 0) ? (
        <section className="dr-scheduled" aria-label={t("scheduledTitle")}>
          {headingVisible(0) ? (
            <div data-index={0}>
              <GroupHeading count={String(appointments)}>{t("scheduledTitle")}</GroupHeading>
            </div>
          ) : null}
          <Rows label={t("scheduledTitle")}>
            {scheduled.map((d, i) => (
              <ScheduledRow
                key={d.id}
                d={d}
                model={model}
                t={t}
                open={route.open === d.id}
                index={1 + scheduledStart + i}
              />
            ))}
          </Rows>
        </section>
      ) : null}
      {showUnsaved || drafts.length > 0 || showDraftsHeading ? (
        <section aria-label={t("title")}>
          {showDraftsHeading ? (
            <div data-index={draftsStart - 1}>
              <GroupHeading count={String(draftCount)}>{t("title")}</GroupHeading>
            </div>
          ) : null}
          <Rows label={t("title")}>
            {showUnsaved ? (
              <CurrentDraft
                composer={unsaved}
                t={t}
                index={draftsStart}
                count={draftCount}
                discard={composerDiscard}
                when={openedAt ? model.stamp(openedAt) : undefined}
              />
            ) : null}
            {drafts.map((d, i) => (
              <DraftRow
                key={d.id}
                d={d}
                model={model}
                t={t}
                open={openDraft === d.id}
                discard={
                  boundDraft === d.id
                    ? composerDiscard
                    : { label: t("discard"), onPress: () => model.discard(d.id) }
                }
                index={savedStart + draftStart + i}
                position={unsavedCount + draftStart + i + 1}
                count={draftCount}
              />
            ))}
          </Rows>
        </section>
      ) : null}
      {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
      {model.empty && draftCount === 0 ? <DraftsEmpty write={commands && (() => commands.write())} /> : null}
      {model.loading ? <Empty label={t("listLoading")} /> : null}
    </>
  );
  return (
    <ListColumn
      plan={plan}
      scrollerRef={scroller}
      head={
        <ListHead
          title={t("title")}
          count={model.draftsSettled && count > 0 ? t("metaCount", { count }) : undefined}
          aside={<ListMenu label={t("listMenu")} mail />}
        />
      }
    >
      {rows}
    </ListColumn>
  );
}

function DraftsEmpty({ write }: { write: (() => void) | undefined }) {
  const t = useText("drafts");
  return (
    <div className="drafts-empty">
      <Empty label={t("emptyTitle")} act={write ? { label: t("emptyWrite"), onPress: write } : undefined} />
    </div>
  );
}

/** An open letter has a row while it is still only in the editor. */
function CurrentDraft({
  composer,
  t,
  index,
  count,
  discard,
  when,
}: {
  composer: Writing;
  t: Text;
  index: number;
  count: number;
  discard: RowProps["own"];
  when?: string;
}) {
  const { compose, plan } = composer;
  const to = recipientsOf({ to: plan.addresses, cc: plan.cc.addresses, bcc: plan.bcc.addresses });
  const who = to ? t("rowTo", { name: to }) : t("noRecipient");
  const subject = compose.subject.trim() || t("noSubject");
  return (
    <div data-index={index}>
      <MailRow
        who={who}
        people={[]}
        sign="write"
        subject={subject}
        preview={compose.body}
        when={when}
        open
        own={discard}
        menuItems={
          discard?.onPress
            ? () => [{ label: discard.label, icon: "trash", onPress: discard.onPress! }]
            : undefined
        }
        listing={{ name: `${who}: ${subject}`, selected: true, place: { at: 1, of: count } }}
      />
    </div>
  );
}

/** A scheduled send speaks for whom it goes to, with their circle, and says it is a reply. */
function ScheduledRow({
  d,
  model,
  t,
  open,
  index,
}: {
  d: EngineDraft;
  model: DraftsModel;
  t: Text;
  open: boolean;
  index: number;
}) {
  const to = recipientsOf(d);
  const first = [...d.to, ...d.cc, ...d.bcc][0];
  const subject = d.subject.trim() || t("noSubject");
  const sends = d.sendAt ? t("scheduledWhen", { when: model.appointment(d.sendAt) }) : "";
  return (
    <MailRow
      who={to ? t("rowTo", { name: to }) : t("noRecipient")}
      address={first?.address}
      people={first ? [{ name: first.name || first.address, address: first.address }] : []}
      sign="clock"
      labels={model.door.repliesHere(d) ? [t("isReply")] : undefined}
      subject={sends || subject}
      preview={sends ? subject : (d.body ?? undefined)}
      open={open}
      own={{ label: t("scheduledCancel"), onPress: () => model.door.cancelSchedule(d.id) }}
      onOpen={() => model.door.editScheduled(d)}
      menuItems={() => [
        { label: t("scheduledCancel"), icon: "clock", onPress: () => model.door.cancelSchedule(d.id) },
      ]}
      listing={{
        name: `${to || t("noRecipient")}: ${subject}`,
        spoken: sends,
        selected: open,
        place: { at: index, of: model.scheduled.length },
      }}
      mark={{ id: d.id, index }}
    />
  );
}

function DraftRow({
  d,
  model,
  t,
  open,
  index,
  position,
  count,
  discard,
}: {
  d: EngineDraft;
  model: DraftsModel;
  t: Text;
  open: boolean;
  index: number;
  position: number;
  count: number;
  discard: RowProps["own"];
}) {
  const to = recipientsOf(d);
  const subject = d.subject.trim() || t("noSubject");
  const waits = model.door.waiting.has(d.id);
  const held = isHeld(model.door, d);
  const reply = model.door.repliesHere(d);
  const state = waits
    ? t("waitingToSend")
    : held
      ? t(heldSentence(d, model.now))
      : (model.door.notSent.get(d.id) ??
        (d.sendError
          ? t("scheduleFailedNote", { reason: d.sendError })
          : d.sendFiles
            ? t("filesNotKeptNote", { count: d.sendFiles })
            : null));
  const refused = model.refusal?.draftId === d.id ? model.refusal : null;
  return (
    <div className="dr-row" data-id={d.id} data-index={index}>
      <MailRow
        who={to ? t("rowTo", { name: to }) : t("noRecipient")}
        people={[]}
        sign={reply ? "reply" : "drafts"}
        labels={held ? [t("heldLabel")] : reply ? [t("isReply")] : undefined}
        subject={subject}
        preview={(held ? d.body : (state ?? d.body)) ?? undefined}
        when={model.stamp(d.updatedAt)}
        open={open}
        own={discard}
        menuItems={
          discard?.onPress
            ? () => [{ label: discard.label, icon: "trash", onPress: discard.onPress! }]
            : undefined
        }
        onOpen={() => model.door.open(d)}
        listing={{
          name: `${to || t("noRecipient")}: ${subject}`,
          spoken: [held ? t("heldLabel") : reply ? t("isReply") : null, state].filter(Boolean).join(", "),
          selected: open,
          place: { at: position, of: count },
        }}
        mark={{ id: d.id }}
      />
      {held && state ? (
        <span className="oh-vh" role="status">
          {state}
        </span>
      ) : null}
      {refused ? (
        <RefusalLine key={refused.at} alert ref={focusRefusal}>
          {t(refusalKey(refused.why))}
        </RefusalLine>
      ) : null}
    </div>
  );
}
