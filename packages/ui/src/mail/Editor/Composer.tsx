import {
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { Button } from "../../base/index.js";
import "./composer.css";
import { ComposerMarks, type ComposerMarksProps } from "./ComposerMarks.js";

export interface ComposerProps {
  /** The sheet's name for a screen reader: "New message", "Reply to Giulia Ferrari". */
  label: string;
  /** A reply: one more sheet at the end of its conversation. */
  reply?: boolean;
  /** What happened to this draft, over its lines: a SendStatus. */
  status?: ReactNode;
  /** Who it goes from and to, and its subject: Recipients. */
  head: ReactNode;
  /** The editor's marks. Left out: the strip is not drawn. */
  marks?: ComposerMarksProps;
  /** The two texts once a draft has landed: DraftTabs. */
  tabs?: ReactNode;
  /** The text itself: the app's editor. */
  children: ReactNode;
  /**
   * The words that stand where the text's first line will stand. The app hands them while nothing is written; the
   * editor says its own placeholder to a screen reader, so these are drawn and not said.
   */
  placeholder?: string;
  /** The mailbox's signature under the text: written over where it stands, and the way to take it off. */
  signature?: {
    label: string;
    text: string;
    onChange?: (text: string) => void;
    /**
     * The field was left, with the words it then holds: said apart from `onChange`, so what holds the letter can
     * tell a leave from a keystroke (a field written down to nothing goes when it is left, not while it is typed in).
     */
    onLeave?: (text: string) => void;
    /** The letter is held by an earlier send: the signature is words alone, as while it goes. */
    locked?: boolean;
    /**
     * The signature as the letter will carry it, its formatting drawn: it stands in the field's place and takes no
     * keys, so nothing of it is lost by typing. The app draws it; the kit reads no markup.
     */
    formatted?: ReactNode;
    /**
     * Beside a formatted signature: the one way to the plain field. `word` says what the press does; `label` names
     * it whole where the word does not say what the press costs. The app answers by handing no `formatted`: the
     * field that press brings takes the keys. An app that draws the formatted signature again first (it asks
     * before the formatting goes) puts the keys where its own answer leaves them.
     */
    asText?: { word: string; label?: string; onPress?: () => void };
    remove?: { label: string; onPress?: () => void };
  };
  /** The files that came with a forward, under their heading: Files. */
  forwarded?: { heading: string; files: ReactNode };
  /** The files put on the letter: Files, each tile with its way off. */
  files?: ReactNode;
  /** One line over the foot: why it was not sent, why nothing was drafted, why a file was not attached. */
  note?: ReactNode;
  foot: {
    label: string;
    /** The clip: Attach. */
    attach?: ReactNode;
    /** Shows and hides the marks. `word` is what stands for it: "Aa". */
    format?: { label: string; word: string; pressed: boolean; onPress?: () => void };
    emoji?: { label: string; expanded?: boolean; onPress?: (anchor: HTMLElement) => void };
    /** At the far end: DraftControl. */
    draft?: ReactNode;
  };
  /** A new message alone in its column, the column a flex column: in ohmarchy its text fills the column down to the foot. */
  fill?: boolean;
  /** A draft is being written: the text is held and a line runs along the editor's top. */
  drafting?: boolean;
  /** It is on its way: the ink ring steps back. */
  going?: boolean;
  /** A file is held over the letter. Left out: the part sees it itself. */
  dropping?: boolean;
  /** Files were let go over the letter. */
  onFiles?: (files: File[]) => void;
}

const carriesFiles = (e: DragEvent): boolean => [...e.dataTransfer.types].includes("Files");

/**
 * A letter being written: one sheet in the app's order, the editor a box inside it. The part is the
 * frame; the text is handed in. A file let go anywhere over the sheet is handed on.
 */
export function Composer(props: ComposerProps) {
  const {
    label,
    reply,
    status,
    head,
    marks,
    tabs,
    children,
    signature,
    forwarded,
    files,
    note,
    foot,
    onFiles,
  } = props;
  const [over, setOver] = useState(false);
  const drop = onFiles
    ? {
        onDragEnter: (e: DragEvent) => carriesFiles(e) && setOver(true),
        onDragOver: (e: DragEvent) => carriesFiles(e) && e.preventDefault(),
        onDragLeave: (e: DragEvent<HTMLElement>) =>
          e.currentTarget.contains(e.relatedTarget as Node | null) || setOver(false),
        onDrop: (e: DragEvent) => {
          if (!carriesFiles(e)) return;
          e.preventDefault();
          setOver(false);
          onFiles([...e.dataTransfer.files]);
        },
      }
    : {};
  return (
    <section
      className="oh-composer"
      aria-label={label}
      aria-busy={props.drafting || undefined}
      data-reply={reply ? "" : undefined}
      data-fill={props.fill ? "" : undefined}
      data-drafting={props.drafting ? "" : undefined}
      data-going={props.going ? "" : undefined}
      data-dropping={(props.dropping ?? over) ? "" : undefined}
      {...drop}
    >
      {status}
      {head}
      <div className="oh-composer-editor">
        {marks ? <ComposerMarks {...marks} /> : null}
        {tabs}
        <div className="oh-composer-text">
          {props.placeholder ? (
            <span className="oh-composer-placeholder" aria-hidden="true" data-words={props.placeholder} />
          ) : null}
          {children}
        </div>
        {signature ? <ComposerSignature signature={signature} going={props.going} /> : null}
        {forwarded || files ? (
          <div className="oh-composer-files">
            {forwarded ? <h3 className="oh-text oh-composer-fileshead">{forwarded.heading}</h3> : null}
            {forwarded?.files}
            {files}
          </div>
        ) : null}
        {note}
        <div
          className="oh-composer-foot"
          role="toolbar"
          aria-label={foot.label}
          onMouseDown={(e) => e.preventDefault()}
        >
          {foot.attach}
          {foot.attach && (foot.format || foot.emoji) ? (
            <i className="oh-composer-hair" aria-hidden="true" />
          ) : null}
          {foot.format ? (
            <span className="oh-composer-format">
              <Button
                kind="quiet"
                size="s"
                label={foot.format.label}
                pressed={foot.format.pressed}
                onPress={foot.format.onPress}
              >
                {foot.format.word}
              </Button>
            </span>
          ) : null}
          {foot.emoji ? (
            <span className="oh-composer-emoji">
              <Button
                kind="quiet"
                size="s"
                icon="msmile"
                label={foot.emoji.label}
                opens="menu"
                expanded={foot.emoji.expanded}
                onPress={(event) => foot.emoji?.onPress?.(event.currentTarget)}
              />
            </span>
          ) : null}
          {foot.draft}
        </div>
      </div>
    </section>
  );
}

/**
 * The signature under the text: words a person can change in place, and the way to take it off. Its words are
 * handed over while they are typed, so a send from inside the field carries what is on the screen. While the
 * letter goes it is words alone. A formatted signature is drawn as it will be sent and is no field: the way to
 * its words is a press of its own.
 */
function ComposerSignature({
  signature,
  going,
}: {
  signature: NonNullable<ComposerProps["signature"]>;
  going?: boolean;
}) {
  const fixed = going || signature.locked;
  const { formatted, asText, remove } = signature;
  /* "Edit as text" was pressed: the press takes its own button away, so the field it opens takes the keys. */
  const opened = useRef(false);
  /* The press is answered by the field or not at all: where the formatted signature is drawn again after it (an
     app that asks first, and is told no), the press is forgotten, and a field that comes later takes no keys. */
  useLayoutEffect(() => {
    if (formatted !== undefined) opened.current = false;
  });
  /* A letter on its way, or held by an earlier send, keeps its signature: the way to take it off is not offered. */
  const off =
    remove && !fixed ? (
      <Button kind="quiet" size="s" icon="x" label={remove.label} onPress={remove.onPress} />
    ) : null;
  if (formatted !== undefined) {
    return (
      <div className="oh-composer-signature" data-formatted="">
        <div className="oh-composer-signed" role="group" aria-label={signature.label}>
          {formatted}
        </div>
        <span className="oh-composer-signacts">
          {asText && !fixed ? (
            <Button
              kind="quiet"
              size="s"
              label={asText.label}
              onPress={() => {
                opened.current = true;
                asText.onPress?.();
              }}
            >
              {asText.word}
            </Button>
          ) : null}
          {off}
        </span>
      </div>
    );
  }
  return (
    <div className="oh-composer-signature">
      {fixed ? (
        <span className="oh-composer-signed">{signature.text}</span>
      ) : (
        <SignatureField signature={signature} opened={opened} />
      )}
      {off}
    </div>
  );
}

function SignatureField({
  signature,
  opened,
}: {
  signature: NonNullable<ComposerProps["signature"]>;
  /** Whether the press that opens the plain field brought it here: then the keys are its own, once. */
  opened: RefObject<boolean>;
}) {
  const field = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el || !opened.current) return;
    opened.current = false;
    el.focus();
    /* The caret after the words, where a person goes on writing. */
    const caret = el.ownerDocument.getSelection();
    caret?.selectAllChildren(el);
    caret?.collapseToEnd();
  }, [opened]);
  /* The field's words are its own while it is typed in. It is drawn once with the words it starts with, and
     written again only where it holds other words than it is handed: the caret stays where the person types. */
  const [first] = useState(signature.text);
  useLayoutEffect(() => {
    const el = field.current;
    if (el && el.textContent !== signature.text) el.textContent = signature.text;
  }, [signature.text]);
  const report = (event: SyntheticEvent<HTMLSpanElement>) =>
    signature.onChange?.(event.currentTarget.textContent ?? "");
  return (
    <span
      ref={field}
      className="oh-composer-signed"
      role="textbox"
      aria-multiline="true"
      aria-label={signature.label}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      onInput={report}
      onBlur={(event) => {
        report(event);
        signature.onLeave?.(event.currentTarget.textContent ?? "");
      }}
    >
      {first}
    </span>
  );
}
