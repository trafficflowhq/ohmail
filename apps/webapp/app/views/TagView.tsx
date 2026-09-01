"use client";

/**
 * TAG — one tag, across everything.
 *
 * ── READ IN PLACE, NOT JUMP-TO-HOME ─────────────────────────────────────────────────────────
 *
 * This used to open a row with `openMessage`, which navigates to the message's HOME view and
 * selects it there — so clicking a tagged Receipt threw you out of the tag and into Receipts,
 * an aliasing that defeats the lens: a tag is a lens over everything, and following a row
 * out of it leaves the tag behind. It reads in place now, the way History does: the Ohbox's
 * two-pane composition — a list beside a reading column — with a click selecting into the
 * column. The message is read where the tag shows it and the tag never leaves the screen.
 *
 * The `List` / `Split` segmented control that used to sit above the rows is gone, along with the
 * solo mode it defaulted to. It offered a choice between the two-pane shape and a centred list
 * that raised a reader sheet per message, defaulted to the slower one, and reset on every visit,
 * so the choice was re-made every arrival. Under 900px the reading column is `display:none` and
 * a click still raises the shell's sheet — which is why `readColumnHidden()` outlives the modes.
 *
 * ── AND THE TAG IS MANAGED FROM ITS OWN PAGE ────────────────────────────────────────────────
 *
 * Rename and Delete live here as well as in Settings — this is the page a taxonomy is actually
 * built on, and the verbs (`tag_rename`, `tag_delete`, wired through `tagAdmin`) already exist.
 * Delete states the count and that the messages do not move BEFORE it asks, the same standard
 * the Settings pane and the rules pane hold: a tag is ohmail's own row and deleting it removes
 * the labels, never the mail.
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { presentsUnread, type EngineMessage, type TagDTO } from "@ohmail/client-engine";
import { Button, Kbd, ListPane, ListRows, MessageRow, ReadColumn, TagDot } from "@ohmail/ui";
import { MessagePane, type MessageAction } from "../shell/MessagePane";
import { avatarOf, rowStamp, hueOf, placeLabel, rowAddress, senderName, tagsOfMessage } from "../shell/format";
import { useZoneNav } from "../shell/zone-nav";
import { useMessageVerbs } from "../shell/message-verbs";
import { readColumnHidden } from "../shell/narrow";


export interface TagAdmin {
  onRename: (tagId: string, name: string) => void;
  onDelete: (tagId: string) => void;
}

export function TagView({
  tag,
  messages,
  tags,
  threadParticipants,
  absoluteTime,
  onToggleTime,
  now,
  onOpen,
  hydrateBody,
  onAction,
  onAddTag,
  onScreen,
  canDelete,
  canReplyAll,
  admin,
}: {
  tag: TagDTO;
  messages: EngineMessage[];
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
   */
  absoluteTime?: boolean;
  onToggleTime?: () => void;
  tags: TagDTO[];
  now: Date;
  /** The reader sheet, in place — the narrow-width tap, where there is no reading column. */
  onOpen: (m: EngineMessage) => void;
  /** Hydrate the split reading column's message, the way ReadsView hydrates `current`. */
  hydrateBody: (id: string, opts?: { retry?: boolean }) => void;
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
  /* THE THREE SEAMS THE MESSAGE VERBS NEED, resolved by the shell — see
     `useMessageVerbs`' header for why none of them is derived in a view. */
  onScreen: (messageId: string, anchor: HTMLElement | null) => void;
  canDelete: (message: EngineMessage) => boolean;
  canReplyAll: (message: EngineMessage) => boolean;
  /**
   * Rename and delete. Absent leaves the page read-only rather than showing dead controls —
   * the same discipline the Settings pane holds: a surface half-wired is worse than one not.
   */
  admin?: TagAdmin;
}) {
  const t = useTranslations("tag");
  /* The list keys' shared vocabulary and the reading column's region name — the Ohbox's own
     labels and `reader.pane`, so four surfaces never phrase the same gesture apart. */
  const to = useTranslations("ohbox");
  const tReader = useTranslations("reader");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /**
   * The message the reading column shows — the user's pick, or the first row so the column is
   * never blank beside a list that has rows. Safe here as it is in History: the list does not
   * re-partition under the fallback, so it cannot re-point at a message nobody chose.
   */
  const shown = messages.find((m) => m.id === selectedId) ?? messages[0] ?? null;

  useEffect(() => {
    if (shown) hydrateBody(shown.id);
  }, [shown?.id, hydrateBody]);

  /**
   * OPENING A ROW MOVES THE CURSOR, ON BOTH LAYOUTS.
   *
   * The cursor is set FIRST and unconditionally. Before the message verbs were declared here it
   * did not have to be: on the NARROW layout opening a row raised the reader and set no cursor,
   * which was invisible because nothing read the cursor there. Every verb in `useMessageVerbs`
   * reads it, so leaving it unset would make `d`, `⇧F` and the filing keys act on the FIRST row
   * of the list while the reader showed the tapped one — the defect `TriageView` documents
   * having already paid for.
   */
  const openRow = (m: EngineMessage) => {
    setSelectedId(m.id);
    // Where the column is hidden the sheet is the only reading surface; where it is standing the
    // selection above is the whole open, and nothing leaves the screen.
    if (readColumnHidden()) onOpen(m);
  };

  /**
   * ↓/↑ WALK THE LIST AS RENDERED — the zone model's list zone (`zone-nav.tsx`), and this
   * view's first list keys. Selecting SHOWS (the column renders `shown`) and shows only:
   * this view writes no read state on display, so a flick down the tag marks nothing by
   * construction. → into the pane is a focus move; where the column is hidden it is the
   * sheet, the same answer a tap gets (`openRow`).
   */
  const navAt = shown ? messages.findIndex((m) => m.id === shown.id) : -1;
  const selectRow = (id: string): void => {
    setSelectedId(id);
    // Keep the new cursor in view — the registry preventDefaults the arrows, so nothing
    // scrolls natively. `?.` on the METHOD: jsdom mounts this view without implementing it.
    queueMicrotask(() =>
      document
        .querySelector<HTMLElement>(`.view-tag .row[data-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView?.({ block: "nearest" }),
    );
  };
  /* THE NINE MESSAGE VERBS, over this view's own cursor. Without this declaration the
     shell's bindings register `disabled` here (they act on `focused`, which has no arm for
     a split view's local cursor) while the action bar goes on printing their keycaps —
     nine keys that print a cap and do nothing. See `message-verbs.ts`. */
  useMessageVerbs({
    shown, scope: ".view-tag", onAction, onAddTag, onScreen, canDelete, canReplyAll,
  });

  useZoneNav({
    list: {
      followId: shown?.id ?? null,
      up: {
        disabled: navAt <= 0,
        run: () => {
          if (navAt > 0) selectRow(messages[navAt - 1]!.id);
        },
        label: to("keyPrev"),
      },
      down: {
        disabled: navAt >= messages.length - 1,
        run: () => {
          if (navAt < messages.length - 1) selectRow(messages[navAt + 1]!.id);
        },
        label: to("keyNext"),
      },
    },
    reader: {
      selector: ".view-tag .read-col",
      disabled: shown == null,
      onHiddenEnter: () => {
        if (shown) onOpen(shown);
      },
    },
  });

  return (
    <section className="view split view-tag">
      <ListPane
        title={tag.name}
        meta={t("metaCount", { count: messages.length })}
        header={
          admin ? (
            <div className="tag-head">
              <TagManage tag={tag} count={messages.length} admin={admin} />
            </div>
          ) : undefined
        }
      >
        <ListRows>
          {messages.length ? (
            messages.map((m) => (
              <MessageRow
                key={m.id}
                id={m.id}
                from={senderName(m)}
                address={rowAddress(m)}
                {...avatarOf(m)}
                participants={m.threadId ? threadParticipants?.(m.threadId) : undefined}
                {...rowStamp(m, now, absoluteTime, onToggleTime)}
                subject={m.subject}
                preview={m.snippet}
                amount={m.amount}
                /* READ STATE AS DRAWN. A tagged message can be a RESURFACED one, and a row
                   that said "read" here while the Ohbox drew the same message bold would be the
                   two-derivations defect in miniature — see `presentsUnread` for the ruling. */
                unread={presentsUnread(m)}
                seen={!presentsUnread(m)}
                selected={shown?.id === m.id}
                threadCount={m.threadCount}
                hasAttachment={m.hasAttachments}
                protected={m.protected != null}
                tags={tagsOfMessage(m, tags).map((x) => ({ name: x.name, hue: hueOf(x) }))}
                place={placeLabel(m.folder)}
                onClick={() => openRow(m)}
              />
            ))
          ) : (
            <div className="empty">
              <span className="glyph">🏷</span>
              <b>{t("emptyTitle")}</b>
              {t.rich("emptyHint", { kbd: (chunks) => <Kbd>{chunks}</Kbd> })}
            </div>
          )}
        </ListRows>
      </ListPane>
      {/* THE READING COLUMN — the Ohbox's own. No `onEnterReader` on the pane, for the reason
          the Ohbox omits it: the "open reading mode" button would sit at exactly the widths
          where the sheet duplicates this column. */}
      <ReadColumn regionLabel={tReader("pane")}>
        {/* THE PANE AGREES WITH THE ROW IT WAS OPENED FROM. `presentsUnread` and not the
            stored flag: a resurfaced message is drawn unread in the list beside this pane, and
            a pane offering "Mark unread" over a bold row is the two-derivations defect at arm's
            length — worse, the fallback verb WRITES `unread: true`, when what a pinned row needs
            is the deliberate read that releases it. The projection is presentation only;
            `onAction` still carries the real message. */}
        {shown ? (
          <MessagePane
            message={shown.unread === presentsUnread(shown) ? shown : { ...shown, unread: presentsUnread(shown) }}
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

/**
 * The tag's own manage control — resting, renaming, or confirming a delete.
 *
 * A UNION and not two booleans, the shape `SettingsView.TagRow` and `MessagePane`'s `BarPanel`
 * both use: two booleans can be true at once, a state there is no rendering for.
 *
 * The copy is deliberately the SAME as the Settings pane's, one namespace over — "Delete X?"
 * with the count, and "The messages stay where they are." A claim about what survives leaving
 * must read identically wherever it is made, or one copy of it ends up false.
 */
type ManageMode = { kind: "rest" } | { kind: "rename"; draft: string } | { kind: "confirm" };

function TagManage({
  tag,
  count,
  admin,
}: {
  tag: TagDTO;
  count: number;
  admin: TagAdmin;
}) {
  const t = useTranslations("tag");
  const [mode, setMode] = useState<ManageMode>({ kind: "rest" });

  // A half-open manage row must not carry over when the tag changes underneath it.
  useEffect(() => setMode({ kind: "rest" }), [tag.id]);

  if (mode.kind === "rename") {
    const next = mode.draft.trim();
    // Unchanged or empty is not a rename: the server would accept a no-op PATCH, but a Save that
    // does nothing is a control that lies about having acted.
    const canSave = next.length > 0 && next !== tag.name;
    const save = () => {
      if (!canSave) return;
      admin.onRename(tag.id, next);
      setMode({ kind: "rest" });
    };
    return (
      <div className="tag-manage">
        <TagDot hue={hueOf(tag)} />
        <input
          className="join-input tag-manage-input"
          autoFocus
          value={mode.draft}
          aria-label={t("renameAria")}
          onChange={(e) => setMode({ kind: "rename", draft: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); save(); }
            // Escape belongs to this input while it is open — the innermost open thing — so it
            // stops here rather than reaching the shell's overlay ladder.
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMode({ kind: "rest" }); }
          }}
        />
        <Button variant="primary" disabled={!canSave} onClick={save}>{t("save")}</Button>
        <Button variant="ghost" onClick={() => setMode({ kind: "rest" })}>{t("cancel")}</Button>
      </div>
    );
  }

  if (mode.kind === "confirm") {
    return (
      <div className="tag-manage">
        <div className="tag-manage-ask">
          <b>{t("deleteAsk", { name: tag.name })}</b>
          <span>{t("deleteWhat", { count })}</span>
        </div>
        <Button
          variant="primary"
          className="danger"
          onClick={() => { admin.onDelete(tag.id); setMode({ kind: "rest" }); }}
        >
          {t("delete")}
        </Button>
        <Button variant="ghost" onClick={() => setMode({ kind: "rest" })}>{t("cancel")}</Button>
      </div>
    );
  }

  return (
    <div className="tag-manage" role="group" aria-label={t("manageAria")}>
      <Button variant="ghost" onClick={() => setMode({ kind: "rename", draft: tag.name })}>
        {t("rename")}
      </Button>
      <Button variant="ghost" onClick={() => setMode({ kind: "confirm" })}>
        {t("delete")}
      </Button>
    </div>
  );
}
