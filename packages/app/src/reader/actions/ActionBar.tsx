/**
 * THE ACTION PANEL of the open letter, at the foot of the column, and its More menu. Its buttons carry the names a
 * person and the journeys find them by. The stop of the read rule: what runs under it is not on screen.
 */
import { panelVerbs, usePanelHints, type ActionWords, type PanelRoom, type Placed } from "./panel-verbs.js";
export type { PanelRoom } from "./panel-verbs.js";
import type { EngineMessage, TagEntity } from "@ohmail/wire";
import { useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { ActionPanel, type PanelVerb } from "@ohmail/ui/mail";
import type { ReplyRunState } from "@ohmail/app-logic/piles";
import { useZoneIs } from "@ohmail/app-logic/keys";
import { useMirror, useOpenConversation } from "@ohmail/app-logic/reader";
import { useListVisit } from "@ohmail/app-logic/reading";
import { FrameContext } from "../../frame/commands.js";
import { useOwnGone } from "../../frame/own-gone.js";
import { useResurfaceTime } from "../../frame/room.js";
import { useText } from "../../text/index.js";
import { useCardKeys, useLetterKeys, useReaderKeys, type DeleteKeyTarget, type PanelMenu } from "../keys.js";
import { useReplyVerbs } from "../parts.js";
import { ReplyPanel } from "./ReplyRun.js";
import { ActionMenus, useActionMenu } from "./ActionMenus.js";
import { useVerbs, type Verbs } from "./use-verbs.js";

interface ActionBarProps {
  verbs: Verbs;
  room?: PanelRoom;
  /** The letter the panel acts on, where the column has the keyboard: its verbs are bound by key too. */
  keys?: EngineMessage | null;
  card?: {
    letter: EngineMessage;
    keysHere: boolean;
    deleteTarget: DeleteKeyTarget | null;
    canAnswerKey?: (id: string) => boolean;
    watchAnswerKey?: (update: () => void) => () => void;
  };
  /** An open reply's verbs (`write`'s), shown in the letter's place: one panel for the column. Null: the letter's. */
  reply: readonly PanelVerb[] | null;
  run?: ReplyRunState | null;
  focus?: boolean;
  showPanel?: boolean;
  canAnswerFromPanel?: boolean;
  conversation?: boolean;
  onScreen?: (anchor: HTMLElement) => void;
  onScreenKey?: () => void;
  screeningDialog?: PanelVerb["dialog"];
  onCalendar?: () => void;
}

const noWatch = () => () => {};
const noAnswerHint = () => false;

function useAnswerHint(card: ActionBarProps["card"], active: boolean): boolean {
  return useSyncExternalStore(
    active ? (card?.watchAnswerKey ?? noWatch) : noWatch,
    () => card === undefined || (active && card.canAnswerKey?.(card.letter.id) !== false),
    noAnswerHint,
  );
}

export function ActionBar({
  verbs,
  room = "desktop",
  keys,
  card,
  reply,
  run = null,
  focus = false,
  showPanel = true,
  canAnswerFromPanel = showPanel,
  conversation = false,
  onScreen,
  onScreenKey,
  screeningDialog,
  onCalendar,
}: ActionBarProps) {
  const t = useText("reader");
  const words = actionWords(t, useText("message"));
  const ohbox = useText("ohbox");
  const screening = useText("screening");
  const shortcuts = useText("shortcuts");
  /* What did not fit the panel: offered first behind More, in the panel's order. */
  const [folded, setFolded] = useState<readonly string[]>([]);
  /* The panel's wrapper: the read rule's stop (`data-read-stop`). */
  const stop = useRef<HTMLDivElement | null>(null);
  const { anchor, menu, setMenu, toggle, close, byKey, trash, confirmTrash, trashAcknowledged } =
    useActionMenu(stop, verbs, onScreenKey);
  /* The account's resurface hour and its writer, as the shell handed them to the room. */
  const hour = useResurfaceTime();
  const { mirror } = useMirror();
  const tags = verbs.tag === null ? [] : (mirror?.list<TagEntity>("tag") ?? []);
  const canTag = tags.length > 0 || verbs.createTag !== null;
  const cardKeys = card?.keysHere === true && reply === null;
  const hintsActive = card === undefined ? keys != null : cardKeys;
  const canHintAnswer = useAnswerHint(card, cardKeys && canAnswerFromPanel);
  const hints = usePanelHints(verbs.readSlot, hintsActive, canHintAnswer);
  const calendarAction = useCalendarVerb(reply === null && run === null ? onCalendar : undefined);
  const all = panelVerbs(
    t,
    words,
    ohbox,
    verbs,
    canTag,
    toggle,
    room,
    hints,
    conversation,
    onScreen ? { label: screening("action"), dialog: screeningDialog, onPress: onScreen } : undefined,
  );
  const items = all.filter((v) => !v.behind);
  const replyItems = reply && card ? [...reply, ...all.filter((v) => v.id === "later")] : reply;
  const behind = [
    ...(replyItems?.filter((verb) => folded.includes(verb.id)) ?? []),
    ...behindMore(all, folded, reply !== null, card !== undefined),
  ];
  const more = {
    label: words.more,
    behind: true,
    expanded: menu === "more" || menu === "cardDelete",
    onPress: toggle("more"),
  };
  usePanelKeyboard({
    card,
    cardKeys,
    byKey,
    showPanel: canAnswerFromPanel,
    keys,
    verbs,
    stop,
    focus,
    replying: reply !== null,
    screeningLabel: onScreenKey ? shortcuts("screen") : undefined,
    calendarAction,
    tagLabel: canTag && reply === null && run === null ? words.tag : undefined,
  });
  return (
    <div className="rd-stop" data-read-stop={showPanel ? "" : undefined} ref={stop}>
      {showPanel && verbs.pendingReplyCopy ? (
        <div className="oh-text" role="status" title={t("replyCopyWaiting")}>
          {t("replyCopySending")}
        </div>
      ) : null}
      {!showPanel ? null : run !== null || reply !== null ? (
        <ReplyPanel run={run} reply={replyItems} more={more} folded={folded} onFold={setFolded} />
      ) : (
        <ActionPanel
          label={t("panel")}
          items={items}
          folded={folded}
          onFold={setFolded}
          more={{ ...more, apart: verbs.done && room === "phone" }}
        />
      )}
      <ActionMenus
        anchor={anchor}
        words={words}
        menu={menu}
        setMenu={setMenu}
        close={close}
        trash={trash}
        confirmTrash={confirmTrash}
        hour={hour}
        tags={tags}
        verbs={verbs}
        behind={behind}
        separate={reply !== null}
        calendarAction={calendarAction}
        calendarKeyHint={hints.calendar.keyHint}
        confirm={card !== undefined && !trashAcknowledged}
      />
    </div>
  );
}

function behindMore(all: readonly Placed[], folded: readonly string[], replying: boolean, card: boolean) {
  if (!replying) return all.filter((verb) => verb.behind || folded.includes(verb.id));
  return all.filter(
    ({ id }) => id !== "reply" && id !== "reply_all" && id !== "forward" && (!card || id !== "later"),
  );
}

function useCalendarVerb(onPress: (() => void) | undefined) {
  const t = useText("reader");
  return onPress ? { label: t("actions.addToCalendar"), onPress } : undefined;
}

/**
 * The panel for one letter where a list draws it in place: the list's visit where it handed one, else the reader's
 * runners through the room's seam. With neither (no visit, and a place whose room is off) nothing is drawn.
 */
export function LetterActions({
  messageId,
  deleteKeyId = messageId,
  canDeleteKey,
  canAnswerKey,
  watchAnswerKey,
  keysHere,
  focus,
  showPanel,
  canAnswerFromPanel,
  room,
  markUnread,
}: {
  messageId: string;
  deleteKeyId?: string;
  canDeleteKey?: (id: string) => boolean;
  canAnswerKey?: (id: string) => boolean;
  watchAnswerKey?: (update: () => void) => () => void;
  keysHere: boolean;
  focus?: boolean;
  showPanel?: boolean;
  canAnswerFromPanel?: boolean;
  room?: PanelRoom;
  markUnread?: (id: string) => void;
}) {
  const { mirror } = useMirror();
  const message = mirror?.get<EngineMessage>("message", messageId) ?? null;
  const visit = useListVisit(messageId);
  const thread = useOpenConversation(
    showPanel !== false && message?.threadId ? messageId : null,
    useOwnGone(),
  );
  const latest = thread.messages.at(-1);
  const reply = useReplyVerbs(messageId, thread.messages);
  const verbs = useVerbs(message, visit, markUnread ? { onMarkUnread: markUnread } : null, latest);
  const otherId = keysHere && deleteKeyId !== messageId ? deleteKeyId : null;
  const other = otherId === null ? null : (mirror?.get<EngineMessage>("message", otherId) ?? null);
  const otherVisit = useListVisit(otherId);
  const otherVerbs = useVerbs(other, otherVisit, null);
  if (message === null || verbs.idle) return null;
  const deleteTarget =
    otherId === null
      ? { letter: message, verbs, canDeleteKey }
      : other !== null && !otherVerbs.idle
        ? { letter: other, verbs: otherVerbs, canDeleteKey }
        : null;
  return (
    <ActionBar
      key={messageId}
      verbs={verbs}
      card={{ letter: message, keysHere, deleteTarget, canAnswerKey, watchAnswerKey }}
      reply={reply}
      focus={focus}
      showPanel={showPanel}
      canAnswerFromPanel={canAnswerFromPanel}
      room={room}
    />
  );
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

function usePanelKeyboard({
  card,
  cardKeys,
  byKey,
  showPanel,
  keys,
  verbs,
  stop,
  focus,
  replying,
  screeningLabel,
  calendarAction,
  tagLabel,
}: Pick<ActionBarProps, "card" | "keys" | "verbs"> & {
  cardKeys: boolean;
  byKey: (which: PanelMenu) => void;
  showPanel: boolean;
  stop: RefObject<HTMLDivElement | null>;
  focus: boolean;
  replying: boolean;
  screeningLabel: string | undefined;
  calendarAction?: { label: string; onPress: () => void };
  tagLabel: string | undefined;
}): void {
  const ohboxReader = useContext(FrameContext)?.api.route.place === "ohbox";
  const readerFocused = useZoneIs("reader");
  const scopedTag = !ohboxReader || readerFocused ? tagLabel : undefined;
  useCardKeys(
    cardKeys,
    card
      ? { letter: card.letter, verbs, menu: byKey, canAnswerKey: card.canAnswerKey, tagLabel: scopedTag }
      : null,
    card?.deleteTarget ?? null,
    showPanel,
  );
  useReaderKeys(cardKeys && verbs.readSlot !== null, { verbs, visit: null });
  useLetterKeys(
    keys != null,
    keys == null
      ? null
      : {
          letter: keys,
          verbs,
          menu: byKey,
          screeningLabel: screeningLabel,
          calendarAction,
          tagLabel: scopedTag,
        },
  );
  useKeyboardBack(replying, stop);
  useLayoutEffect(() => {
    if (focus)
      stop.current
        ?.querySelector<HTMLElement>('[role="toolbar"] button:not(:disabled)')
        ?.focus({ preventScroll: true });
  }, [focus, stop]);
}

function actionWords(t: ReturnType<typeof useText>, tm: ReturnType<typeof useText>): ActionWords {
  const file = (id: "later" | "aside") => t(`verb.${id}`);
  return {
    get reply() {
      return t("verb.reply");
    },
    get replyAll() {
      return tm("menuReplyAll");
    },
    get forward() {
      return tm("menuForward");
    },
    get later() {
      return file("later");
    },
    get aside() {
      return file("aside");
    },
    get resurface() {
      return t("verb.resurface");
    },
    get tag() {
      return t("verb.tag");
    },
    get move() {
      return t("verb.move");
    },
    get more() {
      return t("verb.more");
    },
    get delete() {
      return t("verb.delete");
    },
    get draftReply() {
      return t("verb.draftReply");
    },
  };
}
