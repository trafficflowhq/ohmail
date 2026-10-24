"use client";

/**
 * THE DIAGNOSTICS BLOCK OF A MAIL TO SUPPORT, in the composer. The block is ordinary text in the
 * message body, so what support receives is what is on screen; this strip under the editor says
 * what the block holds and never holds, and takes it out of both halves of the body in one press
 * (or puts it back). An edited block is the person's own text and is left alone.
 */
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";
import { withSupportBlock, withoutSupportBlock } from "@trafficflow/core/diagnostics";
import { appendRich, escapeAsParagraphs, type RichValue } from "./rich-text";

/** The body without the block, or `null` when either half no longer holds it whole. */
export function richWithoutBlock(value: RichValue, block: string): RichValue | null {
  const text = withoutSupportBlock(value.text, block);
  if (text === null) return null;
  if (value.html === "") return { text, html: "" };
  const blockHtml = escapeAsParagraphs(block);
  if (!value.html.includes(blockHtml)) return null;
  const html = value.html.replace(blockHtml, "").replace(/(?:<p>(?:<br>)?<\/p>)+$/, "");
  return { text, html: text === "" ? "" : html };
}

/** The body with the block put back at its end. */
export function richWithBlock(value: RichValue, block: string): RichValue {
  return value.html === ""
    ? { text: withSupportBlock(value.text, block), html: "" }
    : appendRich(value, { text: block, html: "" });
}

export function SupportDiagnostics({ block, value, onChange, disabled }: {
  block: string;
  value: RichValue;
  onChange: (next: RichValue) => void;
  disabled: boolean;
}) {
  const t = useTranslations("help");
  const without = richWithoutBlock(value, block);
  const present = without !== null || value.text.includes(block);
  return (
    <div className="sig-block support-diag" role="group" aria-label={t("diag")}>
      <div className="sig-head">
        <span className="sig-tag">{present ? t("diag") : t("removed")}</span>
        {present ? (
          without !== null ? (
            <Button variant="ghost" disabled={disabled} onClick={() => onChange(without)}>{t("remove")}</Button>
          ) : null
        ) : (
          <Button variant="ghost" disabled={disabled} onClick={() => onChange(richWithBlock(value, block))}>{t("addBack")}</Button>
        )}
      </div>
      {present ? <p className="support-diag-what">{t("diagWhat")}</p> : null}
    </div>
  );
}
