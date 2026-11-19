/**
 * THE ACTION PANEL of the open letter, at the foot of the column, and its More menu. Its buttons carry the names a
 * person and the journeys find them by. The stop of the read rule: what runs under it is not on screen.
 */
import type { EngineMessage, TagEntity } from "@ohmail/wire";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Dialog, Menu, MenuItem } from "@ohmail/ui/base";
import { ActionPanel, MovePicker, type PanelVerb } from "@ohmail/ui/mail";
import type { ReplyRunState } from "@ohmail/app-logic/piles";
import { useMirror } from "@ohmail/app-logic/reader";
import { useListVisit } from "@ohmail/app-logic/reading";
import { useResurfaceTime } from "../../frame/room.js";
import { useText } from "../../text/index.js";
import { isCardDeleteKey, REPLY_KEY, useCardKeys, useLetterKeys, type PanelMenu } from "../keys.js";
import { useReplyVerbs } from "../parts.js";
import { ReplyPanel } from "./ReplyRun.js";
import { ResurfaceMenu } from "./ResurfaceMenu.js";
import { useVerbs, type Verbs } from "./use-verbs.js";

type Open = PanelMenu | "tag" | "confirmDelete" | null;

/** The room the panel stands in: the upright foldable and the phone keep some verbs behind More. */
export type PanelRoom = "desktop" | "fold" | "foldl" | "phone";

/**
 * A verb of the panel, and whether it stands behind More from the start in this room. Its press takes the element
 * pressed (the kit's K3): a menu it opens comes out of that control. Pressed from inside More, it takes More's button.
 */
type Placed = PanelVerb & { behind?: boolean };

/**
 * The panel's verbs in the design's order and the ranks they fold by: Reply, Forward and the read slot never fold;
 * of the others the highest folds first (Tag, Resurface, Park, Later, Reply all). Once nothing is left to fold, the
 * read slot gives up its word first, then Forward, then Reply; on a foldable the read slot gives it up before
 * anything folds. On a phone and on the upright foldable Reply all and Tag stand behind More, and on a phone the
 * read slot too. Tag stands only where the account has tags.
 */
function panelVerbs(
  t: ReturnType<typeof useText>,
  tm: ReturnType<typeof useText>,
  verbs: Verbs,
  tagged: boolean,
  toggle: (which: Exclude<Open, null>) => (at: HTMLElement) => void,
  room: PanelRoom,
  hasKeys: boolean,
): Placed[] {
  const { act, readSlot, filed } = verbs;
  const compact = room === "phone" || room === "fold";
  /* The three that file the letter are toggles: each says whether the letter is in its pile, as today's bar does. */
  const file = (id: "later" | "aside", icon: "later" | "parked", rank: number): Placed => ({
    id,
    label: t(`verb.${id}`),
    icon,
    segment: "file",
    rank,
    pressed: filed === (id === "later" ? "reply_later" : "set_aside"),
    onPress: () => act(id),
  });
  return [
    {
      id: "reply",
      label: t("verb.reply"),
      icon: "reply",
      kind: "ink",
      rank: 0,
      wordOrder: 3,
      keyHint: REPLY_KEY,
      shortcut: hasKeys ? REPLY_KEY : undefined,
      onPress: () => act("reply"),
    },
    ...(verbs.replyAll
      ? [
          {
            id: "reply_all",
            label: tm("menuReplyAll"),
            icon: "replyall" as const,
            rank: 1,
            behind: compact,
            onPress: () => act("reply_all"),
          },
        ]
      : []),
    {
      id: "forward",
      label: tm("menuForward"),
      icon: "forward",
      rank: 0,
      wordOrder: 2,
      onPress: () => act("forward"),
    },
    file("later", "later", 2),
    file("aside", "parked", 3),
    {
      id: "resurface",
      label: t("verb.resurface"),
      icon: "resurface",
      segment: "file",
      rank: 4,
      pressed: filed === "bubbled_up",
      onPress: toggle("resurface"),
    },
    ...(tagged
      ? [
          {
            id: "tag",
            label: t("verb.tag"),
            icon: "tags" as const,
            segment: "file",
            rank: 5,
            behind: compact,
            onPress: toggle("tag"),
          },
        ]
      : []),
    ...(readSlot === null
      ? []
      : [
          {
            id: "read",
            label: t(`verb.${readSlot}`),
            /* Over a conversation the press marks every unread letter of it: the slot's name says how many. */
            name:
              readSlot === "markRead" && verbs.readCount > 1
                ? t("verb.markReadCount", { count: verbs.readCount })
                : undefined,
            icon: readSlot === "markRead" ? ("read" as const) : ("unread" as const),
            apart: true,
            rank: 0,
            wordOrder: 1,
            wordFirst: room === "fold" || room === "foldl",
            behind: room === "phone",
            keyHint: "u",
            widest: t("verb.markUnread"),
            hotIcon: readSlot === "markRead",
            onPress: () => act("unread"),
          },
        ]),
  ];
}

export function ActionBar({
  verbs,
  room = "desktop",
  keys,
  card,
  reply,
  run = null,
}: {
  verbs: Verbs;
  room?: PanelRoom;
  /** The letter the panel acts on, where the column has the keyboard: its verbs are bound by key too. */
  keys?: EngineMessage | null;
  card?: { letter: EngineMessage; keysHere: boolean };
  /** An open reply's verbs (`write`'s), shown in the letter's place: one panel for the column. Null: the letter's. */
  reply: readonly PanelVerb[] | null;
  run?: ReplyRunState | null;
}) {
  const t = useText("reader");
  const tm = useText("message");
  const tp = useText("place");
  const [menu, setMenu] = useState<Open>(null);
  /* What did not fit the panel: offered first behind More, in the panel's order. */
  const [folded, setFolded] = useState<readonly string[]>([]);
  const more = menu === "more" || menu === "cardDelete";
  /* The control a menu comes out of: the verb's button last pressed, or More's for a verb pressed inside More. */
  const pressed = useRef<HTMLElement | null>(null);
  const toggle = (which: Exclude<Open, null>) => (at: HTMLElement) => {
    pressed.current = at;
    setMenu((m) => (m === which ? null : which));
  };
  const close = () => setMenu(null);
  /* The panel's wrapper: the read rule's stop (`data-read-stop`). */
  const stop = useRef<HTMLDivElement | null>(null);
  const { act } = verbs;
  const file = (): void => {
    close();
    act("delete");
  };
  /* The account's resurface hour and its writer, as the shell handed them to the room. */
  const hour = useResurfaceTime();
  const { mirror } = useMirror();
  const tags = verbs.tag === null ? [] : (mirror?.list<TagEntity>("tag") ?? []);
  const all = panelVerbs(t, tm, verbs, tags.length > 0, toggle, room, keys != null);
  const items = all.filter((v) => !v.behind);
  /* Behind More, in the panel's order: what stands there in this room and what folded; Move before the read slot. */
  const behind = all.filter((v) => v.behind || folded.includes(v.id));
  const beforeRead = behind.filter((v) => v.id !== "read");
  const read = behind.filter((v) => v.id === "read");
  /* A key opens a menu as its button does: out of the verb's own button, else out of More where it stands behind it. */
  const byKey = (which: PanelMenu): void => {
    const root = stop.current;
    const own = which === "resurface" ? root?.querySelector<HTMLElement>('[data-id="resurface"]') : null;
    pressed.current = own ?? root?.querySelector<HTMLElement>("[data-more]") ?? null;
    setMenu((m) => (m === which ? null : which));
  };
  useCardKeys(
    card?.keysHere === true && reply === null,
    card ? { letter: card.letter, verbs, menu: byKey } : null,
  );
  useLetterKeys(keys != null, keys == null ? null : { letter: keys, verbs, menu: byKey });
  useKeyboardBack(reply !== null, stop);
  return (
    <div className="rd-stop" data-read-stop="" ref={stop}>
      {run !== null || reply !== null ? (
        <ReplyPanel run={run} reply={reply} />
      ) : (
        <ActionPanel
          label={t("panel")}
          items={items}
          folded={folded}
          onFold={setFolded}
          more={{ label: t("verb.more"), behind: true, expanded: more || undefined, onPress: toggle("more") }}
        />
      )}
      <ResurfaceMenu
        open={menu === "resurface"}
        onClose={close}
        anchor={pressed}
        act={act}
        stored={hour.stored}
        store={hour.store}
      />
      <Menu open={menu === "tag"} onClose={close} anchor={pressed} label={t("verb.tag")} up right>
        {tags.map((tag) => {
          const on = verbs.tagged.includes(tag.id);
          return (
            <MenuItem key={tag.id} checked={on} onPress={() => verbs.tag?.(tag.id, !on)}>
              {tag.name}
            </MenuItem>
          );
        })}
      </Menu>
      <MovePicker
        open={menu === "move"}
        onClose={close}
        anchor={pressed}
        label={t("verb.move")}
        title={t("verb.move")}
        places={verbs.moves.map((id) => ({ id, label: tp(id) }))}
        folders={[]}
        onMove={(id) => {
          close();
          act(`move:${id as (typeof verbs.moves)[number]}`);
        }}
      />
      <Menu
        open={more}
        onClose={close}
        anchor={pressed}
        label={t("verb.more")}
        up
        right
        onKey={(e) => {
          if (menu !== "cardDelete" || !isCardDeleteKey(e.nativeEvent)) return false;
          e.preventDefault();
          file();
          return true;
        }}
      >
        {beforeRead.map((v) => (
          <BehindMore key={v.id} verb={v} close={close} more={pressed} />
        ))}
        {verbs.moves.length > 0 ? (
          <MenuItem icon="move" onPress={() => setMenu("move")}>
            {t("verb.move")}
          </MenuItem>
        ) : null}
        {read.map((v) => (
          <BehindMore key={v.id} verb={v} close={close} more={pressed} />
        ))}
        <DraftReplyItem draft={verbs.draft} close={close} />
        <MenuItem icon="trash" onPress={card ? () => setMenu("confirmDelete") : file}>
          {t("verb.delete")}
        </MenuItem>
      </Menu>
      {card ? (
        <Dialog
          open={menu === "confirmDelete"}
          onClose={close}
          title={t("trashAsk")}
          hot
          kind="delete"
          confirm={{ label: t("verb.move"), onPress: file, keyHint: "↵" }}
          cancel={{ label: t("resurface.cancel"), keyHint: "Esc" }}
        />
      ) : null}
    </div>
  );
}

/** Draft reply behind More, where a drafter stands: the reply opened on the letter and the drafter asked. */
function DraftReplyItem({ draft, close }: { draft: (() => void) | null; close: () => void }) {
  const t = useText("reader");
  if (draft === null) return null;
  return (
    <MenuItem
      icon="spark"
      onPress={() => {
        close();
        draft();
      }}
    >
      {t("verb.draftReply")}
    </MenuItem>
  );
}

/**
 * A verb behind More. Resurface and Tag open their own menus in More's place, out of More's button: the press hands
 * the element More was pressed on.
 */
function BehindMore({
  verb,
  close,
  more,
}: {
  verb: Placed;
  close: () => void;
  more: RefObject<HTMLElement | null>;
}) {
  return (
    <MenuItem
      icon={verb.icon}
      onPress={() => {
        const at = more.current;
        if (verb.id !== "resurface" && verb.id !== "tag") close();
        if (at !== null) verb.onPress?.(at);
      }}
    >
      {verb.label}
    </MenuItem>
  );
}

/**
 * The panel for one letter where a list draws it in place: the list's visit where it handed one, else the reader's
 * runners through the room's seam. With neither (no visit, and a place whose room is off) nothing is drawn.
 */
export function LetterActions({
  messageId,
  keysHere,
  markUnread,
}: {
  messageId: string;
  keysHere: boolean;
  markUnread?: (id: string) => void;
}) {
  const { mirror } = useMirror();
  const message = mirror?.get<EngineMessage>("message", messageId) ?? null;
  const visit = useListVisit(messageId);
  const verbs = useVerbs(message, visit, markUnread ? { onMarkUnread: markUnread } : null);
  const reply = useReplyVerbs(messageId);
  if (message === null || verbs.idle) return null;
  return <ActionBar key={messageId} verbs={verbs} card={{ letter: message, keysHere }} reply={reply} />;
}

/**
 * When a reply's verbs give the panel back (it was sent, discarded or closed) and the press that did it took the
 * keyboard with it, the keyboard goes to the letter's Reply: the verb that opened it, standing where it stood.
 */
function useKeyboardBack(replying: boolean, stop: RefObject<HTMLDivElement | null>): void {
  const was = useRef(replying);
  useLayoutEffect(() => {
    const back = was.current && !replying;
    was.current = replying;
    const panel = stop.current;
    if (!back || panel === null) return;
    const page = panel.ownerDocument;
    const at = page.activeElement;
    if (at !== null && at !== page.body && at.isConnected) return;
    const verb =
      panel.querySelector<HTMLButtonElement>('button[data-id="reply"]:not([hidden])') ??
      panel.querySelector<HTMLButtonElement>("button:not([hidden])");
    /* No scroll of the column: scroll-to-read would count one under a resting pointer as the person's. */
    verb?.focus({ preventScroll: true });
  }, [replying, stop]);
}
