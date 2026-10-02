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
import { router } from "expo-router";
import { WebView } from "react-native-webview";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { useWorld, useWorldToast, type WorldMail } from "../state/world";
import { buildPhoneMailDocument, frameHeightEstimate } from "../mail/mail-document";
import { fetchRemoteImages, imagesSeenBy } from "../mail/remote-images";
import { frameNavDecision, openConfirmedLink } from "../mail/frame-nav";
import { sanitizeMailHtmlPhone } from "../mail/sanitize";
import {
  frameReadingOf,
  frameShows,
  noteFrameTree,
  planFrameCount,
  planFrameLength,
  startFrameCount,
  type FrameReading,
} from "../mail/frame-tree";
import { drawnLength } from "../mail/frame-length";
import { PHONE_FRAME_MAX_CHARS } from "../mail/frame-budget";
import { blockedNotice } from "../mail/notice";
import { Sheet, SheetRow } from "./Sheet";
import { Txt } from "./base";
import { BodyPages } from "./BodyPages";

export function MailBodyFrame({ m, onShowAsText }: { m: WorldMail; onShowAsText: () => void }) {
  const t = useTheme();
  const w = useWorld();
  const toast = useWorldToast();
  const { height: windowHeight } = useWindowDimensions();
  const [asked, setAsked] = useState<string | null>(null);
  const [remote, setRemote] = useState<{ id: string; map: ReadonlyMap<string, string> } | null>(null);
  const [linkAsk, setLinkAsk] = useState<string | null>(null);
  const [refusedFor, setRefusedFor] = useState<string | null>(null);

  const html = m.html ?? "";
  const imagesWanted = m.loadedRemoteContent === true || asked === m.id;
  const resolvedRemote = remote?.id === m.id ? remote.map : undefined;
  const theme = useMemo(
    () => ({ bg: t.c.canvas, ink: t.c.ink, ink2: t.c.ink3, accent: t.c.accent, fontScale: 1 }),
    [t.c.canvas, t.c.ink, t.c.ink3, t.c.accent],
  );
  // THE PICTURES' LENGTH IS READ BEFORE THEY ARE WRITTEN (`src/mail/frame-length.ts`): a picture is
  // written once per reference, so a state whose document would pass PHONE_FRAME_MAX_CHARS is refused
  // without being built, and the sanitize below never writes it.
  const bare = useMemo(() => sanitizeMailHtmlPhone(html, {}), [html]);
  const pictures = useMemo(() => ({ inlineImages: m.inlineImages, resolvedRemote }), [m.inlineImages, resolvedRemote]);
  const pictured = (m.inlineImages?.size ?? 0) > 0 || (resolvedRemote?.size ?? 0) > 0;
  const drawnChars = useMemo(
    () => (pictured ? drawnLength(html, pictures, bare, theme) : null),
    [pictured, html, pictures, bare, theme],
  );
  const tooLong = drawnChars !== null && drawnChars > PHONE_FRAME_MAX_CHARS;
  const sanitized = useMemo(
    () => (pictured && !tooLong ? sanitizeMailHtmlPhone(html, pictures) : bare),
    [pictured, tooLong, html, pictures, bare],
  );

  // THE DOCUMENT THE WEBVIEW IS HANDED IS THE ONE COUNTED (`src/mail/frame-tree.ts`): `current`, in
  // this consent state, counted a step per macrotask before it is drawn. While a new state is counted
  // (a picture arrived, Show images), the frame keeps drawing the last document of this same html whose
  // own count fitted, and keeps it, saying why, when the new state is refused.
  const current = useMemo(() => (tooLong ? null : buildPhoneMailDocument(sanitized.html, theme)), [tooLong, sanitized.html, theme]);
  const plan = useMemo(
    () => (current === null ? planFrameLength(drawnChars ?? 0) : planFrameCount(current, sanitized.oversize === true)),
    [current, drawnChars, sanitized.oversize],
  );
  const [counted, setCounted] = useState<{ key: string; reading: FrameReading } | null>(null);
  const [drawn, setDrawn] = useState<{ id: string; html: string; doc: string } | null>(null);
  useEffect(() => {
    let alive = true;
    const id = m.id;
    const cancel = startFrameCount(plan, (count) => {
      if (!alive) return;
      noteFrameTree(count);
      if (plan.known === null) setCounted({ key: plan.key, reading: count.reading });
      if (count.reading.fits) setDrawn({ id, html, doc: plan.key });
    });
    return () => {
      alive = false;
      cancel();
    };
  }, [plan, m.id, html]);
  const reading = frameReadingOf(plan, counted);

  // The document's own unresolved `cid:` references — the engine fetches THIS message's parts,
  // bounded, and the minted map re-renders this memo through the world.
  const loadInlineImages = w.actions.loadInlineImages;
  const cidsKey = JSON.stringify(sanitized.cids);
  useEffect(() => {
    if (sanitized.cids.length > 0) loadInlineImages(m.id, sanitized.cids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, cidsKey, loadInlineImages]);

  // The consented remote fetch — through the door's proxy, or this phone on the standalone door;
  // minted to `data:`, so the document never gains network. A press the server would not record
  // hands the button back with a sentence.
  const pictureUrls = useMemo(
    () => sanitized.blocked.filter((b) => !b.pixel).map((b) => b.url),
    [sanitized.blocked],
  );
  const route = w.images;
  useEffect(() => {
    if (!imagesWanted || resolvedRemote !== undefined || pictureUrls.length === 0) return;
    let alive = true;
    const consented = m.loadedRemoteContent === true;
    void fetchRemoteImages(route, m.id, pictureUrls, { consented }).then((got) => {
      if (!alive) return;
      if (got.consentRefused) {
        setAsked(null);
        setRefusedFor(m.id);
        return;
      }
      setRemote({ id: m.id, map: got.minted });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagesWanted, resolvedRemote === undefined, pictureUrls.length === 0, m.id]);

  const kept = drawn !== null && drawn.id === m.id && drawn.html === html ? drawn.doc : null;
  const shows = frameShows(reading, current, kept, sanitized.oversize === true);
  if (shows.show === "text") {
    // The size fallback states its reason — a bare plain-text render reads as a bug.
    return (
      <View>
        <Txt variant="caption" tone="ink3" style={{ marginBottom: 10 }}>
          {Copy.mailOversize}
        </Txt>
        <BodyPages variant="readerBody" style={{ maxWidth: t.layout.proseMax }} text={m.body} />
      </View>
    );
  }

  const said = blockedNotice(sanitized.blocked, sanitized.sheets, imagesWanted, imagesSeenBy(route));
  // A refused state with an earlier document still drawn: the pictures are what did not fit, and it says so.
  const lead = shows.show === "frame" && shows.withheld
    ? Copy.mailImagesTooLarge
    : refusedFor === m.id && !imagesWanted ? Copy.mailImagesRefused : null;
  const notice = [lead, said].filter((x) => x !== null).join(" ") || null;
  const canLoad = !imagesWanted && pictureUrls.length > 0;
  // The document drawn: this state's once its own count fits; otherwise the last that fitted for this html.
  const doc = shows.show === "frame" ? shows.doc : null;
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
            <Txt
              variant="caption"
              tone="accent"
              onPress={() => {
                setRefusedFor(null);
                setAsked(m.id);
              }}
              accessibilityRole="button"
            >
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
      {doc !== null ? (
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
            if (d.kind === "compose") router.push({ pathname: "/compose", params: { mailto: d.url } });
            return d.kind === "load";
          }}
          nestedScrollEnabled
          style={{ height, backgroundColor: t.c.canvas }}
          accessibilityLabel={Copy.mailFrameLabel}
        />
      ) : (
        // Where the frame will stand, as the WebView looks before its own first paint.
        <View style={{ height, backgroundColor: t.c.canvas }} />
      )}
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
            if (url !== null) void openConfirmedLink(url, { openURL: (u) => Linking.openURL(u), say: toast.say });
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
