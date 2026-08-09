# Changelog

All notable changes to the ohmail desktop apps are recorded here.

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Dates are the dates the work actually landed; every entry corresponds to commits
you can read in `git log`.

A note on what a version means here: **0.x is a preview.** From 0.4.0 the macOS build
was a working mail client that connects to your mailbox; from 0.7.0 every build is.
See [Status](README.md#status--read-this-first).

## [Unreleased]

Signed installers — a real Apple Developer ID and an Authenticode certificate. See
[Roadmap](README.md#roadmap).

## [0.8.0] — 2026-08-09

The largest release since every platform became a working mail client. Sign-in, the first minutes
after you connect a mailbox, the reading surface, attachments, drafts and the Screener all changed.

### Signing in

**You can sign in to a hosted account from your browser instead of typing a password into the
app.** The app opens a page on the website, where you are already signed in; the page hands you a
short code, and the app takes the code and your address. Nothing else. The code is good once, for
two minutes, and it cannot be used as a password anywhere — a code shown on a web page and a token
mailed to an inbox are separate things that cannot be exchanged for each other.

The password form is still there and still works. Switching between the two clears the fields of
the one you are leaving, so a password you started typing and abandoned is not left sitting in the
window.

**Your key survives this update.** From 0.7.3 the per-install key that seals your stored mailbox
password is kept in a file beside the app's data as well as in your computer's keystore, so an
update no longer costs you the key. If you are updating from **0.7.2 or earlier** this launch asks
for your mailbox password once — the key an older version wrote cannot be read back — and remembers
it from then on. From 0.7.3 it asks for nothing.

### The first minutes on a new mailbox

**A cold start now paints your newest mail first, and says what it is doing.** Connecting a mailbox
used to give you an empty screen, then mail filling in from the oldest message forwards, with
nothing anywhere saying a first import was running — so the message you opened the app to read
arrived last. The app now reads the mailbox's current state, newest first, and the line at the foot
of the sidebar reports the import while it runs and stops when it finishes.

**Settings, Mailboxes lists the mailbox you are actually connected to** — what it is doing and when
it last checked. That pane had been reliably empty on every real install.

**A filing that has not reached your mail server yet says so.** Screening a sender, a bulk apply and
a move are recorded immediately and carried out on your server on the next sync pass. While your
mail host is refusing connections that gap does not close, and nothing said so: the mailbox still
read as connected while a backlog of your decisions built up unapplied. The sidebar now names the
count and points at the mailbox.

### Tags

**Tags made in the browser now appear in the desktop app.** The tag rail was empty and no message
carried a chip, which looks exactly like an account that has never made a tag. Assignments arrive as
the whole set for a message, so removing a tag in the browser removes the chip here too, and
deleting a tag takes its assignments with it.

### Reading

**A plain letter is rendered as text, at the app's own reading size.** Most mail between people is a
paragraph and a sign-off that happens to arrive as HTML. Drawing it inside a sandboxed frame renders
it in the sender's font, their line height and their idea of a link colour. A message that declares
no layout of its own — no canvas, no picture, no background, no stylesheet beyond the boilerplate a
desktop mail client emits — is now rendered as its text part, in the app's typography. Anything with
a design of its own is unchanged, and the sanitized HTML is still never placed in the app's own
document.

**A conversation opens on its latest message and keeps it there.** The thread used to jump as its
other messages arrived. Every message in a thread is now fetched in a single request rather than one
per message throttled behind the others, so a long conversation opens in one go.

**A message that has not arrived yet says so.** Body fetches are limited to a few at a time, and a
message opened while that limit was full was drawn from its snippet — about two hundred characters,
cut mid-word, under a real from-line and subject, with nothing indicating there was more. The record
that says "this is loading" is now written the moment a fetch is decided rather than when it
departs, and both the reading pane and the conversation entries say what they are showing. A body
that failed to load can be asked for again, and reloading the app re-asks by itself rather than
waiting for you to find the one message and press Retry.

### Pictures and attachments

**A message's pictures load when you open it, and a tracking pixel still never does.** Remote images
were blocked behind a press, once per message, for ever — the right default for a beacon and the
wrong one for a photograph. Automatic loading is now the default, and there is a switch in Settings
to turn it off, which restores the per-message press.

Every image is fetched through the app's own proxy rather than by the page: the request carries none
of the browser's identifying headers, because the port it goes through takes a url and nothing else,
and the message frame is under a policy that admits no host but this one. **What that does not do on
a standalone install is hide your address** — the fetch is made by the engine on your own machine,
so it comes from your own connection, exactly as it would in any other mail client. On a hosted
account the fetch happens on the server, and there your address never reaches the sender at all.

What does not move in either mode: a one-pixel image, a zero-dimension image and a beacon-shaped url
are never requested, and remote stylesheets stay blocked.

**Pressing an attachment opens it; the icon in its corner saves it.** It was the other way round,
which meant reading a PDF once cost you a file in your downloads folder to find, open elsewhere and
then delete. A file the app cannot draw — an SVG, a docx, a zip — still saves on a press, because
there is nothing to show.

**Download all now gives you the files, not an archive of them.** A zip is a container somebody has
to deal with, and it hid its own failures: a part the server could not fetch was named in a text
file inside the archive, so the saved file looked complete. Each file is fetched in turn and saved
individually, and one that fails is a failed tile in front of you with the reason on it.

### Drafts

**A half-written message is saved to your account, not to one browser.** A draft lived in local
storage, in whichever browser you happened to be in: close the tab on one machine and it was on
another machine's disk, and it was nowhere at all if you cleared site data. Compose now saves to a
real draft two seconds after you stop typing, and there is a Drafts list beside it that is the same
list everywhere you read your mail.

One draft, from the first keystroke to delivery: the first meaningful edit creates it, every later
save updates it, Send sends that draft rather than a copy of it, and Discard deletes it. Sending
keeps the row — it becomes the sent message. Opening Compose writes nothing; a draft is text
somebody typed.

### The Screener

**A large waiting queue can be worked from the list itself.** A backlogged mailbox puts dozens of
first-time senders at the gate, and the only way through them was to select each one and decide it
in the pane alongside.

- **Filter chips.** "Apply 12" over a queue of nineteen is a true sentence that leaves seven senders
  unaccounted for, because the bulk deliberately steps over junk and over senders the model held or
  was never asked about. The queue now shows its groups with counts and narrows to one on a press,
  so the remainder is on screen instead of implied by a gap.
- **One press files a sender.** Each waiting row carries an accept for its suggestion and a menu of
  the five destinations, and every one of them goes through the same decision the bar and the
  keyboard make — the same undo window, the same rule, the same route past the gate for a sender
  whose mail is already in your inbox. A row with no suggestion gets the destinations and no accept.
- **Progress you can see.** Asking for suggestions and applying them are both several seconds of
  work dispatched a piece at a time, and neither published anything but a sentence. Both now draw a
  real track from the numbers behind that sentence, and it disappears when the work does.
- **What is left of your AI budget** is on the summary, read from the server after the run rather
  than worked out from what the run cost — a figure derived here would be wrong after a renewal, a
  refund or a run in another window, and wrong in the direction that promises budget you do not
  have.
- **It stops calling suggestions a purchase.** The control spoke in the vocabulary of a shop for a
  feature that spends an allowance you have already paid for.

### Bounces

**A bounce of your own mail reaches you.** You send a message, the recipient's server refuses it,
and the delivery report comes back from a daemon you have never corresponded with — so the consent
gate held the one message that says your mail did not arrive, at the moment it was still worth
acting on. A report is now admitted when the app can corroborate it against your own account: a
message id it quotes that you actually sent, or a failed recipient you already correspond with.
Neither of those, and the report takes the ordinary path to the Screener, which is what keeps a
forged report from being a way past the gate. A sender you screened out or quarantined stays where
you put them.

### Triage, History and the rest

**Answer Later, Parked and Resurface are lists you can read from.** They were a stack of tiles with a
name and a subject and nothing else — no time, no unread state, no tags, no attachments, and no way
to open the message. They are the Ohbox's own two-pane composition now, with the same rows, the same
reading pane and the same verbs, and the Reply Run sits at the top of the list rather than below
everything it operates on.

**History stays quick on a large mailbox.** History — mail from everyone you never screened, which
is most of what accumulates over years — is the one list with no upper bound, and it was drawn in
full: at 20 000 rows that is 242 904 elements laid out before you can touch anything, and every
click had to move a selection through all of them. It now draws the rows within reach of the scroll
position and reserves the exact height of the rest, so the scrollbar, the scroll position and the
keyboard order are what they always were. That list renders as a few hundred elements however long
it is.

**A real menu bar.** File, View, Window and Help, plus an app menu with About and Settings on the
platform's own shortcut. New Message is on the shortcut every mail client on the platform uses, the
five places mail lives keep their number keys, Window gets minimize, zoom and full screen — none of
which had an entry before — and Help holds the keyboard sheet, because a key list you can only reach
with a key is a key list nobody finds.

**Settings is a whole screen.** Mailboxes and Screener were present in the navigation and blank when
opened; both work now, over the transport this app actually has. There is an About pane with who
publishes this, which build is running, under what licence, which mailbox it opens and where your
mail lives. On a hosted account, a button opens your account pages in your own browser rather than
leaving you to retype an address — the window names a place and never an address, so nothing that
gets a string into a page can send your browser somewhere else.

**Smaller things.** The macOS icon sits on the system's grid, so the Dock draws it at the same size
as everything beside it. Receipts is one flat list, the same as Reads. Long explanations fold behind
a compact information control, with the sentence that has to be read left on screen. Compose gives
the message the room the reply editor has always had. Nothing claims to be empty while it is still
loading.

## [0.7.3] — 2026-08-08

### Signing in sticks across updates

**An update used to cost you your stored mailbox password, every time.** The app seals that
password under a key of its own and keeps the key in your computer's keystore. macOS records
which program is allowed to read a keystore item, and for an application with no developer
certificate what it records is the hash of that exact binary — so every new version is a
different program as far as the keystore is concerned, and is refused the key the previous
version wrote. What you saw was a launch that failed with a message about disk space on a machine
with plenty free, and a password that would not stick however many times you typed it: the app
could not read the key, so it could not seal a new password under it either.

The key is now kept in a file beside the app's data, readable only by your own user account, and
it is written there while the key is still readable rather than after it has been lost. That file
is read before the keystore is consulted — a machine whose keystore had started answering again
would otherwise hand back the key from before the fallback, which unseals nothing. The keystore
is still tried first on a machine where it works, and still written on every path that mints.

This is a real reduction and it is worth stating plainly rather than burying: where the keystore
refuses, the key that seals your stored mailbox password sits in a file instead of behind your
login password. It sits beside a local mail mirror that is an ordinary unencrypted database, and
your mailbox on your own server remains the master copy of everything.

**Because of that, this update asks for your mailbox password once.** The key written by an
earlier version cannot be read back on a machine whose keystore refuses it — that is the whole
defect — so the first launch after updating asks for the password again, and remembers it from
then on. On macOS that is every install, because the app is unsigned.

**And a keystore lookup can no longer hang the launch.** When macOS will not let a program read a
keystore item, its first move is not to return an error: it puts up a dialog asking for your
login password and waits for an answer. That happened while the app was still working out what to
start, before it had a window of its own to explain itself in — measured at over ten minutes on
one machine, where the same lookup fails in microseconds once it is told not to ask. The app now
looks without letting the keystore ask you anything. The cost is that a keystore which is merely
locked is treated as a refusal, which only reaches an install that has never once got far enough
to write the file.

### The reader and the sidebar

**The message actions float at the bottom of the reader.** Reply, archive, junk and the rest sat
in an opaque strip drawn across the message, which made a false floor where the text appeared to
end — and on a message too short to scroll it never reached the bottom at all, leaving a row of
verbs stranded in the middle of an empty panel. It is a floating pill now, resting just off the
bottom edge whether the message scrolls or not, carrying its own background instead of painting
over the mail. Nothing is hidden behind it: scrolling to the end brings the last paragraph to
rest above it. While you are writing a reply it stands down to a plain row, so it does not
compete with the Send button you are reaching for.

**The command palette and the theme control live in the sidebar.** They used to sit in a capsule
pinned over the bottom of the window, which meant every scrolling list had to keep a band of
empty space beneath itself so its last row was not underneath them. They are rows at the foot of
the navigation sidebar now — one line, with the theme control as an icon at its end — and on a
phone they ride the navigation drawer. Removing that reserved band from four surfaces is what
gave the action bar room to be the right shape.

### Honest states

**Your Ohbox never claims to be empty while it is still loading.** On first open it could stand
for the better part of a minute reading "Nothing in your Ohbox. This device keeps your recent
mail. The rest is on your server", with a control offering to load older mail — and then your
mail would arrive. The first sentence was already held back until the app had read its local copy
once; the rest of the pane was not. "This device keeps your recent mail" says where your mail is,
which is not something the app knows before it has looked, and the only button on the page
pointed backwards past mail that was on its way. The sentence and the control now wait together
for the same thing the first sentence waits for.

### Large mailboxes finish importing

**A big folder no longer starves the ones behind it.** One sync pass reads every folder you watch
against a single budget of read/unread and flag changes, and it used to spend that budget in
folder order, each folder taking all it could. A folder holding thousands of changed messages
needs many passes to drain, and while it did, no folder behind it was ever asked — so every cycle
reported a backlog, the mailbox never reached the state that records a first import as finished,
and it went on describing itself as importing while doing no work.

The budget is shared now. Every folder that still owes changes gets an equal portion of what is
left, and one that cannot use its portion hands it to the folders behind it, so a pass still
spends the whole budget. One owing folder per cycle is exempted from the share in rotation, so
the front of the queue keeps moving and no folder is permanently last. Which folder is read first
is unchanged — that order is what keeps new mail arriving quickly.

## [0.7.2] — 2026-08-08

### The one that matters: the app opens your mail

**Connecting a mailbox left you looking at an empty white window.** The connection itself
succeeded every time — the account was authenticated and your mail was pulled down onto the
machine — and then the window went blank, with no message and no way back in. Relaunching showed
the same nothing, because the mail was already there and the app failed at the same point. It was
not specific to hosted accounts: connecting your own mail server failed the same way, at the same
moment.

The cause was in how this repository is assembled rather than in the app. The client talks to the
mail engine on your machine over the same `/sync` protocol client a hosted account is read with,
and that module was not published here — a stand-in stood at its path instead, one whose
constructor throws by design. So every installer built from this source carried a sync client that
refused to start, and it refused at the first moment a mailbox was ready, which is a few seconds
after you connect one.

The real module is in this repository now, and the build checks which of the two is in the bundle
before it ships: an installer whose engine build carries the stand-in fails to build rather than
reaching you. The artifact you download is also rendered and asserted before it is packaged, which
it never was before — that check alone would have caught this, and it now runs on all three
platforms.

**And a window that cannot draw says why.** Whatever the cause, a failure while the app is starting
puts a message on screen with the reason in it, instead of nothing at all. An empty window is
indistinguishable from one that is still loading, and there was no way to tell them apart.

### Reading

**Mail renders at its natural size.** The viewer had one answer to a message wider than its
column: measure it, then scale the whole document down, text included, whatever made it wide. A
plain letter carrying a single long tracked link measured wide for that link alone and was shrunk
for its entire length — which is how a reading surface ends up both scrolling sideways and set in
type too small to read. Mail is classified now: a message that declares no fixed layout is laid out
at the column, at the app's own reading size, with long words broken and pictures kept in
proportion. A fixed-width newsletter grid keeps the scale-to-fit it has always had, because
reflowing one of those produces a collapsed pile of cells rather than a narrower newsletter.

**A conversation shows every message in full.** A thread rendered its other messages from their
snippets, so opening one showed letters ending mid-word inside full message anatomy — which does
not read as a preview, it reads as mail that has been truncated. The siblings are fetched and
rendered through the same viewer as the message you opened, so they inherit the sanitizer, the
sandboxed frame, remote-content blocking and dark adaptation with nothing to keep in step. The
snippet is now the loading state, which is what it always honestly was, and a body that will not
load says so and offers a retry instead of passing a fragment off as the message.

### Reading and filing

**Your Ohbox opens nothing until you open something.** Arriving at the Ohbox used to open the
newest unread message on its own, which fetched it from your mail server and put it one keypress
away from being marked read. Nothing opens now until you open it; the reading column rests, and
names the key that gets you in.

**Sharper judgement about junk.** Unsolicited commercial mail is screened out as junk whatever the
company sending it. The rule used to turn on whether the sender looked respectable, which let cold
sales approaches through as legitimate business mail; it now turns on whether you have a
relationship with them — a business you were a customer, guest, client or member of, still sending
you things you did not ask for, is a different thing from a stranger selling to you.

**"Syncing your mail" stops when the import is over.** The strip read a server stamp as a floor,
and a mailbox that never reaches a completely idle sync cycle never gets stamped — so the strip
could announce an import in progress for days over a mirror that was complete and readable. An
absent stamp now means "not known to be finished" rather than "in progress", and past the first
day it has to be corroborated by what the app can see for itself.

### Small things

**Two ⌘K commands say when they cannot act.** "Tag it" and "Resurface selection" act on the open
message, and with nothing open they used to run and do nothing. They are still listed — a command
that disappears is a command nobody learns — and they now say they are unavailable, the way the
keys behind them always have.

**A PDF this build cannot show is not a damaged PDF.** The line under a PDF that would not render
blamed the file. Inline PDF preview is not a capability the desktop app has; the line says so
instead.

## [0.7.1] — 2026-08-08

### Screening got a great deal better

**The Screener asks who wrote it.** The question a model is asked about a first-time sender used
to be "which folder does this belong in", and for a sender waiting at the gate the answer to that
question is, by definition, the gate — so it said "hold" for almost everyone and told you nothing.
It now asks the question you are actually asking, and the answer is a real destination: your Ohbox,
Reads, Receipts, screened out, or spam. "The Screener" is not one of the answers any more.

**The criteria changed too, and this is the substantive part.** The old wording admitted anything
with "a consequence if ignored", which is what every notification any service sends claims about
itself — an expired card and a "your storage is 70% full" warning both scored as Ohbox mail. The
criterion is now who wrote it: a person writing to you, or something you are genuinely in the
middle of. Measured against real mail before shipping, on eighteen senders across every class:
seven changed pile, and the notifications that had been crowding the Ohbox went to Reads.

**Say what belongs in your Ohbox, in your own words.** Settings now carries a sentence you write
yourself, and it is given to the model instead of ours whenever it judges a sender for you — both
as new mail is filed and when you ask about the senders waiting in your Screener. Leave it alone
and the product default is used. It is available on both doors, and it works with or without a
model set up: your mail is filed by rules either way.

**A sender the gate is holding nothing for is no longer offered for a suggestion.** Asking about
one produced an answer built from nothing, which is worse than no answer.

### Your own model, on the standalone install

**Bring a key, or run a model on your own machine.** A standalone install can now be given an
Anthropic API key, or pointed at Ollama running locally, and it uses that model for Screener
suggestions. Nothing is sent anywhere until you set one up, and the app is complete without one —
mail is filed by rules, which is the floor and always has been.

**Nothing is withheld from a model you chose any more.** The app used to refuse to ask about
certain mail at all, and the effect was that the senders you most wanted an answer for were the
ones you never got one for. Choosing to use a model is the consent; what protects you is what is
sent, not whether you are asked. Credentials, one-time codes and sign-in links are stripped out of
the text before it leaves — the subject matter survives, the secret does not.

### Reading

**Escape closes the menu, not the message underneath it.** Pressing it with the More menu open
closed both.

**A standalone install has a History pile and a working Screener queue.** The cutline that
separates senders you might still hear from is a Cloud setting, and an install with no Cloud behind
it was waiting for a number no server was going to send: there was no History at all, and senders
you had already decided about were queued up to be asked again. Where there is no such setting, the
default is the answer.

### Under the app

**The mail engine's build is reproducible, and the update feeds are checked before they are
published.** Building the engine twice from the same source now produces the same bytes, file for
file — which is what makes "this was built from the source in front of you" a claim anyone can
test. Both update feeds are verified against the public keys committed in this repository before
they are attached to a release, and the script that does it ships with the source, so you can run
it against a download yourself.

**Two devices can no longer both act on the same approval**, and a request from the window always
reaches the engine — an addressing bug could leave one hanging.

### Shipped in 0.7.0 and not written down at the time

These were in the 0.7.0 download; the notes for that release missed them.

**The Ohbox remembers your reading order.** Earlier is ordered by when you read things rather than
when they arrived, and a message is marked read when you leave it, not the instant it flashes past.

**The action bar is always there, and More is a menu.** The actions on a message are docked to the
message instead of appearing on hover, with the less-used ones gathered behind one control.

**The message viewer.** A dark reading mode that inverts mail written light and leaves mail that is
already dark alone; wide mail fitted to the column instead of overflowing it; and a body that
cannot be loaded says so instead of claiming to still be loading, for ever.

Unsigned on every platform: see the install notes in the README before you double-click anything.

## [0.7.0] — 2026-08-07

**One app, on macOS, Windows and Linux.** macOS shipped a second, separate client written
in Swift until now, drawing the same screens from its own sources. It is retired. All
three platforms now build from one application, so a line in these notes is true
everywhere rather than on one platform. The retired client's source stays in the
repository's history.

**Windows and Linux connect to your mailbox.** They were an interface preview running on
fixtures. The build you download now carries the mail engine: it speaks IMAP over TLS to
your own server, mirrors your mailbox to a database on your computer, and files new mail
into `ohmail/` folders on the server itself, where every other mail app you own can see
it. Your mail password is sealed under a per-install key held in your operating system's
own keystore.

**Two ways in, on every platform.** Connect your own IMAP mailbox directly, or sign in to
ohmail Cloud and read a mailbox Cloud already organises. In both cases the mail already
mirrored to your computer stays readable when the network drops.

**The app carries its own Node runtime.** The mail engine is a Node program and the
download contains the official Node build for your platform, checksum-verified against
nodejs.org's own manifest by the run that made your installer. Nothing to install first,
nothing on your `PATH` for the app to depend on.

**If you are on macOS and already have ohmail installed,** the update is a handover: the
app you have is a different program that shared this one's identity, and it offers you
this release through the update prompt it has always used. Your mailbox, your settings
and your stored mail password are untouched — the new app reads them where they are.

**Attachments.** Closing a PDF preview no longer takes the app down, and pressing an
attachment downloads it.

**Screening.** A first-contact sender the suggestion wants HELD is no longer shown as one
it wants admitted. The three-way answer is now carried end to end, and "apply all" leaves
the held ones alone — a consent gate must not grant consent in bulk on a verdict that
said "ask a human".

Unsigned on every platform: see the install notes in the README before you double-click
anything.

## [0.6.1] — 2026-08-07

**Cloud sign-in in setup.** Setup now offers ohmail Cloud as one of the two ways to add a mailbox:
sign in and read your Cloud account's mail on this Mac, read-only while you're offline. The engine
behind this shipped in 0.6.0, but the setup chooser still said the option wasn't built yet — it now
opens the sign-in.

**Reading, tidied.** A conversation opens at its most recent message instead of scrolling from the
top, and the reading list carries less clutter.

**Screening back into the inbox sticks.** Re-screening a sender that is already in the inbox now
writes a rule for them rather than a decision that had no effect, so they keep landing where you
put them.

macOS only. The Windows and Linux builds remain a fixtures-only preview of the interface.

## [0.6.0] — 2026-08-07

**Read your mail offline on macOS.** Sign in to ohmail Cloud and the app runs the mail engine
locally, mirroring your account's message text to the Mac and keeping it readable when the network
drops. Reading works offline; anything that needs the server — remote media, moving or marking
mail, editing a rule — is unavailable until you reconnect, and then the local copy catches up. The
hosted account stays the master, and only one organizer is ever active for a mailbox at a time.

**A prompt to turn on FileVault.** Because message text now lands on disk, the first Cloud sign-in
checks whether full-disk encryption is on and offers to open the setting if it isn't.

**Cc and Bcc.** Compose carries carbon and blind-carbon recipients end to end; Bcc rides the
envelope only and never appears in the delivered headers.

**A calmer message viewer.** Reads, Receipts and History open in one viewer, with an optional
two-pane list-and-reader in History, a dark reading mode for the message body you can override per
message, and tag pages that read in place.

**Ask-me-when resurfacing.** Snooze a message to tomorrow, next week, or a day you pick.

**Sharper screening.** A DKIM failure counts against a message only when the signature is aligned
with the sender, so an unrelated mailing-list signature no longer demotes legitimate mail.

The Windows and Linux builds remain a fixtures-only preview of the interface.

## [0.5.0] — 2026-08-07

**Signed auto-update.** The app checks for updates and installs them on your word, with the
downloaded payload cryptographically verified before it runs — Sparkle (Ed25519) on macOS,
minisign on Windows and Linux. The signing keypair is independent of any OS code-signing
certificate, so the update is verified even though the apps themselves are unsigned. "Check
for Updates…" is a native menu item; the app never reaches the network from its interface.

**Two-door onboarding on macOS.** Set up a mailbox one of two ways: pick a mail provider and
use an app password (presets for common providers), or sign in to ohmail Cloud and read your
mail over HTTPS. The Cloud credential lives only in memory for the session.

**Local send.** The macOS engine sends over SMTP using the same login it opened IMAP with —
one credential per mailbox.

**A quieter window on macOS** — the title bar merges into the app's surface — and a
**network-egress allow-list** that restricts the app's outbound connections to a named,
disclosed set of hosts.

## [0.4.0-preview] — 2026-08-06

**macOS is now a working mail client.** The `.dmg` carries the local mail engine,
built from this repository's source on the release runner and embedded in the app
beside a vendored Node; the packaging job boots the assembled bundle before it is
uploaded. Windows and Linux remain an interface preview until the engine is ported
to their shell.

### Added

- **The local mail engine ships in the macOS build.** It connects to your own IMAP
  server over TLS, mirrors the mailbox to a local store, and organises new mail into
  `ohmail/` folders on the server — a Screener for first-time senders, Reads,
  Receipts, and the rest — visible in every other mail client. The mail password is
  sealed under a per-install key in your login Keychain.
- **Optional on-device AI.** Bring your own Anthropic key, or run a local model such
  as Ollama, so nothing leaves your machine for suggestions. It is off unless you
  turn it on, and one-time codes and login links are structurally excluded from
  anything AI sees.
- **One organiser per mailbox.** A claim written into the mailbox itself keeps a
  desktop install and the hosted service (or a second machine) from both organising
  the same mailbox at once; ceasing to organise is automatic and becoming the
  organiser is always an explicit choice.

### Changed

- **`open -a ohmail --args --demo`** now means "look around without connecting a
  mailbox" — the fixture world every earlier build showed by default. Launched
  without the flag, the macOS app asks for a mail server and connects.

### Packaging

- The release runner builds the engine from the published source with a pinned
  esbuild, vendors the official universal Node (checksum-verified), embeds both in
  the app, audits every bundled third-party licence for GPL compatibility, and boots
  the assembled bundle to prove it starts before the `.dmg` is uploaded.

## [0.3.0-preview] — 2026-08-05

**Still a preview**: no engine ships in these artifacts, so they do not connect
to a mailbox. The macOS app now contains the code to launch and supervise a local
engine, and it stays inert because it finds nothing to launch.

### Added

- **Compose is a rich text editor.** Bold, italic, lists, headings and links, in
  the inline reply as well as the compose view, where before it was plain text.
  A send may now carry markup alongside its plain-text alternative.

### Changed

- **A Screener decision names the folder it chose.** It used to answer with only
  two destinations, so three of the five decision buttons wrote a rule pointing
  at a place the user had not picked.
- **A partial first import stops presenting itself as a finished one**, so a
  mailbox that is still filling no longer reads as complete.

### Fixed

- The formatting editor kept only the first of two changes that landed in the
  same tick.
- Two different sets of key bindings could produce one cache key.
- A render check that could pass against a stale bundle.
- The macOS orphan test could time out on a loaded CI runner: its reader kept its
  buffer in a local, so a line arriving in the same read as the one it matched
  was discarded. The property under test — that killing the shell leaves no
  engine process behind — is unchanged.
- Two installer inspection checks piped a producer into `grep -q`, which exits at
  its first match and kills the producer; under `set -o pipefail` that reported
  the wrong thing.
- The URL-string audit over the shipped binaries counts 14 on Linux and 15 on
  Windows. The editor brought one new documentation link into the bundle, which
  is the pinned count doing its job.

## [0.2.0-preview] — 2026-07-31

The same interface under its real name. **Still a preview**: this build does not
connect to a mailbox either, and is not meant to until the engine slice lands.
0.1.0-preview's artifacts were left where they are rather than relabelled, so
this is the first release whose files are called `ohmail_*`.

### Changed

- **The version is 0.2.0, not 0.1.1.** Nothing here is a patch: the product is
  called something else than it was, and the installers a stranger downloads have
  different names. It is not 1.0 or a beta either, because the sentence above is
  still true — 0.x means a preview of the interface, and it will keep meaning
  that until the engine ships. `tauri.conf.json` and `Cargo.toml` carry the bare
  `0.2.0` the MSI bundler requires; the `-preview` suffix lives in
  `package.json`, `Info.plist`, the tag and this file.
- **The published message catalogue is a single file, and it grew.**
  `apps/webapp/messages/en.json` is shared with the Cloud client and is published
  whole, so it now also carries the strings for surfaces the desktop app has
  never rendered — a sign-up wizard, plan cards, a marketing page. Those screens
  are Cloud-only and are not part of this repository; their text is compiled into
  the Windows/Linux bundle only because the catalogue is not split. Cosmetic, and
  worth knowing before you run `strings` over a binary and find a price in it.
- **The demo decision left the React module** so it can be tested on its own,
  and the plan card became one template rather than three hard-coded plans.
  Neither changes what the desktop app renders.
- **Renamed: `mailoh` → `ohmail`, on `ohmail.app`.** The mark is unchanged — the
  same outlined "oh." with its terracotta period, the same icon files. Only the
  name set as type moved. This reaches everything a user can see or type: the app
  and window titles, the macOS bundle identifier (`io.mailoh.desktop` →
  `io.ohmail.desktop`) and its Tauri variant, the installer filenames, the Swift
  module and product names, and the repository itself
  (`trafficflowhq/ohmail`). The Debian `Package:` field follows `productName` and
  is now `ohmail`, so the uninstall command is `apt remove ohmail`.

  The `0.1.0-preview` section below was written under the old name and is left
  as it was: it describes a release that really did ship as `mailoh`, and its
  assets really are called `mailoh_*`. A fresh release is cut from the renamed
  build rather than relabelling those files.

  Precisely, for anyone comparing the two release pages: 0.1.0-preview's six
  files are `MailOh.dmg`, `MailOh.app.zip`, `MailOh_0.1.0_x64_en-US.msi`,
  `MailOh_0.1.0_x64-setup.exe`, `MailOh_0.1.0_amd64.AppImage` and
  `MailOh_0.1.0_amd64.deb` — the casing `productName` carried at the time.
  Renaming them now would invalidate the six checksums published against them,
  which is the whole reason a new release exists instead.

### Fixed

- **The rail wordmark still read the old name.** It is painted as two `Text` runs
  so the accent falls on "oh", which means the brand never appears in the source
  as one string and a grep over the tree cannot see it — the rename sweep missed
  it, and its `.accessibilityLabel` had begun contradicting its own visible text,
  telling a sighted user and a VoiceOver user two different names.
  `testWordmarkReadsOhmailHoweverItIsSplit` reconstructs the concatenation of the
  runs and asserts all three agree; verified by mutation.
- **Two claims the rename sweep turned false.** `apps/desktop/README.md` said
  `productName` "used to be `OhMail`, which kebab-cased to `mail-oh`" — it cannot:
  `OhMail` kebab-cases to `oh-mail`, and the value that produces `mail-oh` is
  `MailOh`, which is what it really was. `TRADEMARK.md` named the macOS bundle
  `app.ohmail.app`; the bundle is `ohmail.app`, and `app.ohmail.app` is a website.
- **The CI binary audit was renamed along with everything else**, to
  `ohmail|trafficflow` — but during a rename the old name is exactly what you
  still want asserted against. Both jobs now match `ohmail|mailoh|trafficflow`.
- The "Desktop or Cloud" table in the README described the product the engine
  will make possible as though it already existed. The rows waiting on it are
  marked, and the paragraph above the table says so.

## [0.1.0-preview] — 2026-07-30

The first tagged build. Three platforms, one interface, a fictional mailbox, and
no network in any of them.

### Added

- **ohmail for macOS** — a native SwiftUI client. Every surface: Ohbox, Screener
  (two-pane, decision bar, bulk undo), Reads with its waterline, Receipts,
  triage piles with the Reply Run, tags, search, compose, settings. Light and
  dark, down to a 390 pt window, keyboard-first with a ⌘K palette. Ships with 99
  tests and a `--smoke` render check that hosts every route offscreen and fails
  if anything draws nothing. (2026-07-30)
- **ohmail for Windows and Linux** — a Tauri v2 shell rendering the same
  interface, built by Vite from the shared React shell rather than forked. The
  webview is locked down: `"permissions": []`, `withGlobalTauri` off,
  `assetProtocol` disabled, no `invoke_handler`, no plugins, and a CSP of
  `connect-src 'none'`. `offline-guard.ts` replaces fetch, XHR, WebSocket,
  EventSource and sendBeacon with functions that throw, so "no network" is
  testable rather than merely claimed. (2026-07-30)
- **The design system** — `@ohmail/tokens` (colour, type, spacing, radii,
  shadows, motion, z, in light and dark), `@ohmail/ui` (34 components, 2 hooks)
  and `@ohmail/fixtures` (the demo mailbox everything renders). The tokens carry
  an anti-drift gate: a test parses the canonical design prototype and fails on
  any divergence. Every colour, radius and layout value in the SwiftUI theme is
  then compared numerically against `packages/tokens/src/tokens.ts`, so the two
  clients cannot drift apart either. (2026-07-29)
- **`@ohmail/client-engine`** — the delta-sync core the shell runs on: an
  idempotent apply core, an IndexedDB mirror that writes page and cursor in one
  transaction, selectors, local search, and an optimistic overlay in which the
  user always wins. In this repository it runs against `FixturesAdapter`, a
  complete in-memory server. (2026-07-30)
- **The "oh." icon system** — one master mark in three optical tiers, so it stays
  legible from 16 px to 1024 px. `Resources/ohmail.icns` is the macOS bundle
  icon; the Tauri shell carries the same mark. (2026-07-30)
- **CI that builds what you download** — GitHub Actions produces a `.dmg` and a
  zipped `.app` on macOS 15, `.msi` and NSIS `-setup.exe` on Windows, and
  `.AppImage` and `.deb` on Linux, on every push. Each run prints the toolchain
  it used and the artifact's sha256, so an unsigned download can be checked
  against the run that made it. (2026-07-30)
- **The repository's own paperwork** — GPL-3.0 with a COPYRIGHT statement that
  says what it covers, TRADEMARK.md for the one thing the licence does not carry
  (the "oh." mark and the icon family), CONTRIBUTING, SECURITY, and screenshots
  taken by the app's own `--shot` mode. (2026-07-30)

### Changed

- The repository is `trafficflowhq/ohmail`. It was `mailoh-desktop` while the
  macOS app was the only thing in it; the Windows and Linux shells made that name
  narrower than the contents. The Rust crate was renamed with it. Nothing shipped
  changed: the binaries are still `ohmail` / `ohmail.exe`, and the `.deb` still
  installs `usr/bin/ohmail`. (2026-07-30)
- The demo mailbox is entirely fictional — no real people, no real brands, no
  real domains — and every name in it was cleared before use and recorded in a
  registry that CI greps. (2026-07-29 – 2026-07-30)
- Mail is never collapsed. "N more" placeholders were removed everywhere and held
  Screener mail became a structural array, so every held message renders in full
  and a Screener decision carries all of it. This is a product rule, and the
  guards on it are mutation-tested. (2026-07-30)

### Fixed

- **The Windows installers no longer download WebView2.** Tauri's default
  `webviewInstallMode` had put a WiX custom action in the `.msi` that ran a hidden
  `powershell.exe` against `go.microsoft.com`, and shipped `NSISdl.dll` in the
  `-setup.exe` for the same purpose — an outbound connection made by a product
  that says it cannot make one. Now `"type": "skip"`, and CI greps the built
  installers for all five signatures so it cannot come back. The honest cost is
  documented: the installers do not provide WebView2, which Windows 11 and any
  updated Windows 10 already have. (2026-07-30)
- The `.deb`'s package name is `mail-oh`, not `mailoh` — Tauri kebab-cases it out
  of `productName` and gives no way to override it. `apt remove mail-oh` is the
  command. Pinned in CI so the documentation goes red rather than stale.
  (2026-07-30) — *historical: this entry describes the `mailoh` release. The
  product has since been renamed and `productName` is now `ohmail`, which
  kebab-cases to itself; see the rename entry under Unreleased.*
- The Linux `.deb` inspection in CI anchored its assertions on a leading `/`,
  which `dpkg-deb -c` never prints, so three checks could never have matched.
  (2026-07-30)
- TRADEMARK.md claimed the icon files were the only binary artwork here, which
  contradicted COPYRIGHT two files away, and pointed forkers at a path that does
  not exist in this tree. (2026-07-30)
- Both READMEs overstated the `strings` audit of the release binaries. They now
  enumerate all 13 strings on Linux and 14 on Windows, including the four that
  are not URLs at all, and CI pins the counts. (2026-07-30)
- `ThemeProvider` no longer mismatches on hydration: a deterministic first
  render, then post-mount adoption that never clobbers the pre-paint stamp.
  (2026-07-30)

### Security

- No IMAP client, no HTTP client, no telemetry and no update check exists in
  either build. On macOS the entire app imports AppKit, Foundation, SwiftUI and
  Observation, and nothing else. On Windows and Linux the network APIs are
  removed from the page and the webview forbids connections outright.
- Nothing is signed on any platform. See the install notes in the README —
  Gatekeeper, SmartScreen and the AppImage's executable bit all need a manual
  step, and that is a real cost of a preview rather than something to gloss over.

[Unreleased]: https://github.com/trafficflowhq/ohmail/compare/v0.7.3...HEAD
[0.7.3]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.7.3
[0.7.2]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.7.2
[0.7.1]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.7.1
[0.7.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.7.0
[0.6.1]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.6.1
[0.6.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.6.0
[0.5.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.5.0
[0.4.0-preview]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.4.0-preview
[0.3.0-preview]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.3.0-preview
[0.2.0-preview]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.2.0-preview
[0.1.0-preview]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.1.0-preview
