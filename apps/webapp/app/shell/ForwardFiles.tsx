"use client";

/**
 * THE ORIGINAL'S FILES UNDER A FORWARD — listed, each removable where the server sends only the parts a
 * forward names, with the plan's sentence under them (`forward-files.ts`). Rendered by the compose form
 * and the inline forward dock alike; the plan is the shell's, so the rows and the send are one answer.
 */
import { useTranslations } from "next-intl";
import { Icon, formatFileSize } from "@ohmail/ui";
import { activeFormatLocale } from "./locale";
import type { ForwardFilesPlan, ForwardLine } from "./forward-files";

/** A plan sentence in words, its byte counts in the reader's own units. */
export function useForwardLine(): (line: ForwardLine) => string {
  const t = useTranslations("compose");
  return (line) => {
    const values: Record<string, string> = {};
    for (const [k, n] of Object.entries(line.bytes ?? {})) values[k] = formatFileSize(n, activeFormatLocale());
    return t(line.key, values);
  };
}

export function ForwardFiles({
  plan,
  onRemove,
  disabled,
  said,
}: {
  plan: ForwardFilesPlan;
  onRemove: (id: string) => void;
  /** A send is in flight: nothing moves. */
  disabled: boolean;
  /** A press was refused: its reason is said in place of sending. */
  said: boolean;
}) {
  const t = useTranslations("compose");
  const say = useForwardLine();
  return (
    <div className="forward-files">
      {plan.rows.length > 0 ? (
        <>
          <p className="forward-files-head">{t("forwardFilesHead")}</p>
          <ul className="compose-attach-list">
            {plan.rows.map((part) => (
              <li key={part.id} className="compose-attach-item" data-forward-part={part.id}>
                <Icon name="clip" size={12} />
                <span className="compose-attach-name">{part.filename}</span>
                {part.inline ? <span className="forward-files-tag">{t("forwardFilesEmbedded")}</span> : null}
                <span className="compose-attach-size">{formatFileSize(part.sizeBytes, activeFormatLocale())}</span>
                {part.removable && !disabled ? (
                  <button
                    type="button"
                    className="compose-attach-remove"
                    aria-label={t("attachRemove", { filename: part.filename })}
                    onClick={() => onRemove(part.id)}
                  >
                    <Icon name="x" size={12} />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {plan.line !== null ? <p className="forward-files-line">{say(plan.line)}</p> : null}
      {said && plan.refusal !== null ? (
        <p className="forward-files-refusal" role="alert">{say(plan.refusal)}</p>
      ) : null}
    </div>
  );
}
