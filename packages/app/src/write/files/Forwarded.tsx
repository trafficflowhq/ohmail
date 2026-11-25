/**
 * THE FILES THAT GO WITH A FORWARD, under their heading: a tile each (the ones a person may take off say so), the
 * line that says what goes, and, once a press was refused, why. The plan is the composition's; every sentence key
 * it can name is read here by a literal key, and a key with no row says that the files could not be counted.
 */
import { useState, type ReactNode } from "react";
import { Files, FileTile, SendStatus, type FileTileProps } from "@ohmail/ui/mail";
import { MailRowMenu, type MenuTarget } from "../../place-list/MailRowMenu.js";
import { useText, type Text } from "../../text/index.js";
import { useWriteBeside } from "../above.js";
import type { ForwardLineKey, WriteForwardFiles } from "../ports.js";
import { kindOf } from "./kind.js";

type Values = Record<string, string>;

export function forwardWords(
  t: Text,
  line: ForwardLineKey,
  size: (bytes: number) => string,
): string | undefined {
  const v: Values = {};
  for (const [k, n] of Object.entries(line.bytes ?? {})) v[k] = size(n);
  switch (line.key) {
    case "forwardFilesReading":
      return t("forwarded.reading");
    case "forwardFilesTooLarge":
      return t("forwarded.tooLarge", v);
    case "forwardFilesTotalTooLarge":
      return t("forwarded.totalTooLarge", v);
    default:
      return undefined;
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
  const said = plan.said && refusal !== null ? (forwardWords(t, refusal, size) ?? null) : null;
  const summary =
    line?.key === "forwardFilesTooLarge" || line?.key === "forwardFilesTotalTooLarge"
      ? forwardWords(t, line, size)
      : undefined;
  if (rows.length === 0 && summary === undefined) return { forwarded: undefined, refusal: said };
  return {
    forwarded: {
      heading: t("forwarded.head"),
      files: (
        <Files summary={summary}>
          {rows.map((row) => (
            <ForwardedTile
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

function ForwardedTile({ off, ...props }: FileTileProps) {
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const remove = off?.onPress;
  return (
    <>
      <FileTile {...props} off={off} onMenu={remove ? (at, anchor) => setMenu({ at, anchor }) : undefined} />
      {off && remove && menu ? (
        <MailRowMenu
          target={menu}
          label={props.name}
          onClose={() => setMenu(null)}
          items={[{ label: off.label, icon: "x", onPress: remove }]}
        />
      ) : null}
    </>
  );
}

/** The refusal line, as the kit draws a file's note. */
export function ForwardRefusal({ sentence }: { sentence: string }) {
  return (
    <SendStatus place="start" sign="clip">
      {sentence}
    </SendStatus>
  );
}
