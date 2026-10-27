"use client";

/**
 * Triage is a pile of mail, so it looks like one. The three horizons used to render as a stack of tiles with a title
 * and nothing else — the only piles a reader could not READ from. Now it is the Ohbox's own composition: `ListPane` +
 * `MessageRow` on the left, `ReadColumn` + `MessagePane` on the right — the same components, the same verbs. No third
 * wrapper: `TagView` and `HistoryView` compose the same two by hand, and each differs exactly where a shared wrapper
 * would have to own the difference. The switcher and the Reply Run button are `ListPane.header` furniture, on screen
 * while the list scrolls (the Run button used to sit below the fold, under the stack). The Run's wiring is untouched:
 * `onStartFR` is the `f` key's callback, the shell fills it from `piles.replyLater`, and a completed reply clears
 * `reply_later` — `test/triage-split.test.ts` pins both ends.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRowBadgeCopy } from "../shell/row-copy";
import { rowThreadOf } from "../shell/row-thread";
import { type EngineMessage, type TagDTO, type TriagePileEntry, type TriagePiles } from "@ohmail/client-engine";
import {
  Button,
  Icon,
  ListPane,
  ListRows,
  MessageRow,
  SegmentedControl,
} from "@ohmail/ui";
import { avatarOf, rowStamp, hueOf, resurfaceLabel, rowAddress, senderName, tagsOfMessage } from "../shell/format";
import { useSenderCheckWords } from "../shell/sender-check";
import { useKeyBindings } from "../shell/keymap";
import { useMessageVerbs } from "../shell/message-verbs";
import { useZoneNav } from "../shell/zone-nav";
import { ListEmpty, ListReadColumn, useListView } from "../shell/list-view";
import { useListWindow } from "../shell/list-window";
import { useColumnPick } from "../shell/column-pick";
import { MessagePane, type MessageAction } from "../shell/MessagePane";
import { useReaderVisit, type ReaderMarkSeen } from "../shell/reader-seen";
import { TRIAGE_PILES, type TriagePileId } from "../shell/routing";


/** The pile's own name, for the segment label. */
const PILE_KEY: Record<TriagePileId, "replyLater" | "setAside" | "resurface"> = {
  reply: "replyLater",
  aside: "setAside",
  resurface: "resurface",
};

/**
 * The pile's entries, its count and its one-line explanation, as ONE table.
 *
 * A table rather than a switch so the segment list, the counts and the rendered rows are three
 * reads of the SAME three-member union — adding a horizon fails to compile in all of them at
 * once rather than in one.
 */
const PILE_ENTRIES: Record<TriagePileId, (p: TriagePiles) => TriagePileEntry[]> = {
  reply: (p) => p.replyLater,
  aside: (p) => p.setAside,
  resurface: (p) => p.resurface,
};

const PILE_HINT: Record<TriagePileId, "hintReply" | "hintAside" | "hintResurface"> = {
  reply: "hintReply",
  aside: "hintAside",
  resurface: "hintResurface",
};

const PILE_EMPTY: Record<TriagePileId, "emptyReply" | "emptyAside" | "emptyResurface"> = {
  reply: "emptyReply",
  aside: "emptyAside",
  resurface: "emptyResurface",
};

export function TriageView({
  piles,
  settled,
  owed,
  pile,
  onPile,
  frDone,
  onStartFR,
  messageOf,
  tags,
  threadParticipants,
  threadCountOf,
  absoluteTime,
  onToggleTime,
  now,
  onOpen,
  locateId,
  onPick,
  hydrateBody,
  onAction,
  onAddTag,
  onScreen = () => {},
  canDelete = () => false,
  canReplyAll = () => false,
  onMarkSeen,
}: {
  piles: TriagePiles;
  /** `MailState.settled` / `owed`: an empty pile is said only over a read mirror. */
  settled: boolean;
  owed: boolean;
  /** Which horizon is open — `route.triagePile`. */
  pile: TriagePileId;
  onPile: (next: TriagePileId) => void;
  /** Message ids / titles completed in the Reply Run this session. */
  frDone: Set<string>;
  onStartFR: () => void;
  /**
   * THE MESSAGE BEHIND A PILE ENTRY, or null.
   *
   * A resolver rather than a message array, because the piles are already a projection and
   * re-deriving them here would be a second answer to "what is in Answer Later". Null is a real
   * case and not a defect: the demo world carries `triage_item` rows with no backing message
   * (`fixtures-adapter.ts`), and those cannot be opened by anything.
   */
  messageOf: (messageId: string) => EngineMessage | null;
  /**
   * THE PEOPLE IN A ROW'S CONVERSATION, for its lead circles — bound to the engine's reader by
   * the shell (this view has none) and mapped to `{initials, hue}`. A LOOKUP into the shell's
   * per-version thread index, so calling it per row costs nothing; `[]` for a message whose
   * thread has no second voice in it, and the row then leads with the one sender's circle it
   * always did. Optional, so a view mounted without it (the demo, most tests) is unchanged.
   */
  threadParticipants?: (threadId: string) => { initials: string; hue: number }[];
  /**
   * HOW LONG THE CONVERSATION IS, from the engine's one index (`AppShell`) — 0 where the mirror
   * knows of no thread, which is a row standing for itself. The view has no reader of its own,
   * exactly as {@link threadParticipants} has none.
   */
  threadCountOf?: (threadId: string) => number;
  /**
   * The date stamps — which form they are in, and the press that flips them. One boolean for every
   * row at once: the shell owns it, resets it on a view switch and shares it with the open message,
   * so no two dates on screen are ever in different shapes; `rowStamp` turns the pair into the row's
   * stamp props. Optional — absent leaves the rows as they were. The resurface pile is out of its
   * reach, deliberately: those rows are stamped with when the message COMES BACK, not when it
   * arrived, so there is no second form to flip to.
   */
  absoluteTime?: boolean;
  onToggleTime?: () => void;
  tags: TagDTO[];
  now: Date;
  /** The reader sheet — the narrow-width tap, where there is no reading column. */
  onOpen: (m: EngineMessage) => void;
  /** The URL's open message on this view, and where the view's own pick is reported — `useColumnPick`. */
  locateId?: string | null;
  onPick?: (id: string | null) => void;
  /** Hydrate the reading column's message, the way Tag and History hydrate theirs. */
  hydrateBody: (id: string, opts?: { retry?: boolean }) => void;
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
  /** The shell's gates for the message verbs — see `useMessageVerbs`. A bare mount (tests)
   *  leaves delete and reply-all resting. */
  onScreen?: (messageId: string, anchor: HTMLElement | null) => void;
  canDelete?: (message: EngineMessage) => boolean;
  canReplyAll?: (message: EngineMessage) => boolean;
  /** The shell's `markSeen`: the column's read rule writes through it (`useReaderVisit`). */
  onMarkSeen: ReaderMarkSeen;
}) {
  const t = useTranslations("triage");
  const rowBadge = useRowBadgeCopy();
  const { row: senderCheckRow } = useSenderCheckWords();
  /* The "Done" release control's copy lives in the Ohbox namespace with the verb's other faces
     (the action bar's `actionDone`, the pinned row's) — ONE wording source, not a per-view copy. */
  const to = useTranslations("ohbox");
  /* The reading column's region name — shared with every split view (`ReadColumn`). */
  const tReader = useTranslations("reader");
  const total =
    piles.replyLater.length + piles.setAside.length + piles.resurface.length;
  const entries = PILE_ENTRIES[pile](piles);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  /** The column's row — the pick, else the pile's first OPENABLE entry — or the gone notice (`useListView`). */
  const openable = entries
    .map((e) => (e.messageId ? messageOf(e.messageId) : null))
    .filter((m): m is EngineMessage => m !== null);
  /** A row covers its conversation's members and faces its newest one, so any member names the row's target. */
  const rowTarget = (id: string | null | undefined): string | null => {
    if (id == null) return null;
    const e = entries.find((x) => x.messageId === id || x.memberIds?.includes(id));
    return e?.messageId ?? null;
  };
  const picked = rowTarget(selectedId) ?? selectedId;
  const list = useListView({ rows: openable, settled, pending: owed, picked });
  const shown = list.shown;
  /* The column's visit: entered by an open, → or the person's own press or scroll in it. */
  const visit = useReaderVisit({ shown, markSeen: onMarkSeen });
  const readColRef = useRef<HTMLDivElement>(null);

  /** The cursor is per-pile. Switching horizons must not leave the reader on the last pile's mail. */
  useEffect(() => setSelectedId(null), [pile]);
  // A newer member joined the open row: the cursor follows the row to its new target.
  useEffect(() => {
    if (picked !== selectedId) setSelectedId(picked);
  }, [picked, selectedId]);
  const locatedId = rowTarget(locateId);
  useColumnPick({
    picked, shown: list.standsFor, locateId: locatedId ?? locateId,
    located: locatedId !== null && openable.some((m) => m.id === locatedId),
    select: setSelectedId, onPick,
  });

  useEffect(() => {
    if (shown) hydrateBody(shown.id);
  }, [shown?.id, hydrateBody]);

  // `f` starts the Reply Run from here without the shell's "go to Triage first" hop.
  useKeyBindings([
    {
      chord: "f",
      group: "message",
      label: t("keyReplyRun"),
      disabled: piles.replyLater.length === 0,
      run: onStartFR,
    },
  ]);

  /**
   * Opening a row moves the cursor, on BOTH layouts — it used to move it on only one. `shown` falls
   * back to `openable[0]` when `selectedId` is null, so on the narrow layout — where opening a row
   * raised the reader and set no cursor — every view-local verb acted on a message the reader was
   * not showing: `⇧F` would forward a different person's mail, `a`/`e`/`b`/`r` filed the wrong row.
   * The cursor is set FIRST and unconditionally, so `shown` is "the message this view is showing"
   * on both layouts — what every one of those verbs already assumes. The wide path is unchanged;
   * the narrow path additionally raises the reader, exactly as before.
   */
  const openRow = (m: EngineMessage) => {
    setSelectedId(m.id);
    if (list.columnHidden()) onOpen(m);
    else visit.enter(m.id);
  };

  /**
   * ↓/↑ WALK THE PILE AS RENDERED — the zone model's list zone (`zone-nav.tsx`), and this
   * view's first list-cursor keys. The walk is over `openable` — the entries a cursor can
   * stand on, the same order `shown` falls back through — so a demo orphan (an entry with no
   * message behind it) is never a keyboard stop, exactly as it is not a button. Selecting
   * shows and shows only, a preview the read rule never counts. → into the pane enters it;
   * where the column is hidden it is the sheet, the same answer a tap gets (`openRow`).
   */
  const navAt = shown ? openable.findIndex((m) => m.id === shown.id) : -1;
  /** The pile is a window (`useListWindow`): a horizon has no upper bound, so it mounts the slice on screen. */
  const scrollerRef = useRef<HTMLDivElement>(null);
  const win = useListWindow({ scrollerRef, count: entries.length });
  const selectRow = (id: string): void => {
    setSelectedId(id);
    // Keep the new cursor in view — the registry preventDefaults the arrows, so nothing
    // scrolls natively. `?.` on the METHOD: jsdom mounts this view without implementing it.
    // A row the window has not mounted is reached through its slot, which mounts it.
    queueMicrotask(() => {
      const row = document.querySelector<HTMLElement>(`.view-triage .row[data-id="${CSS.escape(id)}"]`);
      if (row) {
        row.scrollIntoView?.({ block: "nearest" });
        return;
      }
      const el = scrollerRef.current;
      const at = entries.findIndex((e) => e.messageId === id);
      if (el && at >= 0) {
        el.scrollTop = Math.max(0, win.offsetOf(at) - win.rowHeight);
        el.dispatchEvent(new Event("scroll"));
      }
    });
  };
  /* The message verbs over this view's cursor, from the one table Folder, Tag and History use:
     the global ones act on the shell's `focused`, which has no arm for this view. */
  useMessageVerbs({
    shown, scope: ".view-triage", onAction, onAddTag, onScreen, canDelete, canReplyAll,
    rows: openable, select: selectRow,
  });

  useZoneNav({
    list: {
      followId: shown?.id ?? null,
      up: {
        disabled: navAt <= 0,
        run: () => {
          if (navAt > 0) selectRow(openable[navAt - 1]!.id);
        },
        label: to("keyPrev"),
      },
      down: {
        disabled: navAt >= openable.length - 1,
        run: () => {
          if (navAt < openable.length - 1) selectRow(openable[navAt + 1]!.id);
        },
        label: to("keyNext"),
      },
    },
    reader: {
      selector: ".view-triage .read-col",
      disabled: shown == null,
      onEnter: () => { if (shown) visit.enter(shown.id); },
      onHiddenEnter: () => {
        if (shown) onOpen(shown);
      },
    },
  });

  /**
   * One entry, as a row. `time` is the RESURFACE INSTANT on the resurface pile and the message's own
   * date everywhere else — a resurfacing message is defined by when it comes back, and its arrival
   * date is the one fact nobody is asking for. `fr-done` is the Reply Run's session mark, a class
   * rather than a `MessageRow` prop for two reasons: the pane is shared with the desktop shell and
   * knows nothing about runs, and the mark it replaces was a purely visual dim on a tile with no
   * accessible signal, so nothing is lost by keeping it purely visual here.
   */
  const row = (entry: TriagePileEntry, index: number) => {
    const m = entry.messageId ? messageOf(entry.messageId) : null;
    const done = frDone.has(entry.messageId ?? entry.title);
    const when = entry.resurfaceAt ? resurfaceLabel(entry.resurfaceAt, now) : undefined;

    if (!m) {
      /* AN ENTRY WITH NO MESSAGE BEHIND IT IS NOT A BUTTON. The demo world's `triage_item`
         rows have nothing to open, and rendering them through `MessageRow` would put a
         focusable control on screen whose press does nothing — the inert affordance the
         product removes wherever it finds one. Same `.row` chrome, no interaction. */
      return (
        <div className={done ? "row seen fr-done" : "row seen"} key={`orphan-${index}`} data-index={index}>
          <span className="row-top">
            <span className="who">{entry.title}</span>
            {when ? <span className="t num">{when}</span> : null}
          </span>
          <span className="row-mid">
            <span className="subj">{entry.subtitle ?? ""}</span>
          </span>
          {entry.preview ? <span className="prev">{entry.preview}</span> : null}
        </div>
      );
    }

    return (
      <MessageRow
        spoken={rowBadge.spoken}
        key={m.id}
        id={m.id}
        windowIndex={index}
        inSet={{ size: entries.length, position: index + 1 }}
        from={senderName(m)}
        address={rowAddress(m)}
        {...senderCheckRow(m)}
        {...avatarOf(m)}
        participants={m.threadId ? threadParticipants?.(m.threadId) : undefined}
        /* A resurface row's stamp is the instant it COMES BACK — the pile's whole subject, and a
           future one. It has no relative/absolute pair to flip between, and flipping it to the
           message's arrival date would answer a question this pile is not asking, so it stays a
           plain stamp with nothing to press. Every other pile is stamped with the message's own
           date and takes the flip. */
        {...(pile === "resurface" ? { time: when } : rowStamp(m, now, absoluteTime, onToggleTime))}
        subject={m.subject}
        preview={m.protected ? undefined : m.snippet}
        unread={m.unread}
        seen={!m.unread}
        selected={shown?.id === m.id}
        {...rowThreadOf(m, threadCountOf, rowBadge.thread)}
        hasAttachment={m.hasAttachments}
        protectedLabel={m.protected != null ? rowBadge.protectedLabel : undefined}
        tags={tagsOfMessage(m, tags).map((x) => ({ name: x.name, hue: hueOf(x) }))}
        {...(done ? { className: "fr-done" } : {})}
        /* "DONE" ON A SCHEDULED RESURFACE — the same release verb the pinned row and the action
           bar carry, read honestly for a row that is NOT pinned yet: the shell's `resurface_done`
           arm clears the booking (`triage_set: none`) and then files the message with the same
           deliberate read every release takes — unscheduled, read, at its arrival in "Earlier". Never a new
           state. Only this pile's rows carry it: Answer Later and Parked have their own toggles,
           and "done" is a claim about a RESURFACE. Same reveal grammar as the pinned row's
           control (`.rsf-done`, app.css). */
        {...(pile === "resurface"
          ? {
              actions: (
                <button
                  type="button"
                  className="rsf-done"
                  aria-label={to("rowDoneScheduledAria")}
                  title={to("rowDoneScheduledAria")}
                  onClick={() => onAction("resurface_done", m)}
                >
                  <Icon name="check" size={12} />
                  {to("actionDone")}
                </button>
              ),
            }
          : {})}
        onClick={() => openRow(m)}
      />
    );
  };

  return (
    <section className="view split view-triage">
      <ListPane
        title={t("title")}
        meta={t("meta", { count: total })}
        scrollerRef={scrollerRef}
        header={
          <>
            <SegmentedControl<TriagePileId>
              ariaLabel={t("pilesAria")}
              value={pile}
              onChange={onPile}
              className="triage-seg"
              options={TRIAGE_PILES.map((id) => ({
                id,
                label: t("segLabel", { name: t(PILE_KEY[id]), count: PILE_ENTRIES[id](piles).length }),
              }))}
            />
            {/*
                THE REPLY RUN BELONGS TO ONE PILE, SO IT IS ON ONE PANE. It was under all three, saying "Steps through
                the Answer Later pile, one message per screen" while Parked was on screen — a primary action that
                operates on a different pile than the one being looked at reads as misplacement, and it is: the run's
                items are `piles.replyLater` whichever pane you start it from. Scoped rather than re-worded, because
                no wording makes a button that acts elsewhere belong here. The other two piles keep the same row and
                put their own one-line explanation in it, so the header is one shape at three horizons rather than a
                band that appears and disappears as the segments change.
              */}
            <div className="triage-cta">
              {pile === "reply" ? (
                <Button variant="primary" icon="spark" kbdHint="f" onClick={onStartFR}>
                  {t("cta")}
                </Button>
              ) : null}
              <span>{pile === "reply" ? t("ctaNote") : t(PILE_HINT[pile])}</span>
            </div>
          </>
        }
        /* NO `hints` STRIP. The panes that keep one keep only the `? shortcuts` affordance
           (`ShortcutHint`) — the legends are gone everywhere. This view binds one chord, `f`,
           already printed on the Reply Run button by `kbdHint`, and `?` works here without
           being advertised at every pane foot in the app. */
      >
        <ListRows ariaLabel={t("title")}>
          {entries.length ? (
            <>
              <div aria-hidden data-window-top="" style={{ height: win.padTop }} />
              {entries.slice(win.start, win.end).map((e, k) => row(e, win.start + k))}
              {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
            </>
          ) : (
            /* THE PILE'S OWN EMPTINESS, in the `.empty` shape every other pile uses. It states
               what the pile is FOR, which is the only useful thing to say about an empty one —
               the same job the tile stack's hint line did, one layer up.

               THE HINT RENDERS ONCE. On Parked and Resurface the header's `.triage-cta` line is
               already this exact sentence, so the empty state repeating it put the same subtitle
               on screen twice, ~150px apart. Only the Answer Later pane — whose header carries
               the Reply Run's note instead — still needs the hint down here. */
            <ListEmpty
              list={list}
              glyph="◷"
              title={t(PILE_EMPTY[pile])}
              hint={pile === "reply" ? t(PILE_HINT[pile]) : null}
            />
          )}
        </ListRows>
      </ListPane>
      {/* THE READING COLUMN — the Ohbox's own. No `onEnterReader` on the pane, for the reason
          the Ohbox and Tag omit it: the "open reading mode" button would sit at exactly the
          widths where the sheet duplicates this column. */}
      <ListReadColumn
        list={list}
        regionLabel={tReader("pane")}
        /* The column's own way out under a thumb in the two-pane band (DESIGN-FOLD-WIDTHS §1): only
           while a row is picked — the column's first-row fallback has nothing to close. */
        onClose={selectedId !== null ? () => { setSelectedId(null); onPick?.(null); } : undefined}
        closeLabel={tReader("closeColumn")}
        scrollerRef={readColRef}
      >
        {(m) => (
          <MessagePane
            message={m}
            tags={tags}
            now={now}
            onAction={(a) => onAction(a, m)}
            onAddTag={onAddTag}
            scroller={readColRef}
            threadRead={visit.wiring ?? undefined}
          />
        )}
      </ListReadColumn>
    </section>
  );
}
