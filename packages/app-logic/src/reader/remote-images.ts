"use client";

/**
 * The spy-pixel blocker's consent half — the first consumer `GET /img` has ever had.
 * `MessageBody.tsx` blocks every remote reference; this module is the consent path. Why a proxy: the
 * reader's IP is the thing being protected, and "load images" in every other client hands it to the
 * sender. `GET /img` makes the request ours — `PrivacyService.proxyImage` fetches server-side
 * through a port whose signature takes ONLY a url, so no client header can travel, structurally. The
 * url is same-origin and load-bearing: the frame's `img-src` admits `data:` and this origin+path
 * only ({@link imageProxyUrl} is what `proxyImgSource` derives from, so the CSP cannot drift);
 * `/api/*` is a Next rewrite, so `tf_session` rides the GET; built absolute for `srcdoc`.
 */

/**
 * Consent is awaited, not assumed: the local flag decides what this render fetches and the server
 * flag what the next one does, so flipping locally on a POST that fails gives images now and none
 * after a reload — the click awaits the write, and a refusal loads nothing. The button is now the
 * minority case: the default moved to loading pictures on open, through the proxy (mail 0048,
 * `account_settings.block_remote_images_at`); this module is the opt-out branch, unchanged. A pixel
 * is not fetched in either mode unless the pixel switch says so (mail 0072,
 * {@link RemoteImagesChrome.loadPixels}); stylesheets stay blocked in every mode. The proxy is why
 * the new default is affordable: an unpressed image hands the sender none of the reader's network.
 */

/**
 * WHICH SERVER, AND HOW, IS THE HOST'S. This door reaches a picture through the picture wire its host hands
 * ({@link ImageDoor}) and through nothing else: it imports no server client, and over a host that named no wire no
 * door stands at all.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  INLINE_IMAGE_MAX_BYTES, INLINE_IMAGE_MAX_PARTS, INLINE_IMAGE_MAX_TOTAL_BYTES,
} from "@ohmail/client-engine";

/**
 * DOES THIS MESSAGE LOAD ITS PICTURES ON OPEN: the reader's own one term (`letter-seams.ts`), handed on under its
 * name. This file held a second copy of it, word for word; there is one now.
 */
export { autoLoadsImages } from "./letter-seams.js";

/**
 * Everything a rendered message needs in order to offer "Show images" — or ABSENT, a real answer:
 * `undefined` means this host named no picture wire (the demo, the paired page, a page with no server behind it,
 * a test mounting a view with none), and `MessageBody` renders NO button for it rather than a dead one —
 * `MessageBodyProps.imageProxy` says so. The same rule `AttachmentsChrome` follows: a control over a
 * capability nothing can serve is worse than no control.
 */
export interface RemoteImagesChrome {
  /**
   * How to reach a remote image named by THIS message. Curried by message id because the
   * proxy is account- AND message-scoped server-side (`requireOwnedMessage`, a cross-account
   * id is a 404), so the id is not decoration — it is the authorisation.
   */
  proxyFor: (messageId: string) => (url: string) => string;
  /** Has the reader consented in THIS session? Ored with the stored flag by the caller. */
  consented: (messageId: string) => boolean;
  /** The reader pressed "Show images". Awaits the server, then admits the images. */
  consent: (messageId: string) => void;
  /**
   * Does this account load remote images without being asked? The account setting, carried on the
   * chrome so the two surfaces that render a message (`MessagePane`, `Conversation`) read one
   * answer. `true` ⇒ pictures come through the proxy on open and there is no per-message button
   * (a sender not let in still waits for one, {@link autoLoadsImages});
   * `false` ⇒ the bar counts what was blocked and offers "Show images". It changes NOTHING about
   * pixels — a beacon or 1×1 is refused in both modes, inside the sanitizer; {@link loadPixels} is
   * the one thing that can lift that. Deliberately not folded into {@link consented}: that answers
   * "did this person press the button for this message", a per-message fact auto does not make true.
   */
  auto: boolean;
  /**
   * May a tracking pixel ride the proxy with the pictures? The account setting (mail 0072), carried
   * on the chrome beside {@link auto}. `false` — the default — keeps the sanitizer's refusal: a 1×1,
   * a zero-dimension image or a beacon-shaped url is blanked whatever else loads. `true` hands them
   * to the proxy; the sender then learns the open and usually WHICH recipient (bulk senders mint a
   * per-recipient token into the url), while the proxy still hides the reader's network — IP,
   * location, device. This flag must never be described as anonymous opens. It reaches the
   * sanitizer as `SanitizeOptions.loadPixels` and does nothing where no proxy exists.
   */
  loadPixels: boolean;
  /**
   * The pictures already fetched for THIS message, as `data:` URIs keyed by the sender's url.
   * Empty everywhere but a pipe-door: on a client that can name the proxy in a `src`,
   * {@link proxyFor} is the whole mechanism and nothing is ever held here.
   */
  resolvedFor: (messageId: string) => ReadonlyMap<string, string>;
  /**
   * Fetch these pictures for this message — called by the rendering with the urls it is showing
   * blanked and could show. A no-op where there is no fetcher, and idempotent: a url already
   * held, in flight, or refused is never asked for twice.
   */
  needRemote: (messageId: string, urls: string[]) => void;
}

/**
 * `GET /img?mid=…&u=…` for one image, as an absolute same-origin url. Exported and pure so the
 * property that matters is asserted directly: the sender's host never appears in the request's
 * ORIGIN, only in its query — a test that only read the `src` string would pass on
 * `https://evil.example/x.png` too. `origin` is a parameter for the reason `createEngine` takes its
 * env: a test drives the real function instead of a copy.
 */
export function imageProxyUrl(
  base: string,
  origin: string,
  messageId: string,
  url: string,
): string {
  const u = new URL(`${base}/img`, origin);
  u.searchParams.set("mid", messageId);
  u.searchParams.set("u", url);
  return u.toString();
}

export interface RemoteImagesOptions {
  /** Say why the consent could not be recorded. The server's own sentence, never a guess. */
  onFailed: (message: string) => void;
  /**
   * MAY THIS WINDOW STILL ASK THE SERVER FOR THIS ACCOUNT'S BYTES? Asked immediately before a proxied image URL is
   * handed to the renderer, never cached. `/img` is one of the two Cloud reads that never go through `api()` — the
   * browser fetches it itself, from an `<img src>`, so the account boundary cannot see it. On its own that is not a
   * leak: a message id from A's mirror answers 404 under B's session. It stops being harmless the moment anything
   * else has already put a valid id from the other account in front of this window, which is exactly the state every
   * other guard in this slice exists to prevent — so this one is defence in depth, and it is cheap. Absent ⇒ always
   * allowed, which is the desktop and the demo: no cookie jar, no question.
   */
  mayRead?: () => boolean;
  /**
   * THE ACCOUNT'S OWN ANSWER — `"auto"` (the product default: pictures load through the proxy on
   * open) or `"manual"` (the per-message consent flow, which this product shipped with).
   *
   * REQUIRED, with no default, and that is the point. A caller that forgot it would get whichever
   * value read better in this file, and the wrong one loads a sender's content for somebody who
   * asked us not to. The one caller resolves it from `useConsentState().blockRemoteImages`, whose
   * resting value is manual — so a failed settings read, an API too old to have the field, and a
   * build with no API all arrive here as `"manual"`.
   */
  mode: "auto" | "manual";
  /**
   * THE PIXEL SWITCH — `true` lets beacons through the proxy with the pictures, `false` (the
   * product default) keeps refusing them. Required for the reason {@link mode} is: the caller
   * resolves it from `useConsentState().blockTrackingPixels`, whose resting value is BLOCKED, so
   * every unknown arrives here as `false`.
   */
  loadPixels: boolean;
  /**
   * THE HOST'S PICTURE WIRE, or `"none"`. REQUIRED, with no default, for the reason {@link mode} is: a door that
   * fell back to a client of its own would ask a server for a sender's pictures on a host that named no way to.
   * This file imports no server client and can reach none.
   *
   * `"none"` is a real answer, and it is the whole door's: the hook answers `undefined`, so no address is minted,
   * no press is recorded and nothing is fetched, and the rendering offers no control. Anything that is not a wire
   * (a caller that handed nothing) reads as `"none"`.
   */
  wire: ImageDoor | "none";
}

/**
 * A PIPE DOOR'S PICTURES: a host whose engine has no origin an `<img src>` can name (the desktop, reached over a
 * pipe and not a port). `fetch` resolves one picture's bytes as a `data:` URI, or `null` when the door refused:
 * the SSRF gate, a non-image content type, the size cap, or an account that opted out. `record` stores a Show
 * images press through the same door (`POST /messages/:id/load-remote`) and rejects with the sentence to show.
 */
export interface ImagePipe {
  fetch: (messageId: string, url: string) => Promise<string | null>;
  record: (messageId: string) => Promise<void>;
}

/**
 * AN ORIGIN DOOR'S PICTURES: a host whose own origin serves the proxy (a browser). `address` names one picture
 * of one letter there (`GET /img?mid=…&u=…`), absolute and on the page's own origin, which is what the frame's
 * `img-src` is derived from: the renderer asks for it itself, and nothing is fetched or held here. `record` stores
 * a Show images press and rejects with the sentence to show.
 */
export interface ImageOrigin {
  address: (messageId: string, url: string) => string;
  record: (messageId: string) => Promise<void>;
}

/** A host's picture wire as a shell takes it: one of the two ways a letter's picture reaches a window. */
export type ImageDoor = ImagePipe | ImageOrigin;

/** A wire that fetches bytes itself; the other names an address on its own origin. */
const isPipe = (wire: ImageDoor): wire is ImagePipe => "fetch" in wire;

/** The wire a caller handed, or `"none"` for everything that is not one. */
const wireOf = (handed: ImageDoor | "none" | null | undefined): ImageDoor | "none" =>
  typeof handed === "object" && handed !== null ? handed : "none";

/**
 * The chrome, or `undefined` over a host that named no picture wire.
 *
 * State is a `Set` of message ids rather than a flag on the open message: the reader sheet
 * and the Ohbox's reading column mount the same message at once, and two copies of "did they
 * consent" is how one pane loads images and the other does not.
 */
export function useRemoteImages(opts: RemoteImagesOptions): RemoteImagesChrome | undefined {
  const [allowed, setAllowed] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  /**
   * THE CHROME'S IDENTITY IS A PERFORMANCE CONTRACT, SO `onFailed` RIDES A REF: The stream cards compare this hook's
   * return BY REFERENCE (`StreamCardMemo`'s comparator), because a changed chrome is exactly when every mounted card
   * must re-sanitize — a setting flipped, a consent recorded. The one caller passes `onFailed` as an inline arrow, so
   * its identity changes on every shell render — including the render every `/sync` apply causes — and an `onFailed`
   * dependency here would hand the stream a fresh chrome per poll, re-running the sanitizer over every mounted card
   * to deliver nothing. The ref keeps the LATEST callback reachable from a `consent` whose identity moves only with
   * the consent state itself.
   */
  const onFailedRef = useRef(opts.onFailed);
  useEffect(() => { onFailedRef.current = opts.onFailed; });

  /** The host's wire, read at USE time: a press or a rendering always meets the wire this mount stands over now. */
  const wireRef = useRef(wireOf(opts.wire));
  wireRef.current = wireOf(opts.wire);

  /** Read through a ref so the predicate is consulted at USE time, not at render time. */
  const mayReadRef = useRef(opts.mayRead);
  mayReadRef.current = opts.mayRead;
  /**
   * ONE ANSWER PER TASK. A newsletter names thirty pictures and a switch into News builds a few of
   * them, so the predicate — the account cookie, read and parsed — was asked a hundred times inside
   * one task that cannot change its answer. It is still asked at use time, once per task: the memo
   * dies with the task (a microtask clears it), so the next render, the next fetch, asks again.
   */
  const mayMemo = useRef<{ v: boolean } | null>(null);
  const mayNow = (): boolean => {
    const may = mayReadRef.current;
    if (!may) return true;
    if (mayMemo.current) return mayMemo.current.v;
    const v = may();
    mayMemo.current = { v };
    queueMicrotask(() => { mayMemo.current = null; });
    return v;
  };
  const mayNowRef = useRef(mayNow);
  mayNowRef.current = mayNow;

  /**
   * ONE FUNCTION PER MESSAGE: `MessageBody` re-sanitizes when its `imageProxy` changes identity,
   * and the hosts call this during render, so a fresh closure per call re-sanitized and re-measured
   * the open message on every render. Cleared whole at {@link PROXY_CACHE_MAX}; an id then costs one
   * re-sanitize, never a loop. `mayRead` is still asked at call time.
   */
  const proxies = useRef(new Map<string, (url: string) => string>());
  const proxyFor = useCallback((messageId: string) => {
    const hit = proxies.current.get(messageId);
    if (hit) return hit;
    if (proxies.current.size >= PROXY_CACHE_MAX) proxies.current.clear();
    const proxy = (url: string): string => {
      // No wire, no address: nothing here can name a server for a picture.
      const wire = wireRef.current;
      if (wire === "none") return "";
      // An empty `src` renders nothing and requests nothing, which is the right answer here:
      // there is no honest image to show for an account this window does not belong to, and a
      // broken-image icon would be a claim about the mail rather than about the session.
      if (!mayNowRef.current()) return "";
      // What the proxy refuses on sight is never asked for.
      if (url.length > PROXY_URL_MAX_CHARS || !/^https?:\/\//i.test(url)) return "";
      /* An origin door names its own proxy. A pipe door has none to name: its pictures arrive as bytes
         ({@link needRemote}), and what stands here is the address on this window's own origin that the rendering
         reads a source out of only where that origin is a web one, as it always was for such a door. */
      return isPipe(wire) ? imageProxyUrl("", window.location.origin, messageId, url) : wire.address(messageId, url);
    };
    proxies.current.set(messageId, proxy);
    return proxy;
  }, []);

  const consented = useCallback((messageId: string) => allowed.has(messageId), [allowed]);

  const consent = useCallback(
    (messageId: string): void => {
      // One write per message. A second press while the first is in flight would spend a
      // second `cost: "work"` invocation for an idempotent flip nobody is waiting on twice.
      if (allowed.has(messageId) || pending.has(messageId)) return;
      // No wire: the press records nothing and admits nothing.
      const wire = wireRef.current;
      if (wire === "none") return;
      setPending((p) => new Set(p).add(messageId));
      void (async () => {
        try {
          await wire.record(messageId);
          setAllowed((a) => new Set(a).add(messageId));
        } catch (err) {
          // Nothing is admitted. See the header: a local flag the server did not record is a
          // message that shows images once and never again, with no explanation either time.
          // The wire words its own refusal: it rejects with the sentence to show.
          onFailedRef.current(err instanceof Error ? err.message : String(err));
        } finally {
          setPending((p) => {
            const next = new Set(p);
            next.delete(messageId);
            return next;
          });
        }
      })();
    },
    [allowed, pending],
  );

  const auto = opts.mode === "auto";
  const loadPixels = opts.loadPixels;

  /**
   * ── THE PIPE-DOOR'S PICTURES ────────────────────────────────────────────────────────────
   *
   * One map per message of url → `data:` URI, plus the two sets that make {@link needRemote}
   * idempotent: what is in flight, and what was refused. Refusals are REMEMBERED because the
   * rendering re-reports its blanked urls on every sanitize pass, and a door that answered "no"
   * for this url will answer "no" again — without this, a refused picture would be re-fetched
   * on every render, which is the most expensive loop in the product.
   */
  const [resolved, setResolved] = useState<ReadonlyMap<string, ReadonlyMap<string, string>>>(
    () => new Map(),
  );
  const inFlight = useRef(new Set<string>());
  const refused = useRef(new Set<string>());
  /**
   * What ARRIVED, per message, read synchronously. `resolved` is render state and the rendering
   * re-reports every blanked-or-shown url, so a skip keyed on it came one render late and the
   * picture that had just arrived was asked for again, round after round (the desktop loop).
   */
  const held = useRef(new Map<string, Set<string>>());
  /** Bytes already spent per message, against the budget the embedded pictures use. */
  const spent = useRef(new Map<string, number>());

  const resolvedFor = useCallback(
    (messageId: string): ReadonlyMap<string, string> => resolved.get(messageId) ?? EMPTY,
    [resolved],
  );

  const needRemote = useCallback((messageId: string, urls: string[]): void => {
    const wire = wireRef.current;
    if (wire === "none" || !isPipe(wire)) return;
    const fetchImage = wire.fetch;
    const heldHere = held.current.get(messageId);
    for (const url of urls) {
      const key = `${messageId}\u0000${url}`;
      if (inFlight.current.has(key) || refused.current.has(key) || heldHere?.has(url)) continue;
      /* THE PER-MESSAGE PART COUNT, and it is counted against what has been ASKED rather than
         what arrived: a sender can name any number of pictures, and a bound that only counted
         successes would let them spend the budget with failures. */
      const already = heldHere?.size ?? 0;
      if (already + inFlight.current.size >= INLINE_IMAGE_MAX_PARTS) break;
      if ((spent.current.get(messageId) ?? 0) >= INLINE_IMAGE_MAX_TOTAL_BYTES) break;
      inFlight.current.add(key);
      void (async () => {
        try {
          const uri = await fetchImage(messageId, url);
          /* The per-part ceiling, measured on what ARRIVED. A `data:` URI is base64, so the
             bytes it carries are about three quarters of its length; the comparison is on the
             decoded size because that is the number the embedded pictures' ceiling names. */
          const bytes = uri === null ? 0 : Math.floor((uri.length - uri.indexOf(",") - 1) * 0.75);
          if (uri === null || bytes > INLINE_IMAGE_MAX_BYTES) {
            refused.current.add(key);
            return;
          }
          spent.current.set(messageId, (spent.current.get(messageId) ?? 0) + bytes);
          const forHeld = held.current.get(messageId) ?? new Set<string>();
          held.current.set(messageId, forHeld.add(url));
          setResolved((prev) => {
            const next = new Map(prev);
            const forMessage = new Map(next.get(messageId) ?? []);
            forMessage.set(url, uri);
            next.set(messageId, forMessage);
            return next;
          });
        } catch {
          /* A door that threw is a door that said no, and it is remembered as one: the reader
             gets the blanked box, which is what every message showed before any of this. */
          refused.current.add(key);
        } finally {
          inFlight.current.delete(key);
        }
      })();
    }
  }, []);

  /* THE DOOR STANDS WHERE A WIRE DOES, and nowhere else. Its identity moves with what a rendering can see (the
     account's two answers, a consent, a picture's arrival) and with a wire coming or going, never with the wire's
     own identity: every member reads the wire at use time. */
  const stands = wireOf(opts.wire) !== "none";
  return useMemo(
    () => (stands ? { proxyFor, consented, consent, auto, loadPixels, resolvedFor, needRemote } : undefined),
    [proxyFor, consented, consent, auto, loadPixels, resolvedFor, needRemote, stands],
  );
}

/** One identity for "this message has no fetched pictures", never mutated. */
const EMPTY: ReadonlyMap<string, string> = new Map();

/** The longest `u` `GET /img` takes: `PROXY_URL_MAX_CHARS` in `privacy-service.ts`. */
export const PROXY_URL_MAX_CHARS = 8192;

/** How many messages keep their proxy function before the cache is cleared whole. */
const PROXY_CACHE_MAX = 256;
