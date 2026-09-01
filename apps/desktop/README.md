# ohmail for macOS, Windows and Linux

The **Tauri v2 shell**, and the only desktop client there is — a native Rust
window, a locked-down webview, and a static bundle of the *same* client the web
app renders. There is no desktop fork of the interface.

**Two artifacts come out of this one directory.**

- **The app** — what the releases ship on all three platforms. It carries the
  mail engine and its own Node runtime as resources, speaks IMAP to your own
  server, and grants the window a small, named set of commands over a bridge —
  the engine, one notification, the badge, a fixed table of pages it may hand
  to your browser, opening a clicked link or an attachment outside the app,
  host mode's shell controls (state, the Tailscale probe and serve,
  start-at-login), claiming a `mailto:` click the shell is holding, and the two
  default-mail-app commands (a read of the OS's current choice, and a request
  that takes each platform's own sanctioned path). The full list is
  `WINDOW_COMMANDS` in `src-tauri/build.rs`. The webview still reaches the
  network through nothing of its own.
- **The served host client** (`dist-host/`) — the browser bundle host mode
  hands to a phone on your own network. Same shared shell, `fetch` transport,
  no shell channel.

There used to be a third, and it was this README's headline: a fixtures-only
"interface preview". It is retired — the app has no demo surface; it opens
empty and you connect a mailbox (the one demo lives on ohmail.app's landing
page) — and its offline audit moved onto the artifact that ships, where it is
strictly more of a claim (see lock 3).

Set the halves together or they disagree; `npm run app:build:engine` is the one
command that selects all three (the Cargo feature, the UI flag and the resource
config) and is what CI runs.

```bash
npm install                 # in apps/desktop (pnpm install at the monorepo root works too)
npm run ui:build:engine     # → dist/  (the bundle Tauri embeds)
npm run smoke               # → SMOKE OK (39 checks, engine)
npx tauri build --debug     # → src-tauri/target/debug/bundle/…
```

`tauri build` needs `dist/` to already exist — there is no `beforeBuildCommand`
on purpose, so a broken interface fails in its own step instead of inside a Rust
build log. CI does the same, in the same order.

---

## How the UI gets in: the decision

**There is no desktop fork of the interface.** `src/DesktopGate.tsx` mounts
`apps/webapp/app/shell/AppShell` — the same file app.ohmail.app renders — and Vite
compiles it, `@ohmail/ui`, `@ohmail/tokens` and `@ohmail/client-engine` into one
self-contained folder. What is desktop-specific is the thin layer around it: the
providers Next would otherwise supply, the pre-paint theme stamp, the offline
guard, and the gate that asks the native shell what the engine is doing.

Two options were on the table and both were tried:

| | verdict |
|---|---|
| **`next build` with `output: "export"` on apps/webapp** | **Works** — measured, not guessed: 6 static pages, 1.3 MB of `out/`, every asset local. Rejected anyway, for three reasons. It emits **root-absolute** `/_next/…` URLs, which assume the app is served from an origin root; a desktop bundle should not care where it is mounted. It drags Next, next-intl's server pipeline and a webpack build onto three CI runners for a page that is 100 % client-side. And publishing it to the public mirror would mean publishing `apps/webapp` — the *Cloud* client, with its sign-in screen and its API rewrite topology — into the free tier's repository. |
| **A Vite bundle over the shared shell** ✅ | `base: "./"` ⇒ every emitted URL is relative, so the bundle is origin-agnostic: `tauri://localhost`, `http://tauri.localhost` and `file://` all work and nothing can escape through an absolute path. It is the pattern `packages/ui/showcase` already uses in this repo. 380 KB total, builds in half a second, and needs exactly six npm packages. |

The Vite config aliases exactly four seams, and nothing else:

1. **`next-intl` → `use-intl`.** `next-intl` *is* `use-intl` plus Next server
   plumbing (both 3.26.5 here), and the thirteen shell/view files that import it
   only ever call `useTranslations`. Aliasing the wrapper away keeps ICU plurals
   byte-identical instead of re-implementing them in a shim that would drift.
2. **`…/adapters/fixtures-adapter.js` → `src/no-fixtures-adapter.ts`.** The
   shared shell keeps a demo arm for the landing page's demo, and the module
   behind it is the whole fixtures corpus — invented people and sample mail —
   one static import away from every `AppShell` build. The app opens empty and
   shows nothing but your own mailbox, so the module resolves to a refusing
   stub in both artifacts and the corpus never enters the graph.
   `scripts/scan-artifact.mjs` greps the emitted bytes for it, both directions.
3. **`…/api-client` → `src/no-api-client.ts`**, in both builds. Neither desktop
   build has a Cloud account or a server to reach — both talk to a local engine
   over a pipe — and every value the stub exports refuses. The ten shell and view
   modules that import it ask `apiConfigured()` first, which the stub answers
   `false`, so nothing calls into a refusal by accident.
4. **`react` / `react-dom` → this package's copy, by absolute path.** `dedupe`
   is not enough: in the published mirror there is no `packages/ui/node_modules`
   for a bare `react` to resolve into. An absolute alias resolves identically in
   the monorepo and in the mirror, and guarantees a single React instance.

## The webview reaches nothing, four locks

These four locks are about the **webview** and the installer — the surfaces a
stranger downloads and runs. The auto-updater is the one deliberate exception,
and it does not touch any of them: it runs in the Rust process, not the page, so
`connect-src 'none'` and the sealed `fetch` still hold literally, and the webview
is granted no updater permission. What changed is that the *process* makes
requests to one pinned endpoint — one shortly after launch, one whenever the
update menu item is picked, and one for the signed artifact when there is a newer
release to fetch. That is stated plainly in "The auto-updater" below rather than
softened here.

Three of the four are about the running app. The fourth is about the installer,
because an installer that phones home makes the other three beside the point.

**1 · The sync client is real, and the sample world is not in the module graph.**
`@ohmail/client-engine`'s barrel re-exports `HttpAdapter`, the `/sync` protocol
client, and the app constructs it deliberately — it is what the window speaks to
its own engine over: `src/bridge-fetch.ts` hands it a transport that goes to the
local process rather than to a socket. That is why
`packages/client-engine/src/adapters/http-adapter.ts` is published in this
repository whole — the shipped binary conveys it, so it has to be offerable.
(A retired build once aliased a throwing stub at that path, and the public
mirror once substituted the same stub — which blanked every window the moment a
mailbox was ready. `scripts/scan-artifact.mjs` still asserts that stub's refusal
sentence absent, and the real client's own strings present, in every bundle.)

What is aliased OUT instead is the fixtures corpus (seam 2 above): grep either
emitted bundle for the sample world's invented people and there is nothing to
find, which is the no-demo rule as bytes rather than as intent.

**2 · The CSP forbids connections, including to itself.**

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'none';
object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none';
form-action 'none'; frame-ancestors 'none'
```

`connect-src 'none'` is the load-bearing one — no `fetch`, no XHR, no WebSocket,
no EventSource, not even same-origin. `'unsafe-inline'` is present for **styles
only**, because the design system positions the tag picker and the tag hues with
inline `style` attributes; scripts have no such allowance. The same policy minus
`frame-ancestors` is repeated as a `<meta>` in `index.html` — a `<meta>` element
is specified to ignore that one directive, and declaring it there would only
print an error in every console. `desktop-shell.test.ts` asserts the two copies
never drift.

**3 · The page's own network APIs are replaced.**
[`src/offline-guard.ts`](src/offline-guard.ts) swaps `fetch`, `XMLHttpRequest`,
`WebSocket`, `EventSource` and `navigator.sendBeacon` for functions that throw.
This is not belt-and-braces for its own sake — it is what makes the promise
*testable*: `scripts/smoke.mjs` installs working versions of all five before the
bundle loads, and fails if any of them is called or if the guard leaves one
alone.

**4 · The Windows installer fetches exactly one thing, and says so.** The
released installer is built with `tauri.engine.conf.json`, which sets
`webviewInstallMode` to `downloadBootstrapper`: on a machine without the
WebView2 runtime, the installer downloads it from Microsoft — because a mail
client whose window cannot render is not degraded, it is broken. With WebView2
present (Windows 11, and any Windows 10 that has taken updates since 2021, via
Edge) the installer opens no connection. CI's Windows job asserts the
bootstrapper **is** present in the shipped `-setup.exe`, and the README's claim
changed the day the mode did.

The installer also **registers** — it writes the mail-client capability keys
(`windows/hooks.nsh`: a ProgId, `Capabilities\URLAssociations`, and a
`RegisteredApplications` pointer, all in HKCU) so ohmail appears under Settings →
Apps → Default apps → Email. Registration is not the choice: the default lives in
`UserChoice`, whose hash exists precisely so a program cannot write it, and
nothing in this repository touches it. See "The default mail app" below.

(A retired artifact — the fixtures-only interface preview — used
`{ "type": "skip" }` and CI once proved the downloader ABSENT from it, because an
app that claimed to reach nothing had to not ship an installer that reaches
something. `skip` survives in the base `tauri.conf.json`, which no shipped
artifact is built from alone.)

## Capabilities: a named list, and nothing else

`capabilities/` holds two files, and every build carries both.

```json
{ "identifier": "main", "windows": ["main"], "permissions": [] }
```

The main window's FILE grant is **empty** — not `core:default`, not a trimmed
subset. What the shipped app grants it is added at runtime instead
(`LOCAL_ENGINE_CAPABILITY` in `src-tauri/src/engine.rs`): exactly the commands
`WINDOW_COMMANDS` in `build.rs` declares, each with a one-line reason, plus one
receive-only event permission (`core:event:allow-listen`, no `allow-emit` — the
window may hear the shell and cannot make the shell hear anything). The grant is
a Rust string in a module only the `local-engine` feature compiles, so a binary
built without the feature grants nothing at all — a property of the binary
rather than of a file somebody could edit. `withGlobalTauri` is `false`, and
nothing the window may call takes a URL or a filesystem path.

```json
{ "identifier": "updater", "windows": ["updater"], "permissions": ["core:event:allow-listen"] }
```

The second file is the only grant in the tree, and it is not for that window. It
covers the transient progress window shown **only** while an update the user
asked for is downloading (`src/updater-window.ts`, opened and closed by
`src/updater.rs`; the launch check downloads without opening it, and the window
is built unfocused so it never takes the keyboard). It carries exactly one
permission: it may LISTEN for the local
`updater://progress` event the Rust updater emits, so it can render a byte-count.
There is no `core:event:allow-emit`, so it cannot make the shell hear anything
back; no command; no filesystem permission; and it inherits the app-wide
`connect-src 'none'`, so it reaches the network no more than the main window
does. The asymmetry is the design: the download is driven Rust-side, and the page
that watches it is granted one direction of one event.

The published binaries are built **with** `--features local-engine` — that is
what compiles the engine's lifecycle, the keystore access, the engine log
(a double-clicked app has no readable stderr) and the command modules in. The
plugins are registered Rust-side (`updater` and `dialog` for the auto-updater;
`single-instance`, `deep-link`, `notification` and `autostart` under the
feature) and no capability grants the webview any plugin's own permissions — the
page reaches everything through the named commands and nothing else.
`assetProtocol` is disabled, `freezePrototype` is on, and
`dangerousDisableAssetCspModification` is off.

`src-tauri/Cargo.toml` takes Tauri's default features **minus `compression`**,
plus those plugins and nothing more. Dropping brotli costs about a quarter of
a megabyte and buys the audit:

```bash
strings -a src-tauri/target/release/ohmail \
  | grep -oE 'https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+' | sort -u
```

That is the exact command CI runs. Before the updater it returned fourteen
strings on Linux and fifteen on Windows, every one of them a namespace constant,
a documentation link in a panic message, or a rodata join — enumerated in full
below. **The auto-updater changes that set:** it deliberately adds the one
endpoint this build is allowed to reach —
`https://github.com/trafficflowhq/ohmail/releases/latest/download/latest.json` —
and the transitive HTTP client it fetches through (`reqwest`/`hyper`/`rustls`)
brings its own rodata strings. The exact enumeration and the count assertions are
re-established against the updater release binary in CI; the audit rule is
unchanged in spirit and sharpened rather than relaxed — instead of failing on
*any* `ohmail`/`trafficflow` URL it now names every allowed one, and still fails
on anything else. The full allow-list is at the end of this section. The
pre-updater table, unchanged and still every bit of it real, is below:

| string | what it is |
|---|---|
| `http://www.w3.org/1999/xhtml`, `…/2000/svg`, `…/1998/Math/MathML`, `…/1999/xlink`, `…/XML/1998/namespace` | the five XML namespace **constants** React's DOM code compares against. Identifiers, not addresses — nothing dials a namespace. |
| `https://reactjs.org/docs/error-decoder.html?invariant=` | React's minified-error link, printed in a thrown message. |
| `https://prosemirror.net/docs/guide/#generatable)` | the same kind of thing one row up, from the editor instead of from React: ProseMirror's guide, cited in a thrown message about a schema it cannot generate a node for. The trailing `)` is prose, caught mid-sentence. |
| `https://github.com/tauri-apps/muda`, `…/tauri/issues/2549#issuecomment-1250036908`, `…/tauri/issues/8306)`, `…/wry/blob/a0403b9…/src/lib.rs#L1130)`, `https://github.com/whatwg/html/issues/7428` | five source-comment and panic-message URLs from wry, muda and Tauri. Note the trailing `)` on two of them: they are prose, caught mid-sentence. |
| `http://invalid` | **not a URL.** Rust `&str` literals carry their length in the pointer and get packed into rodata with no separator, so `strings` cannot see where one ends. This is the `http` crate's `"http://"` literal immediately followed by its error table; the full line reads `http://invalid uri characterinvalid schemeinvalid authorityinvalid port…`. |
| `https://AllocErrKatakanaDeadlock` | the same artifact: `"https://"` followed by the interned symbols `AllocErr`, `Katakana`, `Deadlock`. The full line reads `…XCloseOMoverflowhttps://AllocErrKatakanaDeadlock`. |

Windows returns **fifteen**. The twelve real ones above are identical; neither
rodata join survives (different linker, different neighbours) and three others
take their place: `http://https://invalid` (the `"http://"` and `"https://"`
literals adjacent, then the same `http`-crate error table), `http://I` (a third
join), and `developer.microsoft.com/en-us/microsoft-edge/webview2` — the link
inside Tauri's "WebView2 not found" dialog, which is the *only* reason that
domain is in the binary and which exists precisely because the installer does
not fetch the runtime for you.

Drop the `| sort -u` and read the whole lines if you want to check the three
adjacency claims yourself — that is the point of shipping uncompressed. CI prints
the complete list on every run and reports its size beside it, so the number here
is reconciled against a run rather than remembered: at 0.8.0 it is **38 on Linux
and 29 on Windows**. Neither is asserted in the workflow, deliberately — a
toolchain bump moves them for reasons nobody can act on, and the check that has to
hold is the allow-list below.

**What CI actually fails on is the allow-list, and it is spelled out one entry at
a time.** Every URL in the binary naming `ohmail` or `trafficflow` must be one of:

| allowed | why it is there |
|---|---|
| `https://github.com/trafficflowhq/ohmail/releases/latest/download/latest.json` | the pinned update feed — the one endpoint this build reaches on its own. Prefix match, because a Rust literal has no terminator in rodata. |
| `https://api.ohmail.app` | the hosted service, reached only after somebody signs in to it. Exact match, because it comes from a quote-terminated JavaScript literal. |
| `https://ohmail.app/mailbox#/settings`, `…/link-desktop`, `…/privacy`, `…/subprocessors` | the fixed table in `src-tauri/src/engine.rs` of pages the app may hand to **your own browser**. The window selects one by key and can never name an address itself, so these are compiled in. Prefix match, same rodata reason. |

Anything else naming this project fails the job. The extracted list is re-split on
`http` before it is judged, because adjacent Rust literals come back from `grep`
glued into one string and a glued pair would otherwise be read as a single
address — which is how an unlisted page could ride in behind a listed one. And
`strings … | grep Ohbox` finds the interface, so you can see that the binary
contains the app you were promised without running it. With brotli on, all of
that is an opaque blob.

## The auto-updater

The app can update itself, and it does it the way an app that fetches and runs
new code has to: every payload is cryptographically verified before it is allowed
to install, and the user consents before anything happens.

**Rust-side, and the menu item is the whole interface.** "Check for Updates…" is
a native menu item, not a button in the web UI — putting it in the page would mean
granting the webview an updater permission and breaking the locks above. Instead
the whole updater lives in `src-tauri/src/updater.rs`, and the webview gains
nothing.

That is also why there is no update banner inside the mail window: a banner needs
a button, a button needs a command, and a command is the exact permission being
withheld. So the item carries the state instead of one fixed word. It reads
"Checking for Updates…" while the feed is being asked, "Downloading ohmail 0.9.2…"
while a release is being fetched, and "Restart to Install 0.9.2" once a verified
payload is waiting — which is the only thing in the app that installs anything.

**One pinned HTTPS feed.** `plugins.updater.endpoints` in `tauri.conf.json` is a
single URL — the project's own GitHub Releases `latest.json`:

```
https://github.com/trafficflowhq/ohmail/releases/latest/download/latest.json
```

Nothing else is reachable. The feed's schema is Tauri's own: a `version`, notes,
a date, and a `platforms` map from `<target>-<arch>` to a signed artifact URL and
its signature. The feed and the signed artifacts are produced by the release
pipeline; this app is only the client side of that contract.

**Every payload is minisign-verified.** `plugins.updater.pubkey` holds the public
half of a minisign keypair. `tauri-plugin-updater` verifies the downloaded
artifact against it before installing; a payload whose signature does not match —
a tampered download, a MITM, a compromised feed — is refused. The private half is
never in the repository: it is supplied at packaging time through the standard
`TAURI_SIGNING_PRIVATE_KEY` environment variable (with
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` empty). Because verification is the whole
security of an unsigned-installer updater, `src-tauri/build.rs` **fails the build
if the pubkey is missing or empty** — you cannot accidentally ship a build that
would trust an unsigned feed.

**One decision, asked once, and nothing installed without it.** The app checks
the feed shortly after launch and whenever the menu item is picked. A newer signed
release is fetched in the background — `Update::download` streams it and verifies
the signature, and that is all it does; nothing on the machine has changed yet.
When the payload is verified and waiting, one dialog asks whether to restart and
install it. "Later" is remembered for the rest of the run and is never asked
again; the menu item stays as the way back to it, and a payload that is never
consented to is discarded when the app quits.

The restart happens on that press and on nothing else. A check that finds nothing
says so only when you asked for it; a check that fails says one plain sentence
with "Try again" beside it, and a check nobody asked for fails silently rather
than putting an error box over your mail.

**No downgrades.** A version that is not strictly newer than the installed one (a
downgrade, or a reinstall of the same release) is refused, as is a feed whose
version does not parse — the gate fails closed. The version is bare semver
everywhere, so the comparison is plain.

The two failures that matter for an updater — a tampered payload being installed,
and a downgrade being installed — are proven, not asserted, in
`src-tauri/src/updater_tests.rs`: a one-byte-flipped payload is watched refused
against the shipped public key, and the downgrade gate is exercised across the
boundary cases. The missing-pubkey packaging gate has its negative control in
`test/desktop-shell.test.ts`.

## The default mail app, and mailto

The app can be this computer's mail app: click an email address anywhere and a
new message opens here, prefilled. Three pieces, each with a stated boundary:

**Registration** is declarative. `plugins.deep-link.desktop.schemes` in
`tauri.engine.conf.json` names `ohmail` and `mailto`, which the bundler turns
into `CFBundleURLTypes` on macOS, a `MimeType=x-scheme-handler/mailto;` line in
the Linux `.desktop` entry, and per-scheme registry keys on Windows — where the
installer additionally writes the capability keys (`windows/hooks.nsh`) that put
ohmail on the Default-apps page. Registration makes the app a **candidate**; the
choice stays the user's, on every platform.

**Becoming the default** takes each platform's own sanctioned path, and never a
registry write. Two shell commands (`src-tauri/src/default_mail.rs`) carry it:
`default_mail_status` reads the current state into three words — `default`,
`not-default`, `unknown` — and `default_mail_request` asks. On macOS that is
`LSSetDefaultHandlerForURLScheme`, which makes **macOS itself** show the consent
dialog; on Windows it opens `ms-settings:defaultapps` (a constant address, the
window still naming no URL) where the person picks ohmail; on Linux it is
`xdg-settings set default-url-scheme-handler mailto ohmail.desktop`. The app asks
**once**, after a mailbox is connected, and never again — either answer persists,
and Settings → General keeps the row with the live-detected state for whoever
changes their mind.

**A mailto click** is parsed by exactly one parser (`src/mailto.ts` — RFC 6068,
read defensively: plain bounded strings, no control characters in single-line
fields, every header a link author invents dropped) and seeds the same compose
form every other entry point uses. The shell HOLDS the link and the window claims
it take-once (`mailto_claim`), which is what makes the click that *starts* the
app deliverable — an event emitted before the page's scripts run is an event
nobody hears. Clicked before a mailbox is connected, the draft waits; connecting
is the thing that has to happen first, and the compose opens once it has. The
link's content is never logged: who you write to is yours.

## Identifiers, names and version

**`io.ohmail.desktop`** — the same identifier the SwiftUI client carries in
`Resources/Info.plist`, deliberately. They are one product with one install, and
the identifier is not only a name: it is where the app's data directory goes and
it is what an update is allowed to replace. This configuration carried a
`.tauri` suffix for a while so that both builds could sit on one Mac during local
verification; the cost was a second data directory for the same mailbox and an
update path that could never hand over between them, which is a permanent fork in
every path the app touches in exchange for a convenience while testing.

The version is **`0.13.1`**, bare, in every place it is written: `tauri.conf.json`,
`Cargo.toml`, `Cargo.lock`, `package.json`, and the macOS `Info.plist`. The
`-preview` suffix earlier builds carried is retired — it marked "this build
cannot update itself yet", and this build ships the auto-updater, so the claim is
no longer true. "Beta" is the channel name, not a semver suffix; the MSI bundler
rejects a pre-release identifier anyway, and the bare number is what reaches the
installer filenames the bundler emits — which the release then renames in place
to the stable names the download page links (`ohmail.dmg`,
`ohmail-linux-amd64.deb`, `ohmail-windows-setup.exe`, …).
`desktop-shell.test.ts` asserts all five places carry the one number, so bumping
four of five is red in the monorepo suite.

**`CFBundleVersion` on macOS is the one number that is NOT this version**, and it
is deliberate. `src-tauri/Info.plist` pins it to a constant far above any build
number the earlier macOS client published. That client shared this bundle
identifier and updated through Sparkle, which compares a feed's version against
the installed `CFBundleVersion` — so a bundle announcing `0.8.0` there would be
read as a downgrade from a four-digit build number, and every installed copy
would report itself up to date for ever. Nothing a person sees uses it:
`CFBundleShortVersionString` is `0.13.1` and is what the app and every download
page show. The floor is asserted in `release-feeds.yml`, so a plist that loses
the key fails the release instead of stranding the installs it protects.

**The bundle's description lives in the base config now.** It used to be
per-artifact — the base said "interface preview" and the engine overlay
overrode it — because two different programs came out of this directory. The
preview is retired, one description is true of the one app, and
`tauri.engine.conf.json` keeps only what genuinely differs: the resources, the
schemes, the Windows installer's bootstrapper mode and hooks.

**One word on Linux, everywhere.** The bundler derives the `.deb`'s `Package:`
field by kebab-casing `productName`, and `productName` is `ohmail`, so the
package name, the binary at `/usr/bin/ohmail`, the icon and the `.desktop`
entry's `Icon=` and `StartupWMClass` are all the same string: `apt remove
ohmail` works. This was not always true — `productName` used to be `MailOh`,
which kebab-cased to `mail-oh` and made the package the one thing on the system
spelled differently from everything else. (`MailOh` is a historical fact, not a
brand reference: it is the only string that produces `mail-oh`, and the rename
sweep briefly turned it into `OhMail`, which kebab-cases to `oh-mail` and made
the sentence impossible.) The Linux CI job asserts
`Package: ohmail` against the built artifact, so if a future Tauri changes the
slug this paragraph goes red instead of quietly going stale.

## Verify it

```bash
npm run ui:typecheck                       # tsc over the shell, the views and the shim
npm run ui:build:engine && npm run smoke   # the render + offline audit, on the built bundle
npm run scan:engine                        # what the bytes contain, both directions
cd ../.. && CI=true npx vitest run apps/desktop/test   # the config assertions
cd apps/desktop/src-tauri && cargo test    # the signature + downgrade proofs
```

`test/desktop-shell.test.ts` is the drift guard: it asserts the identifier, the
one bare version across five files, the CSP directive by directive, the main
window's empty capability FILE and the updater window's single listen-only grant,
the nineteen-command census (declared in `build.rs`, defined, registered, and
granted — the three places a half-added command is missing from), the absent
`compression` feature, the pinned update feed, a valid updater pubkey (with a
negative control for the packaging gate), the fixtures-adapter alias, the
default-mail identities against the installers that register them, and that
`index.html`'s CSP still matches the webview's. Those files are read by
nothing else in the repository, so without it an edit to any of them would keep
every other test green. The Rust-side signature and downgrade proofs run under
`cargo test` (`src-tauri/src/updater_tests.rs`).

`scripts/smoke.mjs` is mutation-tested by hand: deleting the
`installOfflineGuard()` call fails the offline audit's checks, and replacing the
mount with an empty `<div>` fails the render section. Both were watched failing
rather than carried over, and the audit runs on the bundle the installers carry.

## Layout

```
apps/desktop/
├── index.html            document CSP, favicon, #root (the window)
├── host.html             the served host client's own document
├── vite.config.ts        the aliases, base "./", modulePreload off, the two artifacts
├── src/
│   ├── main.tsx          providers + theme stamp + mount the gate
│   ├── DesktopGate.tsx   chooser / notice / the mail client, from the shell's answer
│   ├── mailto.ts         the one mailto parser (RFC 6068, read defensively)
│   ├── DesktopDefaultMail.tsx  the ask-once card + the Settings → General row
│   ├── offline-guard.ts  fetch/XHR/WebSocket/EventSource/sendBeacon → throw
│   ├── bridge-fetch.ts   the local engine's transport
│   ├── no-fixtures-adapter.ts  the sample world, absent
│   └── host-client/      the served bundle's entry, bearer manager, pair landing
├── scripts/smoke.mjs     the render + offline audit over dist/
├── scripts/scan-artifact.mjs  what the emitted bytes contain, both directions
├── test/                 the config drift guard (runs in the monorepo suite)
└── src-tauri/
    ├── Cargo.toml        tauri (defaults minus compression) + the plugins
    ├── tauri.conf.json   window, CSP, bundle targets, icons, updater feed + pubkey
    ├── tauri.engine.conf.json  resources, schemes, Windows bootstrapper + hooks
    ├── windows/hooks.nsh the mail-client capability registration (never the choice)
    ├── build.rs          command manifest + the missing-pubkey packaging gate
    ├── capabilities/     main.json (no permissions) + updater.json (listen only)
    ├── icons/            the "oh." family (.ico, .icns, .png ladder)
    └── src/
        ├── main.rs           the window, the engine's lifetime, the updater hook-up
        ├── engine.rs         the engine's lifecycle, the bridge, the commands
        ├── default_mail.rs   the OS's default-mail read + request, per platform
        ├── host.rs           host mode: tray, tailscale serve, autostart
        ├── config.rs         the settings files (never a secret)
        ├── menu.rs           the one menu bar
        ├── updater.rs        the menu item, the feed check, notify-and-install
        └── *_tests.rs        each module's proofs (cargo test)
```

## What is not here yet

Signed *installers* still need a certificate (Authenticode for Windows) that does
not exist yet; until then the installers are unsigned — which is exactly why the
update payloads are minisign-verified independently of any OS code-signing
certificate. The README says so on every platform.
