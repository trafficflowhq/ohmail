/**
 * THE EDITOR'S MARKS, as the kit's strip draws them: the marks the editor names, each lit while it holds where the
 * caret is, and the link asked for in a card of the kit's own. A plain editor names none: no strip, no "Aa".
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button, Field, Menu, MenuItem } from "@ohmail/ui/base";
import type { ComposerMark, ComposerMarksProps, ComposerProps } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import type { EditorHandle, EditorLink, EditorMarks, MarkId, ParagraphStyle } from "../ports.js";

const NONE: ReadonlySet<MarkId> = new Set();
const NEVER = (): (() => void) => () => undefined;
const GROUPS: readonly (readonly MarkId[])[] = [
  ["bold", "italic", "underline", "strike"],
  ["link"],
  ["numbers", "bullets"],
  ["quote"],
  ["code", "codeBlock"],
  ["divider"],
];
const GLYPH: Partial<Record<MarkId, ComposerMark["glyph"]>> = {
  bold: { letter: "B", as: "bold" },
  italic: { letter: "I", as: "italic" },
  underline: { letter: "U", as: "underline" },
  strike: { letter: "S", as: "strike" },
};
const ICON: Partial<Record<MarkId, ComposerMark["icon"]>> = {
  code: "mcode",
  codeBlock: "mpre",
  divider: "divider",
  link: "link",
  bullets: "mul",
  numbers: "mol",
  quote: "mquote",
};

/** The marks lit now, read again on every change the editor reports. */
function useActive(marks: EditorMarks | null): ReadonlySet<MarkId> {
  const last = useRef<{ key: string; set: ReadonlySet<MarkId> }>({ key: "", set: NONE });
  return useSyncExternalStore(
    marks ? marks.subscribe : NEVER,
    () => {
      if (!marks) return NONE;
      const now = marks.active();
      const key = [...now].sort().join(" ");
      if (key !== last.current.key) last.current = { key, set: now };
      return last.current.set;
    },
    () => NONE,
  );
}

export interface MarksView {
  /** The strip, or undefined: not drawn. */
  readonly strip: ComposerMarksProps | undefined;
  /** The foot's "Aa", or undefined for a plain editor. */
  readonly format: ComposerProps["foot"]["format"];
  /** The link's card while it is asked. */
  readonly card: ReactNode;
}

export function useMarks(handle: EditorHandle | null, editable: boolean, initiallyShown = true): MarksView {
  const t = useText("write");
  const marks = handle !== null && handle.marks !== "none" ? handle.marks : null;
  const active = useActive(marks);
  const [shown, setShown] = useState(initiallyShown);
  const [paragraphAnchor, setParagraphAnchor] = useState<HTMLElement | null>(null);
  const paragraph = marks?.paragraph;
  const paragraphName = t("marks.paragraphStyle");
  const [link, setLink] = useState<EditorLink | null>(null);
  const opened = useRef<EditorLink | null>(null);
  const restore = useRef<EditorLink | null>(null);
  const close = useCallback(() => {
    restore.current = opened.current;
    opened.current = null;
    setLink(null);
  }, []);
  const toggle = useCallback(() => {
    if (!editable || !marks) return;
    if (opened.current) close();
    else {
      opened.current = marks.link.open();
      setLink(opened.current);
    }
  }, [editable, marks, close]);
  useEffect(() => {
    if (!editable) {
      close();
      setParagraphAnchor(null);
    }
  }, [editable, close]);
  useEffect(() => marks?.link.onKey(toggle), [marks, toggle]);
  useLayoutEffect(() => {
    if (link !== null) return;
    restore.current?.restore();
    restore.current = null;
  }, [link]);
  if (marks === null) return { strip: undefined, format: undefined, card: null };
  const label: Record<MarkId, string> = {
    bold: t("marks.bold"),
    italic: t("marks.italic"),
    underline: t("marks.underline"),
    strike: t("marks.strike"),
    code: t("marks.code"),
    codeBlock: t("marks.codeBlock"),
    divider: t("marks.divider"),
    link: t("marks.link"),
    bullets: t("marks.bullets"),
    numbers: t("marks.numbers"),
    quote: t("marks.quote"),
  };
  const offered = new Set(marks.ids);
  const groups = GROUPS.map((group) =>
    group
      .filter((id) => offered.has(id))
      .map((id): ComposerMark => ({
        id,
        label: label[id],
        glyph: GLYPH[id],
        icon: ICON[id],
        ...(id === "link"
          ? { dialogExpanded: link !== null }
          : id === "divider"
            ? {}
            : { pressed: active.has(id) }),
        disabled: !editable,
        onPress: id === "link" ? toggle : () => marks.run(id),
      })),
  );
  if (paragraph) {
    groups.splice(1, 0, [
      {
        id: "paragraph",
        label: paragraphName,
        icon: "paragraph",
        menuExpanded: paragraphAnchor !== null,
        disabled: !editable,
        onPress: (anchor) => setParagraphAnchor((current) => (current ? null : anchor)),
      },
    ]);
  }
  return {
    strip: shown ? { label: t("marks.bar"), groups: groups.filter((group) => group.length > 0) } : undefined,
    format: {
      label: t("marks.show"),
      word: t("marks.word"),
      pressed: shown,
      onPress: () => {
        setParagraphAnchor(null);
        setShown((s) => !s);
      },
    },
    card: link ? (
      <LinkCard link={link} onClose={close} />
    ) : paragraphAnchor && paragraph ? (
      <ParagraphMenu
        anchor={paragraphAnchor}
        paragraph={paragraph}
        subscribe={marks.subscribe}
        onClose={() => setParagraphAnchor(null)}
      />
    ) : null,
  };
}

function ParagraphMenu({
  anchor,
  paragraph,
  subscribe,
  onClose,
}: {
  anchor: HTMLElement;
  paragraph: NonNullable<EditorMarks["paragraph"]>;
  subscribe: EditorMarks["subscribe"];
  onClose: () => void;
}) {
  const t = useText("write");
  const selected = useSyncExternalStore(subscribe, paragraph.active, () => null);
  const choices: readonly [ParagraphStyle, string][] = [
    [0, t("marks.paragraph")],
    [1, t("marks.heading1")],
    [2, t("marks.heading2")],
    [3, t("marks.heading3")],
  ];
  return (
    <Menu open portal anchor={anchor} label={t("marks.paragraphStyle")} onClose={onClose}>
      {choices.map(([style, name]) => (
        <MenuItem
          key={style}
          checked={selected === style}
          checkmark
          onPress={() => {
            onClose();
            paragraph.set(style);
          }}
        >
          {name}
        </MenuItem>
      ))}
    </Menu>
  );
}

/** The link's address, asked in a card: Apply sets it, an empty address or Remove (over a link) takes it off. */
function LinkCard({ link, onClose }: { link: EditorLink; onClose: () => void }) {
  const t = useText("write");
  const address = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const [href, setHref] = useState(link.href ?? "");
  /* Remove is offered only where a link stands at the caret: elsewhere it would be a press that does nothing. */
  const [linked] = useState(link.href !== null);
  const [refused, setRefused] = useState(false);
  const apply = (value: string | null): void => {
    if (link.set(value) === "refused") setRefused(true);
    else onClose();
  };
  return (
    <Menu
      portal
      open
      onClose={onClose}
      label={t("link.title")}
      kind="card"
      title={t("link.title")}
      initialFocus={address}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply(href);
        }}
      >
        <Field
          ref={address}
          label={t("link.field")}
          value={href}
          type="url"
          inputMode="url"
          refusal={refused ? t("link.refused") : undefined}
          onChange={(next) => {
            setHref(next);
            setRefused(false);
          }}
        />
        {linked ? (
          <Button kind="quiet" size="s" onPress={() => apply(null)}>
            {t("link.remove")}
          </Button>
        ) : null}
        <Button kind="ink" size="s" onPress={() => apply(href)}>
          {t("link.apply")}
        </Button>
      </form>
    </Menu>
  );
}
