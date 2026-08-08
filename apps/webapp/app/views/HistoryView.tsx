"use client";

/**
 * HISTORY — mail from people nobody ever decided about, who then went quiet.
 *
 * Every message in this list is READ, and that is guaranteed rather than arranged: a sender
 * with any unread mail is ACTIVE whatever its age, so an unread message pulls its sender into
 * the Screener queue instead. History therefore cannot contain anything that wants attention,
 * which is why the rail entry beside it carries no count and this pane shows no unread state.
 *
 * It is not called Archive. "Archive" is a verb in every other mail client — an action this
 * mail never received — and a mailbox with a real server-side Archive folder would be shown a
 * view by that name whose contents are not that folder's.
 *
 * ── NOTHING HERE HAS MOVED ─────────────────────────────────────────────────────────────────
 *
 * This is a presentation, not a location. Every message in the list is sitting exactly where
 * the mail server has it — usually the INBOX — and every other mail client the person owns
 * still shows it there. The row states the server folder for that reason: a place the product
 * invented must not be mistaken for a place mail was put.
 *
 * ── ONE WAY TO READ IT: THE OHBOX'S ─────────────────────────────────────────────────────────
 *
 * A list beside a reading column, which is the composition every other pile in the product
 * already uses. There used to be a `List` / `Split` segmented control above the rows, defaulting
 * to a solo centred list that raised a reader sheet per message — and it was a control offering
 * a choice nobody wants to make twice: going through old mail one sheet at a time is the slower
 * half of a pair, it was the DEFAULT half, and the toggle reset on every visit, so the cost was
 * paid again on each arrival. The choice is gone and the better shape is simply the shape.
 *
 * READING IN PLACE IS UNCHANGED, and it was the point of the toggle rather than of the modes.
 * A click selects into the column and the message renders where History shows it; the tag or
 * the pile never leaves the screen. Under 900px the reading column is `display:none`, so there
 * a click still raises the shell's reader sheet (`onOpen`) — the same rule the Ohbox keeps, and
 * the reason `readColumnHidden()` survives the deletion.
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { physicalFolderOf, type EngineMessage, type TagDTO } from "@ohmail/client-engine";
import { ListPane, ListRows, MessageRow, ReadColumn } from "@ohmail/ui";
import { MessagePane, type MessageAction } from "../shell/MessagePane";
import { avatarOf, displayTime, rowAddress, senderName, tagsOfMessage, hueOf } from "../shell/format";

/** Below this the reading column is `display:none` (app.css), so a tap must open the sheet. */
function readColumnHidden(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia?.("(max-width: 900px)").matches === true
  );
}

export function HistoryView({
  messages,
  tags,
  now,
  onOpen,
  hydrateBody,
  onAction,
  onAddTag,
}: {
  messages: readonly EngineMessage[];
  tags: TagDTO[];
  now: Date;
  /** The reader sheet, in place — the narrow-width tap, where there is no reading column. */
  onOpen: (m: EngineMessage) => void;
  /** Hydrate the split reading column's message, exactly as ReadsView hydrates `current`. */
  hydrateBody: (id: string, opts?: { retry?: boolean }) => void;
  /** The reading column's message verbs — the shell's `onMessageAction`. */
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
}) {
  const t = useTranslations("history");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /**
   * The message the reading column shows — the user's pick, or the first row so the column is
   * never blank beside a list that has rows. `?? messages[0]` is safe here where it was fatal in
   * the Ohbox: History is all-read and static, so the list never re-partitions under the
   * fallback and it cannot silently re-point at a message nobody chose.
   */
  const shown = messages.find((m) => m.id === selectedId) ?? messages[0] ?? null;

  useEffect(() => {
    if (shown) hydrateBody(shown.id);
  }, [shown?.id, hydrateBody]);

  const openRow = (m: EngineMessage) => {
    // Where the column is hidden the sheet is the only reading surface; where it is standing a
    // click is a selection into it, and nothing leaves the screen.
    if (readColumnHidden()) onOpen(m);
    else setSelectedId(m.id);
  };

  return (
    <section className="view split view-history">
      <ListPane
        title={t("title")}
        meta={messages.length ? t("metaCount", { count: messages.length }) : undefined}
      >
        {/* ONE SENTENCE, ALWAYS PRESENT, AND ABOVE THE LIST.
            "History" is a word this product is using in a way no other mail client does, and a
            list of a thousand old messages under an unexplained heading is a list somebody has
            to guess the meaning of. It is not a dismissible first-run tip: the explanation is
            as true on the hundredth visit as the first, and a hint that disappears is a hint
            nobody can go back to. */}
        <p className="view-note">{t("explainer")}</p>
        <ListRows>
          {messages.length ? (
            messages.map((m) => (
              <MessageRow
                key={m.id}
                id={m.id}
                from={senderName(m)}
                address={rowAddress(m)}
                {...avatarOf(m)}
                time={displayTime(m, now)}
                subject={m.subject}
                preview={m.snippet}
                amount={m.amount}
                /* Never unread, by construction — stated rather than passed through, so that a
                   regression in the cutline shows up here as mail that stops looking read. */
                unread={false}
                seen
                selected={shown?.id === m.id}
                threadCount={m.threadCount}
                hasAttachment={m.hasAttachments}
                protected={m.protected != null}
                tags={tagsOfMessage(m, tags).map((x) => ({ name: x.name, hue: hueOf(x) }))}
                /* WHERE IT ACTUALLY IS. Not a pile label: History is not a folder, and the
                   only honest badge is the server's own. */
                place={physicalFolderOf(m)}
                onClick={() => openRow(m)}
              />
            ))
          ) : (
            <div className="empty">
              <span className="glyph">🕰</span>
              <b>{t("emptyTitle")}</b>
              {/* An empty History says what History IS, not that it is empty. Somebody
                  arriving at an empty one has learned nothing from the word alone. */}
              {t("emptyHint")}
            </div>
          )}
        </ListRows>
      </ListPane>
      {/* THE READING COLUMN — the Ohbox's own, minus the dwell it does not need: History is
          all-read, so there is no read-state to commit and nothing to arm a timer for. No
          `onEnterReader` on the pane, for the reason the Ohbox omits it — the "open reading
          mode" button it renders would sit at exactly the widths where the sheet duplicates
          this column. */}
      <ReadColumn>
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
