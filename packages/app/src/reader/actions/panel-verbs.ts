import { type PanelVerb } from "@ohmail/ui/mail";
import { ariaShortcut, chordKeys, useBinding, useModGlyph } from "@ohmail/app-logic/keys";
import { useText } from "../../text/index.js";
import { FORWARD_KEY, REPLY_KEY, type PanelMenu } from "../keys.js";
import { type Verbs } from "./use-verbs.js";

/** The room the panel stands in: the upright foldable and the phone keep some verbs behind More. */
export type PanelRoom = "desktop" | "fold" | "foldl" | "phone";

/**
 * A verb of the panel, and whether it stands behind More from the start in this room. Its press takes the element
 * pressed (the kit's K3): a menu it opens comes out of that control. Pressed from inside More, it takes More's button.
 */
export type Placed = PanelVerb & { behind?: boolean };
export interface ActionWords {
  readonly reply: string;
  readonly replyAll: string;
  readonly forward: string;
  readonly later: string;
  readonly aside: string;
  readonly resurface: string;
  readonly tag: string;
  readonly move: string;
  readonly more: string;
  readonly delete: string;
  readonly draftReply: string;
}

export type OpenPanel = Exclude<PanelMenu, "screening"> | "tag" | "confirmDelete" | null;

/**
 * The panel's verbs in the design's order and the ranks they fold by: Reply, Forward and the read slot never fold;
 * of the others the highest folds first (Tag, Resurface, Park, Later, Reply all). Once nothing is left to fold, the
 * read slot gives up its word first, then Forward, then Reply; on a foldable the read slot gives it up before
 * anything folds. On a phone and on the upright foldable Reply all and Tag stand behind More, and on a phone the
 * read slot too. Done leads on a resurfaced letter, with its filing verbs behind More on a phone.
 * Tag stands only where the account has tags.
 */
export function panelVerbs(
  t: ReturnType<typeof useText>,
  words: ActionWords,
  ohbox: ReturnType<typeof useText>,
  verbs: Verbs,
  tagged: boolean,
  toggle: (which: Exclude<OpenPanel, null>) => (at: HTMLElement) => void,
  room: PanelRoom,
  hints: ReturnType<typeof usePanelHints>,
  conversation: boolean,
  screening?: { label: string; dialog?: PanelVerb["dialog"]; onPress: (anchor: HTMLElement) => void },
): Placed[] {
  const { act, done, filed } = verbs;
  const compact = room === "phone" || room === "fold";
  /* The three that file the letter are toggles: each says whether the letter is in its pile, as today's bar does. */
  const file = (id: "later" | "aside", icon: "later" | "parked", rank: number): Placed => ({
    id,
    label: words[id],
    icon,
    segment: "file",
    rank,
    behind: done && room === "phone",
    pressed: filed === (id === "later" ? "reply_later" : "set_aside"),
    ...hints[id],
    onPress: () => act(id),
  });
  return [
    ...(done
      ? [
          {
            id: "done",
            label: ohbox("actionDone"),
            icon: "check" as const,
            kind: "ink" as const,
            rank: 0,
            keyHint: "⇧I",
            onPress: () => act("resurface_done"),
          },
        ]
      : []),
    {
      id: "reply",
      label: words.reply,
      icon: "reply",
      kind: done ? undefined : "ink",
      rank: 0,
      wordOrder: 3,
      ...hints.reply,
      onPress: () => act("reply"),
    },
    ...(verbs.replyAll
      ? [
          {
            id: "reply_all",
            label: words.replyAll,
            icon: "replyall" as const,
            rank: 1,
            behind: compact,
            ...hints.replyAll,
            onPress: () => act("reply_all"),
          },
        ]
      : []),
    {
      id: "forward",
      label: words.forward,
      icon: "forward",
      rank: 0,
      wordOrder: 2,
      ...hints.forward,
      onPress: () => act("forward"),
    },
    file("later", "later", 2),
    file("aside", "parked", 3),
    {
      id: "resurface",
      label: words.resurface,
      icon: "resurface",
      segment: "file",
      rank: 4,
      behind: done && room === "phone",
      pressed: filed === "bubbled_up",
      ...hints.resurface,
      onPress: toggle("resurface"),
    },
    ...(tagged
      ? [
          {
            id: "tag",
            label: words.tag,
            icon: "tags" as const,
            segment: "file",
            apart: done,
            rank: 5,
            behind: compact,
            ...hints.tag,
            onPress: toggle("tag"),
          },
        ]
      : []),
    ...(screening
      ? [
          {
            id: "screening",
            label: screening.label,
            icon: "screener" as const,
            rank: 6,
            behind: compact,
            ...hints.screening,
            dialog: screening.dialog,
            onPress: screening.onPress,
          },
        ]
      : []),
    ...readVerb(t, verbs, room, hints.read, conversation),
  ];
}

export function usePanelHints(readSlot: Verbs["readSlot"], active: boolean, canAnswer: boolean) {
  const mod = useModGlyph();
  const reply = useBinding(REPLY_KEY);
  const replyAll = useBinding("shift+r");
  const forward = useBinding(FORWARD_KEY);
  const later = useBinding("a");
  const aside = useBinding("e");
  const resurface = useBinding("b");
  const tag = useBinding("t");
  const screening = useBinding("s");
  const calendar = useBinding("v");
  const read = useBinding(readSlot === "markRead" ? "shift+i" : "u");
  const hint = (binding: typeof reply) =>
    !active || binding === null
      ? {}
      : {
          keyHint: chordKeys(binding.chord, mod).join(" "),
          shortcut: ariaShortcut(binding.chord, mod),
        };
  return {
    reply: canAnswer ? hint(reply) : {},
    replyAll: canAnswer ? hint(replyAll) : {},
    forward: canAnswer ? hint(forward) : {},
    later: hint(later),
    aside: hint(aside),
    resurface: hint(resurface),
    tag: hint(tag),
    screening: hint(screening),
    read: hint(read),
    calendar: hint(calendar),
  };
}

function readVerb(
  t: ReturnType<typeof useText>,
  { readSlot, readCount, act }: Verbs,
  room: PanelRoom,
  hint: ReturnType<typeof usePanelHints>["read"],
  conversation: boolean,
): Placed[] {
  if (readSlot === null) return [];
  return [
    {
      id: "read",
      label: t(`verb.${readSlot}`),
      /* Over a conversation the press marks every unread letter of it. */
      name:
        readSlot === "markRead" && (readCount > 1 || (conversation && readCount > 0))
          ? t("verb.markReadCount", { count: readCount })
          : undefined,
      icon: readSlot === "markRead" ? "read" : "unread",
      apart: true,
      rank: 0,
      wordOrder: 1,
      wordFirst: room === "fold" || room === "foldl",
      behind: room === "phone",
      ...hint,
      widest: t("verb.markUnread"),
      hotIcon: readSlot === "markRead",
      onPress: () => act("unread"),
    },
  ];
}
