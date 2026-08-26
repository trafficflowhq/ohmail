"use client";

/**
 * ═══ TRIAGE IS A PILE OF MAIL, SO IT LOOKS LIKE ONE ═══════════════════════════════════════
 *
 * ── WHAT IT WAS ─────────────────────────────────────────────────────────────────────────
 *
 * Three horizons rendered as `PilesStack` — a stack of tiles, one per entry, showing a title,
 * a subtitle and nothing else. Answer Later, Parked and Resurface are piles of the user's own
 * mail, and they were the only piles in the product a reader could not READ from: no sender
 * avatar, no time, no unread state, no tags, no attachment badge, and above all no way to open
 * the message. To answer something parked you had to remember where it was and find it again
 * in the Ohbox or in Search.
 *
 * ── WHAT IT IS ──────────────────────────────────────────────────────────────────────────
 *
 * The Ohbox's own composition: `ListPane` + `MessageRow` on the left, `ReadColumn` +
 * `MessagePane` on the right. Reading a triage message is now the same act, with the same
 * verbs, as reading an Ohbox message — because it IS the same components.
 *
 * NO THIRD WRAPPER. `TagView` and `HistoryView` already compose these two by hand; a
 * "pile view" abstraction extracted from three callers would be a guess about the fourth, and
 * each of the three differs in exactly the part such a wrapper would have to own (Tag has an
 * admin header, History has a place badge, this has a pile switcher and a run). Two
 * abstractions — the list pane and the message pane — are the ones that exist.
 *
 * ── THE SWITCHER AND THE RUN ARE HEADER FURNITURE ───────────────────────────────────────
 *
 * `ListPane.header` is documented for exactly this ("doorbell, segmented control, bulk bar"),
 * and putting them there is what keeps them on screen while the list scrolls. The Reply Run
 * button had been under the stack, which meant that on a pile of any length it was below the
 * fold — a primary action reachable only by scrolling past everything it operates on.
 *
 * The segmented control keeps its own argument: Answer Later, Park and Resurface are ONE idea
 * at three horizons, so they read as one control with three positions rather than three
 * siblings, and the counts are in the labels because "which of these has anything in it" is the
 * question somebody is asking when they open this screen.
 *
 * THE RUN'S WIRING IS UNTOUCHED. `onStartFR` is the same callback the `f` key has always
 * called; the shell fills it from `piles.replyLater` and a completed reply clears `reply_later`
 * through `reply-send.ts`'s settle. This slice moved where the button is, not what it does —
 * see `test/triage-split.test.ts`, which pins both ends.
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage, TagDTO, TriagePileEntry, TriagePiles } from "@ohmail/client-engine";
import {
  Button,
  Icon,
  ListPane,
  ListRows,
  MessageRow,
  ReadColumn,
  SegmentedControl,
} from "@ohmail/ui";
import { avatarOf, rowStamp, hueOf, resurfaceLabel, rowAddress, senderName, tagsOfMessage } from "../shell/format";
import { useKeyBindings } from "../shell/keymap";
import { useZoneNav } from "../shell/zone-nav";
import { MessagePane, type MessageAction } from "../shell/MessagePane";
import { TRIAGE_PILES, type TriagePileId } from "../shell/routing";

/** Below this the reading column is `display:none` (app.css), so a tap must open the sheet. */
function readColumnHidden(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia?.("(max-width: 900px)").matches === true
  );
}

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
  pile,
  onPile,
  frDone,
  onStartFR,
  messageOf,
  tags,
  threadParticipants,
  absoluteTime,
  onToggleTime,
  now,
  onOpen,
  hydrateBody,
  onAction,
  onAddTag,
}: {
  piles: TriagePiles;
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
   * THE DATE STAMPS — which form they are in, and the press that flips them.
   *
   * One boolean for every row at once: the shell owns it, resets it on a view switch and shares
   * it with the open message, so no two dates on screen are ever in different shapes. `rowStamp`
   * turns the pair into the row's stamp props. Optional, and absent leaves the rows exactly as
   * they were — relative dates, the exact instant on hover, nothing to press.
   *
   * THE RESURFACE PILE IS OUT OF ITS REACH, and deliberately: those rows are stamped with when
   * the message COMES BACK, not when it arrived, so there is no second form of that stamp to flip
   * to and the message's own date is not what the row is about. See the row below.
   */
  absoluteTime?: boolean;
  onToggleTime?: () => void;
  tags: TagDTO[];
  now: Date;
  /** The reader sheet — the narrow-width tap, where there is no reading column. */
  onOpen: (m: EngineMessage) => void;
  /** Hydrate the reading column's message, the way Tag and History hydrate theirs. */
  hydrateBody: (id: string, opts?: { retry?: boolean }) => void;
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
}) {
  const t = useTranslations("triage");
  /* The message verbs' own labels, shared with the global map — the `?` sheet must read one
     sentence for `a` whether the Ohbox's binding answers or this view's does. */
  const ts = useTranslations("shortcuts");
  /* The "Done" release control's copy lives in the Ohbox namespace with the verb's other faces
     (the action bar's `actionDone`, the pinned row's) — ONE wording source, not a per-view copy. */
  const to = useTranslations("ohbox");
  /* The reading column's region name — shared with every split view (`ReadColumn`). */
  const tReader = useTranslations("reader");
  const total =
    piles.replyLater.length + piles.setAside.length + piles.resurface.length;
  const entries = PILE_ENTRIES[pile](piles);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  /**
   * The message the reading column shows — the user's pick, or the pile's first OPENABLE entry
   * so the column is never blank beside a list that has rows. Safe here as it is in Tag and
   * History: this list does not re-partition under the fallback (a pile's membership changes
   * only when the user files something), so it cannot re-point at a message nobody chose.
   */
  const openable = entries
    .map((e) => (e.messageId ? messageOf(e.messageId) : null))
    .filter((m): m is EngineMessage => m !== null);
  const shown = openable.find((m) => m.id === selectedId) ?? openable[0] ?? null;

  /** The cursor is per-pile. Switching horizons must not leave the reader on the last pile's mail. */
  useEffect(() => setSelectedId(null), [pile]);

  useEffect(() => {
    if (shown) hydrateBody(shown.id);
  }, [shown?.id, hydrateBody]);

  // `f` starts the Reply Run from here without the shell's "go to Triage first" hop.
  //
  // ═══ THE MESSAGE VERBS, ALIVE IN THE PILES ═════════════════════════════════════════════
  //
  // `a`, `e`, `b` and `r` were dead inside this view — no request, no toast, no state change
  // — while the footer buttons beside them worked and the same keys worked in the Ohbox. The
  // cause was structural: the global bindings act on the shell's `focused`, which has no arm
  // for this view because the cursor here (`shown`) is view-local state the shell cannot see.
  // So the view declares its own, exactly as the registry intends ("views declare their own"),
  // acting on the message the reading column is showing — the same `onAction` seam the pane's
  // footer dispatches through, so the key and the button remain one code path. On a message
  // already in the pile a key names, the shell's toggle takes it OUT (`state:"none"` — the
  // un-triage path), which is what makes a mis-key recoverable from right here.
  const verbs = shown
    ? ([
        { chord: "a", key: "answerLater", action: "later" },
        { chord: "e", key: "park", action: "aside" },
        { chord: "b", key: "resurface", action: "resurface" },
        { chord: "r", key: "reply", action: "reply" },
      ] as const)
    : [];
  useKeyBindings([
    {
      chord: "f",
      group: "message",
      label: t("keyReplyRun"),
      disabled: piles.replyLater.length === 0,
      run: onStartFR,
    },
    ...verbs.map((v) => ({
      chord: v.chord,
      group: "message" as const,
      label: ts(v.key),
      run: () => shown && onAction(v.action, shown),
    })),
  ]);

  const openRow = (m: EngineMessage) => {
    if (readColumnHidden()) onOpen(m);
    else setSelectedId(m.id);
  };

  /**
   * ↓/↑ WALK THE PILE AS RENDERED — the zone model's list zone (`zone-nav.tsx`), and this
   * view's first list-cursor keys. The walk is over `openable` — the entries a cursor can
   * stand on, the same order `shown` falls back through — so a demo orphan (an entry with no
   * message behind it) is never a keyboard stop, exactly as it is not a button. Selecting
   * shows and shows only: triage writes nothing on display. → into the pane is a focus move;
   * where the column is hidden it is the sheet, the same answer a tap gets (`openRow`).
   */
  const navAt = shown ? openable.findIndex((m) => m.id === shown.id) : -1;
  useZoneNav({
    list: {
      followId: shown?.id ?? null,
      up: {
        disabled: navAt <= 0,
        run: () => {
          if (navAt > 0) setSelectedId(openable[navAt - 1]!.id);
        },
        label: to("keyPrev"),
      },
      down: {
        disabled: navAt >= openable.length - 1,
        run: () => {
          if (navAt < openable.length - 1) setSelectedId(openable[navAt + 1]!.id);
        },
        label: to("keyNext"),
      },
    },
    reader: {
      selector: ".view-triage .read-col",
      disabled: shown == null,
      onHiddenEnter: () => {
        if (shown) onOpen(shown);
      },
    },
  });

  /**
   * One entry, as a row.
   *
   * `time` is the RESURFACE INSTANT on the resurface pile and the message's own date
   * everywhere else. That is the pile's whole subject — a resurfacing message is defined by
   * when it comes back, and its arrival date is the one fact about it nobody is asking for.
   *
   * `fr-done` is the Reply Run's session mark, and it is a class rather than a `MessageRow`
   * prop for two reasons: the pane is shared with the desktop shell and knows nothing about
   * runs, and the mark it replaces was `style={{ opacity: 0.38 }}` on a tile — a purely visual
   * dim with no accessible signal, so nothing is lost by keeping it purely visual here.
   */
  const row = (entry: TriagePileEntry, index: number) => {
    const m = entry.messageId ? messageOf(entry.messageId) : null;
    const done = frDone.has(entry.messageId ?? entry.title);
    const when = entry.resurfaceAt ? resurfaceLabel(entry.resurfaceAt) : undefined;

    if (!m) {
      /* AN ENTRY WITH NO MESSAGE BEHIND IT IS NOT A BUTTON. The demo world's `triage_item`
         rows have nothing to open, and rendering them through `MessageRow` would put a
         focusable control on screen whose press does nothing — the inert affordance the
         product removes wherever it finds one. Same `.row` chrome, no interaction. */
      return (
        <div className={done ? "row seen fr-done" : "row seen"} key={`orphan-${index}`}>
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
        key={m.id}
        id={m.id}
        from={senderName(m)}
        address={rowAddress(m)}
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
        threadCount={m.threadCount}
        hasAttachment={m.hasAttachments}
        protected={m.protected != null}
        tags={tagsOfMessage(m, tags).map((x) => ({ name: x.name, hue: hueOf(x) }))}
        {...(done ? { className: "fr-done" } : {})}
        /* "DONE" ON A SCHEDULED RESURFACE — the same release verb the pinned row and the action
           bar carry, read honestly for a row that is NOT pinned yet: the shell's `resurface_done`
           arm clears the booking (`triage_set: none`) and then files the message with the same
           deliberate read every release takes — unscheduled, read, top of "Earlier". Never a new
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
            {/* THE REPLY RUN BELONGS TO ONE PILE, SO IT IS ON ONE PANE.
                It was under all three, saying "Steps through the Answer Later pile, one message
                per screen" while Parked was on screen — a primary action that operates on a
                different pile than the one being looked at reads as misplacement, and it is:
                the run's items are `piles.replyLater` whichever pane you start it from. Scoped
                rather than re-worded, because no wording makes a button that acts elsewhere
                belong here.

                The other two piles keep the same row and put their own one-line explanation in
                it, so the header is one shape at three horizons rather than a band that appears
                and disappears as the segments change. */}
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
        <ListRows>
          {entries.length ? (
            entries.map(row)
          ) : (
            /* THE PILE'S OWN EMPTINESS, in the `.empty` shape every other pile uses. It states
               what the pile is FOR, which is the only useful thing to say about an empty one —
               the same job the tile stack's hint line did, one layer up.

               THE HINT RENDERS ONCE. On Parked and Resurface the header's `.triage-cta` line is
               already this exact sentence, so the empty state repeating it put the same subtitle
               on screen twice, ~150px apart. Only the Answer Later pane — whose header carries
               the Reply Run's note instead — still needs the hint down here. */
            <div className="empty">
              <span className="glyph" aria-hidden="true">◷</span>
              <b>{t(PILE_EMPTY[pile])}</b>
              {pile === "reply" ? t(PILE_HINT[pile]) : null}
            </div>
          )}
        </ListRows>
      </ListPane>
      {/* THE READING COLUMN — the Ohbox's own. No `onEnterReader` on the pane, for the reason
          the Ohbox and Tag omit it: the "open reading mode" button would sit at exactly the
          widths where the sheet duplicates this column. */}
      <ReadColumn regionLabel={tReader("pane")}>
        {shown ? (
          <MessagePane
            message={shown}
            tags={tags}
            now={now}
            onAction={(a) => onAction(a, shown)}
            onAddTag={onAddTag}
          />
        ) : null}
      </ReadColumn>
    </section>
  );
}
