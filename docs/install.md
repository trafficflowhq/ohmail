# Installing ohmail

The short version is in the [README](../README.md#install). This page has the
rest: first launch on an unsigned build, Linux in detail, how updates work, and
how to check what you downloaded.

[Releases](https://github.com/trafficflowhq/ohmail/releases) has the installers,
no GitHub account needed, and each release names the CI run that built it.
Every desktop build carries the local mail engine and its own Node runtime, so
there is nothing to install first.

## Which file you want

| Platform | File | Requires |
|---|---|---|
| **macOS** | `ohmail.dmg` (universal, arm64 + x86_64) | macOS 15+ |
| **Windows** | `ohmail-windows-setup.exe` (NSIS, per-user, no admin) | Windows 10+, x86_64 |
| **Linux · x86_64** | `ohmail-linux-x86_64.AppImage`, `ohmail-linux-amd64.deb` or `ohmail-linux-x86_64.rpm` | — |
| **Linux · arm64** | `ohmail-linux-aarch64.AppImage`, `ohmail-linux-arm64.deb` or `ohmail-linux-aarch64.rpm` | — |
| **Android** | `ohmail-android.apk` | — |

`uname -m` tells you which Linux build you want: `x86_64` for the first Linux
row, `aarch64` for the second. macOS is one file for both architectures; Windows
is x86_64 only, and there is no arm64 Windows build.

One copy of ohmail runs per login session; opening it again brings the running
window forward.

## First launch on an unsigned build

None of the desktop installers carries a code-signing certificate yet: those
certificates cost money ohmail has not spent. First launch needs one manual
approval, and the checksums below are the checks that are actually available.
Building from source ([build.md](build.md)) is the option that requires trusting
nobody.

**macOS.** The app has no Developer ID signature and is not notarized.
Gatekeeper refuses a double-click and may claim the app "is damaged"; it is not.
Right-click (or Control-click) ohmail.app → Open → Open.

**Windows.** There is no Authenticode signature. SmartScreen shows "Windows
protected your PC" on first run: More info → Run anyway.

**WebView2.** ohmail draws its window in Microsoft's WebView2 runtime. If it is
already installed (Windows 11 has it, and so does any Windows 10 kept current),
the installer makes no network connection. If it is missing, the installer
downloads the runtime from Microsoft; the app cannot render without it. To
install it yourself first: <https://developer.microsoft.com/microsoft-edge/webview2/>

## Linux

**Two architectures, two builds.** `uname -m` prints `x86_64` or `aarch64`;
take the matching files. They are separate builds of the same application:
there is no single Linux file that runs on both, the way the macOS DMG does,
because ELF has no equivalent of a universal binary.

**AppImage.** It needs the executable bit:

```bash
chmod +x ohmail-linux-x86_64.AppImage && ./ohmail-linux-x86_64.AppImage
# on arm64:
chmod +x ohmail-linux-aarch64.AppImage && ./ohmail-linux-aarch64.AppImage
```

On a distribution without unprivileged user namespaces, run it with
`--appimage-extract-and-run`.

**.deb.** `sudo apt install ./ohmail-linux-amd64.deb` (`./ohmail-linux-arm64.deb`
on arm64) installs it and pulls in WebKitGTK.

**.rpm**, on Fedora, RHEL and openSUSE:

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
network access: every crate, every npm package and the Node runtime the mail
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
only under its own id, and a sandbox has its own data directory regardless, so
this build does not read a mailbox another Linux build of ohmail already
mirrored. Connect it to your mail server and it mirrors the mailbox itself; the
server is the master copy either way.

It asks for the network, a window, your login keyring, notifications and the
tray, and nothing else: no access to your files. Attachments you open go out
through the desktop portal. Start-at-login is not offered in this build.

It is not on Flathub yet. The manifest is here and it builds; the listing is a
submission that has not been made. When it is live, the install will be
`flatpak install flathub app.ohmail.Desktop` and this section will say so.
Follow [issue #6](https://github.com/trafficflowhq/ohmail/issues/6) for that.

### A window that never draws

If the window opens and never draws anything, run it against your own
distribution's GTK and WebKitGTK instead of the copies inside the AppImage:

```bash
OHMAIL_SYSTEM_WEBKIT=1 ./ohmail-linux-x86_64.AppImage
```

The AppImage carries most of its own libraries but takes the graphics drivers
from the machine it runs on, and the two have to agree. The case that was known
to break is fixed (the log line to look for is `Could not create default EGL
display`), and this is the way out if a distribution finds another one. It needs
`libwebkit2gtk-4.1` installed, which every desktop that ships a GTK browser
engine already has.

### What arm64 is and is not verified on

The arm64 build is compiled, tested and packaged on arm64 hardware in this
repository's CI, and every check the x86_64 build passes it passes too,
including starting its own mail engine from inside the packaged AppImage. What
has not happened is somebody opening the window on a Raspberry Pi, an Asahi Mac
or an arm64 workstation: there is no arm64 machine in this project. If you run
it, [say how it went](https://github.com/trafficflowhq/ohmail/issues); that is
the part CI cannot answer.

### A packaged install updates through your package manager

A build installed from the `.deb`, the `.rpm` or as a Flatpak reads how it was
installed and does not ask the release feed at all. "Check for Updates" is in
the menu, disabled, and says *"Updates Come from Your Package Manager"* (or
*"Updates Come from Your Software Centre"* on the Flatpak), and Settings → About
says the same beside the version you are running. Update by installing the new
package over the old one, or let your software centre do it, or use the
AppImage, which is the Linux build that applies its own updates.

The feed carries no key for either package format on purpose. Making it work
would mean handing a `.deb` to dpkg, or an `.rpm` to rpm, on a machine whose
packages are owned by whatever installed them, and there is no Debian or Fedora
install in this project's CI that could ever exercise that path. This is the
same on x86_64 and arm64.

### Uninstalling

`sudo apt remove ohmail`, or `sudo dnf remove ohmail` / `sudo zypper remove
ohmail` for the `.rpm`. One word on every platform: the package, the binary at
`/usr/bin/ohmail`, the icon and the desktop entry are all spelled `ohmail`.

## Updates

The AppImage, the Windows setup and the macOS app check one pinned HTTPS
address, the release feed of this repository, at launch, once a day while the
app stays open, and whenever you ask. Every update payload is verified against
the public key committed in this tree before it may install. There is no other
phone-home. `scripts/verify-feeds.mjs` checks both feeds offline; CI runs it on
every release.

A release becomes *Latest* only once those feeds are on it and answering: the
workflow that signs them marks a new release a prerelease until all three have
been read back from the address your app uses. If they never attach,
`/releases/latest` stays on the last release whose feeds work, so your app keeps
an update path instead of a 404.

A build that cannot replace its own files does not make that request at all: a
`.deb` or `.rpm` install, a Flatpak, and a build from source read how they were
installed and say where updates come from instead. A Flatpak says your software
centre, because that is what updates it.

## Check what you downloaded

Every release carries a `SHA256SUMS` listing every file on it, and every run's
summary prints the SHA-256 of the artifacts it made, so you can check what you
downloaded against both:

```bash
shasum -a 256 --check SHA256SUMS   # sha256sum --check on Linux
```

The oldest releases predate `SHA256SUMS` and have only the run summaries.

On Windows and Linux the interface is embedded uncompressed on purpose, so you
can check what a downloaded binary does without running it:

```bash
strings -a ohmail.exe | grep -oE 'https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+' | sort -u
strings -a ohmail.exe | grep -c Ohbox      # the interface really is in there
```

Almost everything the first command prints is an XML namespace constant, a
documentation link inside an error message, Microsoft's WebView2 download page
(see above), or an artifact of grepping a Rust binary. `apps/desktop/README.md`
goes through them one by one. The rest, every string that names ohmail or
TrafficFlow, is a short list CI spells out entry by entry and fails the run on
anything outside it: the pinned update feed, `https://api.ohmail.app`
(contacted only once you sign in to ohmail.app), and seven `ohmail.app` pages
the app may hand to your own browser. Your mail server never appears in that
list and cannot: it is not compiled in, it is whatever you typed, held in your
own configuration file.
