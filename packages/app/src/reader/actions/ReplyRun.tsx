import type { ComponentProps } from "react";
import type { ReplyRunState } from "@ohmail/app-logic/piles";
import { ActionPanel, ReadingHead, type PanelVerb } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";

export function RunReadingHead({
  run,
  ...head
}: ComponentProps<typeof ReadingHead> & { readonly run: ReplyRunState | null }) {
  const t = useText("later");
  return (
    <>
      {run === null ? null : (
        <div className="oh-text rd-reply-run">
          <b>{t("run.start")}</b>
          <span role="status">{t("run.progress", { step: run.step, total: run.total })}</span>
        </div>
      )}
      <ReadingHead {...head} />
    </>
  );
}

export function ReplyPanel({
  run,
  reply,
}: {
  readonly run: ReplyRunState | null;
  readonly reply: readonly PanelVerb[] | null;
}) {
  const reader = useText("reader");
  const t = useText("later");
  if (run === null) return <ActionPanel label={reader("panel")} items={reply ?? []} />;
  const send = reply?.find(({ id }) => id === "send");
  const items: PanelVerb[] = [
    ...(send ? [{ ...send, label: t("run.done"), rank: 0, wordOrder: 1 }] : []),
    { id: "skip", label: t("run.skip"), icon: "down", rank: 0, wordOrder: 2, onPress: run.skip },
    { id: "exit", label: t("run.exit"), icon: "x", rank: 0, wordOrder: 3, onPress: run.exit },
  ];
  return <ActionPanel label={t("run.label")} items={items} />;
}
