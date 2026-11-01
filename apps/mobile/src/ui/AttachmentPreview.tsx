/**
 * THE ATTACHMENT PREVIEW — a picture or a PDF shown in the app, Share beside it (the desktop's
 * preview-first rule). A full-window Modal over the reader: nothing under it is read while it is
 * up (`reader-cover.ts`), a fold waits for it (`reader-held.ts`), and Android's Back closes it.
 *
 * The bytes are drawn in a WebView set up as `MailBodyFrame` is — the wildcard whitelist with a
 * handler that admits the first document alone and hands nothing to `Linking`, no file access,
 * no storage, no windows, no cache, no cookies — and with no `onMessage` and no injected script,
 * so the page has no way back into the app. JavaScript is on only for a PDF, where the document's
 * nonce admits our controller and pdf.js and nothing else (`mail/attachment-preview.ts`). A
 * document past the frame ceiling, or a renderer that died, is a sentence and Share.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, View } from "react-native";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import {
  imagePreviewDocument, pdfPreviewDocument, previewFits, previewNonce, PDF_PREVIEW_MAX_PAGES, type PreviewKind,
} from "../mail/attachment-preview";
import { phoneFrameCeiling } from "../mail/frame-ceiling-native";
import { pdfFrameScripts } from "../mail/pdf-frame-native";
import { shareAttachmentBytes } from "../mail/open-attachment-native";
import { useReaderCover } from "./reader-cover";
import { holdWhileOpen } from "./reader-held";
import { useModalKey } from "./Sheet";
import { Button, Tap, Txt } from "./base";
import { Icon } from "./Icon";

/** The bytes a tile press read, with what they preview as. */
export interface PreviewFile {
  base64: string;
  mime: string;
  filename: string;
  preview: PreviewKind;
}

const ALL_ORIGINS = ["*"];
/** The url shapes the initial `source={{ html }}` load presents, per platform (`frame-nav.ts`). */
const DOCUMENT_LOAD = /^(?:about:blank$|data:text\/html)/i;

export function AttachmentPreview({ file, onClose }: { file: PreviewFile; onClose: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const modalKey = useModalKey();
  useReaderCover(true);
  const holdToken = useRef(Symbol("attachment-preview")).current;
  useEffect(() => holdWhileOpen(holdToken), [holdToken]);
  const [dead, setDead] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [refused, setRefused] = useState(false);
  /* The first document load is the one admitted; any later navigation is refused. */
  const admitted = useRef(false);

  const pdf = file.preview === "pdf";
  const doc = useMemo(() => {
    const theme = { bg: t.c.canvas, ink: t.c.ink, paper: t.c.panel };
    return pdf
      ? pdfPreviewDocument(file.base64, pdfFrameScripts(), {
        cant: `${Copy.previewCantShow} ${Copy.previewShareHint}`,
        more: `${Copy.previewPdfMore(PDF_PREVIEW_MAX_PAGES)} ${Copy.previewShareHint}`,
      }, previewNonce(), theme)
      : imagePreviewDocument(file.base64, file.mime, theme);
  }, [file, pdf, t.c.canvas, t.c.ink, t.c.panel]);
  const ceiling = useMemo(() => phoneFrameCeiling(), []);
  const fits = doc !== null && previewFits(doc.length, ceiling);
  const said = !fits ? (doc === null ? Copy.previewCantShow : Copy.previewTooLarge) : dead ? Copy.previewCantShow : null;

  const share = async () => {
    setRefused(!(await shareAttachmentBytes(file.base64, file.mime, file.filename)));
  };

  return (
    <Modal key={modalKey} visible animationType={t.reduceMotion ? "none" : "slide"} onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: t.c.canvas, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 8 }}>
          <Tap accessibilityRole="button" accessibilityLabel={Copy.previewClose} onPress={onClose} style={{ padding: 8 }}>
            <Icon name="x" size={16} color={t.c.ink2} />
          </Tap>
          <Txt variant="button" numberOfLines={1} ellipsizeMode="middle" style={{ flex: 1 }}>
            {file.filename}
          </Txt>
          <Button label={Copy.previewShare} icon="open" variant="plain" onPress={() => void share()} />
        </View>
        {refused ? (
          <Txt variant="caption" tone="ink3" accessibilityRole="alert" style={{ paddingHorizontal: 20, paddingBottom: 6 }}>
            {Copy.attachmentShareRefused}
          </Txt>
        ) : null}
        {said !== null || doc === null ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 14, paddingHorizontal: 24 }}>
            <Txt variant="note" tone="ink2" accessibilityRole="alert" style={{ textAlign: "center" }}>
              {`${said ?? Copy.previewCantShow} ${Copy.previewShareHint}`}
            </Txt>
            <Button label={Copy.previewShare} icon="open" variant="solid" onPress={() => void share()} />
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <WebView
              source={{ html: doc }}
              originWhitelist={ALL_ORIGINS}
              javaScriptEnabled={pdf}
              domStorageEnabled={false}
              allowFileAccess={false}
              allowFileAccessFromFileURLs={false}
              allowUniversalAccessFromFileURLs={false}
              allowsInlineMediaPlayback={false}
              setSupportMultipleWindows={false}
              javaScriptCanOpenWindowsAutomatically={false}
              incognito
              cacheEnabled={false}
              sharedCookiesEnabled={false}
              thirdPartyCookiesEnabled={false}
              onShouldStartLoadWithRequest={(req) => {
                if (admitted.current || !DOCUMENT_LOAD.test(req.url)) return false;
                admitted.current = true;
                return true;
              }}
              onLoadEnd={() => setLoaded(true)}
              onRenderProcessGone={() => setDead(true)}
              onContentProcessDidTerminate={() => setDead(true)}
              style={{ flex: 1, backgroundColor: t.c.canvas }}
              accessibilityLabel={Copy.previewFrameLabel}
            />
            {loaded ? null : (
              <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
                <Txt variant="caption" tone="ink3">{Copy.previewPreparing}</Txt>
              </View>
            )}
          </View>
        )}
      </View>
    </Modal>
  );
}
