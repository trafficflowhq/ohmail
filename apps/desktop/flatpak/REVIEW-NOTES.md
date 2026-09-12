# Flatpak build — notes

The manifest is `app.ohmail.Desktop.yml`. It builds the app in this repository with no network
access: the crates come from `cargo-sources.json`, the npm trees from `node-sources.json`, and the
Node runtime the mail engine runs on is the one the `node22` SDK extension builds from source.

## Build it yourself

```bash
flatpak install flathub org.flatpak.Builder org.gnome.Sdk//50 \
  org.freedesktop.Sdk.Extension.rust-stable//25.08 org.freedesktop.Sdk.Extension.node22//25.08

flatpak run org.flatpak.Builder --user --force-clean --install \
  build-dir apps/desktop/flatpak/app.ohmail.Desktop.yml

flatpak run app.ohmail.Desktop
```

Add `--sandbox --disable-download` to prove the build reaches no network. Regenerate the two
source files after a dependency change:

```bash
flatpak run --command=flatpak-cargo-generator org.flatpak.Builder \
  apps/desktop/src-tauri/Cargo.lock -o apps/desktop/flatpak/cargo-sources.json
flatpak run --command=flatpak-node-generator org.flatpak.Builder \
  npm package-lock.json -r --node-sdk-extension node22 \
  -o apps/desktop/flatpak/node-sources.json
```

Both are generated, and a build resolves only what they declare — a dependency bump that leaves
them behind builds nowhere and fails inside the builder. `node scripts/flathub-manifest.mjs
--check` reads every checksum the lockfiles name and refuses a source file that is missing one.
The npm generator's `-r` walks the lockfiles from the tree root, so the root `package-lock.json`
is the one it starts at; `--check --mirror <that tree>` includes it.

The release notes in `app.ohmail.Desktop.metainfo.xml` are derived from `CHANGELOG.md` by
`scripts/appstream-releases.mjs`; run it with `--write` after a version lands and commit the
result. Without `--write` it checks, and it is what the CI job runs.

## The four questions this app's permissions raise

**Why it carries its own Node runtime.** The mail engine — the IMAP client, the mail parser, the
local database — is a Node program, and it is in this repository under `apps/sidecar`. Relying on
the Node the user happens to have installed is not something a desktop app can do: the `PATH` a
desktop launch gets is not a shell's, and an app that starts and then cannot find its own engine
is a broken install. In this build the runtime is not downloaded and it is not a prebuilt binary
from a vendor: it is the `node22` SDK extension's own `node`, which freedesktop-sdk compiles from
source, copied into the app with its licence beside it.

**Why `--share=network`.** It is an email client. It opens IMAP and SMTP connections to the server
the person configures — their own, or their provider's — and there is no other host it contacts.
The update check every other build of this app makes is off here, because the software centre
installs updates; the app reads that it is running in a Flatpak and does not ask the release feed
at all. Host mode, which serves the person's own phone on their own network, is the other user of
the socket.

**Why `--talk-name=org.kde.StatusNotifierWatcher`.** Host mode — the app serving this person's
own phone on their own network — draws a tray icon, and the icon is where that state is reported
and where Quit lives. A sandboxed app that builds one without this name gets no icon and no
error: the computer would be serving a phone with nothing on screen saying so. The grant is the
status-notifier host and nothing else; the app owns no bus name of its own beyond its app id.

**Why `--talk-name=org.freedesktop.secrets`.** The app mirrors the mailbox to a database on the
computer and encrypts it. The key is kept in the login keyring rather than in a file beside the
data, which is the only place it is meaningfully safer. Without the grant the app says the keyring
is unavailable and does not open the mailbox — it does not fall back to storing the key unencrypted.

## What this build does not do

There is no `--filesystem` grant of any kind. The database, the log and any attachment the app
writes live under the app's own data directory; a file the person opens is handed to the portal.

Start-at-login is not offered in this build. The other Linux builds write a `~/.config/autostart`
entry, which a sandboxed app cannot do for the host session, and the honest mechanism — the
Background portal — is not wired yet. The setting is hidden here rather than shown and ignored.

## What the linters say

`appstreamcli validate` and Flathub's own linter are run against the files in this directory.

- `flatpak-builder-lint manifest app.ohmail.Desktop.yml` — no findings. The submission manifest,
  rendered by `scripts/flathub-manifest.mjs` with the tag and commit pinned, is linted the same
  way and is also clean — with the two generated source files BESIDE it, which is the shape the
  pull request has. Linted on its own it reports `manifest-json-warnings`, because the two names
  in `sources:` are includes resolved next to the manifest and there is nothing there to include.
- `appstreamcli validate app.ohmail.Desktop.metainfo.xml` and `flatpak-builder-lint appstream` —
  two `screenshot-image-not-found`, one per `<image>`. The URLs name this repository's default
  branch, and the files are in this directory; they resolve once this tree is published, which is
  before the submission is opened. Both are re-run at that point and the answer is then zero
  findings, not an explanation. `test/flatpak-metainfo.test.ts` holds the half that can be read
  offline: every `<image>` names a path that exists here, so a renamed screenshot is red at once
  rather than at review.
- One pedantic note, `cid-contains-uppercase-letter`, on the `D` of `app.ohmail.Desktop`. It stays:
  Flathub's own linter refuses an id whose last component is a lowercase `desktop`, so the two
  rules point opposite ways and only one of them is a submission requirement.
