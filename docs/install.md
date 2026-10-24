# Installing ohmail

Moved here from the README, word for word; the README keeps the short version. Download links point at the latest release.

## Install

**[Releases](https://github.com/trafficflowhq/ohmail/releases) has the
installers** — no GitHub account needed, and each release names the CI run that
built it. Every build carries the local mail engine and its own Node runtime —
nothing to install first.

| Platform | File | Requires |
|---|---|---|
| **macOS** | `ohmail.dmg` (universal, arm64 + x86_64) | macOS 15+ |
| **Windows** | `ohmail-windows-setup.exe` (NSIS, per-user, no admin) | Windows 10+, x86_64 |
| **Linux · x86_64** | `ohmail-linux-x86_64.AppImage`, `ohmail-linux-amd64.deb` or `ohmail-linux-x86_64.rpm` | — |
| **Linux · arm64** | `ohmail-linux-aarch64.AppImage`, `ohmail-linux-arm64.deb` or `ohmail-linux-aarch64.rpm` | — |

`uname -m` tells you which Linux build you want: `x86_64` for the first row,
`aarch64` for the second. macOS is one file for both architectures; Windows is
x86_64 only — there is no arm64 Windows build.

**Nothing carries a code-signing certificate yet**, on any platform: those
certificates cost money ohmail has not spent, so first launch needs one manual
approval, described per platform below, and the checksums are the checks that
are actually available. Building from source is the option that requires
trusting nobody.

**Check what you downloaded.** Every release carries a **`SHA256SUMS`** listing
every file on it, and every run's summary prints the SHA-256 of the artifacts
it made, so you can check what you downloaded against both:

```bash
shasum -a 256 --check SHA256SUMS   # sha256sum --check on Linux
```

`SHA256SUMS` is published from **0.13.3** onward; earlier releases have only
the run summaries.

**Updates.** The AppImage, the Windows setup and the macOS app check this
repository's release feed at launch and once a day while they stay open, and
verify every update against a public key committed in this tree before it may
install; a `.deb`, `.rpm` or Flatpak install updates through your package
manager instead. [Updates](#updates) has the rest.

One copy of ohmail runs per login session; opening it again brings the running
window forward.

## macOS

> [!IMPORTANT]
> **The app has no Developer ID signature and is not notarized.** Gatekeeper
> will refuse a double-click and may claim the app "is damaged". It is not.
> **Right-click (or Control-click) ohmail.app → Open → Open.**

## Windows

> [!IMPORTANT]
> **No Authenticode signature.** SmartScreen will show "Windows protected your
> PC" on first run: **More info → Run anyway.**

> [!IMPORTANT]
> **About WebView2.** ohmail draws its window in Microsoft's WebView2 runtime.
> If it is already installed — Windows 11 has it, and so does any Windows 10
> kept current — **the installer makes no network connection.** If it is
> missing, the installer downloads the runtime from Microsoft; the app cannot
> render without it. To install it yourself first:
> <https://developer.microsoft.com/microsoft-edge/webview2/>

## Linux

```bash
chmod +x ohmail-linux-x86_64.AppImage && ./ohmail-linux-x86_64.AppImage   # AppImage
sudo apt install ./ohmail-linux-amd64.deb                                 # Debian, Ubuntu
sudo dnf install ./ohmail-linux-x86_64.rpm                                # Fedora, RHEL; zypper on openSUSE
```

On arm64 the same, with the `aarch64` and `arm64` files. Flatpak, a window
that never draws, what arm64 is verified on, how a packaged install updates,
and uninstalling: [Linux, in detail](#linux-in-detail).

## Linux, in detail

**Two architectures, two builds.** `uname -m` prints `x86_64` or `aarch64`;
take the matching pair of files. They are separate builds of the same
application — there is no single Linux file that runs on both, the way the macOS
DMG does, because ELF has no equivalent of a universal binary.

> [!IMPORTANT]
> **The AppImage needs the executable bit:**
> ```bash
> chmod +x ohmail-linux-x86_64.AppImage && ./ohmail-linux-x86_64.AppImage
> # on arm64:
> chmod +x ohmail-linux-aarch64.AppImage && ./ohmail-linux-aarch64.AppImage
> ```
> On a distribution without unprivileged user namespaces, run it with
> `--appimage-extract-and-run`.

The `.deb` installs with `sudo apt install ./ohmail-linux-amd64.deb`
(`./ohmail-linux-arm64.deb` on arm64) and pulls in WebKitGTK.

On Fedora, RHEL and openSUSE, take the `.rpm`:

```bash
sudo dnf install ./ohmail-linux-x86_64.rpm      # Fedora, RHEL, CentOS Stream
sudo zypper install ./ohmail-linux-x86_64.rpm   # openSUSE
# on arm64, the same with ./ohmail-linux-aarch64.rpm
```

Note the architecture words: the `.rpm` is named for the machine (`x86_64`,
`aarch64`, what `uname -m` prints), like the AppImage, while the `.deb` is named
for the Debian architecture (`amd64`, `arm64`). Both spellings are the ones the
tool in your hand uses.

The `.rpm` declares no dependencies, for the same reason the `.deb` needs only
WebKitGTK: the mail engine and its Node runtime are inside the package, and the
webview stack is your desktop's. Any Fedora or openSUSE desktop that ships a GTK
browser engine already has it.

### Flatpak

A Flatpak manifest is in this repository at
`apps/desktop/flatpak/app.ohmail.Desktop.yml`, and it builds the app with no
network access — every crate, every npm package and the Node runtime the mail
engine runs on are declared, checksummed sources. Build and install it yourself:

```bash
flatpak install flathub org.flatpak.Builder org.gnome.Sdk//50 \
  org.freedesktop.Sdk.Extension.rust-stable//25.08 \
  org.freedesktop.Sdk.Extension.node22//25.08

flatpak run org.flatpak.Builder --user --force-clean --install \
  build-dir apps/desktop/flatpak/app.ohmail.Desktop.yml

flatpak run app.ohmail.Desktop
```

The app id is `app.ohmail.Desktop`, which is not the identifier the AppImage,
`.deb` and `.rpm` use. That is deliberate: a Flatpak may claim desktop names
only under its own id, and a sandbox has its own data directory regardless — so
this build does not read a mailbox another Linux build of ohmail already
mirrored. Connect it to your mail server and it mirrors the mailbox itself; the
server is the master copy either way.

It asks for the network, a window, your login keyring, notifications and the
tray, and nothing else — no access to your files. Attachments you open go out
through the desktop portal. Start-at-login is not offered in this build.

> [!NOTE]
> **It is not on Flathub yet.** The manifest is here and it builds; the listing
> is a submission that has not been made. When it is live, the install will be
> `flatpak install flathub app.ohmail.Desktop` and this section will say so.
> Follow [issue
> #6](https://github.com/trafficflowhq/ohmail/issues/6) for that.

> [!TIP]
> **If the window opens and never draws anything**, run it against your own
> distribution's GTK and WebKitGTK instead of the copies inside the AppImage:
> ```bash
> OHMAIL_SYSTEM_WEBKIT=1 ./ohmail-linux-x86_64.AppImage
> ```
> The AppImage carries most of its own libraries but takes the graphics drivers
> from the machine it runs on, and the two have to agree. 0.13.4 fixed the case
> that was known to break — the log line to look for is `Could not create default
> EGL display` — and this is the way out if a distribution finds another one. It
> needs `libwebkit2gtk-4.1` installed, which every desktop that ships a GTK
> browser engine already has.

> [!NOTE]
> **What arm64 is and is not verified on.** The arm64 build is compiled, tested
> and packaged on arm64 hardware in this repository's CI, and every check the
> x86_64 build passes it passes too — including starting its own mail engine
> from inside the packaged AppImage. What has NOT happened is somebody opening
> the window on a Raspberry Pi, an Asahi Mac or an arm64 workstation: there is no
> arm64 machine in this project. If you run it, [say how it
> went](https://github.com/trafficflowhq/ohmail/issues) — that is the part CI
> cannot answer.

> [!IMPORTANT]
> **A packaged install does not update itself, and no longer offers to.** A build
> installed from the `.deb`, the `.rpm` or as a Flatpak reads how it was
> installed and does not ask the release feed at all: "Check for Updates" is in
> the menu, disabled, and says *"Updates Come from Your Package Manager"* — or
> *"Updates Come from Your Software Centre"* on the Flatpak — and Settings →
> About says the same thing beside the version you are running. Update by
> installing the new package over the old one, or let your software centre do it
> — or use the **AppImage**, which is the Linux build that applies its own
> updates.
>
> It used to offer, until 0.17.0. A packaged build asked
> the feed for a package of its own kind, did not find one (the feed publishes
> AppImages, one per architecture), fell back to the AppImage for its
> architecture, downloaded it, and then reported *"ohmail could not install the
> update."* Nothing on disk was touched — but it was a button that promised a
> restart, and 130 MB of download spent on nothing.
>
> The feed carries no key for either package format on purpose. Making it work
> would mean handing a `.deb` to dpkg, or an `.rpm` to rpm, on a machine whose
> packages are owned by whatever installed them — and there is no Debian or
> Fedora install in this project's CI that could ever exercise that path. This is
> the same on x86_64 and arm64, and it applies to any distribution package built
> from any of the four.

Uninstall with `sudo apt remove ohmail`, or `sudo dnf remove ohmail` /
`sudo zypper remove ohmail` for the `.rpm`. One word on every platform:
the package, the binary at `/usr/bin/ohmail`, the icon and the desktop entry are
all spelled `ohmail`.

## Updates

The app checks one pinned HTTPS address — the release feed of this repository —
at launch, once a day while the app stays open, and whenever you ask, and every
update payload is cryptographically verified against the public key committed in
this tree before it may install. There is no other phone-home.
`scripts/verify-feeds.mjs` checks both feeds offline; CI runs it on every
release.

A release becomes *Latest* only once those feeds are on it and answering: the
workflow that signs them marks a new release a prerelease until all three have
been read back from the address your app uses. If they never attach,
`/releases/latest` stays on the last release whose feeds work, so your app keeps
an update path instead of a 404.

A build that cannot replace its own files does not make that request at all: a
`.deb` or `.rpm` install, a Flatpak, and a build from source read how they were
installed and say where updates come from instead — a Flatpak says your software
centre, because that is what updates it. The AppImage, the Windows setup and the
macOS app are the three that check and install.

## Verify it yourself

On Windows and Linux the interface is embedded **uncompressed** on purpose, so
you can check what a downloaded binary does without running it:

```bash
strings -a ohmail.exe | grep -oE 'https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+' | sort -u
strings -a ohmail.exe | grep -c Ohbox      # the interface really is in there
```

Almost everything the first command prints is an XML namespace constant, a
documentation link inside an error message, Microsoft's WebView2 download page
(see the Windows note above), or an artifact of grepping a Rust binary.
`apps/desktop/README.md` goes through them one by one. The rest — every string
that names ohmail or TrafficFlow — is a short list CI spells out entry by entry
and **fails the run** on anything outside it: the pinned update feed,
`https://api.ohmail.app` (contacted only once you choose ohmail Cloud), and
seven `ohmail.app` pages the app may hand to your own browser. Your mail server
never appears in that list and cannot: it is not compiled in, it is whatever you
typed, held in your own configuration file.

**What's in this repository.** Everything ohmail runs on: the desktop app,
the mail engine, the web interface, the sync API, and the background
organizer. The only code that is not here is the machinery for billing our
hosted customers — a separate service this server reaches over a documented
API; `packages/db/src/entitlements-client.ts` is the open client of it, and
`ENTITLEMENTS_URL` is the one setting that points at one.

Self-hosting has no plans, no metering and no billing surface — every limit
is off, and AI features run on the provider keys you configure. [Your own
server](../README.md#your-own-server) in the README is the supported way to do that.

## Build the desktop app yourself

**Requirements:** [Rust](https://rustup.rs) (stable) and Node 22. On macOS also
the Xcode command line tools. On Linux also the Tauri prerequisites — on Ubuntu
24.04:

<!-- run by .github/workflows/contributor.yml: linux-packages -->
```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev \
  libssl-dev build-essential curl wget file patchelf desktop-file-utils
```

On Windows, the MSVC build tools and WebView2.

### The interface, checked before anything native

The quickest verification, and it needs nothing but the repository and Node:
build the app's UI bundle and render it headlessly — the render check draws the
whole client against a stub engine channel and proves, on the built bundle, that
the page itself opens no connection. (The app has no demo mode: it opens empty
until you connect a mailbox. The demo is at ohmail.app/demo.)

<!-- run by .github/workflows/contributor.yml: interface -->
```bash
cd apps/desktop
npm ci --ignore-scripts  # apps/desktop has its own lockfile
npm run ui:build:engine  # → dist/, the bundle the app embeds
npm run smoke            # → SMOKE OK — renders, offline audit included
```

### The real thing, with the mail engine in it

From the repository root:

<!-- run by .github/workflows/contributor.yml: engine -->
```bash
# The engine, bundled with the pinned esbuild — a devDependency of the root
# manifest, so `npm ci` at the root is the whole resolution. The bundle is only
# reproducible for a fixed bundler version, so a different one is refused.
# --ignore-scripts: no dependency's install script runs, as in CI.
npm ci --ignore-scripts
# The changes this repository carries to its dependencies (`patches/`), applied
# with git. The bundler refuses an engine that does not carry them.
node scripts/apply-patches.mjs apply
node scripts/engine-bundle.mjs

# It boots from the layout it ships in — and refuses to when its migration
# journal is moved away, which is what makes the first half worth anything.
node scripts/verify-engine-boot.mjs

# The official Node build for this platform, checked against nodejs.org's own
# SHASUMS256.txt before it is unpacked. A mismatch is a refusal, not a warning.
node scripts/vendor-node.mjs

# And the app itself.
cd apps/desktop && npm run app:build:engine
```

Building with no network? Put the release archives in a directory and name it,
`OHMAIL_NODE_ARCHIVES=/path/to/archives node scripts/vendor-node.mjs` in place
of the plain `vendor-node.mjs` line: nothing is downloaded, and the bytes are
checked against the digests pinned in the script.

On Linux, a source-built AppImage bundles GTK from the build host, which may
use a different GTK version than the release artifact. The shell pins GTK's
text DPI to 96, so the desktop's `text-scaling-factor` does not resize the
whole webview; monitor scaling remains unchanged.

On Arch Linux, pin Tauri's GTK hook before building an AppImage. Tauri's
uncached hook forces `GDK_BACKEND=x11`, sending HiDPI Wayland sessions through
XWayland at 1×. `NO_STRIP=1` avoids Tauri's bundled `linuxdeploy` strip rejecting
the host's `.relr.dyn` sections.

From the repository root:

```bash
install -m 755 apps/desktop/src-tauri/linux/linuxdeploy-plugin-gtk.sh \
  ~/.cache/tauri/linuxdeploy-plugin-gtk.sh
```

Then from `apps/desktop`:

```bash
NO_STRIP=1 npm run app:build:engine -- --bundles appimage
```

The result carries the engine at `engine/bin/ohmail-engine.mjs` and the runtime
at `runtime/node`, both under the app's resource directory. The build prints
the engine's SHA-256, and so does every CI run — and
`scripts/verify-engine-repro.mjs` builds it twice and refuses if the results
differ, which is what makes a rebuild that matches mean anything.

## How it is put together

One app, three platforms, four architectures — macOS as one universal binary,
Windows on x86_64, Linux built separately for x86_64 and arm64. All of them are
the same program: a Rust (Tauri) window around the React
implementation of the design system, with a Node mail engine beside it that
the window talks to over a private pipe — no port, no socket, no listener
while host mode is off; arming host mode opens exactly the loopback door the
host section above describes, and nothing else.

**The page reaches nothing directly.** The webview's Content-Security-Policy
names one source in `connect-src`, the app's in-process command scheme, in the
spelling of each platform's webview (`ipc:` on Linux and macOS,
`http://ipc.localhost` on Windows; `apps/desktop/src-tauri/tauri.<os>.conf.json`).
On Windows a CSP also lets that source match `https://ipc.localhost`, a loopback
address nothing in the app serves. `fetch`, XHR and WebSocket to any other
address are refused before they are attempted. In the interface-only build the main window's capability list
is literally empty (`"permissions": []`). In the build you download, the
window can call thirty-five commands and nothing else, every one declared in
`src-tauri/build.rs`: the bridge to the mail engine and its restart, a
notification and the icon's badge, the window's own performance numbers,
opening a link, a link from a message or an attachment outside the app and
saving an attachment to your Downloads folder (validated by the shell, never
fetched by the page), host mode's controls — reading its state, probing and
arming Tailscale, start-at-login, and opening Tailscale's download page as one
more fixed address the shell owns — the probe a pairing link starts, the
default-mail-app registration, the active Omarchy theme, the updater's
state, press and daily check, the window's first-frame report and its text
size. Mail does not travel
over the network from the page — it travels down a pipe to a process on the
same machine. The engine holds the IMAP connection; the page holds no
credential.

Every colour, radius and spacing step comes from `packages/tokens`; the
interface sources under `apps/webapp/app/` and `packages/ui` are the same ones
the web client renders, not a copy. `apps/desktop/README.md` is the long
version — the aliases, the capability set, and what each directory is.

This repository is where ohmail is developed. Every change reaches `main` as a
pull request, ours included: nothing is pushed to it directly, and a pull
request is merged only once its required checks pass. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for how to send one;
[CHANGELOG.md](../CHANGELOG.md) records what has shipped.
