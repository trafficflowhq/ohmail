import { createContext, useEffect, useState, type ReactNode } from "react";
import { Button, Empty } from "@ohmail/ui/base";
import { QuickLook } from "@ohmail/ui/mail";
import { faultOf, fileLookOf, isHeldUrl } from "@ohmail/app-logic/reader";
import { useModalGate } from "@ohmail/app-logic/session/modal-gate";
import { useText } from "../../text/index.js";
import type { ReaderFile } from "../ports.js";

export interface PdfPage {
  readonly page: number;
  readonly total: number;
  readonly step: (delta: number) => void;
  readonly content: ReactNode;
}

export type PdfLook = (blob: Blob | undefined) => PdfPage;
const noPdf: PdfLook = () => ({ page: 1, total: 0, step: () => {}, content: null });

/** The browser host's PDF renderer, shared with Write. */
export const PdfLookContext = createContext<PdfLook | null>(null);

const MAX_TEXT_CHARS = 512 * 1024;
type Way = { label: string; onPress: () => void; busy?: boolean };

interface PreviewProps {
  readonly item: ReaderFile;
  readonly facts: string;
  readonly blob: Blob | undefined;
  readonly usePdf: PdfLook | null;
  readonly onClose: () => void;
  readonly download?: Way;
  readonly all?: Way;
  readonly step?: (delta: number) => void;
  readonly retry?: () => void;
}

function TextPreview({ blob, download }: { blob: Blob; download: boolean }) {
  const t = useText("attachmentPreview");
  const [result, setResult] = useState<{ text: string; truncated: boolean } | "failed" | null>(null);
  useEffect(() => {
    let live = true;
    void blob
      .slice(0, MAX_TEXT_CHARS * 4)
      .text()
      .then(
        (text) => {
          if (live)
            setResult({
              text: text.slice(0, MAX_TEXT_CHARS),
              truncated: text.length > MAX_TEXT_CHARS || blob.size > MAX_TEXT_CHARS * 4,
            });
        },
        () => {
          if (live) setResult("failed");
        },
      );
    return () => {
      live = false;
    };
  }, [blob]);
  if (result === null) return <p role="status">{t("rendering")}</p>;
  if (result === "failed") return <p role="status">{t("noPreviewTitle")}</p>;
  return (
    <pre data-file-text="">
      {result.text}
      {result.truncated ? `\n\n${download ? t("textTruncated") : t("textTruncatedHere")}` : null}
    </pre>
  );
}

function PreviewContent({ item, blob, retry, download }: PreviewProps) {
  const t = useText("attachmentPreview");
  const attachment = useText("attachments");
  const kind = fileLookOf(item.mimeType);
  if (kind === "other") return <p role="status">{t("noPreviewTitle")}</p>;
  if (item.state === "too_large" || item.previewTooLarge) {
    return (
      <div role="status">
        <Empty label={t("tooLargeTitle")} line={t("textTooLargeDetail")} />
      </div>
    );
  }
  if (item.state === "failed") {
    return (
      <div>
        <p role="status">{attachment(faultOf(item).key)}</p>
        {retry && faultOf(item).way === "retry" ? (
          <Button kind="two" size="s" onPress={retry}>
            {t("retry")}
          </Button>
        ) : null}
      </div>
    );
  }
  if (item.state !== "ready") return <p role="status">{t("fetching")}</p>;
  // The file door mints blob URLs and can adopt a staged image from the desktop's local scheme.
  const url = item.objectUrl;
  if (
    kind === "image" &&
    url &&
    (isHeldUrl(url) ||
      /^attachment-preview:\/\/localhost\/|^https?:\/\/attachment-preview\.localhost\//.test(url))
  ) {
    return <img src={url} alt={item.filename} />;
  }
  if (kind === "text" && blob) return <TextPreview blob={blob} download={download !== undefined} />;
  return <p role="status">{t("noPreviewTitle")}</p>;
}

/** The same modal for the reader's held bytes and the exact bytes on the draft. */
export function FilePreview(props: PreviewProps) {
  const { item, blob, usePdf, facts, onClose, download, all, step } = props;
  const t = useText("attachmentPreview");
  useModalGate(true);
  const kind = fileLookOf(item.mimeType);
  const show = (content: ReactNode, page?: PdfPage) => {
    const paging = page !== undefined && page.total > 1;
    return (
      <QuickLook
        open
        portal
        onClose={onClose}
        label={t("ariaLabel")}
        name={item.filename}
        kind={kind}
        facts={page?.total ? `${facts} · ${t("page", { page: page.page, total: page.total })}` : facts}
        download={download}
        all={all}
        close={{ label: t("close") }}
        prev={step ? { label: t("prevAttachment"), onPress: () => step(-1) } : undefined}
        next={step ? { label: t("nextAttachment"), onPress: () => step(1) } : undefined}
        pages={
          paging
            ? {
                up: { label: t("prevPage"), end: page.page === 1, onPress: () => page.step(-1) },
                down: { label: t("nextPage"), end: page.page === page.total, onPress: () => page.step(1) },
              }
            : undefined
        }
        hints={[
          { label: t("close"), keys: ["Space", "Esc"] },
          ...(step ? [{ label: t("move"), keys: ["←", "→"] }] : []),
          ...(paging ? [{ label: t("pageHint"), keys: ["↑", "↓"] }] : []),
        ]}
      >
        {content}
      </QuickLook>
    );
  };
  const pdfBlob = kind === "pdf" && item.state === "ready" ? blob : undefined;
  const useHostPdf = usePdf ?? noPdf;
  const pdf = useHostPdf(pdfBlob);
  return pdfBlob && usePdf ? show(pdf.content, pdf) : show(<PreviewContent key={item.id} {...props} />);
}
