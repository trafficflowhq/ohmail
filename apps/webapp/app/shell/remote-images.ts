"use client";

/**
 * The spy-pixel blocker's consent half — the first consumer `GET /img` has ever had.
 * `MessageBody.tsx` blocks every remote reference; this module is the consent path. Why a proxy at
 * all: the reader's IP is the thing being protected, and "load images" in every other mail client
 * hands it to the sender. Routing through `GET /img` makes the request ours —
 * `PrivacyService.proxyImage` fetches server-side through a port whose signature takes ONLY a url,
 * so no client header can travel, structurally. The url is same-origin and load-bearing: the frame's
 * `img-src` admits `data:` and this function's own origin+path only ({@link imageProxyUrl} is what
 * `proxyImgSource` derives from, so the CSP cannot drift from the url), and `/api/*` is a Next
 * rewrite so the host-only `tf_session` cookie rides the subresource GET. Built absolute:
 * a relative url in `srcdoc` resolves against the parent's base — a later `<base>` would change it.
 */

/**
 * Consent is awaited, not assumed: the local flag decides what this render fetches and the server
 * flag what the next one does, so flipping locally on a POST that fails gives images now and none
 * after a reload — the click awaits the write, and a refusal loads nothing. The button is now the
 * minority case: the default moved to loading pictures on open, through the proxy (mail 0048,
 * `account_settings.block_remote_images_at`); this module is the opt-out branch, unchanged. A
 * tracking pixel is not fetched in either mode unless the pixel switch says so (mail 0072,
 * {@link RemoteImagesChrome.loadPixels}) — that refusal lives in the sanitizer; remote stylesheets
 * stay blocked in every mode. The proxy is why the new default is affordable: an unpressed image
 * still hands the sender none of the reader's network.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE, apiConfigured, messageOf, privacy } from "../api-client";

/**
 * Everything a rendered message needs in order to offer "Show images" — or ABSENT, a real answer:
 * `undefined` means this client cannot proxy an image (`?demo=1`, the desktop shell, a test mounting
 * a view without an API), and `MessageBody` renders NO button for it rather than a dead one —
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
   * answer. `true` ⇒ pictures come through the proxy on open and there is no per-message button;
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
   * MAY THIS WINDOW STILL ASK THE SERVER FOR THIS ACCOUNT'S BYTES? Asked immediately before a
   * proxied image URL is handed to the renderer, never cached.
   *
   * `/img` is one of the two Cloud reads that never go through `api()` — the browser fetches it
   * itself, from an `<img src>`, so the account boundary cannot see it. On its own that is not a
   * leak: a message id from A's mirror answers 404 under B's session. It stops being harmless
   * the moment anything else has already put a valid id from the other account in front of this
   * window, which is exactly the state every other guard in this slice exists to prevent — so
   * this one is defence in depth, and it is cheap.
   *
   * Absent ⇒ always allowed, which is the desktop and the demo: no cookie jar, no question.
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
}

/**
 * The chrome, or `undefined` on a client with no server behind it.
 *
 * State is a `Set` of message ids rather than a flag on the open message: the reader sheet
 * and the Ohbox's reading column mount the same message at once, and two copies of "did they
 * consent" is how one pane loads images and the other does not.
 */
export function useRemoteImages(opts: RemoteImagesOptions): RemoteImagesChrome | undefined {
  const [allowed, setAllowed] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  /**
   * ── THE CHROME'S IDENTITY IS A PERFORMANCE CONTRACT, SO `onFailed` RIDES A REF ──────────
   *
   * The stream cards compare this hook's return BY REFERENCE (`StreamCardMemo`'s comparator),
   * because a changed chrome is exactly when every mounted card must re-sanitize — a setting
   * flipped, a consent recorded. The one caller passes `onFailed` as an inline arrow, so its
   * identity changes on every shell render — including the render every `/sync` apply causes —
   * and an `onFailed` dependency here would hand the stream a fresh chrome per poll, re-running
   * the sanitizer over every mounted card to deliver nothing. The ref keeps the LATEST callback
   * reachable from a `consent` whose identity moves only with the consent state itself.
   */
  const onFailedRef = useRef(opts.onFailed);
  useEffect(() => { onFailedRef.current = opts.onFailed; });

  /** Read through a ref so the predicate is consulted at USE time, not at render time. */
  const mayReadRef = useRef(opts.mayRead);
  mayReadRef.current = opts.mayRead;

  const proxyFor = useCallback(
    (messageId: string) => (url: string) => {
      // An empty `src` renders nothing and requests nothing, which is the right answer here:
      // there is no honest image to show for an account this window does not belong to, and a
      // broken-image icon would be a claim about the mail rather than about the session.
      const may = mayReadRef.current;
      if (may && !may()) return "";
      return imageProxyUrl(API_BASE ?? "", window.location.origin, messageId, url);
    },
    [],
  );

  const consented = useCallback((messageId: string) => allowed.has(messageId), [allowed]);

  const consent = useCallback(
    (messageId: string): void => {
      // One write per message. A second press while the first is in flight would spend a
      // second `cost: "work"` invocation for an idempotent flip nobody is waiting on twice.
      if (allowed.has(messageId) || pending.has(messageId)) return;
      setPending((p) => new Set(p).add(messageId));
      void (async () => {
        try {
          await privacy.loadRemote(messageId);
          setAllowed((a) => new Set(a).add(messageId));
        } catch (err) {
          // Nothing is admitted. See the header: a local flag the server did not record is a
          // message that shows images once and never again, with no explanation either time.
          onFailedRef.current(messageOf(err));
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

  return useMemo(
    () => (apiConfigured() ? { proxyFor, consented, consent, auto, loadPixels } : undefined),
    [proxyFor, consented, consent, auto, loadPixels],
  );
}
