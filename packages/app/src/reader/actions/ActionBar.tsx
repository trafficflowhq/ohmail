/**
 * THE ACTION PANEL of the open letter, at the foot of the column, and its More menu. Its buttons carry the names a
 * person and the journeys find them by. The stop of the read rule: what runs under it is not on screen.
 */
import {
  panelVerbs,
  usePanelHints,
  type ActionWords,
  type OpenPanel,
  type PanelRoom,
} from "./panel-verbs.js";
export type { PanelRoom } from "./panel-verbs.js";
import type { EngineMessage, TagEntity } from "@ohmail/wire";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ActionPanel, type PanelVerb } from "@ohmail/ui/mail";
import type { ReplyRunState } from "@ohmail/app-logic/piles";
import { useMirror } from "@ohmail/app-logic/reader";
import { useListVisit } from "@ohmail/app-logic/reading";
import { useResurfaceTime } from "../../frame/room.js";
import { useText } from "../../text/index.js";
import { useCardKeys, useLetterKeys, type DeleteKeyTarget, type PanelMenu } from "../keys.js";
import { useReplyVerbs } from "../parts.js";
import { ReplyPanel } from "./ReplyRun.js";
import { ActionMenus } from "./ActionMenus.js";
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
  };
  /** An open reply's verbs (`write`'s), shown in the letter's place: one panel for the column. Null: the letter's. */
  reply: readonly PanelVerb[] | null;
  run?: ReplyRunState | null;
  focus?: boolean;
  showPanel?: boolean;
  conversation?: boolean;
  onScreen?: (anchor: HTMLElement) => void;
  onScreenKey?: () => void;
  screeningDialog?: PanelVerb["dialog"];
}

function menuAnchor(root: HTMLElement | null, which: PanelMenu): HTMLElement | null {
  const target = which === "resurface" || which === "tag" ? which : null;
  const own = target ? root?.querySelector<HTMLElement>(`[data-id="${target}"]:not([hidden])`) : null;
  return own ?? root?.querySelector<HTMLElement>("[data-more]") ?? null;
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
  conversation = false,
  onScreen,
  onScreenKey,
  screeningDialog,
}: ActionBarProps) {
  const t = useText("reader");
  const words = actionWords(t, useText("message"));
  const ohbox = useText("ohbox");
  const screening = useText("screening");
  const shortcuts = useText("shortcuts");
  const [menu, setMenu] = useState<OpenPanel>(null);
  /* What did not fit the panel: offered first behind More, in the panel's order. */
  const [folded, setFolded] = useState<readonly string[]>([]);
  /* The control a menu comes out of: the verb's button last pressed, or More's for a verb pressed inside More. */
  const pressed = useRef<HTMLElement | null>(null);
  const toggle = (which: Exclude<OpenPanel, null>) => (at: HTMLElement) => {
    pressed.current = at;
    setMenu((m) => (m === which ? null : which));
  };
  const close = () => setMenu(null);
  /* The panel's wrapper: the read rule's stop (`data-read-stop`). */
  const stop = useRef<HTMLDivElement | null>(null);
  const file = (): void => {
    close();
    verbs.act("delete");
  };
  /* The account's resurface hour and its writer, as the shell handed them to the room. */
  const hour = useResurfaceTime();
  const { mirror } = useMirror();
  const tags = verbs.tag === null ? [] : (mirror?.list<TagEntity>("tag") ?? []);
  const cardKeys = card?.keysHere === true && reply === null;
  const hints = usePanelHints(
    verbs.readSlot,
    card === undefined || (cardKeys && showPanel),
    card?.canAnswerKey?.(card.letter.id) !== false,
  );
  const all = panelVerbs(
    t,
    words,
    ohbox,
    verbs,
    tags.length > 0,
    toggle,
    room,
    hints,
    conversation,
    onScreen ? { label: screening("action"), dialog: screeningDialog, onPress: onScreen } : undefined,
  );
  const items = all.filter((v) => !v.behind);
  const replyItems = reply && card ? [...reply, ...all.filter((v) => v.id === "later")] : reply;
  /* Behind More, in the panel's order: what stands there in this room and what folded; Move before the read slot. */
  const behind = all.filter((v) => v.behind || folded.includes(v.id));
  /* A key opens a menu as its button does: out of the verb's own button, else out of More where it stands behind it. */
  const byKey = (which: PanelMenu): void => {
    if (which === "screening") {
      onScreenKey?.();
      return;
    }
    pressed.current = menuAnchor(stop.current, which);
    setMenu((m) => (m === which ? null : which));
  };
  usePanelKeyboard({
    card,
    cardKeys,
    byKey,
    showPanel,
    keys,
    verbs,
    stop,
    focus,
    replying: reply !== null,
    screeningLabel: onScreenKey ? shortcuts("screen") : undefined,
    tagLabel: tags.length > 0 && reply === null && run === null ? words.tag : undefined,
  });
  return (
    <div className="rd-stop" data-read-stop={showPanel ? "" : undefined} ref={stop}>
      {!showPanel ? null : run !== null || reply !== null ? (
        <ReplyPanel run={run} reply={replyItems} />
      ) : (
        <ActionPanel
          label={t("panel")}
          items={items}
          folded={folded}
          onFold={setFolded}
          more={{
            label: words.more,
            behind: true,
            apart: verbs.done && room === "phone",
            expanded: menu === "more" || menu === "cardDelete" || undefined,
            onPress: toggle("more"),
          }}
        />
      )}
      <ActionMenus
        anchor={pressed}
        words={words}
        menu={menu}
        setMenu={setMenu}
        close={close}
        trash={file}
        hour={hour}
        tags={tags}
        verbs={verbs}
        behind={behind}
        confirm={card !== undefined}
      />
    </div>
  );
}

/** Draft reply behind More, where a drafter stands: the reply opened on the letter and the drafter asked. */
/**
 * The panel for one letter where a list draws it in place: the list's visit where it handed one, else the reader's
 * runners through the room's seam. With neither (no visit, and a place whose room is off) nothing is drawn.
 */
export function LetterActions({
  messageId,
  deleteKeyId = messageId,
  canDeleteKey,
  canAnswerKey,
  keysHere,
  focus,
  showPanel,
  markUnread,
}: {
  messageId: string;
  deleteKeyId?: string;
  canDeleteKey?: (id: string) => boolean;
  canAnswerKey?: (id: string) => boolean;
  keysHere: boolean;
  focus?: boolean;
  showPanel?: boolean;
  markUnread?: (id: string) => void;
}) {
  const { mirror } = useMirror();
  const message = mirror?.get<EngineMessage>("message", messageId) ?? null;
  const visit = useListVisit(messageId);
  const verbs = useVerbs(message, visit, markUnread ? { onMarkUnread: markUnread } : null);
  const otherId = keysHere && deleteKeyId !== messageId ? deleteKeyId : null;
  const other = otherId === null ? null : (mirror?.get<EngineMessage>("message", otherId) ?? null);
  const otherVisit = useListVisit(otherId);
  const otherVerbs = useVerbs(other, otherVisit, null);
  const reply = useReplyVerbs(messageId);
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
      card={{ letter: message, keysHere, deleteTarget, canAnswerKey }}
      reply={reply}
      focus={focus}
      showPanel={showPanel}
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
  tagLabel,
}: Pick<ActionBarProps, "card" | "keys" | "verbs"> & {
  cardKeys: boolean;
  byKey: (which: PanelMenu) => void;
  showPanel: boolean;
  stop: RefObject<HTMLDivElement | null>;
  focus: boolean;
  replying: boolean;
  screeningLabel: string | undefined;
  tagLabel: string | undefined;
}): void {
  useCardKeys(
    cardKeys,
    card ? { letter: card.letter, verbs, menu: byKey, canAnswerKey: card.canAnswerKey } : null,
    card?.deleteTarget ?? null,
    showPanel,
  );
  useLetterKeys(
    keys != null,
    keys == null
      ? null
      : {
          letter: keys,
          verbs,
          menu: byKey,
          screeningLabel: screeningLabel,
          tagLabel: tagLabel,
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
