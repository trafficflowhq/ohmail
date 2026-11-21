"use client";

import type { ReactNode } from "react";
import { richWithBlock, richWithoutBlock, type RichValue } from "@ohmail/app-logic/writing/rich-text";
import { useText } from "../../text/index.js";

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
  action,
}: {
  block: string;
  value: RichValue;
  onChange: (next: RichValue) => void;
  action: (choice: { word: string; remove: boolean; press: () => void }) => ReactNode;
}) {
  const t = useText("help");
  const without = richWithoutBlock(value, block);
  const present = without !== null || value.text.includes(block);
  return (
    <div className="sig-block support-diag" role="group" aria-label={t("diag")}>
      <div className="sig-head">
        <span className="sig-tag">{present ? t("diag") : t("removed")}</span>
        {without !== null
          ? action({ word: t("remove"), remove: true, press: () => onChange(without) })
          : !present
            ? action({
                word: t("addBack"),
                remove: false,
                press: () => onChange(richWithBlock(value, block)),
              })
            : null}
      </div>
      {present ? <p className="support-diag-what">{t("draftDiagWhat")}</p> : null}
    </div>
  );
}
