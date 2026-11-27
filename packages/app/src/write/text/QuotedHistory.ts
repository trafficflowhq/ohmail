import { useText } from "../../text/index.js";
import { useWriting } from "../above.js";
import type { EditorProps } from "../ports.js";

export function useQuotedHistory(
  messageId: string | undefined,
  forward: boolean,
): EditorProps["quotedHistory"] {
  const { loadQuotedHistory } = useWriting();
  const t = useText("write");
  if (!messageId || !loadQuotedHistory) return undefined;
  return {
    load: () => loadQuotedHistory(messageId, forward),
    show: t("history.show"),
    hide: t("history.hide"),
    edit: t("history.edit"),
    restore: t("history.restore"),
    unavailable: t("history.unavailable"),
  };
}
