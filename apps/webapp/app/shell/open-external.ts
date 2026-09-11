/**
 * Links in a message, on a desktop that has no second window. Every outbound link carries
 * `target="_blank"` (the sanitizer forces it), and a `_blank` click is a request for a NEW WINDOW,
 * forwarded to whatever the host registered — this app registers nothing, so the webview dropped
 * the request silently: not the navigation policy, not the CSP, not a missing permission, which is
 * why no log anywhere showed it. A click interceptor rather than a new-window handler, because
 * attaching one means this process owning the main window's creation, shared with the interface
 * preview whose published claim is that it spawns no process — so the seam is here: one handler on
 * the two documents that exist, and a link added tomorrow is covered by having been rendered.
 */

/**
 * The scheme table, in one place. `http:`/`https:` — the shell's opener → the user's own browser,
 * never this window ({@link externalTargetOf} decides; `external_url` in `engine.rs` decides again,
 * because the argument comes out of a message). `mailto:` — THIS window → the compose form through
 * the one RFC 6068 parser ({@link mailtoTargetOf} decides, {@link setMailtoSink} is where it
 * lands); never the opener, never a process. Everything else is cancelled with nothing — `cid:`
 * above all: it names a part of the message being read and must not leave this machine. The
 * `mailto:` row was "everything else" for two releases — the fix was reasoned about as a browser,
 * and the one scheme a MAIL CLIENT answers itself was swept into refuse.
 */

/**
 * Two documents: a body is the app's own elements or a sandboxed `<iframe srcdoc>`, and a click in
 * the frame does not bubble to the embedder, so the handler is installed on each (the frame is
 * reachable because its sandbox keeps `allow-same-origin`). Off everywhere except the one build
 * that needs it: {@link enableExternalLinks} is called by the desktop entry point of the
 * engine-bearing build and nothing else — the web app installs no listener and anchors keep browser
 * semantics (inert by construction, not by a branch), and the desktop preview installs nothing
 * either: its grant is empty, and a click that invoked a command and was refused by the ACL would
 * make its no-command claim false while still opening nothing.
 */

/** The shell command that hands one address to the platform's opener. `engine.rs` owns the gate. */
export const OPEN_EXTERNAL_COMMAND = "open_external";

/**
 * The classifier — pure, and the whole of the decision. Answers the address to open in the user's
 * own browser, or `null` for "this is not one"; split from the handler so the rule is driven
 * directly by the suite and is the same rule for both documents. `base` decides what a relative
 * href resolves against and what counts as this app's own origin (the frame passes
 * `trustSameOrigin: false` — see {@link interceptLinkClicks}). Only `http:` and `https:` are ever
 * an address; everything else answers `null`, and `cid:` is why the default for an unrecognised
 * scheme is refuse — it names a part of the message being read. `mailto:` answering `null` here is
 * not the end of its story ({@link mailtoTargetOf}), but this function feeds a process spawn.
 */
export function externalTargetOf(href: string, base: string): string | null {
  const raw = href.trim();
  if (raw === "") return null;
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // `href`, not the input: the browser's own serialisation is what the shell's gate is written
  // against, and it percent-encodes every character that gate refuses.
  return url.href;
}

/**
 * The second classifier — the one scheme this app answers ITSELF: the mailto string to open a
 * compose form from, or `null`. The header's rule ("http and https go out, everything else
 * cancelled") was wrong for `mailto:` in the one product where that is least excusable — this app
 * IS the mail client, and an address clicked in a newsletter got nothing, silently;
 * `apps/desktop/src/mailto.ts` and the gate's compose seam already existed, reachable only by a link
 * the OS delivered. The RAW href is returned, never `URL.href`: the WHATWG parser may re-encode a
 * mailto's opaque path, and two normalisations in a row is how `%26` in a subject becomes a new
 * header — `parseMailto` (RFC 6068, split-then-decode) reads the bytes the author wrote.
 */

/**
 * The scheme is read off the bytes, not off a `URL` — whatever decides must be the same bytes as
 * whatever is handed on (`external_url` states the same rule on the other side). `new URL` strips
 * ASCII tab and newline before parsing, so `"mail\nto:a@b.test"` parses as a `mailto:` URL — this
 * function would then approve one string and return another whose scheme `parseMailto`'s own
 * `/^mailto:/i` does not match; that divergence happened to fail closed, which is the kind of luck
 * that stops being luck when a caller changes. So the test is the parser's own, on the string that
 * travels. The string stays untrusted: it becomes text in a compose form and never reaches
 * {@link OPEN_EXTERNAL_COMMAND} or a process spawn.
 */
export function mailtoTargetOf(href: string, base: string): string | null {
  void base; // deliberately unused — a mailto is absolute or it is not a mailto. See the header.
  const raw = href.trim();
  // Case-insensitive because a scheme is, and on the RAW value so that the string this
  // function approved is byte-for-byte the string its caller hands to `parseMailto`.
  if (!/^mailto:/i.test(raw)) return null;
  return raw;
}

/**
 * Whether this link is the client's own navigation — its scheme and host, not its "origin". On macOS the app
 * document is served from `tauri://localhost`, and `tauri:` is not a special scheme, so its WHATWG origin is
 * OPAQUE and serialises to `"null"` — as does every opaque origin, so an `.origin === .origin` test answers YES
 * for `mailto:`, `cid:`, `javascript:`, `data:` and `file:` (measured, not reasoned). Those clicks were left to
 * the webview on macOS while every test passed (jsdom has a real http origin). "Reject opaque origins" is the
 * obvious repair and wrong: the app's OWN routes are opaque on macOS too — the app would stop routing. Scheme
 * AND host answers the real question on all three platforms: `tauri:`+`localhost` matches itself and nothing
 * else, and on Windows/Linux (`http://tauri.localhost`) it is exactly the origin comparison it replaces.
 */
export function isAppsOwnNavigation(href: string, base: string): boolean {
  try {
    const target = new URL(href, base);
    const here = new URL(base);
    return target.protocol === here.protocol && target.host === here.host;
  } catch {
    return false;
  }
}

/**
 * Whether the interceptor has been switched on for this window.
 *
 * A module-level flag rather than a probe for `__TAURI_INTERNALS__`, because the probe cannot
 * tell the two desktop artifacts apart: the runtime defines that object in the preview too, whose
 * window is granted nothing and must call nothing. The build that has the command says so.
 */
let enabled = false;

/** Switch the interceptor on. Called once, from the engine-bearing desktop build's entry point. */
export function enableExternalLinks(): void {
  enabled = true;
}

/** Whether {@link interceptLinkClicks} will do anything. Read by the suite, and by the frame. */
export function externalLinksEnabled(): boolean {
  return enabled;
}

/**
 * What this window does with a clicked `mailto:` — a compose form, or nothing. A registration
 * rather than an argument to {@link enableExternalLinks}: the two are armed at different moments by
 * different owners — the interceptor once, by the desktop entry point, before React mounts; the
 * thing that can open a compose form is a component's own state and does not exist until the gate
 * has mounted. `null` — the default and the web app's permanent state — means a mailto is
 * cancelled, the behaviour before this seam existed; also the desktop's state before the gate
 * mounts, so the arm degrades to the old outcome rather than an exception. Registering a sink arms
 * nothing on its own: no listener exists unless {@link enableExternalLinks} was called.
 */
let mailtoSink: ((raw: string) => void) | null = null;

/** Point the `mailto:` arm at a compose form, or pass `null` to take it away. */
export function setMailtoSink(sink: ((raw: string) => void) | null): void {
  mailtoSink = sink;
}

interface TauriInternals {
  invoke(command: string, payload?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Ask the shell to open one address, and say so if it will not.
 *
 * The rejection arm is a `console.error` and not a swallow: this whole slice exists because a
 * link failed without a trace, and a second silent failure mode in the fix would be the same
 * defect wearing the repair. There is no UI context at a document-level listener to raise a
 * toast from — the caller is a click on any anchor in the window — so the window's own log is
 * where it goes, which is the one place a report can quote.
 */
async function askShellToOpen(url: string): Promise<void> {
  const host = globalThis as { __TAURI_INTERNALS__?: Partial<TauriInternals> };
  const internals = host.__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== "function") return;
  try {
    await (internals as TauriInternals).invoke(OPEN_EXTERNAL_COMMAND, { url });
  } catch (err) {
    console.error(`ohmail: the shell would not open ${url}`, err);
  }
}

/** Documents already carrying the listener, so a second install is not a second handler. */
const installed = new WeakSet<Document>();

interface InterceptOptions {
  /**
   * Whether a link to this document's OWN origin may be left to the browser. `true` for the app's document, where
   * same-origin anchors are the client's own navigation — the `#/settings` routes, the in-page jumps — and preventing
   * them would break the app. `false` inside a message frame, where nothing is the app's own navigation. A `srcdoc`
   * document inherits the embedder's base URL, so a sender writing `<a href="/x">` or an absolute link to the app's
   * own origin would otherwise be handed straight to the webview, which would navigate the frame — or, having escaped
   * it, the window — inside the app's origin. That is the catastrophic shape this file's header rules out, and it is
   * ruled out by refusing every click in a frame that is not an http/https address to open.
   */
  trustSameOrigin: boolean;
}

/**
 * Install the one handler on one document. Idempotent, and a no-op unless {@link enableExternalLinks} has been
 * called. CAPTURE phase, so the decision is made before any component's own `onClick` — a surface that stops
 * propagation for its own reasons must not be able to turn a link back into a silent no-op, which is the failure
 * being fixed. Modifier keys are deliberately NOT inspected. In a browser ⌘-click means "open in a new tab", and here
 * every one of these opens in the user's browser regardless; branching on the modifier would produce two behaviours
 * where the platform offers one. Answers a disposer.
 */

/**
 * Neither caller needs one — the app's document lives as long as the window and a frame's dies with the message — and
 * it is returned because a listener with no way off is a listener no test can prove the ABSENCE of: the web app's
 * case is "nothing is installed", and asserting that in a suite that shares one document means being able to get back
 * to nothing.
 */
export function interceptLinkClicks(doc: Document, opts: InterceptOptions): () => void {
  if (!enabled) return () => {};
  if (installed.has(doc)) return () => {};
  installed.add(doc);

  const onClick = (ev: Event): void => {
    const mouse = ev as MouseEvent;
    // A handled click, or one of the secondary buttons the platform answers itself.
    if (ev.defaultPrevented) return;
    if (typeof mouse.button === "number" && mouse.button !== 0) return;

    const from = ev.target as Element | null;
    const anchor = from?.closest?.("a[href], area[href]") as
      | (Element & { getAttribute(name: string): string | null })
      | null;
    if (!anchor) return;

    const href = anchor.getAttribute("href") ?? "";
    // An in-page jump is this document's own business in either document.
    if (href.startsWith("#")) return;

    const base = doc.baseURI;

    // THE APP'S OWN NAVIGATION IS DECIDED FIRST, AND THE ORDER IS THE WHOLE OF IT. This test used to sit BELOW the
    // one after it, which made it dead code for exactly the scheme it exists to judge: `/mailbox#/settings` resolves
    // to an `http:` URL, so the classifier claimed it and the client's own route was posted to the platform's browser
    // before the same-origin question was ever asked. On macOS that never showed — the window is served from
    // `tauri://localhost`, so an in-app link is not http at all and fell through to the check below. On Windows and
    // Linux the window is served from `http://tauri.localhost`, where every internal link in the app is same-origin
    // http and would have left for the browser. One ordering, two platforms, and only one of them could see it.

    // The test itself is scheme-and-host rather than origin equality, and that is not a detail: on macOS an origin
    // comparison answered YES for `mailto:`, `cid:`, `javascript:` and `file:` as well, because every opaque origin
    // serialises to the same `"null"`. See {@link isAppsOwnNavigation} — that is the mirror of the bug this comment
    // describes.
    if (opts.trustSameOrigin && isAppsOwnNavigation(href, base)) return;

    const target = externalTargetOf(href, base);
    if (target !== null) {
      ev.preventDefault();
      void askShellToOpen(target);
      return;
    }

    // AN ADDRESS IS THIS APP'S OWN BUSINESS. Second, and never first: the ordering is what keeps
    // the two classifiers from ever both claiming an href, and the http arm is the one with a
    // process spawn behind it, so it is the one that gets to answer first. See
    // `mailtoTargetOf` for why the raw href travels rather than `URL.href`.
    const compose = mailtoTargetOf(href, base);
    if (compose !== null) {
      // Cancelled BEFORE the sink is called, and cancelled even when there is no sink. The
      // webview's answer to a `mailto:` it cannot hand anywhere is its own business and is not
      // one this window wants: on a machine with another mail app registered, leaving the
      // default would hand the click to that app, from inside the mail client the person is
      // reading in.
      ev.preventDefault();
      mailtoSink?.(compose);
      return;
    }

    // Not an address to open, not a compose, and not this app's own. In a message frame that is
    // every link the lines above did not claim — `trustSameOrigin` is false there, so a sender
    // cannot reach this point with a link to the app's origin either. Stopped, because the one
    // outcome that must never happen is the webview leaving the app for a place a message chose.
    ev.preventDefault();
  };

  doc.addEventListener("click", onClick, true);
  return () => {
    doc.removeEventListener("click", onClick, true);
    installed.delete(doc);
  };
}
