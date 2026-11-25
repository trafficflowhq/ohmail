import type { ReactNode } from "react";
import { ComposerMarks, type ComposerMarksProps } from "./ComposerMarks.js";
import { AfterComposerTextSlot } from "./AfterComposerText.js";
import "./composer.css";

interface ComposerEditorProps {
  marks?: ComposerMarksProps;
  tabs?: ReactNode;
  children: ReactNode;
  afterText?: ReactNode;
  footer?: ReactNode;
  placeholder?: string;
  preview?: string;
  signature?: boolean;
}

/** The formatting strip and actions frame the scrolling text, in a letter or in signature settings. */
export function ComposerEditor({
  marks,
  tabs,
  children,
  afterText,
  footer,
  placeholder,
  preview,
  signature,
}: ComposerEditorProps) {
  return (
    <div className="oh-composer-editor" data-signature={signature ? "" : undefined}>
      {marks && <ComposerMarks {...marks} />}
      {tabs}
      <div className="oh-composer-scroll">
        <AfterComposerTextSlot>
          <div className="oh-composer-text" data-preview={preview === undefined ? undefined : ""}>
            {preview !== undefined && <div className="oh-composer-preview">{preview}</div>}
            {placeholder && (
              <span className="oh-composer-placeholder" aria-hidden="true" data-words={placeholder} />
            )}
            {children}
          </div>
        </AfterComposerTextSlot>
        {afterText}
      </div>
      {footer}
    </div>
  );
}
