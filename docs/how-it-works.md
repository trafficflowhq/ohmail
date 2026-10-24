# How ohmail works

Moved here from the README, word for word: how ohmail organizes inside your mailbox, model providers and keys, and where your mail is and what the app talks to.

## How ohmail organizes inside your mailbox

For the reader who wants the mechanism. Everything below is ordinary IMAP,
inspectable from any other mail client — which is the point: the mailbox is
the source of truth, and everything ohmail adds to it is plain IMAP a
stranger's client can read.

The folders ohmail creates are a small, frozen set:

```
Inbox                    mail from people you've said yes to
Junk                     your provider's own — your spam verdicts file into it
Sent                     your replies, left where your provider already keeps them
ohmail/
├── Screener             new senders wait here until you decide where they go
├── News                 newsletters and things you read when you have a minute
├── Receipts             receipts, confirmations, orders
├── Screened             senders you keep, but out of the Inbox
├── Quarantine           spam the automatic patterns set aside, held for review
└── _meta                a small bookkeeping folder; some mail apps show it
```

`_meta` also holds your ohmail settings for this mailbox — the senders you've
screened in, your rules, notification choices, away reply and tag names — as a
small versioned-JSON message, so they live in your mailbox rather than in any
ohmail database and move with it (see "Your mailbox stays the source of truth"
above). The format is specified in
[docs/organizer-profile.md](organizer-profile.md) and implemented in
`packages/core/src/adapters/organizer-profile.ts`; deleting the message only
resets ohmail's settings, never your mail.

There is no folder called "Spam". Your own spam verdicts ride to the
provider's native Junk folder; what ohmail's automatic patterns set aside on
their own lands in `ohmail/Quarantine`, held for review — "Spam" is only ever
a friendly label the app shows.

**Real moves, crash-safe.** Filing a message is a real IMAP move into one of
those folders. ohmail first records where the message should be, then the one
active organizer performs the move on the server and confirms what it
observed — so a crash mid-move leaves a pending intention, never a half-moved
mailbox, and nothing else races it.

**One organizer per mailbox, agreed inside the mailbox.** Beside the settings
message, `ohmail/_meta` holds the organizer **lease**: which single install or
service currently organizes this mailbox, renewed as it works — so a desktop
install and a server, which can never query each other, still cannot fight
over one mailbox.

**Your own folders, if you want them.** Off by default, and per mailbox:
switch "Use folders" on and the folders you already keep appear in the menu,
each as its own list — the real folders on your server, never a copy. Create,
rename and delete them from ohmail and the same IMAP operations happen in your
mailbox; deleting a folder files its mail to your provider's Trash first,
never an expunge. (Not yet in the standalone desktop app.)

**Spam and deletion use your provider's own folders.** A spam verdict files the
message into the mailbox's native Junk folder — where its filter and your other
clients expect spam — and "Not junk" moves it back out; the sender rule, stored
with your settings, is the durable memory either way. Delete moves to native
Trash, never expunges. Beyond those user-commanded acts — and the Spam filing
"Act on confident suggestions for me" does once you switch it on, the same move
your press would make — ohmail never acts in Junk or Trash on its own: no rule,
no other automatic pass and no AI proposal may name them.

**What travels, and what stays.** Not a slogan — the architecture. ohmail's desktop app, the hosted service and
a server you run never share a database; the only medium they all read is the
mailbox itself, so that is where everything durable lives:

- **Your mail and its organization** are real IMAP folders on your own server —
  the `ohmail/*` tree plus any folders of your own — moved by ordinary IMAP
  commands, readable by any client, kept when you leave.
- **Your settings, rules and screening structure** are one small versioned-JSON
  message in the hidden `ohmail/_meta` folder — the portable organizer profile,
  specified in [docs/organizer-profile.md](organizer-profile.md).
- **Which ohmail organizes the mailbox** is decided in the mailbox too: a lease
  message in the same `_meta` folder names the one active organizer, so a
  desktop install, a self-hosted server and the hosted service can hand a
  mailbox to one another without ever talking to one another.

So switching between hosting types is reconnecting a mailbox. Connect the same
mailbox from a desktop install, from a server you run, or from
[ohmail Cloud](https://ohmail.app), and ohmail finds the settings stored in it
and asks before using them. What a deployment keeps to itself is the working
copy — the local mirror, cached bodies, device pairings, billing —
reconstructible from the mailbox or irrelevant to it, plus the honest edge:
decisions with no IMAP representation yet. Triage piles, Resurface timers,
learned patterns, which tag is on which message, notes, snippets and the app's
own preference switches all stay with the deployment they were made on — the
mail, its folders and the profile above are what travel.

## Model providers and keys

Pick the model in **Settings → Desktop**, under *AI for suggestions and drafts*.
Four options:

- **Your Anthropic key** — requests go to `api.anthropic.com`, billed to your
  account.
- **Your OpenAI key** — requests go to `api.openai.com`, billed to your
  account.
- **Your OpenCode Go key** — requests go to `opencode.ai` and on to the
  provider behind the model you choose, billed through your OpenCode account.
  The models to choose from are the ones your Go workspace lists that this app
  can drive; Settings shows them after the key is checked, and marks the free
  and preview ones. The check reads your workspace's Go configuration and runs
  no model, so it does not prove the model will answer. Eligibility, model
  privacy and billing are managed in your OpenCode account, where ohmail cannot
  see or enforce them.
- **A model on this machine** — served by Ollama at
  `http://127.0.0.1:11434` by default, or any address you give it. Install
  Ollama and `ollama pull llama3.2` before choosing it. Nothing leaves the
  machine if the server is on it. `llama3.2` is the default because it is the
  smallest model measured to do both jobs; something much smaller will suggest
  a door and then fail to write a draft, and says so rather than hanging.

A key is sealed under a key held in your operating system's keystore, is never
written down in the clear, is never read back, and is sent to no host but its
own vendor's. The endpoint for a key is fixed in the code and no setting can
move it — the option whose address you can change is the local one, which
carries no key. Saving runs a fresh test (for OpenCode Go, the configuration
read above), so a server that is not running, or
is running without the model you named, is reported while you are still in the
settings rather than the next time you open your mail.

## Where your mail is, and what the app talks to

**Local mode** — the default, no account: the engine connects to your IMAP
server over TLS, mirrors your mailbox — every folder but Junk, Trash and Drafts
— to a database on your own disk, and files mail into `ohmail/` folders on the
server itself. Nothing leaves your computer but the connections to your provider
(IMAP to read, SMTP to send), the signed update check, the pictures in a message
you open (fetched by your computer; a switch makes each message ask first), the
one-click unsubscribe a screen-out sends where the list offers one (a switch
turns it off), a DNS lookup, through your system's resolver, of the key a
company or a newsletter signs its mail with, where your provider does not
confirm senders itself, and — only if you turn it on — requests to whichever
model provider you chose. Choose a local Ollama and that last one stays on your
machine too. No telemetry, no analytics.

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

Your mail password is sealed under a per-install key and never written in the
clear. The key is kept in your computer's keystore (Keychain, Credential
Manager, Secret Service) **and mirrored to a file beside the app's data that
only your user account can read** — because an unsigned app is refused its own
keystore item after every update, and without the mirror your stored password
would be lost each time. Where that happens the key lives in the file rather
than behind your login password — a real reduction, stated here rather than
buried — and the local mail mirror beside it is an ordinary unencrypted
database. On a Linux desktop with no Secret Service (a window manager with
neither GNOME Keyring nor KWallet running, say) the file is the only copy from
the first launch. A locked keyring is never stepped around: the app asks you to
unlock it and open ohmail again. The app's log names the store it used each
time it starts.

The folder set ohmail creates, and the bookkeeping behind it, are in
[How ohmail organizes inside your mailbox](#how-ohmail-organizes-inside-your-mailbox)
above.

**Cloud mode** — optional: the same app can instead sign in to
[ohmail Cloud](https://ohmail.app), the hosted service, and act as a viewer of
a mailbox Cloud organizes on a machine that does not sleep — which is what
push, mobile and screening-while-your-laptop-is-shut require. Signing a
computer in is one confirmation: **Sign in with browser** opens ohmail.app, you
confirm there, and the app opens your mail — on a fresh install there is no
address or code to type. A signed-in desktop stays signed in through a busy
server or a dropped connection; only a refusal from ohmail Cloud ends the
session. If you have a
machine of your own that stays awake, host mode (above) gives your other
devices the same mailbox without Cloud — though new-mail push for your phone
is one job it leaves out: that takes a full server, ours or a self-hosted
one that has set up its own push keypair. Cloud is for when the always-on machine should be
ours rather than yours. It is a
commercial service built from the server source in this repository (only the billing
machinery is separate);
the desktop app neither asks for it nor needs it, and the choice is made in
the app, not by a different download. Prices and the full comparison are at
[ohmail.app](https://ohmail.app).
