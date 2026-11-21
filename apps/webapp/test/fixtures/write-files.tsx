import { useMemo, useState } from "react";
import { composeAttachCap } from "@ohmail/client-engine";
import { writeBesideOf } from "@ohmail/app-logic/writing/writing-of";
import type { ComposeAttachment } from "@ohmail/wire";
import { TextProvider } from "@ohmail/app/text";
import { WriteAbove } from "@ohmail/app/write";
import { Composer } from "@ohmail/ui/mail";
import { FilesNote, useFiles } from "../../../../packages/app/src/write/files/Files";
import { formatFileSize } from "@ohmail/ui/file-size";
import en from "../../messages/en.json";
import de from "../../messages/de.json";

interface WriteFilesFixtureProps {
  cap?: number;
  locale?: "en" | "de";
  onChange?: (files: ComposeAttachment[]) => void;
}

/** The live Write file controls over the same state the composition feeds back after each pick. */
export function WriteFilesFixture({ cap = composeAttachCap(null), locale = "en", onChange }: WriteFilesFixtureProps) {
  const beside = useMemo(
    () => writeBesideOf(null as never, "acc-quality", "strict", false, (bytes) => formatFileSize(bytes, locale), () => true),
    [locale],
  );
  return (
    <TextProvider locale={locale} messages={locale === "en" ? en : de} timeZone="UTC">
      <WriteAbove writing={{} as never} beside={beside}>
        <FileControls cap={cap} onChange={onChange} />
      </WriteAbove>
    </TextProvider>
  );
}

function FileControls({ cap, onChange }: Pick<Required<WriteFilesFixtureProps>, "cap"> & Pick<WriteFilesFixtureProps, "onChange">) {
  const [list, setList] = useState<ComposeAttachment[]>([]);
  const controls = useFiles({
    list,
    onList: (next) => { setList(next); onChange?.(next); },
    cap: { bytes: cap, binding: "mailbox" },
    locked: false,
    forward: false,
  });
  return (
    <Composer
      label="Letter" head={null}
      files={controls.files} note={controls.note ? <FilesNote sentence={controls.note} /> : undefined}
      foot={{ label: "Letter tools", attach: controls.attach }}
      onFiles={controls.onFiles}
    >
      <div />
    </Composer>
  );
}
