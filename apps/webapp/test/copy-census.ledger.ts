/**
 * ═══ THE COPY CENSUS — THE DISPOSITIONS ═══════════════════════════════════════════════════
 *
 * `./copy-census.scan.ts` enumerates every string a component writes itself. Each one lands in
 * exactly one of the two tables here, and both directions are checked: a finding with no row is
 * red (a new hardcoded label has to be argued for, in a diff), and a row matching no finding is
 * red (the ledger cannot rot into folklore).
 *
 * A lane that closes strings edits this file DOWN in the same commit.
 */

/** One exempted string, and why it is not copy. */
export interface Exemption {
  /** The literal exactly as the scan reports it — whitespace collapsed, trimmed. */
  text: string;
  why: string;
}

/**
 * ── EXEMPT: strings that are not words in a language ───────────────────────────────────────
 *
 * Three kinds, and nothing else qualifies:
 *
 *   · THE WORDMARK. "oh" + "mail" is one name split across two elements so the stylesheet can
 *     weight the halves; two gate screens write it whole. A brand is not translated, and
 *     `test/support/wordmark.js` already pins how it is written.
 *   · KEYCAPS. `esc` is what is printed on the key, and `mod+Enter` is a chord identifier the
 *     keymap parses — not a sentence. Keycaps stay platform-true; translating them would name
 *     a key nobody's keyboard has. `Ctrl` is the same fact from the other side: the keymap
 *     RESOLVES `mod` to it on a non-Mac, so it is the printing on a key rather than a word.
 *   · MACHINE TEXT. A document, a security policy, a stylesheet selector or a script the
 *     browser parses. `MessageBody` returns the mail frame's whole HTML and its CSP directives;
 *     `ThemeProvider` returns the pre-paint boot script; `zone-nav` returns CSS selectors;
 *     `IcsEventCard` returns iCalendar wire tokens. None of them is read by a person, and
 *     "translating" any of them would break the thing it is addressed to.
 *
 * The third kind arrived with the `return` pass — see the scan's header for the measurement
 * that admitted it. It is deliberately BY FILE AND BY STRING rather than by a heuristic: a rule
 * like "contains a brace" would also swallow real interpolated copy, and the whole design of
 * this ledger is that a non-word costs a line somebody has to write down.
 *
 * A fourth kind used to be here and is gone: `localStorage` names (`ohmail.theme` and its
 * siblings). They are excluded by the prose rule itself now — a dotted lowercase token is not a
 * sentence — so listing them would be a stale row, which this ledger treats as an error.
 */
export const EXEMPT: Record<string, Exemption[]> = {
  "apps/webapp/app/views/HistoryRail.tsx": [
    { text: "--history-gutter", why: "machine text — the CSS custom property the rows' gutter rule reads (history-rail.css)" },
  ],
  "packages/ui/src/composites/RailNav.tsx": [
    { text: "oh", why: "wordmark — the first half of the brand, weighted by the stylesheet" },
    { text: "mail", why: "wordmark — the second half" },
  ],
  "packages/ui/src/composites/Reader.tsx": [
    { text: "esc", why: "keycap — what is printed on the key" },
  ],
  "packages/ui/src/composites/CommandPalette.tsx": [
    { text: "esc", why: "keycap — the palette foot names the key, not a word" },
  ],
  "packages/ui/src/composites/FocusReplyOverlay.tsx": [
    { text: "esc", why: "keycap — the run's exit hint names the key" },
  ],
  "apps/webapp/app/shell/AppShell.tsx": [
    { text: "oh", why: "wordmark — the first half of the brand" },
    { text: "mail", why: "wordmark — the second half" },
  ],
  "apps/webapp/app/shell/engine.tsx": [
    { text: "oh", why: "wordmark — the boot screen's mark" },
    { text: "mail", why: "wordmark — its second half" },
  ],
  "apps/webapp/app/shell/FirstRun.tsx": [
    { text: "oh", why: "wordmark — the first half of the brand" },
    { text: "mail", why: "wordmark — the second half" },
    { text: "esc", why: "keycap — the flow's dismiss hint" },
  ],
  "apps/webapp/app/shell/SenderMenu.tsx": [
    { text: "esc", why: "keycap — the resolve step's and the confirm's step-back hint" },
  ],
  "apps/webapp/app/shell/InlineReply.tsx": [
    { text: "esc", why: "keycap — the editor's dismiss hint" },
    { text: "mod+Enter", why: "chord identifier — the keymap parses it; `mod` resolves per platform" },
    { text: "mod+shift+Enter", why: "chord identifier — Send + Done's, parsed by the keymap and printed by `chordKeys`" },
  ],
  "apps/webapp/app/views/ComposeView.tsx": [
    { text: "mod+Enter", why: "chord identifier — parsed by the keymap, not read by anyone" },
  ],
  "apps/webapp/app/views/OhboxView.tsx": [
    { text: "esc", why: "keycap — the selection capsule's clear hint" },
    { text: "Backspace", why: "chord identifier — the keymap parses it and `chordKeys` prints ⌫; nobody reads this word" },
  ],
  "apps/webapp/app/shell/MessagePane.tsx": [
    { text: "shift+Backspace", why: "chord identifier — the Trash bar's Restore keycap; the keymap parses it and `chordKeys` prints ⇧⌫, nobody reads this word" },
  ],
  /**
   * A FOLDER PATH IS NOT A WORD, and this one is the fallback of a fallback. `restoreLabel`
   * answers where a restore would put a message; a row from a server that predates the field
   * carries no destination, and `"INBOX"` is the path that server's restore would in fact use.
   * It goes straight into `placeLabel`, which is the ONE function that turns a folder into
   * something a person reads — so the string never reaches a screen, and translating it would
   * name a folder no mail server has.
   */
  "apps/webapp/app/views/TrashView.tsx": [
    { text: "INBOX", why: "folder path — fed to `placeLabel`, which is what a reader sees; never rendered itself" },
  ],
  /**
   * MACHINE TEXT, ALL OF IT. These four files return documents, policies, selectors and wire
   * tokens from functions, and the `return` pass reaches them for the first time. Every row here
   * is addressed to a parser rather than to a reader.
   */
  "apps/webapp/app/components/MessageBody.tsx": [
    { text: "table table", why: "a CSS rule fragment for the sanitized mail frame's stylesheet" },
    { text: "default-src 'none'", why: "CSP directive — the mail frame's policy, parsed by the browser" },
    { text: "img-src data: blob:{}", why: "CSP directive — the image arm, with the proxy path spliced in" },
    { text: "style-src 'unsafe-inline'", why: "CSP directive for the frame's own stylesheet" },
    { text: "font-src data:", why: "CSP directive — embedded faces only" },
    { text: "script-src 'none'", why: "CSP directive — the frame runs nothing" },
    { text: "object-src 'none'", why: "CSP directive — no plugins in the mail frame" },
    { text: "frame-src 'none'", why: "CSP directive — no nested frames in the mail frame" },
    { text: "form-action 'none'", why: "CSP directive — a mail body may not post anywhere" },
    { text: "base-uri 'none'", why: "CSP directive — no base rewriting inside the frame" },
    { text: "<!doctype html><html{}{}{}><head><meta charset=\"utf-8\">", why: "the mail frame's document, opened" },
    { text: "<meta http-equiv=\"Content-Security-Policy\" content=\"{}\">", why: "the policy tag that carries the directives above" },
    { text: "<meta name=\"referrer\" content=\"no-referrer\">", why: "a document meta tag, parsed not read" },
    { text: "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">", why: "a document meta tag, parsed not read" },
    { text: "<style>{}</style></head><body>", why: "the frame document's style block and body open" },
    { text: "</body></html>", why: "the frame document, closed" },
  ],
  "packages/ui/src/theme/ThemeProvider.tsx": [
    { text: "(prefers-color-scheme: dark)", why: "a media query the browser evaluates" },
    { text: "var f=null;try{f=localStorage.getItem({})}catch(e){}", why: "the pre-paint theme script — JavaScript, emitted as text" },
    { text: "if(f!==\"paper\"&&f!==\"ohmarchy\"){try{f=localStorage.getItem({})}catch(e){}}", why: "the same script, the account-face read" },
    { text: "if(f!==\"paper\"&&f!==\"ohmarchy\")f=(/Linux/.test(navigator.platform||\"\")&&!/Android|CrOS/.test(navigator.userAgent||\"\"))?\"ohmarchy\":\"paper\";", why: "the same script, the platform default" },
    { text: "if(f===\"ohmarchy\")try{document.documentElement.dataset.face=\"ohmarchy\"}catch(e){}", why: "the same script, the face stamp" },
    { text: "var l=null;try{l=localStorage.getItem({})}catch(e){}", why: "the same script, the layout read" },
    { text: "if(l===\"zero\")try{document.documentElement.dataset.layout=\"zero\"}catch(e){}})()", why: "the same script, the layout stamp and its close" },
  ],
  "apps/webapp/app/views/SearchView.tsx": [
    { text: ".view-search .search-box input", why: "a CSS selector — how the view reaches its own query box to select the kept text and to put the caret back after Escape" },
  ],
  "apps/webapp/app/shell/zone-nav.tsx": [
    { text: "[role=\"dialog\"], [role=\"alertdialog\"], [role=\"menu\"]", why: "a CSS selector — what counts as a layer above the deck" },
    { text: "{} button:not([disabled])", why: "a CSS selector, composed per zone" },
  ],
  "apps/webapp/app/shell/ThreadMarks.tsx": [
    { text: ":focus-visible", why: "a CSS selector — `Element.matches` asks whether a square's focus came from the keyboard" },
  ],
  "apps/webapp/app/components/ComposeAttach.tsx": [
    { text: "read failed", why: "the reason on a rejected FileReader, logged and re-thrown — never rendered" },
  ],
  "apps/desktop/src/DesktopAccessLock.tsx": [
    { text: "ohmail", why: "wordmark — the access lock's mark, written whole beside the other gate cards" },
  ],
  "apps/desktop/src/DoorChooser.tsx": [
    { text: "ohmail", why: "wordmark — the chooser's mark, written whole rather than split" },
  ],
  "apps/desktop/src/GateNotice.tsx": [
    { text: "ohmail", why: "wordmark — the apology card's mark, written whole" },
  ],
  "apps/desktop/src/DesktopGate.tsx": [
    { text: "ohmail", why: "wordmark — the relaunch card's mark, written whole. That card is not "
      + "`GateNotice`: its title is a success and its footer would be false, so it draws its own "
      + "`.gate-card` and carries its own mark" },
  ],
  "apps/desktop/src/host-client/PairScreen.tsx": [
    { text: "oh", why: "wordmark — the pairing screen's mark" },
    { text: "mail", why: "wordmark — its second half" },
  ],
};

/**
 * ── UNTRANSLATED: what is left after the desktop window learned to speak ───────────────────
 *
 * This table held NINE FILES and 112 strings — the standalone app's whole chrome, English in a
 * German install: the door chooser and its three sign-in forms, the gate's apology, Settings →
 * Desktop and Settings → About, the default-mail ask, the boot line. All of it now reads
 * `desktopDoor` through `apps/desktop/src/door-copy.ts`, and this is the remainder.
 *
 * The header used to say closing them needed "a `desktopDoor` namespace registered in
 * `vite.config.ts`'s `WINDOW_ONLY_NAMESPACES` — window-only for the reason `desktopScreener` is,
 * and provably so: the served client mounts none of these." That is what happened, and the proof
 * is now a case rather than a claim: `apps/desktop/test/desktop-messages.test.ts` walks the
 * served client's import graph from `host-client/main.tsx` and asserts no file in it reads the
 * namespace, next to the assertion that the namespace is on the window-only list and not on the
 * base one.
 *
 * TWO ROWS SURVIVE, and neither is a screen:
 *
 *   · the firewall command Settings → Devices shows somebody to paste into a terminal. It was
 *     already here, with the reason it still has — arguably code, counted honestly rather than
 *     exempted by assertion. `ufw` and `tcp` are not English.
 *   · one error fragment in Settings → Mailboxes, which arrived with the `return` pass and is
 *     the half-a-pane trap in miniature: `the mail engine answered {status}` appears in EIGHT
 *     modules, and seven of them are `.ts` files this scan does not walk. Translating the one
 *     the scan can see would leave a German sentence and seven English twins produced by the
 *     same failure, which is worse than eight consistent ones. It goes when the fragment is
 *     given one home.
 *
 * THE NUMBER IS STILL THE POINT. It is exact, so a lane that closes one edits it down, and a
 * lane that adds an English literal to one of these files goes red on the count.
 */
export interface Untranslated {
  /** Distinct strings the scan finds in this file. Exact — edit it down as they are closed. */
  count: number;
  why: string;
}

export const UNTRANSLATED: Record<string, Untranslated> = {
  "apps/desktop/src/DesktopDevices.tsx": { count: 1, why: "a shell command shown to copy — arguably code; counted honestly rather than exempted by assertion" },
  "apps/desktop/src/DesktopMailboxes.tsx": { count: 1, why: "`the mail engine answered {status}` — one of eight identical fragments, seven of them in `.ts` modules this scan does not walk" },
};
