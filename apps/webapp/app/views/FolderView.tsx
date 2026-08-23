"use client";

/**
 * FOLDER — one of the mailbox's OWN folders, opened from the rail (FOLDERS-SPEC.md §3,
 * "Views: a user folder opens as a parameterized view — a list filtered on `m.folder`").
 *
 * The composition is `TagView`'s — a lens read in place: the two-pane list beside a reading
 * column, a click selecting into the column, the shell's sheet under 900px. The differences
 * are the folder's, both deliberate:
 *
 *  · the list wears the standard NEW-FOR-YOU / EARLIER grouping (iteration 2, feedback 5 —
 *    "it's perfect that you show the earlier / unread layout on the folders");
 *  · an EMPTY folder is an answer, not an error: it exists on the server and holds no mail,
 *    and the empty state says exactly that — the folder list comes from the mailbox itself,
 *    not from the messages in it.
 *
 * Read-only in the foundation stage: no move verb, no rules door, no menu — later stages.
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { type EngineMessage, type FolderEntity, type TagDTO } from "@ohmail/client-engine";
import { ListGroupLabel, ListPane, ListRows, MessageRow, ReadColumn } from "@ohmail/ui";
import { MessagePane, type MessageAction } from "../shell/MessagePane";
import { avatarOf, rowStamp, hueOf, rowAddress, senderName, tagsOfMessage } from "../shell/format";
import { folderLeafOf, folderParentOf } from "../shell/folders";

/** Below this the reading column is `display:none` (app.css), so a tap must open the sheet. */
function readColumnHidden(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia?.("(max-width: 900px)").matches === true
  );
}

export function FolderView({
  folder,
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
}: {
  folder: FolderEntity;
  /** The folder's mail, newest first — filtered by the shell on (mailboxId, name). */
  messages: EngineMessage[];
  tags: TagDTO[];
  threadParticipants?: (threadId: string) => { initials: string; hue: number }[];
  absoluteTime?: boolean;
  onToggleTime?: () => void;
  now: Date;
  /** The reader sheet, in place — the narrow-width tap, where there is no reading column. */
  onOpen: (m: EngineMessage) => void;
  hydrateBody: (id: string, opts?: { retry?: boolean }) => void;
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
}) {
  const t = useTranslations("folder");
  const to = useTranslations("ohbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The user's pick, or the first row so the column is never blank beside a list that has
  // rows — TagView's rule, safe for TagView's reason: the list does not re-partition under it.
  const shown = messages.find((m) => m.id === selectedId) ?? messages[0] ?? null;

  useEffect(() => {
    if (shown) hydrateBody(shown.id);
  }, [shown?.id, hydrateBody]);

  const openRow = (m: EngineMessage) => {
    if (readColumnHidden()) onOpen(m);
    else setSelectedId(m.id);
  };

  const groups: Array<[string, EngineMessage[]]> = [
    // The standard grouping, the Ohbox's own labels: unread is what is unhandled here, read is
    // the folder's past. Both keys live in the `ohbox` namespace so the two lists can never
    // drift apart in copy.
    [to("newForYou"), messages.filter((m) => m.unread)],
    [to("previouslySeen"), messages.filter((m) => !m.unread)],
  ];

  const parent = folderParentOf(folder.name);

  return (
    <section className="view split view-folder">
      <ListPane
        title={folderLeafOf(folder.name)}
        // The full path as the meta line when the folder is nested, so "Q1" says where it
        // lives; the count otherwise — TagView's meta, one namespace over.
        meta={parent ? folder.name : t("metaCount", { count: messages.length })}
      >
        <ListRows>
          {messages.length ? (
            groups.map(([label, set]) =>
              set.length ? (
                <div key={label}>
                  <ListGroupLabel>{label}</ListGroupLabel>
                  {set.map((m) => (
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
                      unread={m.unread}
                      seen={!m.unread}
                      selected={shown?.id === m.id}
                      threadCount={m.threadCount}
                      hasAttachment={m.hasAttachments}
                      protected={m.protected != null}
                      tags={tagsOfMessage(m, tags).map((x) => ({ name: x.name, hue: hueOf(x) }))}
                      onClick={() => openRow(m)}
                    />
                  ))}
                </div>
              ) : null,
            )
          ) : (
            <div className="empty">
              <span className="glyph">📁</span>
              <b>{t("emptyTitle")}</b>
              {t("emptyHint")}
            </div>
          )}
        </ListRows>
      </ListPane>
      {/* The reading column — the Ohbox's own; no `onEnterReader`, TagView's reason. */}
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
