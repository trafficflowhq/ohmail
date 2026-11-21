/**
 * A LETTER'S FILES, drawn from the list the shell's file door holds; nothing here fetches. A press on a file that can
 * be looked at opens the shell's one look, any other press saves. A file that did not arrive says one whole sentence
 * and offers what helps, on its tile, or nothing where nothing helps.
 */
import { useEffect, useState } from "react";
import { FileNotArrived, FileTile, Files as KitFiles } from "@ohmail/ui/mail";
import {
  faultOf,
  fileLookOf,
  isAuthListFailure,
  listRetryIsOffered,
  thumbnailOf,
} from "@ohmail/app-logic/reader";
import { useFrame } from "../../frame/commands.js";
import { NONE } from "../../host/index.js";
import { useLocale, useText } from "../../text/index.js";
import { FilePreview, type PdfLook } from "../look/FilePreview.js";
import type { ReaderFile, ReaderFileList, ReaderFiles, ReaderParts } from "../ports.js";

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

function Tile({
  messageId,
  item,
  files,
  preview,
}: {
  messageId: string;
  item: ReaderFile;
  files: ReaderFiles;
  preview: ((id: string) => void) | null;
}) {
  const t = useText("attachments");
  const tb = useText("body");
  const { host } = useFrame();
  const locale = useLocale();
  const kind = kindOf(item);
  const size = sizeOf(item.sizeBytes, locale);
  if (item.state === "loading")
    return <FileNotArrived state="fetching" kind={kind} name={item.filename} line={t("loading")} />;
  if (item.state === "too_large")
    return <FileNotArrived state="large" kind={kind} name={item.filename} line={t("tooLarge", { size })} />;
  if (item.state === "failed") {
    const fault = faultOf(item);
    const reason = t(fault.key);
    if (item.reasking) {
      return (
        <FileNotArrived
          state="failed"
          kind={kind}
          name={item.filename}
          line={t("faultWillRetry", { reason })}
        />
      );
    }
    const recover = host.session.recover;
    const way =
      fault.way === "retry"
        ? { label: t("listRetry"), onPress: () => files.ensure(messageId, item.id, { retry: true }) }
        : fault.way === "signIn" && recover !== NONE
          ? { label: tb("signIn"), onPress: () => recover("signIn") }
          : undefined;
    return <FileNotArrived state="failed" kind={kind} name={item.filename} line={reason} way={way} />;
  }
  const thumb = thumbnailOf(item);
  const look = fileLookOf(item.mimeType) !== "other" ? preview : null;
  return (
    <FileTile
      kind={kind}
      name={item.filename}
      size={item.inline ? `${size} · ${t("embedded")}` : size}
      look={thumb ? <img src={thumb} alt="" /> : undefined}
      main={{
        label: look ? t("preview", { name: item.filename }) : t("download", { name: item.filename }),
        onPress: () => (look ? look(item.id) : files.open(messageId, item.id)),
      }}
      save={{
        label: t("download", { name: item.filename }),
        busy: item.saving,
        onPress: () => files.open(messageId, item.id),
      }}
    />
  );
}

function listFailureKey(code: string | null): string {
  if (isAuthListFailure(code)) return "listSignedOut";
  if (code === "timeout") return "listTimeout";
  if (code === "network") return "listOffline";
  return "listFailed";
}

function ListNotice({ list }: { list: Extract<ReaderFileList, { state: "failed" | "loading" }> }) {
  const t = useText("attachments");
  if (list.state === "loading") {
    return list.retrying ? (
      <FileNotArrived state="list" line={t("listRetrying")} way={{ label: t("listRetry"), busy: true }} />
    ) : null;
  }
  const way = listRetryIsOffered(list.code, list.retryable)
    ? { label: t("listRetry"), onPress: list.onRetry }
    : undefined;
  return <FileNotArrived state="list" line={t(listFailureKey(list.code))} way={way} />;
}

export function LetterFiles({
  messageId,
  selection,
  parts,
  omit,
}: {
  messageId: string;
  selection?: string;
  omit?: string | undefined;
  parts: Pick<ReaderParts, "files" | "look">;
}) {
  const t = useText("attachments");
  const locale = useLocale();
  const { files, look } = parts;
  const [picked, setPicked] = useState<{ id: string; selection: string | undefined } | null>(null);
  const activeId = picked?.selection === selection ? picked?.id : undefined;
  useEffect(() => setPicked(null), [selection]);
  const select = (id: string) => setPicked({ id, selection });
  const preview =
    look === NONE ? null : typeof look === "function" ? (id: string) => look(messageId, id) : select;
  /* Keyed on the hold alone: the door changes identity while it fetches (Download all), a hold must not. */
  const hold = files === NONE ? undefined : files.hold;
  useEffect(() => hold?.(messageId), [hold, messageId]);
  if (files === NONE) return null;
  const list = files.itemsOf(messageId, { includeInlineParts: true });
  if (list.state === "failed" || list.state === "loading") return <ListNotice list={list} />;
  if (list.state !== "ready") return null;
  /* The door already leaves out an invitation's calendar body that a listed calendar file carries (Google's pair); one
     it lists is the event's one copy (Exchange, Outlook), a file the person can save. */
  const items = omit ? list.items.filter((item) => item.id !== omit) : list.items;
  if (items.length === 0) return null;
  const many = items.length > 1;
  return (
    <KitFiles
      summary={
        many
          ? t("count", {
              count: items.length,
              size: sizeOf(
                items.reduce((sum, item) => sum + item.sizeBytes, 0),
                locale,
              ),
            })
          : undefined
      }
      all={
        many
          ? {
              label: t("downloadAll"),
              busy: files.downloadingAll(messageId),
              onPress: () =>
                files.downloadAll(messageId, { includeInlineParts: true, ...(omit ? { omit } : {}) }),
            }
          : undefined
      }
    >
      {items.map((item) => (
        <Tile key={item.id} messageId={messageId} item={item} files={files} preview={preview} />
      ))}
      {activeId && typeof look === "object" && items.some((item) => item.id === activeId) ? (
        <LetterPreview
          messageId={messageId}
          items={items}
          activeId={activeId}
          select={select}
          close={() => setPicked(null)}
          files={files}
          usePdf={look.usePdf}
          omit={omit}
        />
      ) : null}
    </KitFiles>
  );
}

function LetterPreview({
  messageId,
  items,
  activeId,
  select,
  close,
  files,
  usePdf,
  omit,
}: {
  messageId: string;
  items: readonly ReaderFile[];
  activeId: string;
  select: (id: string) => void;
  close: () => void;
  files: ReaderFiles;
  usePdf: PdfLook;
  omit?: string | undefined;
}) {
  const t = useText("attachmentPreview");
  const attachments = useText("attachments");
  const locale = useLocale();
  const index = items.findIndex((item) => item.id === activeId);
  const item = items[index]!;
  const { releasePreviews, ensure } = files;
  useEffect(() => () => releasePreviews?.(messageId), [messageId, releasePreviews]);
  useEffect(() => {
    if (item.state === "idle" && fileLookOf(item.mimeType) !== "other") ensure(messageId, activeId);
  }, [activeId, ensure, item.mimeType, item.state, messageId]);
  const facts = [
    kindOf(item),
    sizeOf(item.sizeBytes, locale),
    ...(items.length > 1 ? [t("count", { index: index + 1, total: items.length })] : []),
  ];
  return (
    <FilePreview
      item={item}
      facts={facts.join(" · ")}
      blob={files.blobOf?.(messageId, activeId)}
      usePdf={usePdf}
      onClose={close}
      step={
        items.length > 1
          ? (delta) => select(items[(index + delta + items.length) % items.length]!.id)
          : undefined
      }
      retry={() => ensure(messageId, activeId, { retry: true })}
      download={{ label: t("download"), busy: item.saving, onPress: () => files.open(messageId, activeId) }}
      all={
        items.length > 1
          ? {
              label: attachments("downloadAll"),
              busy: files.downloadingAll(messageId),
              onPress: () =>
                files.downloadAll(messageId, { includeInlineParts: true, ...(omit ? { omit } : {}) }),
            }
          : undefined
      }
    />
  );
}
