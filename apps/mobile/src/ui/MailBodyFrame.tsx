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

import { useEffect, useMemo, useRef, useState } from "react";
import { Linking, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { WebView } from "react-native-webview";
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { letterInDark, paletteOf } from "../theme/palette";
import { useWorld, useWorldToast, type WorldMail } from "../state/world";
import { buildPhoneMailDocument } from "../mail/mail-document";
import {
  armFrameTimer,
  FRAME_UNANSWERED_MS,
  frameFinal,
  frameHeightFor,
  frameLayout,
  nextFrameHeight,
  rememberedFrameHeight,
  rememberFrameHeight,
  settleDelayMs,
  settleFrameHeight,
  unansweredFrameHeight,
  type FrameHeight,
} from "../mail/frame-height";
import { fetchRemoteImages, imagesSeenBy, pictureBudget, type PictureBudget } from "../mail/remote-images";
import { frameNavDecision, openConfirmedLink } from "../mail/frame-nav";
import { sanitizeMailHtmlPhone, type PhoneSanitizedMail, type PhoneSanitizeOptions } from "../mail/sanitize";
import { letterInk } from "../mail/paper";
import {
  frameReadingOf,
  frameShows,
  noteFrameTree,
  planFrameCount,
  planFrameLength,
  startFrameCount,
  type FramePlan,
  type FrameReading,
} from "../mail/frame-tree";
import { drawnLength } from "../mail/frame-length";
import { phoneFrameCeiling } from "../mail/frame-ceiling-native";
import { blockedNotice } from "../mail/notice";
import { Sheet, SheetRow } from "./Sheet";
import { Txt } from "./base";
import { BodyPages } from "./BodyPages";
import { HistoryFold } from "./HistoryFold";

/** What a pass that threw leaves: nothing drawn, and the letter read as text. */
const UNREADABLE: PhoneSanitizedMail = { html: "", blocked: [], sheets: [], cids: [], links: [], light: true, paper: null, ink: null, history: null };

/** One sanitizer pass; a throw on hostile html is this letter's alone, never the reader's. */
function sanitizeGuarded(html: string, opts: PhoneSanitizeOptions): PhoneSanitizedMail {
  try {
    return sanitizeMailHtmlPhone(html, opts);
  } catch {
    return UNREADABLE;
  }
}

interface Drawn {
  id: string;
  html: string;
  doc: string;
}

/**
 * Counts `plan` (nothing for null) a step per macrotask, logs it, and records a document whose own count
 * fitted as drawn for this message and html; cancelled on cleanup. The reading the frame may act on.
 */
function useFrameCount(plan: FramePlan | null, id: string, html: string, setDrawn: (d: Drawn) => void): FrameReading | null {
  const [counted, setCounted] = useState<{ key: string; reading: FrameReading } | null>(null);
  useEffect(() => {
    if (plan === null) return;
    let alive = true;
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
  }, [plan, id, html, setDrawn]);
  return plan === null ? null : frameReadingOf(plan, counted);
}

export function MailBodyFrame({ m, onShowAsText, onFinal, historyOpen = false, onHistory }: {
  m: WorldMail;
  onShowAsText: () => void;
  /** The drawn height is the document's now (or the text fallback's), or not any more. */
  onFinal?: (final: boolean) => void;
  /** The quoted history is open: the frame draws the whole document. */
  historyOpen?: boolean;
  /** Where this document's quoted history sits (the reader draws the row), or null when it has none here. */
  onHistory?: (at: "trailing" | "leading" | null) => void;
}) {
  const t = useTheme();
  const w = useWorld();
  const toast = useWorldToast();
  const [asked, setAsked] = useState<string | null>(null);
  const [remote, setRemote] = useState<{ id: string; map: ReadonlyMap<string, string>; pixels: ReadonlySet<string> } | null>(null);
  const [linkAsk, setLinkAsk] = useState<string | null>(null);
  const [refusedFor, setRefusedFor] = useState<string | null>(null);
  const [frameHeight, setFrameHeight] = useState<FrameHeight | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  /** The message the reader asked to see in its own colours in a dark scheme (the web's per-message flip). */
  const [originalFor, setOriginalFor] = useState<string | null>(null);
  // THE FRAME IS AS TALL AS ITS DOCUMENT and never scrolls itself (`src/mail/frame-height.ts`). A new
  // width re-measures at the seed's size above a spacer holding the old height; the settle is armed
  // only by a seed-size reading at that width, and a frame no reading answers reads as text.
  const { width: windowWidth } = useWindowDimensions();
  const html = m.html ?? "";
  // THE QUOTED HISTORY FOLDS OUT OF THE DOCUMENT (the shared detector, `sanitize.ts`'s `fold`): folded,
  // every document below is the cut one, and the frame's height, its remembered height and its drawn
  // document are keyed on the fold state, so a folded state never draws the whole document.
  const folded = useMemo(() => sanitizeGuarded(html, { fold: true, subject: m.subject }), [html, m.subject]);
  const history = folded.history ?? null;
  const folding = history !== null && !historyOpen;
  const frameId = folding ? `${m.id}#folded` : m.id;
  const sized = frameHeightFor(frameHeight, frameId, windowWidth, rememberedFrameHeight(frameId));
  const update = (f: (s: FrameHeight) => FrameHeight) =>
    setFrameHeight((prev) => f(frameHeightFor(prev, frameId, windowWidth, rememberedFrameHeight(frameId))));
  useEffect(() => {
    if (frameHeight !== null) rememberFrameHeight(frameHeight);
  }, [frameHeight]);
  const settleKey = sized.measured === null ? null : `${sized.key}@${sized.width}:${sized.measured}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => armFrameTimer(settleDelayMs(sized, Date.now()), () => update(settleFrameHeight)), [settleKey]);
  const awaiting = loadedFor === frameId && !sized.answered && sized.text === null ? `${sized.key}@${sized.width}` : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => armFrameTimer(awaiting === null ? null : FRAME_UNANSWERED_MS, () => update(unansweredFrameHeight)), [awaiting]);

  // A marked sender's pictures wait for the press whatever the stored flag says (`Mail.senderCheck`).
  const imagesWanted = (m.loadedRemoteContent === true && m.senderCheck === undefined) || asked === m.id;
  const resolvedRemote = remote?.id === m.id ? remote.map : undefined;
  // THE PICTURES' LENGTH IS READ BEFORE THEY ARE WRITTEN (`src/mail/frame-length.ts`): a picture is
  // written once per reference, so a state whose document would pass this phone's ceiling (its memory
  // class, `src/mail/frame-ceiling.ts`) is refused without being built, and the sanitize below never
  // writes it.
  const ceiling = useMemo(() => phoneFrameCeiling(), []);
  const bare = useMemo(() => (folding ? folded : sanitizeGuarded(html, {})), [folding, folded, html]);
  // THE LETTER'S SHEET IS LIGHT IN BOTH SCHEMES (the web's `.mb-sheet`): a dark scheme inverts a letter
  // whose own paper reads light, and the reader may flip it back to its own colours.
  // The ink is the body's own when it reads on the paper painted, otherwise the light sheet's.
  const sheetInk = paletteOf("light", t.face);
  const paper = bare.paper ?? sheetInk.panel;
  const ink = letterInk(paper, bare.ink, sheetInk.ink);
  const adaptable = t.scheme === "dark" && bare.light;
  const inverted = adaptable && originalFor !== m.id;
  const sheetBg = inverted ? letterInDark.canvas : paper;
  const theme = useMemo(
    () => ({ bg: paper, ink, ink2: sheetInk.ink3, accent: sheetInk.accent, fontScale: 1, invert: inverted ? letterInDark : null }),
    [paper, ink, sheetInk, inverted],
  );
  const pictures = useMemo(
    () => ({ inlineImages: m.inlineImages, resolvedRemote, fold: folding, subject: m.subject }),
    [m.inlineImages, resolvedRemote, folding, m.subject],
  );
  const pictured = (m.inlineImages?.size ?? 0) > 0 || (resolvedRemote?.size ?? 0) > 0;
  const drawnChars = useMemo(() => {
    if (!pictured || bare === UNREADABLE) return null;
    try {
      return drawnLength(html, pictures, bare, theme);
    } catch {
      return Number.NaN;
    }
  }, [pictured, html, pictures, bare, theme]);
  const tooLong = drawnChars !== null && drawnChars > ceiling;
  const lengthThrew = Number.isNaN(drawnChars);
  const sanitized = useMemo(
    () => (lengthThrew ? UNREADABLE : pictured && !tooLong && bare !== UNREADABLE ? sanitizeGuarded(html, pictures) : bare),
    [lengthThrew, pictured, tooLong, html, pictures, bare],
  );
  // A pass that threw (a hostile letter's worst case) shows this letter as text with its own notice.
  const unreadable = folded === UNREADABLE || sanitized === UNREADABLE;

  // THE DOCUMENT THE WEBVIEW IS HANDED IS THE ONE COUNTED (`src/mail/frame-tree.ts`): `current`, in
  // this consent state, counted a step per macrotask before it is drawn. While a new state is counted
  // (a picture arrived, Show images), the frame keeps drawing the last document of this same html whose
  // own count fitted, and keeps it, saying why, when the new state is refused.
  const current = useMemo(() => (tooLong || unreadable ? null : buildPhoneMailDocument(sanitized.html, theme)), [tooLong, unreadable, sanitized.html, theme]);
  const plan = useMemo(
    () => (unreadable ? null : current === null ? planFrameLength(drawnChars ?? 0, ceiling) : planFrameCount(current, sanitized.oversize === true, ceiling)),
    [unreadable, current, drawnChars, sanitized.oversize, ceiling],
  );
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const reading = useFrameCount(plan, frameId, html, setDrawn);
  const kept = drawn !== null && drawn.id === frameId && drawn.html === html ? drawn.doc : null;
  // A PICTURED STATE REFUSED WITH NOTHING KEPT FALLS BACK TO THE BARE DOCUMENT, NEVER TO TEXT: a remount
  // after Show as text finds its pictures already minted, so no bare document was drawn first. The same
  // html with no picture is counted, and once it fits it is the kept document (the images sentence).
  const needBare = pictured && kept === null && reading !== null && !reading.fits;
  const barePlan = useMemo(
    () => (needBare ? planFrameCount(buildPhoneMailDocument(bare.html, theme), bare.oversize === true, ceiling) : null),
    [needBare, bare, theme, ceiling],
  );
  const bareReading = useFrameCount(barePlan, frameId, html, setDrawn);

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
  // Only the pictures this document names and the phone does not hold yet: opening a folded history
  // asks for its own pictures, never again for the ones already drawn.
  const pictureUrls = useMemo(
    () => sanitized.blocked.filter((b) => !b.pixel && resolvedRemote?.has(b.url) !== true).map((b) => b.url),
    [sanitized.blocked, resolvedRemote],
  );
  const route = w.images;
  // ONE BUDGET PER MESSAGE across every pass (the engine's inline-image ceilings): a url is asked for
  // once, minted or failed, and the press is recorded once.
  const spent = useRef<{ id: string; tried: Set<string>; budget: PictureBudget; recorded: boolean } | null>(null);
  if (spent.current?.id !== m.id) spent.current = { id: m.id, tried: new Set(), budget: pictureBudget(), recorded: false };
  const untried = pictureUrls.filter((u) => !spent.current!.tried.has(u));
  const asking = untried.join("\n");
  useEffect(() => {
    const log = spent.current!;
    const urls = untried.filter((u) => !log.tried.has(u));
    if (!imagesWanted || urls.length === 0 || log.budget.parts <= 0 || log.budget.bytes <= 0) return;
    for (const u of urls) log.tried.add(u);
    const consented = m.loadedRemoteContent === true || log.recorded;
    void fetchRemoteImages(route, m.id, urls, { consented, budget: log.budget }).then((got) => {
      if (spent.current !== log) return;
      if (got.consentRefused) {
        for (const u of urls) log.tried.delete(u);
        setAsked(null);
        setRefusedFor(m.id);
        return;
      }
      log.recorded = true;
      setRemote((was) => was?.id === m.id
        ? { id: m.id, map: new Map([...was.map, ...got.minted]), pixels: new Set([...was.pixels, ...got.pixels]) }
        : { id: m.id, map: got.minted, pixels: new Set(got.pixels) });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagesWanted, asking, m.id]);

  const shows = frameShows(reading, current, kept, sanitized.oversize === true, barePlan === null ? "none" : bareReading);
  // The read rule takes this frame's top, and the end marker under it, only once its height is the document's.
  const final = frameFinal(sized, unreadable || shows.show === "text");
  const finalTo = useRef(onFinal);
  finalTo.current = onFinal;
  useEffect(() => { finalTo.current?.(final); }, [final]);
  // The reader draws the history row beside the frame; the text fallback folds its own text.
  const asText = unreadable || shows.show === "text" || sized.text !== null;
  const historyTo = useRef(onHistory);
  historyTo.current = onHistory;
  const historyAt = asText || history === null ? null : history.at;
  useEffect(() => { historyTo.current?.(historyAt); }, [historyAt]);
  if (asText) {
    // The fallback states its reason — a bare plain-text render reads as a bug. An unreadable html
    // part is not read again for the fold: the text folds by its own reading.
    return (
      <View>
        <Txt variant="caption" tone="ink3" style={{ marginBottom: 10 }}>
          {unreadable ? Copy.mailUnreadable : Copy.mailOversize}
        </Txt>
        <HistoryFold foldKey={m.id} html={unreadable ? null : html} subject={m.subject}>
          <BodyPages variant="readerBody" style={{ maxWidth: t.layout.proseMax }} text={m.body} />
        </HistoryFold>
      </View>
    );
  }

  const fetchedPixels = remote?.id === m.id ? remote.pixels.size : 0;
  const said = blockedNotice(sanitized.blocked, sanitized.sheets, imagesWanted, imagesSeenBy(route), fetchedPixels);
  // A refused state with an earlier document still drawn: the pictures are what did not fit, and it says so.
  const lead = shows.show === "frame" && shows.withheld
    ? Copy.mailImagesTooLarge
    : refusedFor === m.id && !imagesWanted ? Copy.mailImagesRefused : null;
  const notice = [lead, said].filter((x) => x !== null).join(" ") || null;
  const canLoad = !imagesWanted && pictureUrls.length > 0;
  // The document drawn: this state's once its own count fits; otherwise the last that fitted for this html.
  const doc = shows.show === "frame" ? shows.doc : null;
  const { frame: height, spacer } = frameLayout(sized);
  const flip = adaptable ? (
    <Txt
      variant="caption"
      tone="accent"
      onPress={() => setOriginalFor(inverted ? m.id : null)}
      accessibilityRole="button"
      accessibilityLabel={inverted ? Copy.mailDarkOriginalTitle : Copy.mailDarkAdaptTitle}
    >
      {inverted ? Copy.mailDarkOriginal : Copy.mailDarkAdapt}
    </Txt>
  ) : null;

  return (
    <View>
      {/* The sentence is a line of its own; the links are one right-aligned row under it at every
          width, wrapping as a group only when the row itself does not fit. */}
      <View style={{ gap: 6, marginBottom: 10 }}>
        {notice !== null ? (
          <Txt variant="caption" tone="ink3">
            {notice}
          </Txt>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", columnGap: 12, rowGap: 6 }}>
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
          {flip}
          <Txt variant="caption" tone="accent" onPress={onShowAsText} accessibilityRole="button">
            {Copy.mailShowAsText}
          </Txt>
        </View>
      </View>
      <View
        testID="mail-sheet"
        style={[
          { backgroundColor: sheetBg, borderRadius: t.radius.card },
          t.lift("l0"),
          t.scheme === "dark" ? { borderWidth: 1, borderColor: t.c.hairSoft } : null,
        ]}
      >
        <View style={{ borderRadius: t.radius.card, overflow: "hidden" }}>
          {doc !== null ? (
            <WebView
              // ONE document, rebuilt when the maps move; never a URL. `key` on the id keeps a
              // recycled frame from showing the previous message during the swap.
              key={frameId}
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
              scrollEnabled={false}
              onScroll={(e) => {
                const reported = e.nativeEvent.contentSize.height;
                const view = e.nativeEvent.layoutMeasurement.height;
                const at = Date.now();
                update((s) => nextFrameHeight(s, reported, view, at));
              }}
              onLoadEnd={() => setLoadedFor(frameId)}
              style={{ height, backgroundColor: sheetBg }}
              accessibilityLabel={Copy.mailFrameLabel}
            />
          ) : (
            // Where the frame will stand, as the WebView looks before its own first paint.
            <View style={{ height, backgroundColor: sheetBg }} />
          )}
        </View>
      </View>
      {spacer > 0 ? <View style={{ height: spacer }} /> : null}
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
