"use client";

import { Button } from "@ohmail/ui";
import { richWithBlock, richWithoutBlock, type RichValue } from "@ohmail/app-logic/writing/rich-text";
import { useText } from "../../text/index.js";

import { useWriting } from "../above.js";
import { useWriteParts } from "../parts.js";
import type { EditorProps } from "../ports.js";

/** The editor and support controls update both halves of the same draft body. */
export function LetterText(props: Omit<EditorProps, "value" | "onChange" | "label">) {
  const { editor: Editor } = useWriteParts();
  const { compose, onComposeFields } = useWriting();
  const t = useText("write");
  const value = { text: compose.body, html: compose.html };
  const onChange = (next: RichValue) => onComposeFields({ ...compose, body: next.text, html: next.html });
  return (
    <>
      <Editor {...props} label={t("text")} value={value} onChange={onChange} />
      {compose.diag ? (
        <SupportDiagnostics
          block={compose.diag}
          value={value}
          onChange={onChange}
          disabled={!props.editable}
        />
      ) : null}
    </>
  );
}

/**
 * THE DIAGNOSTICS BLOCK OF A MAIL TO SUPPORT, in the composer. The block is ordinary text in the
 * message body, so what support receives is what is on screen; this strip under the editor says
 * what the block holds and never holds, and takes it out of both halves of the body in one press
 * (or puts it back). An edited block is the person's own text and is left alone.
 */
export function SupportDiagnostics({
  block,
  value,
  onChange,
  disabled,
}: {
  block: string;
  value: RichValue;
  onChange: (next: RichValue) => void;
  disabled: boolean;
}) {
  const t = useText("help");
  const without = richWithoutBlock(value, block);
  const present = without !== null || value.text.includes(block);
  return (
    <div className="sig-block support-diag" role="group" aria-label={t("diag")}>
      <div className="sig-head">
        <span className="sig-tag">{present ? t("diag") : t("removed")}</span>
        {present ? (
          without !== null ? (
            <Button variant="ghost" disabled={disabled} onClick={() => onChange(without)}>
              {t("remove")}
            </Button>
          ) : null
        ) : (
          <Button variant="ghost" disabled={disabled} onClick={() => onChange(richWithBlock(value, block))}>
            {t("addBack")}
          </Button>
        )}
      </div>
      {present ? <p className="support-diag-what">{t("diagWhat")}</p> : null}
    </div>
  );
}
