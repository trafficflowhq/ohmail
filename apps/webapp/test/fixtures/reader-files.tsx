import { type ContextType } from "react";
import { TextProvider } from "@ohmail/app/text";
import { FrameContext } from "../../../../packages/app/src/frame/commands";
import { LetterFiles } from "../../../../packages/app/src/reader/files/Files";
import type { ReaderParts } from "../../../../packages/app/src/reader/ports";
import en from "../../messages/en.json";
import de from "../../messages/de.json";

const frame = { api: { host: { session: { recover: "none" } } } } as ContextType<typeof FrameContext>;

/** Mount the files the Reader draws over a synthetic door or the production attachment hook. */
export function ReaderFilesFixture({
  files,
  messageId,
  look = "none",
  locale = "en",
}: {
  files: ReaderParts["files"];
  messageId: string;
  look?: ReaderParts["look"];
  locale?: "en" | "de";
}) {
  return (
    <TextProvider locale={locale} messages={locale === "en" ? en : de} timeZone="UTC">
      <FrameContext.Provider value={frame}>
        <LetterFiles messageId={messageId} parts={{ files, look }} />
      </FrameContext.Provider>
    </TextProvider>
  );
}
