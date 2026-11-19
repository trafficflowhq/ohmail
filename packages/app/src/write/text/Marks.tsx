/**
 * THE EDITOR'S MARKS, as the kit's strip draws them: the marks the editor names, each lit while it holds where the
 * caret is, and the link asked for in a card of the kit's own. A plain editor names none: no strip, no "Aa".
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, Field, Menu } from "@ohmail/ui/base";
import type { ComposerMark, ComposerMarksProps, ComposerProps } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import type { EditorHandle, EditorMarks, MarkId } from "../ports.js";

const NONE: ReadonlySet<MarkId> = new Set();
const NEVER = (): (() => void) => () => undefined;
const GROUPS: readonly (readonly MarkId[])[] = [
  ["bold", "italic", "underline", "strike"],
  ["link"],
  ["numbers", "bullets"],
  ["quote"],
  ["code"],
];
const GLYPH: Partial<Record<MarkId, ComposerMark["glyph"]>> = {
  bold: { letter: "B", as: "bold" },
  italic: { letter: "I", as: "italic" },
  underline: { letter: "U", as: "underline" },
  strike: { letter: "S", as: "strike" },
};
const ICON: Partial<Record<MarkId, ComposerMark["icon"]>> = {
  code: "mcode",
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
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!editable) setAsking(false);
  }, [editable]);
  useEffect(() => marks?.link.onKey(() => setAsking((open) => !open)), [marks]);
  if (marks === null) return { strip: undefined, format: undefined, card: null };
  const label: Record<MarkId, string> = {
    bold: t("marks.bold"),
    italic: t("marks.italic"),
    underline: t("marks.underline"),
    strike: t("marks.strike"),
    code: t("marks.code"),
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
        pressed: id === "link" ? asking : active.has(id),
        disabled: !editable,
        onPress: id === "link" ? () => setAsking((open) => !open) : () => marks.run(id),
      })),
  ).filter((group) => group.length > 0);
  return {
    strip: shown ? { label: t("marks.bar"), groups } : undefined,
    format: {
      label: t("marks.show"),
      word: t("marks.word"),
      pressed: shown,
      onPress: () => setShown((s) => !s),
    },
    card: asking ? (
      <LinkCard
        marks={marks}
        onClose={() => {
          setAsking(false);
          handle?.focus({ preventScroll: true });
        }}
      />
    ) : null,
  };
}

/** The link's address, asked in a card: Apply sets it, an empty address or Remove (over a link) takes it off. */
function LinkCard({ marks, onClose }: { marks: EditorMarks; onClose: () => void }) {
  const t = useText("write");
  const [href, setHref] = useState(() => marks.link.read() ?? "");
  /* Remove is offered only where a link stands at the caret: elsewhere it would be a press that does nothing. */
  const [linked] = useState(() => marks.link.read() !== null);
  const [refused, setRefused] = useState(false);
  const apply = (value: string | null): void => {
    if (marks.link.set(value) === "refused") setRefused(true);
    else onClose();
  };
  return (
    <Menu open onClose={onClose} label={t("link.title")} kind="card" title={t("link.title")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply(href);
        }}
      >
        <Field
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
