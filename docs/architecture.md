# How ohmail is put together

The short version is in the [README](../README.md#where-your-mail-is-and-what-the-app-talks-to).

## The pieces

- `apps/desktop`: the desktop app. A Rust (Tauri) shell in `src-tauri` around
  the window in `src`.
- `apps/sidecar`: the desktop's mail engine, the Node process beside the window.
- `apps/webapp`: the web client; its `app/shell` and `app/views` are the
  interface the desktop window renders too.
- `apps/mobile`: the phone app, Android and iOS from one tree.
- `apps/server` and `apps/worker`: the API server and the background organizer
  of the server stack (`deploy/selfhost`).
- `packages/`: design tokens (`tokens`), components (`ui`), the client engine
  every client runs (`client-engine`), the mail core (`core`), the services and
  the database schemas.

Every colour, radius and spacing step comes from `packages/tokens`; the
interface sources under `apps/webapp/app/` and `packages/ui` are the same ones
the web client renders, not a copy. `apps/desktop/README.md` is the long
version: the aliases, the capability set, and what each directory is.

## The window and the engine

One app, three platforms, four architectures: macOS as one universal binary,
Windows on x86_64, Linux built separately for x86_64 and arm64. All of them are
the same program: a Rust (Tauri) window around the React implementation of the
design system, with a Node mail engine beside it that the window talks to over
a private pipe. There is no port, no socket and no listener while host mode is
off; arming host mode opens exactly the loopback door
[host mode](self-host/host-mode.md) describes, and nothing else.

Mail does not travel over the network from the page: it travels down a pipe to
a process on the same machine. The engine holds the IMAP connection; the page
holds no credential.

## What the page can reach

The webview's Content-Security-Policy names one source in `connect-src`, the
app's in-process command scheme, in the spelling of each platform's webview
(`ipc:` on Linux and macOS, `http://ipc.localhost` on Windows;
`apps/desktop/src-tauri/tauri.<os>.conf.json`). On Windows a CSP also lets that
source match `https://ipc.localhost`, a loopback address nothing in the app
serves. `fetch`, XHR and WebSocket to any other address are refused before they
are attempted.

In the interface-only build the main window's capability list is literally
empty (`"permissions": []`). In the build you download, the window can call the
commands declared in `WINDOW_COMMANDS` in `apps/desktop/src-tauri/build.rs` and
nothing else: the bridge to the mail engine and its recovery, notifications and
the icon's badge, the window's own performance numbers, the diagnostic file,
opening a link or an attachment outside the app and saving an attachment
(validated by the shell, never fetched by the page), the in-app attachment
preview, host mode's controls, the default-mail-app registration, the active
Omarchy theme, the updater, and the window's first-frame report and text size.
`apps/desktop/README.md` describes the capability set.

## Where your password and mail live

In the desktop app's default mode the engine connects to your IMAP server over
TLS, mirrors your mailbox (every folder but Junk, Trash and Drafts) to a
database on your own disk, and files mail into `ohmail/` folders on the server
itself.

Your mail password is sealed under a per-install key and never written in the
clear. The key is kept in your computer's keystore (Keychain, Credential
Manager, Secret Service) **and mirrored to a file beside the app's data that
only your user account can read**, because an unsigned app is refused its own
keystore item after every update, and without the mirror your stored password
would be lost each time. Where that happens the key lives in the file rather
than behind your login password, a real reduction, stated here rather than
buried, and the local mail mirror beside it is an ordinary unencrypted database.
On a Linux desktop with no Secret Service (a window manager with neither GNOME
Keyring nor KWallet running, say) the file is the only copy from the first
launch. A locked keyring is never stepped around: the app asks you to unlock it
and open ohmail again. The app's log names the store it used each time it
starts.

## Signed in to a server

The same app can instead sign in to a server, one you run or ohmail.app, and act
as a viewer of a mailbox that server organizes on a machine that does not sleep.
Signing a computer in to ohmail.app is one confirmation: **Sign in with
browser** opens ohmail.app, you confirm there, and the app opens your mail; on a
fresh install there is no address or code to type. A signed-in desktop stays
signed in through a busy server or a dropped connection; only a refusal from the
server ends the session. The choice is made in the app, not by
a different download.

## Search

Search answers as you type, typo-tolerant, over your whole mailbox: the words of
every message (a long one's first 65,536 characters), its subject, its sender,
its recipients and its attachment names. What the app already holds shows at
once and is replaced by the mailbox's answer; the line under the box says how
long it took, and the count follows right behind, first about how many, then
the exact number. On a desktop that organizes its own mailbox, search reads the
app's own store with the same indexes as the server. Narrow it by sender,
folder, unread or attachments, and sort by best match, newest, oldest, mailbox
or sender. Your provider's Junk, Trash and Drafts folders are the places it does
not reach.
