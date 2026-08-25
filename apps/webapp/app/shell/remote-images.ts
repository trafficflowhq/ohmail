"use client";

/**
 * ── THE SPY-PIXEL BLOCKER'S CONSENT HALF, AND THE FIRST CONSUMER `GET /img` HAS EVER
 *    HAD ────────────────────────────────────────────────────────────────────────────────
 *
 * `MessageBody.tsx` has blocked every remote reference from the day it landed, and its
 * header states the
 * one thing it deliberately does NOT do: *"It does not fetch a blocked image after consent,
 * and the consent button is therefore absent rather than dead."* This module is that consent
 * path. It is the whole of what was missing, and it is small on purpose — the sanitizer,
 * the frame CSP and the SSRF gate are all somewhere else, already built and already watched.
 *
 * ── WHY A PROXY AT ALL, RATHER THAN JUST LETTING THE `<img>` LOAD ───────────────────────
 *
 * Because the reader's IP address is the thing being protected, and "load images" in every
 * other mail client hands it to the sender. A remote image in bulk mail is a request to a
 * host the sender chose, from the reader's own machine, carrying their address, their
 * approximate location, their user agent and the fact that they opened this message at this
 * minute. Routing it through `GET /img` makes that request OURS: `PrivacyService.proxyImage`
 * fetches server-side through a port whose signature takes ONLY a url — there is no
 * parameter through which a client header could travel, which is a structural guarantee
 * rather than a remembered one.
 *
 * ── THE URL IS SAME-ORIGIN, AND THAT IS LOAD-BEARING IN TWO PLACES ──────────────────────
 *
 * `frameCsp(true)` admits `img-src data: 'self'` and nothing else — there is no policy under
 * which the message frame may name a sender's host — and the app's own policy
 * (`security-headers.ts`) is `img-src 'self' data: blob:`. A `srcdoc` document inherits the
 * embedder's policy container, so what is enforced is the INTERSECTION, and `'self'` on both
 * sides means exactly one host may serve a consented image: this one. `/api/*` is a Next
 * rewrite onto `api.ohmail.app` (`next.config.mjs`), so the browser only ever talks to its
 * own origin and the host-only `tf_session` cookie rides along on the subresource GET —
 * which is what authenticates the proxy. A cross-origin API url would fail BOTH the CSP and
 * the cookie, silently, and look like "images just don't work".
 *
 * The url is built ABSOLUTE against `location.origin` rather than left root-relative. A
 * relative url in a `srcdoc` document resolves against the PARENT's base url, which is the
 * behaviour we want and is also the kind of inherited subtlety that changes under a `<base>`
 * somebody adds later. Absolute costs nothing and depends on nothing.
 *
 * ── CONSENT IS AWAITED, NOT ASSUMED ─────────────────────────────────────────────────────
 *
 * The optimistic shape — flip locally, POST in the background — is wrong here and the reason
 * is specific rather than stylistic: the local flag decides what THIS render fetches, and the
 * server flag decides what the NEXT one does. Flipping locally on a POST that then fails
 * gives a reader images now and no images after a reload, with nothing said in between. So
 * the click awaits the write, and a refusal is reported and loads nothing.
 *
 * ── AND THE BUTTON IS NOW THE MINORITY CASE ─────────────────────────────────────────────
 *
 * The product default moved: a message's remote images load on open, through the proxy, and the
 * per-message consent flow above is what an account gets when it OPTS OUT (mail 0048,
 * `account_settings.block_remote_images_at`). Everything in this file still exists and still runs
 * unchanged in that mode — the module did not become dead code, it became the second branch.
 *
 * What did not move: **a tracking pixel is never fetched in either mode.** That refusal lives in
 * the sanitizer, where a 1×1, a zero-dimension image and a beacon-shaped url override the proxy
 * outright (`MessageBody.tsx`), and it is not reachable from this file at all. Nor did remote
 * stylesheets, which have no proxied form to load. The default that changed is which PICTURES a
 * reader has to ask for, and it is affordable precisely because of the paragraph above it: the
 * proxy's port takes a url and nothing else, so an image the reader never pressed a button for
 * still tells the sender nothing about them.
 */

import { useCallback, useMemo, useState } from "react";
import { API_BASE, apiConfigured, messageOf, privacy } from "../api-client";

/**
 * Everything a rendered message needs in order to offer "Show images" — or ABSENT, which is
 * a real answer and not an oversight.
 *
 * `undefined` means this client cannot proxy an image: `?demo=1` (fixtures, zero network,
 * and a self-contained surface makes no external request), the desktop shell, and any test that
 * mounts a view without an API.
 * `MessageBody` renders NO BUTTON for it rather than a dead one — `MessageBodyProps.imageProxy`
 * says so in as many words. The same rule `AttachmentsChrome` follows, for the same reason:
 * a control over a capability nothing can serve is worse than no control.
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
   * DOES THIS ACCOUNT LOAD REMOTE IMAGES WITHOUT BEING ASKED? The account setting, carried on the
   * chrome so the two surfaces that render a message (`MessagePane`, `Conversation`) read one
   * answer instead of each reaching for the consent state themselves.
   *
   * `true` ⇒ every message's pictures come through the proxy on open and there is no per-message
   * button, because there is nothing left for it to do. `false` ⇒ exactly today's behaviour: the
   * bar counts what was blocked and offers "Show images".
   *
   * **It changes NOTHING about pixels.** A beacon or a 1×1 is refused the proxy in both modes,
   * inside the sanitizer, and remote stylesheets are blocked in both modes because a sheet cannot
   * be proxied at all. What moves is which PICTURES load.
   *
   * It is deliberately not folded into {@link consented}: that function answers "did this person
   * press the button for this message", which is a per-message fact the auto mode does not make
   * true, and a caller that needed to tell the two apart would have no way left to.
   */
  auto: boolean;
  /**
   * MAY A TRACKING PIXEL RIDE THE PROXY WITH THE PICTURES? The account setting (mail 0072), carried
   * on the chrome beside {@link auto} for the same reason: every surface that renders a message
   * reads one answer.
   *
   * `false` — the product default — keeps the refusal the sanitizer has always made: a 1×1, a
   * zero-dimension image or a beacon-shaped url is blanked whatever else loads. `true` hands those
   * to the proxy like any other image, so the sender learns the message was opened and still
   * nothing about who opened it or from where. It reaches the sanitizer as
   * `SanitizeOptions.loadPixels` and does nothing where no proxy exists.
   */
  loadPixels: boolean;
}

/**
 * `GET /img?mid=…&u=…` for one image, as an absolute same-origin url.
 *
 * Exported and pure so the property that matters can be asserted directly rather than
 * inferred from a rendered attribute: **the sender's host never appears in the request's
 * ORIGIN, only in its query**. A test that only read the `src` string would pass on
 * `https://evil.example/x.png` too.
 *
 * `origin` is a parameter for the same reason `createEngine` takes its env: it lets a test
 * drive the real function instead of a copy of it.
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

  const onFailed = opts.onFailed;

  const proxyFor = useCallback(
    (messageId: string) => (url: string) =>
      imageProxyUrl(API_BASE ?? "", window.location.origin, messageId, url),
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
          onFailed(messageOf(err));
        } finally {
          setPending((p) => {
            const next = new Set(p);
            next.delete(messageId);
            return next;
          });
        }
      })();
    },
    [allowed, pending, onFailed],
  );

  const auto = opts.mode === "auto";
  const loadPixels = opts.loadPixels;

  return useMemo(
    () => (apiConfigured() ? { proxyFor, consented, consent, auto, loadPixels } : undefined),
    [proxyFor, consented, consent, auto, loadPixels],
  );
}
