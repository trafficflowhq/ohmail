# ohmail for macOS, Windows and Linux

The **Tauri v2 shell**, and the only desktop client there is — a native Rust
window, a locked-down webview, and a static bundle of the *same* client the web
app renders. There is no desktop fork of the interface.

**Two artifacts come out of this one directory, and the difference is the whole
of the reading below.**

- **The interface preview.** The shell over a fictional mailbox that ships inside
  it, with no engine, the sync client aliased to a stub and the webview granted
  nothing. This is the artifact "it opens no connection" is asserted against, and
  every lock in the next section is literally true of it.
- **The engine-bearing app**, which is what the releases ship on all three
  platforms. It carries the mail engine and its own Node runtime as resources,
  speaks IMAP to your own server, and grants the window a small, named set of
  commands over a bridge — the engine, one notification, the badge, and a fixed
  table of pages it may hand to your browser. The webview still reaches the
  network through nothing of its own.

Set the halves together or they disagree; `npm run app:build:engine` is the one
command that selects all three (the Cargo feature, the UI flag and the resource
config) and is what CI runs.

```bash
npm install                 # in apps/desktop (pnpm install at the monorepo root works too)
npm run ui:build            # → dist/  (the bundle Tauri embeds)
npm run smoke               # → SMOKE OK (33 checks)
npx tauri build --debug     # → src-tauri/target/debug/bundle/…
```

`tauri build` needs `dist/` to already exist — there is no `beforeBuildCommand`
on purpose, so a broken interface fails in its own step instead of inside a Rust
build log. CI does the same, in the same order.

---

## How the UI gets in: the decision

**There is no desktop fork of the interface.** `src/main.tsx` imports
`apps/webapp/app/shell/AppShell` — the same file app.ohmail.app renders — and Vite
compiles it, `@ohmail/ui`, `@ohmail/tokens`, `@ohmail/fixtures` and
`@ohmail/client-engine` into one self-contained folder. Three lines of that file
are the whole desktop-specific layer: the providers Next would otherwise supply,
the pre-paint theme stamp, and the offline guard.

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
2. **`…/adapters/http-adapter.js` → `src/no-http-adapter.ts`.** See below.
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

**1 · The sync client is not in the PREVIEW's module graph.**
`@ohmail/client-engine`'s barrel re-exports `HttpAdapter`, the `/sync` protocol
client. In the preview build Vite aliases that module to
[`src/no-http-adapter.ts`](src/no-http-adapter.ts), whose constructor throws, and
in that bundle `x-csrf-token`, `idempotency-key`, `X-Sync-Seq` and `/sync?` all
return **zero** matches.

That count holds because of seam 3 as much as seam 2. The Cloud client is a stub
whose `apiConfigured()` is `false` at compile time, so every caller's
`if (!apiConfigured())` guard folds and the request paths behind them — the
draft-reply POST and its `Idempotency-Key` among them — are removed as dead code
rather than merely never run.

**In the engine-bearing build the real adapter is there, deliberately**, and it
is what the window speaks to its own engine over: `src/bridge-fetch.ts` hands it
a transport that goes to the local process rather than to a socket. That is why
`packages/client-engine/src/adapters/http-adapter.ts` is published in this
repository whole — the shipped binary conveys it, so it has to be offerable.
Publishing a throwing stub at its path instead is exactly what once blanked every
engine build's window the moment a mailbox was ready, and the alias above is now
scoped to the artifact whose claim it belongs to.

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

**4 · The PREVIEW's Windows installers do not fetch the WebView2 runtime, and the
RELEASED ones deliberately do.** This is the one lock where the two artifacts were
argued to opposite answers, so read the reversal before the reasoning below it.

`tauri.conf.json` — the preview — sets `webviewInstallMode` to `{ "type": "skip" }`,
and everything from here to the end of this section is about that artifact.
`tauri.engine.conf.json`, which is the config the released installers are built
with, sets `downloadBootstrapper` instead, and CI's Windows job asserts the
bootstrapper **is** present in the shipped `-setup.exe`. The argument for the
reversal is short: an interface preview whose window cannot render is a demo that
did not run, and a mail client whose window cannot render is not degraded, it is
broken. The zero-network promise belongs to the artifact that makes it.

`bundle.windows.webviewInstallMode` is `{ "type": "skip" }` there. Tauri's default is
`downloadBootstrapper`, which compiles a WiX custom action into the `.msi` —
`DownloadAndInvokeBootstrapper`, a hidden `powershell.exe` running
`Invoke-WebRequest` against `go.microsoft.com/fwlink/p/?LinkId=2124703` whenever
`INSTALLED_WEBVIEW2_VERSION` is empty — and the equivalent NSISdl step into the
`-setup.exe`. Standard, and Microsoft, but still an outbound connection made by a
product whose claim is *cannot*, not *does not*. `skip` removes both.

The cost is real and it is stated on the download page: **the installers do not
provide WebView2.** Windows 11 and any Windows 10 that has taken updates since
2021 already have the Evergreen runtime, because Edge installs it. On a machine
that does not, the app will not start, and Tauri's own dialog says so with a link
to Microsoft's installer page — that link, and only that link, is why
`developer.microsoft.com` appears in the Windows binary's string table. Install
it once, from Microsoft, deliberately:
<https://developer.microsoft.com/microsoft-edge/webview2/>

`skip` drops Tauri's whole `install_webview` section, not just the download step,
so the shipped `.msi` has no `INSTALLED_WEBVIEW2_VERSION` property and no
registry probe either — it does not even look. CI asserts that rather than
trusting the config: six greps over the built `.msi`
(`DownloadAndInvokeBootstrapper`, `fwlink`, `go.microsoft.com`,
`MicrosoftEdgeWebview2Setup`, `Invoke-WebRequest`, `INSTALLED_WEBVIEW2_VERSION`),
then `7z` over the `-setup.exe` to check that `NSISdl.dll` is not in
`$PLUGINSDIR` and that no embedded WebView2 installer was `File`d into the
payload. All eight were run against the last pre-fix installers and all eight
fired. `desktop-shell.test.ts` asserts the config key itself, so a future edit
that restores the default is red in the monorepo suite too.

## Capabilities: none for the window you use

`capabilities/` holds two files, and every build carries both.

```json
{ "identifier": "main", "windows": ["main"], "permissions": [] }
```

The main window's permission list is **empty**. Not `core:default`, not a trimmed
subset — empty. The frontend calls no `invoke`, `withGlobalTauri` is `false`, so
the webview has no Tauri API to reach for and would be refused if it tried. On the
Rust side there is no `invoke_handler`, no `std::net` and no socket of any kind.

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

The one file this binary can open is behind a compile-time feature that is
**off** in every published build: `src/engine.rs` — the shell's ownership of a
local mail engine's lifetime — writes that engine's diagnostics to a log file,
because a double-clicked app has no readable stderr. It is compiled by
`cargo build --features local-engine` and by nothing else, so in the binary you
downloaded that module, its keystore access, its two commands and its log are
not present at all rather than merely unused. There *are* two plugins —
`tauri-plugin-updater` and
`tauri-plugin-dialog`, both for the auto-updater — but they are registered
Rust-side and no capability grants the webview access to either, so the page
still cannot call them. `assetProtocol` is disabled, `freezePrototype` is on, and
`dangerousDisableAssetCspModification` is off.

`src-tauri/Cargo.toml` takes Tauri's default features **minus `compression`**,
plus those two plugins and nothing more. Dropping brotli costs about a quarter of
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

## Identifiers, names and version

**`io.ohmail.desktop`** — the same identifier the SwiftUI client carries in
`Resources/Info.plist`, deliberately. They are one product with one install, and
the identifier is not only a name: it is where the app's data directory goes and
it is what an update is allowed to replace. This configuration carried a
`.tauri` suffix for a while so that both builds could sit on one Mac during local
verification; the cost was a second data directory for the same mailbox and an
update path that could never hand over between them, which is a permanent fork in
every path the app touches in exchange for a convenience while testing.

The version is **`0.9.4`**, bare, in every place it is written: `tauri.conf.json`,
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
`CFBundleShortVersionString` is `0.9.4` and is what the app and every download
page show. The floor is asserted in `release-feeds.yml`, so a plist that loses
the key fails the release instead of stranding the installs it protects.

**The bundle's own description is per-artifact, and has to be.** `tauri.conf.json`
still says "interface preview", because that file alone is what `npx tauri build`
produces and that build genuinely has no engine in it. The engine-bearing artifact
overrides `shortDescription` and `longDescription` in
`src-tauri/tauri.engine.conf.json`, where they describe an app that connects to a
mailbox. One sentence stretched to cover two different programs would be false of
one of them, and the installers show it to people.

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
npm run ui:build && npm run smoke          # the render + offline audit, on the built bundle
cd ../.. && CI=true npx vitest run apps/desktop/test   # the config assertions
cd apps/desktop/src-tauri && cargo test    # the signature + downgrade proofs
```

`test/desktop-shell.test.ts` is the drift guard: it asserts the identifier, the
one bare version across five files, the CSP directive by directive, the main
window's empty capability list and the updater window's single listen-only grant,
the absent `invoke_handler`, the absent `compression` feature,
the exact two-plugin allow-list, the pinned update feed, a valid updater pubkey
(with a negative control for the packaging gate), the http-adapter alias, and
that `index.html`'s CSP still matches the webview's. Those files are read by
nothing else in the repository, so without it an edit to any of them would keep
every other test green. The Rust-side signature and downgrade proofs run under
`cargo test` (`src-tauri/src/updater_tests.rs`).

`scripts/smoke.mjs` is mutation-tested by hand the way the Swift harness is:
deleting the `installOfflineGuard()` call fails 5 of its 33 checks, and replacing
`<AppShell/>` with an empty `<div>` fails 19. Both were watched failing at this
release rather than carried over.

## Layout

```
apps/desktop/
├── index.html            document CSP, favicon, #root
├── vite.config.ts        the aliases, base "./", modulePreload off, the two artifacts
├── src/
│   ├── main.tsx          providers + theme stamp + mount AppShell
│   ├── offline-guard.ts  fetch/XHR/WebSocket/EventSource/sendBeacon → throw
│   ├── bridge-fetch.ts   the local engine's transport (local-engine builds only)
│   ├── build-flags.d.ts  the one flag that picks which artifact this is
│   └── no-http-adapter.ts the Cloud sync client, absent
├── scripts/smoke.mjs     the render + offline audit over dist/
├── test/                 the config drift guard (runs in the monorepo suite)
└── src-tauri/
    ├── Cargo.toml        tauri (defaults minus compression) + updater + dialog
    ├── tauri.conf.json   window, CSP, bundle targets, icons, updater feed + pubkey
    ├── build.rs          command manifest + the missing-pubkey packaging gate
    ├── capabilities/     main.json (no permissions) + updater.json (listen only)
    ├── icons/            the "oh." family (.ico, .icns, .png ladder)
    └── src/
        ├── main.rs           the window, and the updater hook-up
        ├── engine.rs         the local engine's lifetime, bridge and log (feature-gated)
        ├── engine_tests.rs   the lifecycle and the bridge, against real processes
        ├── updater.rs        the menu item, the feed check, notify-and-install
        └── updater_tests.rs  tampered-payload and downgrade proofs (cargo test)
```

## What is not here yet

The engine. This Tauri build has no IMAP client, no accounts and no AI: it renders
the interface on Mila's fixture world. The auto-updater is now in (see above); what
is still absent is the mail engine, which shipped in the macOS build first and is
being ported to this shell next — it lands behind `AppState`/`OhmailEngine`, the
seam both platforms share. Signed *installers* still need a certificate
(Authenticode for Windows) that does not exist yet; until then the installers are
unsigned — which is exactly why the update payloads are minisign-verified
independently of any OS code-signing certificate. The README says so on every
platform.
