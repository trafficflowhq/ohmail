"use client";

import { Button } from "@ohmail/ui/base";
import type { RichValue } from "@ohmail/app-logic/writing/rich-text";
import { useText } from "../../text/index.js";

import { useWriting } from "../above.js";
import { useWriteParts } from "../parts.js";
import type { EditorProps } from "../ports.js";
import { useQuotedHistory } from "./QuotedHistory.js";
import { SupportDiagnostics } from "./SupportDiagnostics.js";

/** The editor and support controls update both halves of the same draft body. */
export function LetterText(props: Omit<EditorProps, "value" | "onChange" | "label">) {
  const { editor: Editor } = useWriteParts();
  const { compose, onComposeFields, composeHistoryTarget, composeEpochNow } = useWriting();
  const t = useText("write");
  const quotedHistory = useQuotedHistory(
    composeHistoryTarget?.messageId,
    composeHistoryTarget?.forward === true,
  );
  const editorKey = `${composeEpochNow?.() ?? 0}:${composeHistoryTarget?.messageId ?? ""}:${composeHistoryTarget?.forward ?? false}`;
  const value = { text: compose.body, html: compose.html };
  const onChange = (next: RichValue) =>
    onComposeFields({ ...compose, body: next.text, html: next.html, aiDraft: false });
  return (
    <>
      <Editor
        key={editorKey}
        {...props}
        quotedHistory={quotedHistory}
        label={t("text")}
        value={value}
        onChange={onChange}
      />
      {compose.diag ? (
        <SupportDiagnostics
          block={compose.diag}
          value={value}
          onChange={onChange}
          action={({ word, remove, press }) => (
            <Button
              kind="quiet"
              size="s"
              icon={remove ? "x" : undefined}
              disabled={!props.editable}
              onPress={press}
            >
              {word}
            </Button>
          )}
        />
      ) : null}
    </>
  );
}
