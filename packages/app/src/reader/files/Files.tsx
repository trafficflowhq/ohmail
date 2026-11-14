/**
 * A LETTER'S FILES, drawn from the list the shell's file door holds; nothing here fetches. A press on a file that can
 * be looked at opens the shell's one look, any other press saves. A file that did not arrive says one whole sentence
 * and offers what helps, on its tile, or nothing where nothing helps.
 */
import { useEffect } from "react";
import { FileNotArrived, FileTile, Files as KitFiles } from "@ohmail/ui/mail";
import { faultOf, fileLookOf, thumbnailOf } from "@ohmail/app-logic/reader";
import { useFrame } from "../../frame/commands.js";
import { NONE } from "../../host/index.js";
import { useLocale, useText } from "../../text/index.js";
import { useParts } from "../parts.js";
import type { ReaderFile, ReaderFiles } from "../ports.js";

const KIND: Record<ReturnType<typeof fileLookOf>, string> = {
  image: "IMG",
  pdf: "PDF",
  text: "TXT",
  other: "FILE",
};

/** A file's kind as its tile prints it: the declared type's, or the name's ending as it stands, never cut. */
function kindOf(item: ReaderFile): string {
  const look = fileLookOf(item.mimeType);
  /* Text says its own declared kind where that is a short word (CSV), plain text TXT. */
  const sub = (item.mimeType.split(";")[0] ?? "").trim().toLowerCase().split("/")[1] ?? "";
  if (look === "text" && sub !== "plain" && /^[a-z]{2,4}$/.test(sub)) return sub.toUpperCase();
  if (look !== "other") return KIND[look];
  const dot = item.filename.lastIndexOf(".");
  return dot > 0 && dot < item.filename.length - 1 ? item.filename.slice(dot + 1).toUpperCase() : KIND.other;
}

function sizeOf(bytes: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let u = 0;
  while (n >= 1000 && u < units.length - 1) {
    n /= 1000;
    u += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: n < 10 && u > 0 ? 1 : 0 }).format(n)} ${units[u]}`;
}

function Tile({ messageId, item, files }: { messageId: string; item: ReaderFile; files: ReaderFiles }) {
  const t = useText("attachments");
  const tb = useText("body");
  const { host } = useFrame();
  const { look } = useParts();
  const locale = useLocale();
  const kind = kindOf(item);
  const size = sizeOf(item.sizeBytes, locale);
  if (item.state === "loading")
    return <FileNotArrived state="fetching" kind={kind} name={item.filename} line={t("loading")} />;
  if (item.state === "too_large")
    return <FileNotArrived state="large" kind={kind} name={item.filename} line={t("tooLarge", { size })} />;
  if (item.state === "failed") {
    const fault = faultOf(item);
    const recover = host.session.recover;
    const way =
      fault.way === "retry"
        ? { label: t("listRetry"), onPress: () => files.ensure(messageId, item.id, { retry: true }) }
        : fault.way === "signIn" && recover !== NONE
          ? { label: tb("signIn"), onPress: () => recover("signIn") }
          : undefined;
    return <FileNotArrived state="failed" kind={kind} name={item.filename} line={t(fault.key)} way={way} />;
  }
  const thumb = thumbnailOf(item);
  const lookable = look !== NONE && fileLookOf(item.mimeType) !== "other";
  return (
    <FileTile
      kind={kind}
      name={item.filename}
      size={item.inline ? `${size} · ${t("embedded")}` : size}
      look={thumb ? <img src={thumb} alt="" /> : undefined}
      main={{
        label: lookable ? t("preview", { name: item.filename }) : t("download", { name: item.filename }),
        onPress: () =>
          lookable
            ? (look as (m: string, a: string) => void)(messageId, item.id)
            : files.open(messageId, item.id),
      }}
      save={{ label: t("download", { name: item.filename }), onPress: () => files.open(messageId, item.id) }}
    />
  );
}

export function LetterFiles({ messageId }: { messageId: string }) {
  const t = useText("attachments");
  const { files } = useParts();
  /* Keyed on the hold alone: the door changes identity while it fetches (Download all), a hold must not. */
  const hold = files === NONE ? undefined : files.hold;
  useEffect(() => hold?.(messageId), [hold, messageId]);
  if (files === NONE) return null;
  const list = files.itemsOf(messageId, { includeInlineParts: true });
  if (list.state === "failed") {
    return (
      <FileNotArrived
        state="list"
        line={t("listFailed")}
        way={{ label: t("listRetry"), onPress: list.onRetry }}
      />
    );
  }
  if (list.state !== "ready") return null;
  /* The door already leaves out an invitation's calendar body that a listed calendar file carries (Google's pair); one
     it lists is the event's one copy (Exchange, Outlook), a file the person can save. */
  const items = list.items;
  if (items.length === 0) return null;
  const many = items.length > 1;
  return (
    <KitFiles
      summary={many ? t("count", { count: items.length }) : undefined}
      all={
        many
          ? {
              label: t("downloadAll"),
              busy: files.downloadingAll(messageId),
              onPress: () => files.downloadAll(messageId, { includeInlineParts: true }),
            }
          : undefined
      }
    >
      {items.map((item) => (
        <Tile key={item.id} messageId={messageId} item={item} files={files} />
      ))}
    </KitFiles>
  );
}
