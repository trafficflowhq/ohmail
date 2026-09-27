"use client";

/**
 * One message's files, on whichever surface shows the message. The strip and its ASK are one
 * component: rendering the strip holds the message's list (`AttachmentsChrome.hold`), so no pane
 * can draw a strip over a list nobody asked for. That was the defect: the list was asked for the
 * Ohbox selection only, and a plain-text message opened anywhere else showed no file at all.
 */
import { useEffect } from "react";
import { isPreviewable } from "../components/AttachmentPreview";
import { AttachmentStrip } from "../components/AttachmentStrip";
import { useMessageChrome } from "./message-chrome";
import { opensInSystemViewer } from "./open-attachment";

export function MessageFiles({ messageId }: { messageId: string }) {
  const chrome = useMessageChrome();
  const attachments = chrome.attachments;
  /* Keyed on the HOLD, never the chrome: the chrome changes identity while a Download all runs,
     and a re-run released the list mid-download, so nothing saved. */
  const hold = attachments?.hold;
  useEffect(() => hold?.(messageId), [hold, messageId]);
  if (!attachments) return null;
  return (
    <AttachmentStrip
      /* EVERY PART IS LISTED, whichever way the body draws: an inline picture stays downloadable
         here, marked and grouped after the real files. `onDownloadAll` takes the same opts, so the
         head's count and the saved set agree. */
      items={attachments.itemsOf(messageId, { includeInlineParts: true })}
      onOpen={(attachmentId) => attachments.open(messageId, attachmentId)}
      /* Looking is offered on the types this app can draw (image, PDF, text), minus the desktop's
         system-viewer types; everything else saves. The judgement has one owner, not the strip. */
      onPreview={(attachmentId) => chrome.openAttachmentPreview(messageId, attachmentId)}
      canPreview={(item) => isPreviewable(item.mimeType) && !opensInSystemViewer(item.mimeType)}
      onDownloadAll={() => attachments.downloadAll(messageId, { includeInlineParts: true })}
      downloadingAll={attachments.downloadingAll(messageId)}
      calendarTextOf={(attachmentId) => attachments.calendarTextsOf(messageId).get(attachmentId)}
    />
  );
}
