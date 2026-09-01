/**
 * ═══ LINKS IN A MESSAGE, ON A DESKTOP THAT HAS NO SECOND WINDOW ════════════════════════════
 *
 * In a browser tab, `<a target="_blank">` opens a tab and there is nothing to write. In the
 * desktop window there is no tab to open, and what happens instead is the defect this module
 * exists for: **nothing at all, silently.**
 *
 * ── THE MECHANISM, BECAUSE IT IS NOT ANY OF THE THREE THINGS IT LOOKS LIKE ──────────────────
 *
 * Every outbound link this product renders carries `target="_blank"` — the mail sanitizer forces
 * it onto every `<a>` in a body (`MessageBody.tsx`), and the five hand-written link-outs in the
 * shell spell it out. A `_blank` click is not a navigation: it is a request for a NEW WINDOW,
 * which the webview forwards to whatever the host application registered to answer it. This app
 * registers nothing, and a webview with no new-window handler drops the request on the floor and
 * returns no window. So:
 *
 *  · it is NOT the navigation policy refusing — no navigation is ever attempted;
 *  · it is NOT the CSP — `connect-src 'none'` governs fetches, not window opening;
 *  · it is NOT a missing Tauri permission — nothing was invoked to be denied.
 *
 * The click is answered correctly, by a component whose correct answer is "no window". Which is
 * why it produced no error anywhere, in any log, on any platform.
 *
 * ── WHY THIS IS A CLICK INTERCEPTOR AND NOT A NEW-WINDOW HANDLER ────────────────────────────
 *
 * The webview CAN be given a new-window handler, and that would be one seam covering both
 * documents. It is not the one taken, for a reason about the OTHER artifact: attaching it means
 * this process owning the creation of the main window, and the window is created from
 * `tauri.conf.json` — shared by the interface preview, whose published claim is that it spawns no
 * process and calls no command. Buying one seam by moving both artifacts' window construction
 * into Rust, to add a browser-spawn to the one that must not have it, is the expensive way round.
 *
 * So the seam is here, and it is still ONE mechanism: one handler, installed on the two
 * documents that exist. It is not a per-component patch — no link surface in the shell knows
 * this module exists, and a link added tomorrow is covered by having been rendered.
 *
 * ── THE WHOLE SCHEME TABLE, IN ONE PLACE ────────────────────────────────────────────────────
 *
 *   http:, https:     the shell's opener → the user's own browser. Never this window.
 *                     {@link externalTargetOf} decides; `external_url` in `engine.rs` decides
 *                     again, because the argument comes out of a message.
 *   mailto:           THIS window → the compose form, through the one RFC 6068 parser.
 *                     {@link mailtoTargetOf} decides, {@link setMailtoSink} is where it lands.
 *                     Never the opener, never a process.
 *   everything else   cancelled, and nothing happens. No dialog, no toast, no log — there is
 *                     nothing a person could act on. `cid:` above all: it names a part of the
 *                     message being read and must not leave this machine.
 *
 * The `mailto:` row was `everything else` for two releases, which is the second half of the
 * defect this file was written for: the fix was reasoned about in terms of the browser, so the
 * one scheme a MAIL CLIENT answers itself was swept into "refuse". Nothing had to be built to
 * close it — `apps/desktop/src/mailto.ts` and the gate's compose seam were already there,
 * reachable only by a link the operating system delivered.
 *
 * ── THE TWO DOCUMENTS, AND WHY EVENTS DO NOT REACH ACROSS ───────────────────────────────────
 *
 * A message body is drawn one of two ways: as the app's own elements (the prose path), or inside
 * a sandboxed `<iframe srcdoc>` carrying the sender's own markup. A click in the frame does not
 * bubble to the embedder — they are separate documents — so the handler is installed on each.
 * The frame is reachable at all because its sandbox keeps `allow-same-origin`; without that, the
 * links inside a designed HTML mail could not be fixed from here by any means.
 *
 * ── OFF EVERYWHERE EXCEPT THE ONE BUILD THAT NEEDS IT ───────────────────────────────────────
 *
 * {@link enableExternalLinks} is called by the desktop entry point of the engine-bearing build
 * and by nothing else, so:
 *
 *  · in the WEB app nothing is installed, no listener exists, and an anchor keeps exactly the
 *    semantics the browser gives it. This module is imported by shared code and is inert there
 *    by construction rather than by a branch that could be got wrong;
 *  · in the desktop PREVIEW nothing is installed either. That artifact's grant is empty and its
 *    claim is that it calls no command; a click that invoked one and was refused by the ACL
 *    would make the claim false while still opening nothing.
 */

/** The shell command that hands one address to the platform's opener. `engine.rs` owns the gate. */
export const OPEN_EXTERNAL_COMMAND = "open_external";

/**
 * THE CLASSIFIER — pure, and the whole of the decision.
 *
 * Answers the address to open in the user's own browser, or `null` for "this is not one". Split
 * out from the handler so the rule can be driven directly by the suite rather than through a
 * synthesised event, and so it is the same rule for both documents.
 *
 * `base` decides two things: what a relative href resolves against, and what counts as this
 * app's own origin. The second is why the frame passes `trustSameOrigin: false` — see
 * {@link interceptLinkClicks}.
 *
 * Only `http:` and `https:` are ever an address. Everything else — `mailto:`, `tel:`, `cid:`,
 * and anything the sanitizer would have removed — answers `null`, and `cid:` is the reason the
 * default for an unrecognised scheme is "refuse" rather than "pass through": it names a part of
 * the message being read, and it must not leave this machine.
 *
 * `mailto:` answering `null` here is not the end of its story — see {@link mailtoTargetOf}. It
 * must answer `null` HERE regardless, because what this function feeds is a process spawn.
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
 * THE SECOND CLASSIFIER — pure, and the one scheme this app answers ITSELF.
 *
 * Answers the mailto string to open a compose form from, or `null` for "this is not one".
 *
 * ── WHY THIS EXISTS, WHICH IS THE SAME BUG AS THE FILE'S HEADER, ONE SCHEME LATER ───────────
 *
 * The header's fix was written about the BROWSER, so its rule became "http and https go out,
 * everything else is cancelled". Cancelling is correct for `cid:` (it names a part of the
 * message being read), for `javascript:`, `data:` and `file:`. It is WRONG for `mailto:`, and
 * wrong in the one product where that is least excusable: **this app is the mail client.** An
 * address clicked in a newsletter, in a signature, or on a receipt's "contact us" line got
 * exactly what the original defect gave every link — nothing, silently.
 *
 * Nothing had to be built to answer it. `apps/desktop/src/mailto.ts` already reads a mailto
 * into a bounded compose prefill, and the gate already seeds the compose form from it — but
 * only for a link the OPERATING SYSTEM delivered. A link clicked inside the window never
 * reached that parser, because this seam refused it two layers earlier.
 *
 * ── THE RAW HREF IS RETURNED, NOT A PARSED ANYTHING, AND THAT IS THE BOUNDARY ────────────────
 *
 * `URL.href` is deliberately NOT used. It normalises the opaque path of a `mailto:` — the
 * WHATWG parser is entitled to re-encode it — and the one parser that reads these fields
 * (`parseMailto`, RFC 6068, split-then-decode) is written against the bytes a link author
 * wrote. Two normalisations in a row is how `%26` inside a subject becomes a new header. So
 * this function only DECIDES; it hands the original string on untouched.
 *
 * That string is untrusted, and it stays untrusted: it goes to a parser whose stated contract
 * is what its output can never contain, and it becomes text in a compose form. It never
 * reaches {@link OPEN_EXTERNAL_COMMAND}, never reaches a process spawn, and the shell's own
 * gate (`external_url` in `engine.rs`) refuses it a second time if it ever did.
 */
export function mailtoTargetOf(href: string, base: string): string | null {
  const raw = href.trim();
  if (raw === "") return null;
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== "mailto:") return null;
  // The href as written, not `url.href` — see the header.
  return raw;
}

/** Whether this document's own origin is somewhere a link may go without leaving the app. */
function sameOrigin(href: string, base: string): boolean {
  try {
    return new URL(href, base).origin === new URL(base).origin;
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
 * What this window does with a clicked `mailto:` — a compose form, or nothing.
 *
 * A registration rather than an argument to {@link enableExternalLinks}, because the two are
 * armed at different moments and by different owners: the interceptor is armed once by the
 * desktop entry point, before React mounts, while the thing that can open a compose form is a
 * component's own state and does not exist until the gate has mounted. A sink that had to be
 * supplied at arming time would have to be a mutable box anyway; this is that box, named.
 *
 * `null` — the default, and the web app's permanent state — means a mailto is CANCELLED and
 * nothing else, which is the behaviour before this seam existed. It is also the desktop's
 * state for the short window before the gate mounts, so the arm degrades to the old outcome
 * rather than to an exception.
 *
 * Registering a sink does NOT arm anything on its own: no listener is installed unless
 * {@link enableExternalLinks} has been called, so shared code may register one and the web app
 * stays inert by construction.
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
   * Whether a link to this document's OWN origin may be left to the browser.
   *
   * `true` for the app's document, where same-origin anchors are the client's own navigation —
   * the `#/settings` routes, the in-page jumps — and preventing them would break the app.
   *
   * `false` inside a message frame, where nothing is the app's own navigation. A `srcdoc`
   * document inherits the embedder's base URL, so a sender writing `<a href="/x">` or an
   * absolute link to the app's own origin would otherwise be handed straight to the webview,
   * which would navigate the frame — or, having escaped it, the window — inside the app's origin.
   * That is the catastrophic shape this file's header rules out, and it is ruled out by refusing
   * every click in a frame that is not an http/https address to open.
   */
  trustSameOrigin: boolean;
}

/**
 * Install the one handler on one document. Idempotent, and a no-op unless
 * {@link enableExternalLinks} has been called.
 *
 * CAPTURE phase, so the decision is made before any component's own `onClick` — a surface that
 * stops propagation for its own reasons must not be able to turn a link back into a silent
 * no-op, which is the failure being fixed.
 *
 * Modifier keys are deliberately NOT inspected. In a browser ⌘-click means "open in a new tab",
 * and here every one of these opens in the user's browser regardless; branching on the modifier
 * would produce two behaviours where the platform offers one.
 *
 * Answers a disposer. Neither caller needs one — the app's document lives as long as the window
 * and a frame's dies with the message — and it is returned because a listener with no way off is
 * a listener no test can prove the ABSENCE of: the web app's case is "nothing is installed", and
 * asserting that in a suite that shares one document means being able to get back to nothing.
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

    // THE APP'S OWN NAVIGATION IS DECIDED FIRST, AND THE ORDER IS THE WHOLE OF IT.
    //
    // This test used to sit BELOW the one after it, which made it dead code for exactly the
    // scheme it exists to judge: `/mailbox#/settings` resolves to an `http:` URL, so the
    // classifier claimed it and the client's own route was posted to the platform's browser
    // before the same-origin question was ever asked. On macOS that never showed — the window is
    // served from `tauri://localhost`, so an in-app link is not http at all and fell through to
    // the check below. On Windows and Linux the window is served from `http://tauri.localhost`,
    // where every internal link in the app is same-origin http and would have left for the
    // browser. One ordering, two platforms, and only one of them could see it.
    if (opts.trustSameOrigin && sameOrigin(href, base)) return;

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
