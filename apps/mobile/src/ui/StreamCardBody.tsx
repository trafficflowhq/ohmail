import { useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { Copy } from "../copy";
import type { WorldMail } from "../state/live";
import { useTheme } from "../theme";
import { Tap, TapRow, Txt } from "./base";
import { BODY_BLOCK_CHARS } from "./body-pages";
import { FadeOut } from "./FadeOut";
import { Icon } from "./Icon";
import { MailBodyFrame, useMailPreview } from "./MailBodyFrame";

const PREVIEW_LINES = 6;

export function StreamCardBody({ m, onRead, children, showFilePrompt = true }: {
  m: Pick<WorldMail, "id" | "subject" | "snippet" | "protected" | "hasAttachments" | "senderCheck">;
  onRead: () => void;
  children?: ReactNode;
  showFilePrompt?: boolean;
}) {
  const t = useTheme();
  const stored = useMailPreview(m.id);
  const text = m.protected ? Copy.protectedPreview : (stored.text || m.snippet || "");
  const html = m.protected ? null : stored.html;
  // Measure real wrapping without passing an entire long letter to native Text.
  const preview = text.slice(0, BODY_BLOCK_CHARS);
  // Keep the measurement for this preview without storing its displayed words in state.
  const textRun = useMemo(() => Symbol(), [preview]);
  const [textFit, setTextFit] = useState<{ run: symbol; height: number } | null>(null);
  const [htmlFit, setHtmlFit] = useState<{ html: string; clipped: boolean | null } | null>(null);
  const textClipped = textFit !== null && textFit.run === textRun;
  const frameClipped = html ? (htmlFit?.html === html ? htmlFit.clipped : true) : null;
  const clipped = frameClipped ?? textClipped;
  const hasMore = (showFilePrompt && m.hasAttachments) || clipped
    || (!m.protected && (preview.length < text.length || !stored.complete));
  const height = (t.type.streamBody.lineHeight ?? 27) * PREVIEW_LINES;
  const fallback = preview ? (
    <TapRow onPress={onRead} accessibilityRole="button" accessibilityLabel={m.subject || Copy.readsReadInFull}>
      <View style={{ maxHeight: textClipped ? textFit.height : height, overflow: "hidden" }}>
        <Txt variant="streamBody" onTextLayout={({ nativeEvent: { lines } }) => {
          const last = lines.length > PREVIEW_LINES ? lines[PREVIEW_LINES - 1] : undefined;
          const next = last ? Math.ceil(last.y + last.height) : null;
          setTextFit((old) => next === null ? null
            : old?.run === textRun && old.height === next ? old : { run: textRun, height: next });
        }}>{preview}</Txt>
        {textClipped ? <FadeOut color={t.c.panel} /> : null}
      </View>
    </TapRow>
  ) : null;
  return (
    <View style={{ paddingHorizontal: 20, paddingBottom: 20, gap: 10 }}>
      {children ? (
        <TapRow onPress={onRead} accessibilityRole="button" accessibilityLabel={m.subject || Copy.readsReadInFull}>
          {children}
        </TapRow>
      ) : null}
      {html ? (
        <View style={{ marginHorizontal: -20 }}>
          <MailBodyFrame
            m={{ id: m.id, subject: m.subject, senderCheck: m.senderCheck, body: preview, html, inlineImages: stored.inlineImages }}
            preview={{
              maxHeight: height,
              fallback: fallback ? <View style={{ paddingHorizontal: 20 }}>{fallback}</View> : null,
              onClipped: (clipped) => setHtmlFit({ html, clipped }),
            }}
          />
          {frameClipped ? <FadeOut color={t.c.panel} /> : null}
        </View>
      ) : fallback}
      {hasMore ? (
        <Tap accessibilityRole="button" accessibilityLabel={Copy.readsReadInFull} onPress={onRead}
          style={{ alignSelf: "center", backgroundColor: t.c.tint2, borderRadius: t.radius.pill,
            minHeight: 44, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Txt variant="button">{Copy.readsReadInFull}</Txt>
          <Icon name="diagonal" size={13} color={t.c.ink} />
        </Tap>
      ) : null}
    </View>
  );
}
