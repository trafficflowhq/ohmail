/**
 * THE LETTER'S OWN FILES, in the composer's places: the clip at the foot (its name says the ceiling), a tile each
 * with its way off, the room under them from the first file on (the pictures' quality and how much is used), and
 * one line over the foot for what the last pick could not do. A drop on the letter is a pick.
 */
import type { ComposeAttachment } from "@ohmail/wire";
import type { ReactNode } from "react";
import { Attach, AttachRoom, Files, FileTile, SendStatus } from "@ohmail/ui/mail";
import { base64Bytes, useLetterFiles, type LetterCap, type LetterFiles } from "@ohmail/app-logic/write/files";
import { useText } from "../../text/index.js";
import { useWriteBeside } from "../above.js";
import { kindOf } from "./kind.js";
import { Quality } from "./Quality.js";

export interface FilesView {
  readonly model: LetterFiles;
  /** The foot's clip. */
  readonly attach: ReactNode;
  /** The tiles and the room, or undefined: no file yet. */
  readonly files: ReactNode;
  /** What the last pick or quality move said, and the files still being read; or null. */
  readonly note: string | null;
  /** A drop on the letter. */
  readonly onFiles: ((files: File[]) => void) | undefined;
}

export function useFiles({
  list,
  onList,
  cap,
  locked,
  forward,
}: {
  list: readonly ComposeAttachment[];
  onList: (next: ComposeAttachment[]) => void;
  cap: LetterCap;
  locked: boolean;
  /** A forward: the ceiling names the person's own files. */
  forward: boolean;
}): FilesView {
  const t = useText("write");
  const beside = useWriteBeside();
  const model = useLetterFiles({ list, onList, cap: cap.bytes, pictures: beside.pictures });
  const total = beside.size(cap.bytes);
  const { notes } = model;
  const said: string[] = [];
  if (model.attaching.length > 0)
    said.push(t("files.still", { name: model.attaching[0]!, count: model.attaching.length }));
  if (notes.refusedAt !== null) said.push(t("files.refused", { size: beside.size(notes.refusedAt) }));
  if (notes.unreadable) said.push(t("files.unreadable"));
  if (notes.twice.length > 0) said.push(t("files.twice", { filenames: notes.twice.join(", ") }));
  if (notes.qualityKept !== null) said.push(t("files.qualityKept", { size: beside.size(notes.qualityKept) }));
  if (notes.scope) said.push(t("files.qualityScope"));
  const pick = (files: readonly File[]): void => {
    if (!locked) void model.add(files);
  };
  return {
    model,
    attach: (
      <Attach
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
              <FileTile
                key={`${at}:${file.filename}`}
                kind={kindOf(file.filename, file.contentType)}
                name={file.filename}
                size={beside.size(base64Bytes(file.contentBase64))}
                off={
                  locked
                    ? undefined
                    : {
                        label: t("files.remove", { filename: file.filename }),
                        onPress: () => model.remove(at),
                      }
                }
              />
            ))}
          </Files>
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
            {cap.binding === "surface" ? <> {t("files.capSurface")}</> : null}
          </AttachRoom>
        </>
      ),
    note: said.length > 0 ? said.join(" ") : null,
    onFiles: locked ? undefined : (files) => pick(files),
  };
}

/** A file's line over the foot, as the kit draws it. */
export function FilesNote({ sentence }: { sentence: string }) {
  return (
    <SendStatus place="start" sign="clip">
      {sentence}
    </SendStatus>
  );
}
