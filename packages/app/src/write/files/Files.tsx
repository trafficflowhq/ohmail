/**
 * THE LETTER'S OWN FILES, in the composer's places: the clip at the foot (its name says the ceiling), a tile each
 * with its way off, the room under them from the first file on (the pictures' quality and how much is used), and
 * one line over the foot for what the last pick could not do. A drop on the letter is a pick.
 */
import type { ComposeAttachment } from "@ohmail/wire";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MailRowMenu, type MenuTarget } from "../../place-list/MailRowMenu.js";
import { Attach, AttachRoom, Files, FileTile, SendStatus, type ComposerProps } from "@ohmail/ui/mail";
import { base64Bytes, useLetterFiles, type LetterCap, type LetterFiles } from "@ohmail/app-logic/write/files";
import { fileLookOf } from "@ohmail/app-logic/reader";
import { FilePreview, PdfLookContext } from "../../reader/look/FilePreview.js";
import { useText } from "../../text/index.js";
import { useWriteBeside } from "../above.js";
import { kindOf } from "./kind.js";
import { Quality } from "./Quality.js";

export interface FilesView {
  readonly previewOpen: boolean;
  readonly model: LetterFiles;
  /** The foot's clip. */
  readonly attach: ReactNode;
  /** The tiles and the room, or undefined: no file yet. */
  readonly files: ReactNode;
  /** What the last pick or quality move said, and the files still being read; or null. */
  readonly note: string | null;
  /** A drop on the letter. */
  readonly onFiles: ((files: File[]) => void) | undefined;
  readonly heldDrop: ComposerProps["heldDrop"];
}

interface UseFilesOptions {
  list: readonly ComposeAttachment[];
  onList: (next: ComposeAttachment[]) => void;
  cap: LetterCap;
  locked: boolean;
  /** A forward: the ceiling names the person's own files. */
  forward: boolean;
  letterEpochNow?: () => number;
  focusEditor?: () => void;
}

export function useFiles({
  list,
  onList,
  cap,
  locked,
  forward,
  letterEpochNow,
  focusEditor,
}: UseFilesOptions): FilesView {
  const t = useText("write");
  const beside = useWriteBeside();
  const { pickFile } = beside;
  const usePdf = useContext(PdfLookContext);
  const previewWords = useText("attachmentPreview");
  const { active, setPicked, restore, close } = usePickedFile(list);
  const model = useLetterFiles({ list, onList, cap: cap.bytes, pictures: beside.pictures, letterEpochNow });
  const total = beside.size(cap.bytes);
  const { notes } = model;
  const said = fileNotes(model, (bytes) => beside.size(bytes), t);
  const pick = (files: readonly File[]): void => {
    if (!locked && active === null) void model.add(files);
  };
  return {
    model,
    previewOpen: active !== null,
    attach: (
      <Attach
        key={letterEpochNow?.()}
        label={forward ? t("files.attachForward", { size: total }) : t("files.attach", { size: total })}
        disabled={locked}
        onFiles={pick}
      />
    ),
    files:
      list.length === 0 ? undefined : (
        <>
          <Files>
            {list.map((file, at) => (
              <DraftTile
                key={`${at}:${file.filename}`}
                file={file}
                size={beside.size(base64Bytes(file.contentBase64))}
                off={
                  locked
                    ? undefined
                    : {
                        label: t("files.remove", { filename: file.filename }),
                        onPress: () => model.remove(at),
                      }
                }
                open={(anchor) => {
                  const previous = anchor.ownerDocument.activeElement;
                  restore.current =
                    previous instanceof HTMLInputElement && focusEditor
                      ? focusEditor
                      : () => {
                          if (previous instanceof HTMLElement && previous.isConnected)
                            previous.focus({ preventScroll: true });
                        };
                  setPicked(file);
                }}
              />
            ))}
          </Files>
          {active ? (
            <DraftPreview
              file={active}
              facts={[
                kindOf(active.filename, active.contentType),
                beside.size(base64Bytes(active.contentBase64)),
                ...(list.length > 1
                  ? [previewWords("count", { index: list.indexOf(active) + 1, total: list.length })]
                  : []),
              ].join(" · ")}
              usePdf={usePdf}
              close={close}
              step={
                list.length > 1
                  ? (delta) => setPicked(list[(list.indexOf(active) + delta + list.length) % list.length]!)
                  : undefined
              }
            />
          ) : null}
          <AttachRoom
            used={t("files.used", { used: beside.size(model.used), total })}
            weight={
              notes.saved === null
                ? undefined
                : t("files.saved", { from: beside.size(notes.saved.from), to: beside.size(notes.saved.to) })
            }
          >
            {model.level === "none" ? null : (
              <Quality level={model.level} locked={locked} onLevel={model.setLevel} />
            )}
          </AttachRoom>
        </>
      ),
    note: said.length > 0 ? said.join(" ") : null,
    onFiles: locked ? undefined : (files) => pick(files),
    heldDrop:
      locked || active !== null || pickFile === undefined || pickFile === "none"
        ? undefined
        : {
            looksLikeDrag: pickFile.looksLikeDrag,
            matchesDrop: pickFile.matchesDrop,
            receive: () => {
              void model.add(() => pickFile.take());
            },
          },
  };
}

function attachmentBlob(file: ComposeAttachment): Blob | undefined {
  try {
    const bytes = Uint8Array.from(atob(file.contentBase64), (char) => char.charCodeAt(0));
    return new Blob([bytes], { type: file.contentType.split(";")[0]?.trim().toLowerCase() });
  } catch {
    return undefined;
  }
}

function useFileImage(blob: Blob | undefined, image: boolean): string | undefined {
  const [url, setUrl] = useState<{ blob: Blob; value: string } | null>(null);
  useEffect(() => {
    if (!image || !blob || typeof URL.createObjectURL !== "function") return;
    const value = URL.createObjectURL(blob);
    setUrl({ blob, value });
    return () => URL.revokeObjectURL?.(value);
  }, [blob, image]);
  return url && url.blob === blob ? url.value : undefined;
}

function DraftTile({
  file,
  size,
  off,
  open,
}: {
  file: ComposeAttachment;
  size: string;
  off?: { label: string; onPress: () => void };
  open: (anchor: HTMLElement) => void;
}) {
  const t = useText("attachments");
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const preview = t("preview", { name: file.filename });
  const image = fileLookOf(file.contentType) === "image";
  const blob = useMemo(() => (image ? attachmentBlob(file) : undefined), [file, image]);
  const src = useFileImage(blob, image);
  return (
    <>
      <FileTile
        kind={kindOf(file.filename, file.contentType)}
        name={file.filename}
        size={size}
        look={src ? <img src={src} alt="" /> : undefined}
        main={{
          label: preview,
          onPress: (event) => open(event.currentTarget),
          onMouseDown: (event) => {
            const current = event.currentTarget.ownerDocument.activeElement;
            if (
              current instanceof HTMLElement &&
              (current.isContentEditable || current.matches("input, textarea"))
            )
              event.preventDefault();
          },
        }}
        off={off}
        onMenu={(at, anchor) => setMenu({ at, anchor })}
      />
      {menu ? (
        <MailRowMenu
          portal
          target={menu}
          label={file.filename}
          onClose={() => setMenu(null)}
          items={[
            {
              label: preview,
              icon: "clip",
              onPress: () => {
                menu.anchor.focus({ preventScroll: true });
                open(menu.anchor);
              },
            },
            ...(off ? [{ ...off, icon: "x" as const }] : []),
          ]}
        />
      ) : null}
    </>
  );
}

function DraftPreview({
  file,
  facts,
  usePdf,
  close,
  step,
}: {
  file: ComposeAttachment;
  facts: string;
  usePdf: React.ContextType<typeof PdfLookContext>;
  close: () => void;
  step?: (delta: number) => void;
}) {
  const kind = fileLookOf(file.contentType);
  const blob = useMemo(() => (kind === "other" ? undefined : attachmentBlob(file)), [file, kind]);
  const src = useFileImage(blob, kind === "image");
  return (
    <FilePreview
      item={{
        id: file.filename,
        filename: file.filename,
        mimeType: file.contentType,
        sizeBytes: base64Bytes(file.contentBase64),
        state: "ready",
        inline: false,
        objectUrl: src,
      }}
      facts={facts}
      blob={blob}
      usePdf={usePdf}
      onClose={close}
      step={step}
    />
  );
}

/** A file's line over the foot, as the kit draws it. */
export function FilesNote({ sentence }: { sentence: string }) {
  return (
    <SendStatus place="start" sign="clip">
      {sentence}
    </SendStatus>
  );
}

function usePickedFile(list: readonly ComposeAttachment[]) {
  const [picked, setPicked] = useState<ComposeAttachment | null>(null);
  const active = picked !== null && list.includes(picked) ? picked : null;
  const restore = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (active !== null) return;
    const focus = restore.current;
    restore.current = null;
    if (focus) queueMicrotask(focus);
  }, [active]);
  const close = () => setPicked(null);
  return { active, setPicked, restore, close };
}

function fileNotes(
  model: ReturnType<typeof useLetterFiles>,
  size: ReturnType<typeof useWriteBeside>["size"],
  t: ReturnType<typeof useText>,
): string[] {
  const { notes } = model;
  const said: string[] = [];
  if (model.attaching.length > 0)
    said.push(t("files.still", { name: model.attaching[0]!, count: model.attaching.length }));
  if (notes.refusedAt !== null) said.push(t("files.refused", { size: size(notes.refusedAt) }));
  if (notes.unreadable) said.push(t("files.unreadable"));
  if (notes.twice.length > 0) said.push(t("files.twice", { filenames: notes.twice.join(", ") }));
  if (notes.qualityKept !== null) said.push(t("files.qualityKept", { size: size(notes.qualityKept) }));
  return said;
}
