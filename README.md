<div align="center">

<img src="docs/ohmail-icon.png" width="88" height="88" alt="ohmail">

# ohmail for the desktop

**Consent-first email, on the mailboxes you already have.**

One app, on macOS, Windows and Linux.
Free, GPL-3.0, no account, no subscription — this repository is the whole thing.

[![build](https://github.com/trafficflowhq/ohmail/actions/workflows/build.yml/badge.svg)](https://github.com/trafficflowhq/ohmail/actions/workflows/build.yml)
[![latest release](https://img.shields.io/badge/download-v0.9.5-a3461c)](https://github.com/trafficflowhq/ohmail/releases/tag/v0.9.5)
[![licence: GPL-3.0](https://img.shields.io/badge/licence-GPL--3.0-a3461c)](LICENSE)
[![macOS 15+](https://img.shields.io/badge/macOS-15%2B-111111)](#macos)
[![Windows 10+](https://img.shields.io/badge/Windows-10%2B-111111)](#windows)
[![Linux](https://img.shields.io/badge/Linux-AppImage%20%C2%B7%20deb-111111)](#linux)
[![ohmail.app](https://img.shields.io/badge/ohmail.app-website-666666)](https://ohmail.app)

</div>

---

## What this repository is

**ohmail is email that asks your permission before it takes your attention.** A
first-time sender waits in the Screener until you say where they belong; after
that the Ohbox holds only people you said yes to, newsletters skim past in Reads,
and receipts file themselves. It runs on the mailbox you already have — any IMAP
provider — and organises it **in place**, in real folders on your real server, so
leaving costs you nothing.

**This repository is the free ohmail desktop app** — macOS, Windows and Linux,
all of it, all of its source, under GPL-3.0. **Every build now carries the local
mail engine and connects to a real mailbox.** There is no paid edition of the
desktop app, no feature held back for one, and no telemetry reporting back on
you.

**ohmail Cloud is the optional hosted half, and it is what pays for this one.**
Your phone cannot hold a connection to your mailbox open all day; something has
to stay awake to notice new mail, run it past the Screener and file it. Cloud is
that work done on a machine that never sleeps, plus the web and mobile apps and
push. It is a commercial service with a codebase of its own, built by the same
people, and the desktop app neither asks for it nor needs it.
[Desktop or Cloud](#desktop-or-cloud) is the full comparison, prices included.

## The current release — v0.9.5

**[Download it here.](https://github.com/trafficflowhq/ohmail/releases/tag/v0.9.5)**
`ohmail.dmg` for macOS, an NSIS `-setup.exe` for Windows, an `.AppImage` and a
`.deb` for Linux. Every file was built by GitHub Actions from the tree this tag
points at, and the run that made them prints the SHA-256 of each one. Nothing is
signed on any platform — see the per-platform install notes under
[Download a build](#download-a-build) before you double-click anything.

**Every platform is now a working mail client.** The app carries the local mail
engine: it connects to your own IMAP mail server over TLS, mirrors your mailbox to
a database on your computer, and organises new mail into `ohmail/` folders on the
server itself — a Screener for first-time senders, Reads, Receipts, and the rest —
so the filing is visible in every other mail app you own. It asks for your server
and password on first launch; the password is sealed under a per-install key kept
in your computer's keystore (Keychain on macOS, Credential Manager on Windows, the
Secret Service on Linux) **and mirrored to a file beside the app's data that only
your user account can read**. The mirror is not belt-and-braces: an app without a
developer certificate is refused its own keystore item after every update, and
without a copy it can still read, your stored password would be lost each time.
Where that happens the key lives in the file rather than behind your login
password — a real reduction, stated here rather than buried, and it sits beside a
local mail mirror that is an ordinary unencrypted database. In this **local mode** nothing leaves your
computer but the IMAP connection to your provider, the signed update check, and —
only if you turn it on — your own AI key or a local Ollama: no telemetry, no
analytics. You can instead sign in to **ohmail Cloud** (the optional hosted
service) and use the app as a viewer of a mailbox Cloud already organises; that
mode connects to ohmail.app, and your session is held in memory only.

**The app carries its own Node runtime.** The mail engine is a Node program, and
the download contains the official Node build for your platform — verified against
nodejs.org's own published checksums by the run that made your installer — so
there is nothing to install first and nothing on your `PATH` for the app to
depend on.

**What is new since v0.7.3.** This is the largest release since every platform
became a working mail client.

- **Sign in from your browser.** A hosted account can be reached without typing a
  password into the app: the website hands you a short code, good once, for two
  minutes, and the app takes that instead. The password form still works.
- **Your first minutes on a new mailbox make sense.** A cold start paints your
  newest mail first and the sidebar says what the import is doing while it runs.
  Settings, Mailboxes lists the mailbox you are actually connected to, and a
  filing that has not reached your mail server yet says so instead of looking done.
- **Tags made in the browser reach the desktop app.**
- **Reading.** A plain letter is drawn as text in the app's own typography rather
  than in the sender's; a conversation opens on its latest message and fetches the
  whole thread in one request; a message that has not arrived yet says so instead
  of showing its first two hundred characters as though they were the mail.
- **Pictures load when you open a message,** through the app's own proxy rather
  than from the page, so none of your browser's identifying headers reach the
  sender. On a standalone install the fetch still comes from your own connection;
  on a hosted account it is made on the server. There is a switch to turn
  automatic loading off, and a tracking pixel is never requested in either mode.
- **Attachments open on a press** and save from the icon in the corner; Download
  all gives you the files rather than a zip.
- **Drafts are saved to your account,** two seconds after you stop typing, with a
  Drafts list beside Compose.
- **The Screener can be worked from the list itself** — filter chips over the
  waiting queue, one press to file a sender from its row, a real progress track on
  both staged operations, and what is left of your AI budget on the summary.
- **A bounce of your own mail reaches you** when the app can corroborate it against
  something you sent; forged reports still wait at the gate.
- **Answer Later, Parked and Resurface are readable lists,** not tiles.
- **History stays quick** on a mailbox of any size, and there is a full menu bar
  with the keyboard shortcuts a desktop mail client is expected to have.

See the [changelog](CHANGELOG.md) for the rest.

**Updating from v0.7.2 or earlier asks for your mailbox password once.** From
v0.7.3 the per-install key that seals it is kept in a file beside the app's data as
well as in the keystore, so it now survives an update; a key written by an older
version cannot be read back. From v0.7.3 this update asks for nothing.

**If you are on macOS and already have ohmail installed**, the update is a
handover: the app you have is a different program — a native client that shared
this one's identity — and it will offer you this release through the same update
prompt it always has. Your mailbox, your settings and your stored password are
untouched; they live in the same place and the new app reads them.

v0.1.0-preview shipped under the earlier name `mailoh` and its files are still
named that way; they were not relabelled, because renaming a released file
invalidates every checksum published against it. [CHANGELOG.md](CHANGELOG.md) has
the full list.

## Status — read this first

**All three platforms are a working mail client.** The app connects to your IMAP
mailbox and organises it in place. It is unsigned on every platform, which is the
thing to read the install notes about.

| | What it does |
|---|---|
| **Connects to your mailbox** | ✅ Yes, on macOS, Windows and Linux. The bundled engine speaks IMAP over TLS, mirrors your mailbox to a local store, and files new mail into `ohmail/` folders on your server. |
| **What it talks to** | Local mode: your IMAP server, the signed update feed, and — only if you turn it on — your own Anthropic key or a local Ollama. Cloud mode: ohmail.app, the hosted service you sign into, as a viewer. No telemetry, no analytics. |
| **Credentials** | Your mail password, sealed under a per-install key and never written in the clear. The key is kept in your computer's keystore and mirrored to a file only your user account can read, because an unsigned app is refused its own keystore item after every update. |
| **Runs, and is worth looking at** | Every surface is real: Ohbox, Screener, Reads, Receipts, triage piles, tags, search, compose, settings — light and dark, down to a 390 pt window, keyboard-first. |
| **Tested** | The interface model, the rules and design tokens, and the engine's sync, lease and organise logic are covered by the test suite; every platform's packaging job opens the artifact it just built and starts the engine inside it; and the release engine was verified connecting to and organising a real IMAP mailbox. |
| 🔜 Next | Signed builds — a real Apple Developer ID and an Authenticode certificate. Today's are unsigned, so first launch needs the approval described in the install notes. The app already updates itself over a signed feed on all three platforms. |

If you came here from [ohmail.app](https://ohmail.app): the build for your platform
reads and organises your mail today. Questions to support@ohmail.app.

## What ohmail is

Email that asks your permission before it takes your attention, built **on your
existing mailboxes** — any IMAP provider — and organising them **in place**, in
real folders on the real server. Leave whenever you like; your mailbox stays
organised.

- **Screener** — nobody reaches you twice by default. First contact waits, with
  every held message shown in full, and you send the sender somewhere: Ohbox,
  Reads, Receipts, screened out, spam. The choice becomes a rule.
- **Ohbox** — the inbox, after the Screener has done its work. Only mail from
  people you said yes to.
- **Reads** — newsletters in a skim stream with a seen-waterline, so a week away
  costs you nothing.
- **Receipts** — orders, confirmations, tickets. Filed, not read.
- **Triage piles** — Answer Later, Parked, and **Resurface** for mail that
  should come back at a chosen time.
- **Tags, never folders** — cross-cutting, and applied on top of the one place a
  message actually lives.
- **Organise in place** — every decision lands as a real folder on your real
  server, readable by every other mail app you own. There is no export step,
  because there is nothing to export.
- **Spy pixels blocked** — the tracking pixels that tell a sender when you opened
  their mail, and where, do not load.
- **AI proposes, you decide.** Suggestions are preselected, never applied.
  Nothing sends itself. One-time codes and login links are structurally excluded
  from anything AI touches — in this codebase a protected message has *no body
  field to leak*.

### What your mailbox looks like

ohmail files mail by moving it between a small, fixed set of real IMAP folders in
your own account — nothing lives in a database only ohmail can read. Open any
other mail app and this is what you find:

```
Inbox                    mail from people you've said yes to
Junk                     your provider's own — ohmail never reads or writes it
Sent                     your replies, left where your provider already keeps them
ohmail/
├── Screener             new senders wait here until you decide where they go
├── Reads                newsletters and things you read when you have a minute
├── Receipts             receipts, confirmations, orders
├── Screened             senders you keep, but out of the Inbox
├── Quarantine           junk-grade mail, set aside
└── _meta                a tiny bookkeeping folder, hidden in your other mail apps
```

Those are the only folders ohmail creates, and the set is deliberately frozen:
your Inbox, and five folders under `ohmail/`. Your provider's own Junk folder is
never touched, and your Sent folder is read but never moved. There is no folder
called "Spam" — the pile ohmail sets junk-grade mail aside in is
`ohmail/Quarantine`; "Spam" is only ever a friendly label the app shows over it.

Because every decision lands as a real folder on your real server, leaving costs
you nothing: cancel, sign out, or just open a different mail app, and your mail is
already filed exactly where you left it.

## Screenshots

Rendered from this source tree, unretouched.

**Ohbox** — a thread, its rule provenance, the blocked tracking pixel, the tags.

<img src="docs/ohbox-light.png" alt="ohmail Ohbox, light" width="100%">

**Screener** — a first-time sender who is a person rather than a list: two held
messages, both shown in full, one suggested destination, five to choose from, and
the keys that pick them. (In this preview the suggestion is a fixture, not a live
model — see [Status](#status--read-this-first).)

<img src="docs/screener-light.png" alt="ohmail Screener, light" width="100%">

<details>
<summary><strong>Dark mode</strong> (same two surfaces)</summary>

<img src="docs/ohbox-dark.png" alt="ohmail Ohbox, dark" width="100%">
<img src="docs/screener-dark.png" alt="ohmail Screener, dark" width="100%">

</details>

All of it is fictional mail from a fictional persona. No real people, no real
brands, no scraped inboxes.

## Download a build

**[Releases](https://github.com/trafficflowhq/ohmail/releases) is the place to
start** — the installers are attached there, they need no GitHub account, and
each release names the run that built it. (Every release so far is marked a
pre-release, which is accurate and which is why `/releases/latest` does not
resolve to one: GitHub reserves that address for stable releases, and there has
not been one yet.)

Every push to `main` also builds all three platforms and attaches the installers
to that run: [latest builds →](https://github.com/trafficflowhq/ohmail/actions/workflows/build.yml).
That is how to get a build newer than the last release. The artifact list is at
the bottom of a run page and GitHub requires you to be signed in to download from
there. **Each run's summary prints the SHA-256 of every artifact it produced**,
plus the toolchain and the runner, so you can check what you downloaded against
what the run made.

| Platform | Artifacts | Runner |
|---|---|---|
| **macOS** | `ohmail.dmg` (universal, arm64 + x86_64), `ohmail.app.tar.gz` (the update payload) | `macos-15` |
| **Windows** | `ohmail-windows-setup.exe` (NSIS) | `windows-latest` |
| **Linux** | `ohmail-linux-x86_64.AppImage`, `ohmail-linux-amd64.deb` | `ubuntu-latest` |

Every one is engine-bearing and carries its own Node runtime. The names are
stable across releases on purpose, so the download links on the site keep
working; the version is in the release, not in the filename.

**Nothing here is signed**, on any platform. Code-signing certificates cost money
ohmail has not spent yet. We would rather say that plainly than have you discover
it from a scary dialog. On all three platforms, building from source is the
option that requires trusting nobody.

### macOS

> [!IMPORTANT]
> **The DMG is unsigned and un-notarized.** It carries an ad-hoc signature only,
> not an Apple Developer ID. On first launch macOS Gatekeeper will refuse a
> double-click and may claim the app "is damaged". It is not.
> **Right-click (or Control-click) ohmail.app → Open → Open.** The same note is
> in the DMG as *Read me first.txt*. Signed and notarized builds land with the
> developer account.

Requires macOS 15 (Sequoia) or newer.

### Windows

> [!IMPORTANT]
> **No Authenticode signature.** SmartScreen will show "Windows protected your
> PC" on first run. **More info → Run anyway.** The NSIS installer installs
> per-user, so it needs no administrator; the `.msi` is there for anyone who
> deploys that way.

> [!IMPORTANT]
> **About WebView2.** ohmail draws its window in Microsoft's WebView2 runtime.
> If it is already installed — Windows 11 has it, and so does any Windows 10 kept
> current, because Edge installs it — **the installer makes no network
> connection.** If it is missing, the installer downloads the runtime from
> Microsoft and installs it; the app cannot render without it.
>
> Earlier, preview-only builds shipped with that downloader deliberately removed
> (`webviewInstallMode: skip`), because a build that drew nothing but fixtures had
> no business carrying an installer that could open a connection. A mail client is
> a different thing: with the downloader removed, a machine without WebView2 gets
> an installer that completes and an app that will not start. If you would rather
> install the runtime yourself first, it is here:
> <https://developer.microsoft.com/microsoft-edge/webview2/>

Requires Windows 10 or newer.

### Linux

> [!IMPORTANT]
> **The AppImage needs the executable bit**, which GitHub's artifact zip does not
> preserve:
> ```bash
> chmod +x ohmail-linux-x86_64.AppImage && ./ohmail-linux-x86_64.AppImage
> ```
> If it exits immediately on a distribution that has not enabled unprivileged
> user namespaces, run it with `--appimage-extract-and-run`.

The `.deb` installs with `sudo apt install ./ohmail-linux-amd64.deb` and pulls in
WebKitGTK. It is **not** in any repository, and a `.deb` install cannot replace
itself in place, so it does not auto-update — the AppImage is the Linux build that
applies its own updates, from the same signed feed the app checks.

To uninstall it: `sudo apt remove ohmail`. The Debian package name, the binary at
`/usr/bin/ohmail`, the icon and the launcher entry are all the same word.

### Verify it yourself

On Windows and Linux the interface is embedded **uncompressed** on purpose, so
you can check what a downloaded binary does without running it:

```bash
strings -a ohmail.exe | grep -oE 'https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+' | sort -u
strings -a ohmail.exe | grep -c Ohbox      # the interface really is in there
```

Almost everything the first command prints is one of four things: an XML
namespace constant React compares against, a documentation link inside a panic or
error message, Microsoft's own WebView2 download page (see the Windows note
above), or an artifact of grepping a Rust binary, where `"http://"` is a string
literal that sits in read-only data with no terminator between it and whatever
was placed next to it. `apps/desktop/README.md` goes through them one by one,
with the full surrounding line for the ones that are not URLs at all.

The rest — every string that names ohmail or TrafficFlow — is a short list CI
spells out entry by entry and **fails the run** on anything outside it:

- the pinned update feed, `…/releases/latest/download/latest.json`;
- `https://api.ohmail.app`, the hosted service, which the app contacts only after
  you have signed in to it;
- four `ohmail.app` pages the app may hand to **your own browser** — your account
  settings, the page that hands the app a sign-in code, the privacy notice and the
  subprocessor list. The window picks one of them by name and cannot express an
  address at all, so nothing that gets a string into a page can send your browser
  somewhere else.

CI runs exactly these greps on every build and prints the complete list in the job
log, so you can compare a download against what the run saw. Your own mail server
never appears in this list and cannot: it is not compiled in, it is whatever you
typed, held in your own configuration file.

## Build it yourself

**Requirements:** [Rust](https://rustup.rs) (stable) and Node 22. On macOS also
the Xcode command line tools. On Linux also the Tauri prerequisites — on Ubuntu
24.04:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev \
  libssl-dev build-essential curl wget file patchelf desktop-file-utils
```

On Windows, the MSVC build tools and WebView2.

### The interface, on its own

The quickest thing to build, and the one that needs nothing but the repository:
the app around a small fictional mailbox that ships inside it, with no engine and
no network at all.

```bash
cd apps/desktop
npm install
npm run ui:build      # → dist/, the bundle the app embeds
npm run smoke         # → SMOKE OK (33 checks) — renders, and proves it is offline
npx tauri build       # → src-tauri/target/release/bundle/…
```

### The real thing, with the mail engine in it

Three more steps, because the shipped app carries two things the repository does
not: the engine built as one file, and a Node runtime to run it with.

```bash
# The engine, bundled with the pinned esbuild — installed off to one side rather
# than added to the project, so nothing here depends on a bundler.
D=$(mktemp -d) && (cd $D && npm install --no-save esbuild@0.24.0)
OHMAIL_ESBUILD_FROM=$D node scripts/engine-bundle.mjs

# It boots from the layout it ships in — and refuses to when its migration
# journal is moved away, which is what makes the first half worth anything.
node scripts/verify-engine-boot.mjs

# The official Node build for this platform, checked against nodejs.org's own
# SHASUMS256.txt before it is unpacked. A mismatch is a refusal, not a warning.
node scripts/vendor-node.mjs

# And the app. One command sets all three things that have to agree: the UI
# bundle with the bridge in it, the Rust feature that owns the engine's
# lifetime, and the bundler config that puts the engine and the runtime inside
# the package.
cd apps/desktop && npm run app:build:engine
```

The result carries the engine at `engine/bin/ohmail-engine.mjs` and the runtime
at `runtime/node`, both under the app's own resource directory —
`Contents/Resources/` inside the macOS bundle, `/usr/lib/ohmail/` from the Linux
package, beside the executable on Windows. You can check the engine is the one
this source produces: the build prints its SHA-256, and so does every CI run.

`apps/desktop/README.md` is the long version: why the UI is bundled with Vite
rather than exported from Next, what each of the three aliases does, and the
complete capability and CSP set.

### What the window itself can reach

**The page reaches nothing directly, in either build.** The webview's
Content-Security-Policy is `connect-src 'none'`, so `fetch`, XHR, WebSocket and
EventSource are refused before they are attempted, and the page then replaces
those APIs with functions that throw. The Cloud sync client is aliased out of the
bundle at build time — it is not compiled in, and its source is not in this
repository at all.

**In the interface-only build that is the whole story**, and it is a property of
the artifact rather than of a branch: the main window's Tauri capability list is
literally empty (`"permissions": []`), so the page can call no Tauri command,
touch no file and spawn no process. The one other grant in the tree belongs to a
different window — the transient one shown while an update downloads, which is
allowed to listen for a local progress event (`core:event:allow-listen`) and
nothing else: no emit back, no command, no file, and the same `connect-src
'none'`. That build is what you get from `npm run ui:build` + `npx tauri build`,
and it is what the render check in CI runs against.

**In the build you download, the window can call six commands and nothing else.**
They are the bridge to the mail engine, a notification, and the icon's badge. Mail
does not travel over the network from the page — it travels down a pipe to a
process on the same machine, which is what makes the CSP above compatible with an
app that reads your mail at all. The engine holds the IMAP connection; the page
holds no credential, because the shell adds the engine's session token on its own
side of that pipe.

The one thing the *process* reaches on its own is the update feed, and it does so
shortly after launch and whenever you ask — one pinned HTTPS address, with every
payload cryptographically verified before it may install. There is no repeating
timer: one check per run, plus the ones you ask for.

## Desktop or Cloud

ohmail comes in two halves, and **this repository is the whole of the first
one**. Here is the honest comparison, including the parts where Desktop wins.

The Desktop column describes what the local engine makes possible, and that engine
now ships on all three platforms — so these rows are real wherever you run it.

|  | **Desktop** — this repository | **Cloud** — optional |
|---|---|---|
| **Price** | **Free, forever.** Not a trial, not a freemium tier. | $9 / $15 / $29 per month |
| **Mailboxes** | As many as you like | 5 / 10 / 50 |
| **Where your mail is processed** | **Your machine. Only.** It never touches our servers — there is no server to touch. | EU-hosted: a full copy of your mail, encrypted at rest, **not** end-to-end — solely to serve you, deletable |
| **Account** | **None.** Nothing to sign up for, nothing to cancel. | Yes |
| **AI** | Bring your own Anthropic key, or run a local model such as [Ollama](https://ollama.com) so nothing leaves your machine at all. Off unless you turn it on. | A monthly allowance of managed AI actions (~2k / 6k / 20k). 🔜 No live model is connected in production yet either; the metering that governs it is. |
| **Web and mobile apps** | — | Yes |
| **Push notifications** | — | Yes |
| **Works while your laptop is shut** | — | Yes — mail is screened and filed as it arrives |
| **Open source** | **GPL-3.0. All of it, right here.** | No |

### Why a Cloud exists at all

Not to unlock features. Your phone cannot hold a connection to your mailbox open
all day — the battery and the operating system will not allow it. Something has
to stay awake to notice new mail, run it past the Screener and file it. On
Desktop that something is your computer, while it is on. Cloud is that same work,
done on a machine that does not sleep.

**The Screener, the Ohbox, the tags and the organise-in-place model are identical
on both — the privacy posture deliberately is not.** That is the axis of the whole
table above: Desktop is designed so your mail never leaves your machine, while
Cloud necessarily holds a copy of it to deliver push, mobile and search. Both are
honest positions; they are not the same position, and picking between them is the
point.

Desktop is not *planned* as a demo of Cloud — it is a complete product on its own,
and as of this release that is true on all three platforms: every build carries the
mail engine and connects to your own mailbox.

### If you do want Cloud

- **14 days free, no card.** The trial runs **rules-only** — the whole product
  except the managed AI actions, which begin when a subscription does.
- **Run out of AI actions and mail keeps flowing, rules-only,** until the next
  cycle. There are no overage charges, ever. We would rather degrade than
  surprise you with a bill.
- **Leave whenever.** Your mail was organised in place, in real folders on your
  own server, the entire time. There is no export, because there is nothing to
  export — cancel and your mailbox stays exactly as organised as it was.

Details and sign-up: **[ohmail.app](https://ohmail.app)**. And if the answer is
"the free desktop app is fine, thanks" — genuinely, that is a good outcome. It is
why we built it this way.

## How it is put together

One app, three platforms. A Rust window around the React implementation of the
design system, with a Node mail engine beside it that the window talks to over a
private pipe — no port, no socket, no listener; the only party that can reach the
engine is the process holding the pipe.

macOS used to be a second, native client written in Swift, and this section used
to describe both. That client is retired: two renderings of one specification is
twice the surface for the same product, and every screen it drew now comes from
the same React sources the other two platforms already used.

### The app — `apps/desktop`

| Piece | What is in it |
|---|---|
| `src-tauri/src/main.rs` | opens the window, installs the menu bar, hooks up the updater, and — in the engine-bearing build — owns the engine's lifetime |
| `src-tauri/src/engine.rs` | the engine's whole life: find a Node runtime, spawn it with the engine, read its frames, and make certain it is gone when the app is. Compiled only with the `local-engine` feature, so the interface-only build does not contain it at all |
| `src-tauri/tauri.conf.json` | window geometry (clean to 390 px), the CSP, the bundle targets, the `oh.` icon family |
| `src-tauri/capabilities/main.json` | the main window's grant: `"permissions": []` |
| `src-tauri/capabilities/updater.json` | the transient download-progress window's grant: `core:event:allow-listen`, and nothing else |
| `src/` | the desktop-specific layer: providers, the pre-paint theme stamp, the offline guard, and the two stubs that stand in for the Cloud sync client and the Cloud API client |
| `packages/{tokens,ui,fixtures,client-engine}` + `apps/webapp/app/{shell,views,components}` | the interface itself — the same sources the web client renders, compiled by Vite into the bundle Tauri embeds |

`apps/webapp/app/` here is **only** the client shell, its views and the components
they compose. The Cloud web app's sign-in, its API topology and its server-side
plumbing are not in this repository, and neither is the `/sync` protocol client
nor the Cloud API client. Each of those two resolves to a stub, so the tree
compiles and the bundle can reach neither: the sync client throws on any use, and
the API client throws on every call but answers plainly that no Cloud is
configured — which is what the shared sources ask it before they act, and what
lets them skip a Cloud path instead of crashing on one.

Worth knowing if you plan to read the code:

- **Every colour, radius and spacing step comes from `packages/tokens`.** The
  values are authored in OKLCH and converted once; nothing in a view writes a
  colour of its own, and the design system is the same one the web client
  renders, not a copy of it.
- **`npm run smoke` is the interesting test.** It loads the built bundle and
  walks every route, so it fails on a screen that compiles and does not draw —
  which a typecheck cannot see. It runs on all three platforms in CI, before the
  bundle is ever put inside an installer.
- **The engine is a separate process on a private pipe.** `src-tauri/src/engine.rs`
  is the whole of its lifetime, and it is compiled only under the `local-engine`
  feature — so the interface-only build does not contain the code at all rather
  than containing it and not using it. `cargo test` runs both configurations.
- **Compact layout is not an afterthought.** The window is clean down to 390 px;
  the rail becomes a drawer and panes collapse per view, in both colour schemes.

This tree is a generated mirror of a private monorepo (the Cloud backend lives
there and stays there). Commits arrive as syncs that name the monorepo revision
they came from; pull requests land in the monorepo and come back out here.

## Roadmap

1. **Signed installers** — a notarized DMG with a real Apple Developer ID and an
   Authenticode-signed .exe. Today's builds are unsigned on every platform, which
   is what the install notes are about. Updates are already signed and verified;
   this is about the first launch.
2. **AI, on by default** — Screener suggestions and draft replies via your own API
   key or a local Ollama ship off by default; making them a first-class part of
   the flow is the remaining work. Proposed, never applied; sensitive mail
   structurally excluded.
3. **A packaged Linux repository** — an apt source and a properly signed AppImage,
   so an install is a command rather than a download and a `chmod`.

Dates are not promised. The order is. Each of these is an open issue with the
detail in it, and [CHANGELOG.md](CHANGELOG.md) records what has actually shipped.

## Licence

GPL-3.0-or-later. Copyright © 2026 **TrafficFlow GmbH**, Staubstrasse 1, 8038
Zürich, Switzerland.

The desktop client is free and is meant to stay free: GPL-3.0 means anyone can
use, study, change and share it, and any redistributed change comes back under
the same terms — so a closed-source re-skin of ohmail is not possible. Full text
in [LICENSE](LICENSE) — a verbatim copy of the FSF's GPL-3.0 — and the reasoning,
the third-party position and the per-file-header decision in
[COPYRIGHT](COPYRIGHT).

**The code is free; the name and the icon are not.** You may fork, build and
redistribute this source; a fork you publish needs its own name and its own
artwork, so nobody is misled about who supports it.
[TRADEMARK.md](TRADEMARK.md) is the policy, and it is more permissive than you
probably expect — packaging ohmail for a distribution under its own name is
explicitly fine.

Contributions need **no CLA and no copyright assignment**, just a DCO sign-off
(`git commit -s`) — see [CONTRIBUTING.md](CONTRIBUTING.md), which is also honest
about the one part of the tree where GPL-only contributions constrain us.
Security reports: [SECURITY.md](SECURITY.md).

---

<div align="center">

[ohmail.app](https://ohmail.app) · [issues](https://github.com/trafficflowhq/ohmail/issues) · support@ohmail.app

Built in Zürich by [TrafficFlow GmbH](https://trafficflow.ch).

</div>
