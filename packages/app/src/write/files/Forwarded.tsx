/**
 * THE FILES THAT GO WITH A FORWARD, under their heading: a tile each (the ones a person may take off say so), the
 * line that says what goes, and, once a press was refused, why. The plan is the composition's; every sentence key
 * it can name is read here by a literal key, and a key with no row says that the files could not be counted.
 */
import type { ReactNode } from "react";
import { Files, FileTile, SendStatus } from "@ohmail/ui/mail";
import { useText, type Text } from "../../text/index.js";
import { useWriteBeside } from "../above.js";
import type { ForwardLineKey, WriteForwardFiles } from "../ports.js";
import { kindOf } from "./kind.js";

type Values = Record<string, string>;

export function forwardWords(t: Text, line: ForwardLineKey, size: (bytes: number) => string): string {
  const v: Values = {};
  for (const [k, n] of Object.entries(line.bytes ?? {})) v[k] = size(n);
  switch (line.key) {
    case "forwardFilesLine":
      return t("forwarded.line", v);
    case "forwardFilesAllGo":
      return t("forwarded.allGo", v);
    case "forwardFilesReading":
      return t("forwarded.reading", v);
    case "forwardFilesUnreadKept":
      return t("forwarded.unreadKept", v);
    case "forwardFilesUnreadAllGo":
      return t("forwarded.unreadAllGo", v);
    case "forwardFilesRemovedGo":
      return t("forwarded.removedGo", v);
    case "forwardFilesUnreadRemovedGo":
      return t("forwarded.unreadRemovedGo", v);
    case "forwardFilesTooLarge":
      return t("forwarded.tooLarge", v);
    case "forwardFilesTotalTooLarge":
      return t("forwarded.totalTooLarge", v);
    default:
      return t("forwarded.unknown");
  }
}

export interface ForwardedView {
  /** The composer's `forwarded` slot, or undefined when the original has no file. */
  readonly forwarded: { heading: string; files: ReactNode } | undefined;
  /** Why a press was refused over these files, said over the foot; or null. */
  readonly refusal: string | null;
}

export function useForwarded(plan: WriteForwardFiles | null, locked: boolean): ForwardedView {
  const t = useText("write");
  const { size } = useWriteBeside();
  if (plan === null) return { forwarded: undefined, refusal: null };
  const { rows, line, refusal } = plan.plan;
  const said = plan.said && refusal !== null ? forwardWords(t, refusal, size) : null;
  if (rows.length === 0 && line === null) return { forwarded: undefined, refusal: said };
  return {
    forwarded: {
      heading: t("forwarded.head"),
      files: (
        <Files summary={line === null ? undefined : forwardWords(t, line, size)}>
          {rows.map((row) => (
            <FileTile
              key={row.id}
              kind={kindOf(row.filename)}
              name={row.inline ? t("forwarded.embedded", { filename: row.filename }) : row.filename}
              size={size(row.sizeBytes)}
              off={
                row.removable && !locked
                  ? {
                      label: t("files.remove", { filename: row.filename }),
                      onPress: () => plan.onRemove(row.id),
                    }
                  : undefined
              }
            />
          ))}
        </Files>
      ),
    },
    refusal: said,
  };
}

/** The refusal line, as the kit draws a file's note. */
export function ForwardRefusal({ sentence }: { sentence: string }) {
  return (
    <SendStatus place="start" sign="clip">
      {sentence}
    </SendStatus>
  );
}
