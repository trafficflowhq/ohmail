# Building ohmail yourself

The short version is in the [README](../README.md#build-and-contribute); [CONTRIBUTING.md](../CONTRIBUTING.md)
has the test suites.

## Requirements

[Rust](https://rustup.rs) (stable) and Node 22. On macOS also
the Xcode command line tools. On Linux also the Tauri prerequisites — on Ubuntu
24.04:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev \
  libssl-dev build-essential curl wget file patchelf desktop-file-utils
```

On Windows, the MSVC build tools and WebView2.

## The interface, checked before anything native

The quickest verification, and it needs nothing but the repository and Node:
build the app's UI bundle and render it headlessly — the render check draws the
whole client against a stub engine channel and proves, on the built bundle, that
the page itself opens no connection. (The app has no demo mode: it opens empty
until you connect a mailbox. The demo is at ohmail.app/demo.)

```bash
cd apps/desktop
npm ci                   # apps/desktop has its own lockfile
npm run ui:build:engine  # → dist/, the bundle the app embeds
npm run smoke            # → SMOKE OK — renders, offline audit included
```

## The real thing, with the mail engine in it

```bash
# The engine, bundled with the pinned esbuild — a devDependency of the root
# manifest, so `npm ci` at the root is the whole resolution. The bundle is only
# reproducible for a fixed bundler version, so a different one is refused.
npm ci
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

# Building with no network? Put the release archives in a directory and name it:
# nothing is downloaded, and the bytes are checked against the digests pinned in
# the script.
OHMAIL_NODE_ARCHIVES=/path/to/archives node scripts/vendor-node.mjs

# And the app itself.
cd apps/desktop && npm run app:build:engine
```

## Linux notes

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

## A reproducible engine

The result carries the engine at `engine/bin/ohmail-engine.mjs` and the runtime
at `runtime/node`, both under the app's resource directory. The build prints
the engine's SHA-256, and so does every CI run — and
`scripts/verify-engine-repro.mjs` builds it twice and refuses if the results
differ, which is what makes a rebuild that matches mean anything.
