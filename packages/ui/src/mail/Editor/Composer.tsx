import { useState, type DragEvent, type ReactNode } from "react";
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
  /** The mailbox's signature under the text: written over where it stands, and the way to take it off. */
  signature?: {
    label: string;
    text: string;
    onChange?: (text: string) => void;
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
        <div className="oh-composer-text">{children}</div>
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

/** The signature under the text: words a person can change in place, and the way to take it off. While the letter goes it is words alone. */
function ComposerSignature({
  signature,
  going,
}: {
  signature: NonNullable<ComposerProps["signature"]>;
  going?: boolean;
}) {
  return (
    <div className="oh-composer-signature">
      {going ? (
        <span className="oh-composer-signed">{signature.text}</span>
      ) : (
        <span
          className="oh-composer-signed"
          role="textbox"
          aria-multiline="true"
          aria-label={signature.label}
          contentEditable="plaintext-only"
          suppressContentEditableWarning
          spellCheck={false}
          onBlur={(event) => signature.onChange?.(event.currentTarget.textContent ?? "")}
        >
          {signature.text}
        </span>
      )}
      {signature.remove ? (
        <Button
          kind="quiet"
          size="s"
          icon="x"
          label={signature.remove.label}
          onPress={signature.remove.onPress}
        />
      ) : null}
    </div>
  );
}
