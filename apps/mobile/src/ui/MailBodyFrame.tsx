/**
 * The mail document's frame — the phone's twin of the webapp's sandboxed iframe. The sanitizer
 * (`src/mail/sanitize.ts`, the web's rules) decides what the document SAYS; this component
 * decides what it MAY DO: JavaScript OFF, CSP `default-src 'none'; img-src data:`, and
 * `originWhitelist={["*"]}` DELIBERATELY — measured in the library's `WebViewShared.tsx`, a
 * navigation failing the whitelist is handed to `Linking.openURL` WITHOUT consulting the
 * handler, so a narrow whitelist is the bypass and the wildcard makes the handler the only
 * gate. The document carries no real URL (`ohmail-link:` tokens); a token routes to the
 * confirm sheet, which names the destination. Remote images re-enter only as gated `data:` URIs.
 */

import { useEffect, useMemo, useState } from "react";
import { Linking, useWindowDimensions, View } from "react-native";
import { WebView } from "react-native-webview";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { useWorld, type WorldMail } from "../state/world";
import { buildPhoneMailDocument, frameHeightEstimate } from "../mail/mail-document";
import { fetchRemoteImages } from "../mail/remote-images";
import { frameNavDecision } from "../mail/frame-nav";
import { sanitizeMailHtmlPhone } from "../mail/sanitize";
import { blockedNotice } from "../mail/notice";
import { Sheet, SheetRow } from "./Sheet";
import { Txt } from "./base";

export function MailBodyFrame({ m, onShowAsText }: { m: WorldMail; onShowAsText: () => void }) {
  const t = useTheme();
  const w = useWorld();
  const { height: windowHeight } = useWindowDimensions();
  const [asked, setAsked] = useState<string | null>(null);
  const [remote, setRemote] = useState<{ id: string; map: ReadonlyMap<string, string> } | null>(null);
  const [linkAsk, setLinkAsk] = useState<string | null>(null);

  const html = m.html ?? "";
  const imagesWanted = m.loadedRemoteContent === true || asked === m.id;
  const resolvedRemote = remote?.id === m.id ? remote.map : undefined;
  const sanitized = useMemo(
    () => sanitizeMailHtmlPhone(html, { inlineImages: m.inlineImages, resolvedRemote }),
    [html, m.inlineImages, resolvedRemote],
  );

  // The document's own unresolved `cid:` references — the engine fetches THIS message's parts,
  // bounded, and the minted map re-renders this memo through the world.
  const loadInlineImages = w.actions.loadInlineImages;
  const cidsKey = JSON.stringify(sanitized.cids);
  useEffect(() => {
    if (sanitized.cids.length > 0) loadInlineImages(m.id, sanitized.cids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, cidsKey, loadInlineImages]);

  // The consented remote fetch — app-side, minted to `data:`; the document never gains network.
  const pictureUrls = useMemo(
    () => sanitized.blocked.filter((b) => !b.pixel).map((b) => b.url),
    [sanitized.blocked],
  );
  useEffect(() => {
    if (!imagesWanted || resolvedRemote !== undefined || pictureUrls.length === 0) return;
    let alive = true;
    void fetchRemoteImages(pictureUrls).then((map) => {
      if (alive) setRemote({ id: m.id, map });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagesWanted, resolvedRemote === undefined, pictureUrls.length === 0, m.id]);

  if (sanitized.oversize) {
    // The size fallback states its reason — a bare plain-text render reads as a bug.
    return (
      <View>
        <Txt variant="caption" tone="ink3" style={{ marginBottom: 10 }}>
          {Copy.mailOversize}
        </Txt>
        <Txt variant="readerBody" style={{ maxWidth: t.layout.proseMax }}>
          {m.body}
        </Txt>
      </View>
    );
  }

  const notice = blockedNotice(sanitized.blocked, sanitized.sheets, imagesWanted);
  const canLoad = !imagesWanted && pictureUrls.length > 0;
  const doc = buildPhoneMailDocument(sanitized.html, {
    bg: t.c.canvas,
    ink: t.c.ink,
    ink2: t.c.ink3,
    accent: t.c.accent,
    fontScale: 1,
  });
  const height = frameHeightEstimate(sanitized.html, windowHeight);

  return (
    <View>
      {notice !== null || canLoad ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          {notice !== null ? (
            <Txt variant="caption" tone="ink3" style={{ flexShrink: 1 }}>
              {notice}
            </Txt>
          ) : null}
          <View style={{ flex: 1 }} />
          {canLoad ? (
            <Txt variant="caption" tone="accent" onPress={() => setAsked(m.id)} accessibilityRole="button">
              {Copy.mailShowImages}
            </Txt>
          ) : null}
          <Txt variant="caption" tone="accent" onPress={onShowAsText} accessibilityRole="button">
            {Copy.mailShowAsText}
          </Txt>
        </View>
      ) : (
        <View style={{ flexDirection: "row", justifyContent: "flex-end", marginBottom: 10 }}>
          <Txt variant="caption" tone="accent" onPress={onShowAsText} accessibilityRole="button">
            {Copy.mailShowAsText}
          </Txt>
        </View>
      )}
      <WebView
        // ONE document, rebuilt when the maps move; never a URL. `key` on the id keeps a
        // recycled frame from showing the previous message during the swap.
        key={m.id}
        source={{ html: doc }}
        originWhitelist={ALL_ORIGINS}
        javaScriptEnabled={false}
        domStorageEnabled={false}
        allowFileAccess={false}
        allowsInlineMediaPlayback={false}
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={(req) => {
          const d = frameNavDecision(req.url, sanitized.links);
          if (d.kind === "confirm") setLinkAsk(d.url);
          return d.kind === "load";
        }}
        nestedScrollEnabled
        style={{ height, backgroundColor: t.c.canvas }}
        accessibilityLabel={Copy.mailFrameLabel}
      />
      <Sheet open={linkAsk !== null} onClose={() => setLinkAsk(null)} label={Copy.mailOpenLinkTitle}>
        <Txt variant="sectionLabel" tone="ink3" style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
          {Copy.mailOpenLinkTitle}
        </Txt>
        {/* The destination said out loud — the web prints the true host beside a disagreeing
            label; on a phone (no hover, no status bar) the confirm carries that disclosure. */}
        <Txt variant="note" tone="ink2" style={{ paddingHorizontal: 14, paddingBottom: 10 }} numberOfLines={3}>
          {linkAsk ?? ""}
        </Txt>
        <SheetRow
          icon="open"
          label={Copy.mailOpenLinkOpen}
          onPress={() => {
            const url = linkAsk;
            setLinkAsk(null);
            if (url !== null) void Linking.openURL(url).catch(() => undefined);
          }}
        />
      </Sheet>
    </View>
  );
}

/**
 * Everything passes the WHITELIST so that NOTHING is ever OS-opened by the library's own
 * fallback — `onShouldStartLoadWithRequest` above is then the one gate (see the header).
 */
const ALL_ORIGINS = ["*"];
