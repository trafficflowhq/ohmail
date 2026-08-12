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

## [0.9.3] — 2026-08-12

Mostly about mail rendering as what it is, and about the app staying truthful while work
settles. Pictures a sender embeds now show in the letter instead of arriving as a blanked
box plus a download; filing verbs can be taken back with the same key that filed; pile
counts hold steady while a filing is still in flight; and a message scheduled to resurface
can no longer vanish into no list at all. The desktop launch also says what it is doing
instead of holding one sentence over an empty window.

### Reading

**Embedded images render in the message, and attachments mean files.** An image a sender
embeds by reference — a signature logo, a pasted screenshot, a newsletter's artwork — used
to render as a blanked box while being listed as a downloadable attachment. Now the message
shows it where the sender put it, and the attachment strip, the Files library and the
paperclip all mean the same thing: a file you could download. Nothing is ever fetched from
a URL the sender wrote — only the message's own parts are read, with strict budgets on how
many and how large.

**Sender names arrive with the mail.** Messages used to reach the reader as bare addresses;
the name the sender writes on their own From line is now captured and shown.

**Mail stays legible at narrow widths.** Tables in mail no longer split numbers in half —
data cells keep each value whole, and a table wider than the column scrolls inside the
message. Wide code blocks keep their whitespace and scroll instead of wrapping
mid-identifier. Plain-text receipts that align columns with spaces render aligned. The
phone reading overlay paints an opaque ground and gains a visible back button, and an
unknown address lands on a real not-found page with a way back.

**The thread column's rendering is finished.** A conversation's message panels keep their
shadows intact, a partially scrolled panel runs to the window's edge before it is cut, the
column casts no shadow of its own, and the stray vertical line at the list/viewer boundary
is gone.

**Smaller reading corrections.** The quoted-history control is the compact pill it was
designed as; "Show original" recedes to a quiet footnote; and the widest message action row
no longer overflows its pill.

### Reading state

**Mail you had already read no longer shows as new.** On a mailbox with existing history,
the Reads and Receipts piles treated the absence of a "seen up to here" line as "everything
is new". They now fall back to the mailbox's own read state, so mail read before this app
ever ran — or read in another client — presents as read.

**"Mark all read" clears everything the view shows** — flipping unread messages on your own
mail server too, so other clients agree — and answers with an undo that replays exactly the
messages the press flipped.

### Keys and filing

**Keys work where the interface says they do.** The message verbs act inside the Triage
view, reply's `r` and `shift-R` work wherever a message is read, Escape closes what is open
everywhere — including the search box and the narrow-width drawer — and opening a search
hit lands on the message that was clicked, not the one nearest the end.

**Filing is reversible.** The three "not now" verbs — Later, Park, Resurface — are toggles:
the verb that filed a message takes it back out, from the key, the button and the palette
alike. Rows carry a quiet badge naming the state, and the buttons show their pressed state.

**Pile counts hold steady while filing settles.** A message moved between piles was
briefly counted in both; the count on the rail and the pile it names are now the same
number through the whole round trip.

**One "? shortcuts" button replaces the pane-foot key legends** — it opens the complete,
always-current shortcut sheet instead of a hand-written excerpt that clipped mid-word.

### Ohbox and resurfacing

**A due resurface lands pinned and unread in the Ohbox — never in no list.** A message
whose resurface time came could vanish from every view while remaining findable only by
search. It now pins at the top of the Ohbox, arrives bold, and the pin is spent by reading
or re-filing it, whichever route does it.

**A resurfaced row is one row** while the pin is still settling, and a conversation keeps
its faces when your own reply is its newest message.

**A self-send is one panel.** A message sent to your own address could render as identical
twins; the conversation now collapses the copies and the real row outranks the provisional
one.

### Writing

**The docked reply is a floating card whose controls stay visible.** The recipients, the
toolbar, the attachment strip and Send/Cancel no longer scroll away — only the message text
scrolls. A grip sets the panel's height, and Reply is a toggle: pressing `r` again closes
the editor it opened, keeping the draft.

**A link popover replaces the browser prompt.** The field prefills with the link under the
caret, Remove appears when the caret stands in one, and destinations a mail client cannot
open are refused with a visible message.

**The picture-shrink dial sits in the attach row**, names its direction — Most, More, Some,
Off (original) — and remembers the choice per signed-in account.

**A sent message can no longer linger in Drafts.** Pressing Send during the autosave race
could leave the delivered message sitting in Drafts, reopenable with Send live. The send
now reports which row it used and the compose cleans up the other. Pasting a picture or
dropping a file attaches it through the same pipeline as the picker.

**The message leaves from the address on the From line when Send is pressed** — choosing a
different From after the first pause in typing used to change the screen and nothing else.
And a send that could not be confirmed now surfaces in Drafts with a line stating what is
and is not known, instead of vanishing from every surface.

**One sent row per send on Exchange.** Microsoft 365 saves its own re-rendered copy of
every submission beside the copy this client appends; the two are now recognised as one
message, and the provisional copy the interface shows stands down the moment the real one
arrives.

**The attachment cap is your mail server's own announced limit on the standalone desktop.**
The fixed "Up to 3 MB total" is the hosted API's ceiling and still applies wherever a send
rides that request; a standalone install now states and enforces the limit its own
submission server announces.

### Screening and privacy

**A forged From cannot inherit a contact's consent.** The authentication-results reader is
now actually wired per provider, so a message claiming a known contact's address is checked
against the mailbox provider's own verdict before it inherits that contact's standing — and
a backdated Date: header can no longer dodge the screening cutoff, because age is measured
by the server's own receive time only.

**A code hidden inside encoded mail is stripped before any AI request.** One-time codes and
sign-in links were already removed from text sent to the model; that now covers codes
arriving base64- or quoted-printable-encoded, on messages the credential screen has flagged.

**A reload paints the current piles.** Each reload briefly resurrected already-decided
Screener rows until the server's consent answer arrived; the answer is now remembered per
device — nothing that authorises rides the cache — so the piles open partitioned.

**A filing whose message was deleted from the server stops retrying.** The status bar
counted it under "Filing N messages…" indefinitely; a server-observed delete now settles it.

### Sessions and the app

**A session that ends mid-use says so.** Every surface used to report its own symptom as a
content failure. A confirmed session end now renders one sign-in prompt over a dimmed
shell, failure notes distinguish "your session ended" from "this could not be loaded", and
failures recorded while the session was bad are re-asked once it heals.

**The launch says what it is doing.** The desktop engine narrates its boot — setting up the
store, replaying recent changes, bringing the schema up to date — in the corner where the
app reports sync work. And the slow launch this narrates gets rarer: the write-ahead log is
checkpointed after every sync drain that wrote, so recovery replays at most one drain's
churn.

**German sessions read German throughout.** Relative-time stamps ("Synced 2 minutes ago")
and the generic provider label follow the app language, and the desktop binary now bundles
the strings both need.

**Anchored popovers clamp to the window** instead of opening half off-screen from an anchor
low in the window, with the lowest options unreachable.

**Settings tell the truth.** The Rules pane reflows at phone width instead of forcing a
sideways pan, a rule's confirmation opens at its row rather than off-screen at the top, and
the Notifications pane states what exists instead of rendering five switches nothing reads.
Sign-in copy promises "a passkey or a one-time code" rather than a passkey for everyone,
and a card-less trial says "Trial ends", not "Renews".

## [0.9.2] — 2026-08-12

Mostly about reading. A conversation is no longer one message with the others summarised
around it — every message on the thread is a panel you can read in place, and the mail
inside those panels renders as what it is: tables as tables, code as code, quoted history
folded away until you want it. The other half is the app remembering where you had got to,
so the piles you have already been through stop presenting themselves as new.

### Reading a conversation

**Every message on a thread is its own panel.** Opening a conversation used to show one
message in full and the rest as rows you clicked through one at a time. Now the thread is a
single scrolling column of full messages, in order, so reading a conversation is reading
rather than a sequence of decisions about what to open next.

**Each message carries its own header** — the subject, the people, and its own actions menu,
with names first. On a long thread the header travels with the message it belongs to, so it
is always clear which message an action is about.

**Recipients are written out, and each person is a popover.** To and Cc list the people
rather than a count, and pressing a name shows that person's address and the actions for
them without leaving the message.

**Plain HTML mail renders its own structure.** Tables arrive as tables, lists as lists, and
links are real links. Mail that was written with structure keeps it instead of being
flattened into a paragraph.

**Code in a message reads as code**, in a monospaced block that stays inside the letter
rather than pushing the layout sideways. Long lines scroll within the block.

**The trailing quoted history folds behind a toggle.** The part of a reply that repeats the
message before it is collapsed by default, with a control to show it. A long back-and-forth
opens at the new writing rather than at the bottom of a pile of quotes.

### Where you had got to

**Reads and Receipts remember your last visit.** Each of those views now draws a line at the
point you had reached, with everything that arrived since it above. Leaving the view commits
the line — so the next visit is measured from when you actually left, not from whichever
message happened to be on screen.

**The sidebar counts those two piles by what is new since your last visit**, not by what is
unread. For a pile you read through in passing, "unread" was never the number you wanted.

**Rows in those two views no longer carry their own unread dot.** The line is the answer to
"what is new here", and a per-row marker beside it was a second, quieter answer that
disagreed with it often enough to be worth removing.

### Screening

**People you dealt with months ago stop coming back to the queue.** A sender you had already
decided about could reappear in the Screener as a first-time sender waiting on you, because
the app had no record of where your screening history began. It does now, and mail from
before that point files itself the way your existing decisions say it should.

**Senders you screened out read as decided.** Their rows are dimmed rather than presented at
full weight, so a list you have already worked through looks worked through.

**The AI allowance line survives an empty queue** and refreshes after a purchase, instead of
disappearing when there was nothing waiting and going stale once you had topped it up.

### Lists

**Drag a message row onto the sidebar to file it.** The rail's targets accept a dragged row
and apply the same verbs the row's own controls do — the gesture is an alternative to the
menu, not a different set of rules.

**A conversation's faces sit beside its subject, and one sender leads the row again.** The
people in a thread are shown next to what the thread is about, rather than the row being led
by whoever happened to write last.

**Pile titles are one size.** Different lists were rendering their headings at different
sizes depending on how they were reached.

**`k` is the inverse of `j`, including the way into a list.** Moving up from the top of a
list and moving down from outside it now mirror each other, so the two keys undo one another
everywhere rather than nearly everywhere.

**A long wait draws the shape of the screen.** The two waits that are genuinely long — first
boot and a large view opening — show the layout they are about to fill instead of an empty
frame. It appears only after a short delay, so a fast load does not flash a skeleton.

**A failing sync says so exactly once.** At some window widths the notice appeared twice.

### Writing

**Attach files to an inline reply, in a roomier editor, and choose which address answers.**
Replying without opening a separate window now offers the same attachment and From controls
as a full compose.

**Pictures are shrunk before they are attached**, on your machine, so a photo straight from a
camera does not become a message your recipient's server refuses.

**The attachment limit comes from your mail server.** The cap shown while composing is the
size your provider actually accepts, read from the server, rather than a fixed number that
was wrong in both directions depending on who you use.

**The message box takes a click anywhere in it**, and applying Code across several lines
produces one block rather than one block per line.

**A new message to a domain you send from leaves from that address.** Writing to a domain you
hold an address on picks that address as the sender instead of defaulting to your primary
one.

### Signing in

**Session lifetimes roll per surface** — 90 days on the web, 400 days on an installed app.
An installed app is a device you have already unlocked, and it is treated that way rather
than being signed out on the browser's schedule.

## [0.9.1] — 2026-08-11

Mostly about the app getting out of your way: it stops doing work it had already
finished, starts promptly on an install that had been running a while, and closes when
you close it. The rest is the reading and writing surfaces catching up with the rest of
the app.

### Lighter, quicker to start, and it quits when asked

**The app no longer re-reads your whole mailbox every twenty seconds.** When it is signed
in to a hosted account, the pass that fetches message bodies recorded its finishing
position in a way it then read back as "not started", so a walk that had completed began
again on the next poll, and on every poll after that, for the life of the run. Nothing was
ever wrong with the mail — the same rows were written back over themselves — but the work
never stopped. It now records that it has finished, and afterwards fetches only the bodies
this device is actually missing.

**A slow launch is fixed at the cause.** The local database keeps a write-ahead log, and
nothing was trimming it while the app ran; on an install that had accumulated a large one,
starting up meant replaying the whole log before the window appeared, which on the worst
installs took close to two minutes. The log is now trimmed periodically, so it does not
reach that size. The launch also waits long enough for a recovery that is genuinely under
way to finish, instead of reporting a healthy engine that is repairing itself as one that
failed to start — and cutting that short was the worst thing to do, because an unfinished
recovery leaves the log where it was and makes the next start longer still.

**Quitting no longer kills work in progress.** With a hosted account the sync now stops at
the next page or batch when you quit or sign out, and the app waits for it to finish
before closing the database. It used to queue behind a sync that was still starting new
work, miss its shutdown grace, and be killed outright.

### Reading

**A message you have read leaves New straight away.** Marking a message read moves the row
out of New and updates the count immediately, without waiting for the server to answer.

**A conversation's row is led by the people in it**, on every list, rather than by whichever
message happened to be last.

**Every mail time is shown in your own timezone.** Times in lists and in open messages used
to be drawn as UTC, so a message that arrived at 16:32 could be stamped 14:32.

**Hovering a date names the exact day and time, and one press changes the whole list.**
Relative dates are easy to read and cannot say *which* Saturday; pressing any date in a
list switches every date in it — and the open message with it — to the exact form, and back.
A message that carries no date of its own gets neither, rather than an empty promise.

### Screening and unsubscribing

**Unsubscribing when you screen someone out is visible in Settings and can be turned off.**
Under Screener there is now a switch for it, with what it does written beside it: one
request per list, once, sent from our servers so your address and your reading times stay
out of the sender's log. Senders who offer no one-click link are filed and nothing is sent
for them, and a request already sent cannot be taken back.

**The notice that tells you an unsubscribe went out now covers marking mail as spam,** not
only screening a sender out — the request was already being sent in both cases.

### Tags

**Ten tag colours** instead of three, and **the Tag control moved into the row's action
pill**, beside the other things you can do to a message.

### Writing

**Recipients are chips, and a reply's audience can be edited.** Addresses in To, Cc and Bcc
are separate items you can remove one at a time and move between fields with the keyboard,
and a reply no longer commits you to the recipients it chose.

**Cancelling a message asks where you are writing it.** The question appears at the message
rather than in the middle of the screen, and it says plainly that discarding deletes what
you have written on your account as well as here, and cannot be undone.

**The address you are replying from is a control you can change,** not a fixed line with a
notice attached.

### Resurface

**"Now" is one of the choices.** Resurface offered Tomorrow, Next week and a date picker
and no way to say *now*; it does, and the message comes back to the top immediately.

**A scheduled resurface arrives on a standalone install too.** Bringing a message back at
its due time was done by the hosted service, so an install with no hosted account never did
it at all.

**A resurfaced message is pinned on every device, not only the one that asked.** The pin
used to exist only on the screen that pressed the button, and disappeared from it a moment
later.

### Settings

**The away responder has its own section** rather than sitting inside another one — and a
hosted account reached from the desktop app now has the responder at all.

**Mailboxes says where a hosted mailbox is managed and opens it,** and can show **how many
messages each mailbox holds**.

### Signing in

**Linking the app to a hosted account no longer means retyping a code.** The browser hands
the code back to the app directly; the app keeps a secret the browser never sees and proves
it when it claims the code, so a program that intercepts the handover holds something it
cannot spend. Typing the code in by hand still works and is unchanged.

### Sync

**A resume point the server can no longer honour is refused rather than answered emptily.**
A device holding a position ahead of the server's history used to receive an empty answer
for ever, and quietly stop receiving mail; it is now told to start again.

### German

**Two of the view names read plainer in German.** Reads is called Reads, and Resurface is
"Wieder auftauchen" — the words it uses elsewhere for the same action, so the pile and the
button that fills it now agree.

## [0.9.0] — 2026-08-11

The release that stops assuming your mail is in English and your mailbox speaks a password.
Microsoft 365 and Outlook.com sign in the way those accounts are meant to, the whole interface
speaks German, and conversations arrive in the Ohbox as conversations rather than as a scatter of
replies.

### Microsoft 365 and Outlook.com

**Connect an Outlook account by signing in to Microsoft, not by typing a password.** Settings has a
Connect Outlook entry that hands you to Microsoft's own sign-in and comes back with the mailbox
connected — no app password, no dug-out server names. An account that refuses password sign-in to
mail clients could not be connected at all before this release; now it can.

**A mailbox that has fallen out can be reconnected with nothing to type**, and the return from
Microsoft finishes the job on whatever screen it lands on rather than only the one it started from.

### German

**The whole interface is available in German**, and the language is a property of your account
rather than of the machine in front of you. Set it once and the next device you sign in on is
already in German; leave it alone and each device keeps following its own system setting. Settings →
General has the selector.

Dates, times and counts follow the language, and a sentence that has no German translation yet falls
back to English rather than showing you the name of a missing phrase.

### Conversations

**A back-and-forth arrives in the Ohbox as one row, not as one row per reply.** Opening it shows the
newest message with the earlier ones folded above it, each openable in place.

### Getting around

**Switching between the Ohbox, Reads, Receipts and the Screener is immediate** — the view you asked
for is drawn from what is already on your machine instead of waiting for the network — and a change
you make on one device reaches your others noticeably sooner.

### Writing

**Reply all** is in the reply control, on `shift`+`R`, and it is offered only when there is actually
more than one person to answer. Replies keep the editor in view as you type and quote the message
you are answering without the wall of angle brackets plain-text mail arrives with. A reply names the
address it is going out from, and says so plainly when the address it arrived at is disconnected and
another one has to stand in; a new message lets you choose.

**Attachments and forwarding are finished**: attach files to a new message or a reply, forward a
message with its attachments intact, and see what you sent appear in your Sent folder immediately
rather than after the next sync.

### Screening

**A rule can now match on the subject or on the words in a message, not only on the sender.** That
covers the mail where the address changes every time but the subject does not — receipts, alerts,
newsletters sent through a rotating relay.

### Away

**An away autoresponder.** You write the subject and the message, and choose who gets it: only
senders you have already let past the Screener (the default), or everyone who writes. Each person is
answered once, from the mailbox they wrote to, and mailing lists, no-reply addresses, security mail
and your own addresses are never answered at all.

While it is on, the Ohbox says so at the top of the pile — an autoresponder you have forgotten about
is worse than none.

### Reading

**Plain-text mail with quoted history reads as nested quotes** rather than a bar in front of every
line, and **addresses written in a non-Latin script are shown the way their owner wrote them**
instead of the punycode the protocol carries them in.

**Marking a message unread does what it says everywhere** — the row comes back, the count agrees,
and the change reaches your server so every other mail app agrees too.

### Connecting a mailbox

**The connect screen works out your server's settings and tells you plainly when it cannot.** It
detects whether the server wants an encrypted connection and on which port; when a certificate is
refused it names the actual reason and, where the certificate is issued for a different name,
suggests the address that would work. A server that offers no encryption at all can still be used,
but only after you have been told and have said yes.

### Updating

**The app now looks for a new release by itself**, shortly after launch and whenever you pick Check
for Updates. That is a request to the update feed on GitHub and nothing else, and the release it
fetches is signature-verified before anything is installed, as it always has been.

**One question instead of three dialogs.** A newer release is downloaded in the background, and you
are asked once, without being blocked: restart now or later. "Later" is not asked again for the rest
of the run, and the app restarts only when you press the button.

### Sync and reliability

- A mailbox that has never synced is worked on first, so a newly connected account fills in promptly
  instead of waiting behind mailboxes that are already up to date.
- A sync that resumes after an interruption picks up from a point that is still current, rather than
  replaying from a stale one.
- Read and unread marks made in Outlook are adopted rather than overwritten.
- Long mailbox addresses no longer squash the controls beside them.
- Filing a batch of mail sends it to your server in groups rather than one message at a time, and one
  mailbox with a large backlog no longer holds the queue while it drains.

## [0.8.2] — 2026-08-10

A follow-up to 0.8.1 about staying up when a single screen has trouble, a calmer sync line, less
work for your machine, and reading, filing, tags and rules that behave the way you would expect.

### Nothing takes the whole app down

**A screen that hits trouble shows a notice in its own panel, and the rest of the app keeps
working.** Receipts in particular could get into a state that took the window down; it no longer
can. Whatever the screen, a failure is now contained to that screen with a short message and a way
to try again, instead of a blank window.

### The sync line is calm

**No more false "stopped" or "failed".** A first sync, or a brief retry, used to flash "Sync
stopped — sign in" or "Sync failed. Retrying." while nothing was actually wrong. The line now waits
for a real, repeated problem before it says anything is wrong, and while your server is briefly
refusing and the app is re-confirming, it says a quiet **Catching up…** rather than going silent or
crying failure.

### Lighter on your machine

**Reading long lists of mail no longer keeps the processor busy.** Every arriving change used to
redraw more of the list than it needed to; now a change redraws only the rows that actually
changed, which is most of the difference between a warm laptop and a cool one when the app has been
open a while.

### Reading

**A message shows its full body, and a header that names who it was to.** The reader draws the whole
message rather than a shortened copy, and carries a header with the sender and recipients. In a
conversation, the earlier messages fold into rows you can open one at a time over the one you came
to read.

**Tags on a message fold into one small control**, so a message with several tags no longer pushes
its own text down the page, and **any date can be clicked for the exact time** it happened — a hover
shows it, a click keeps it.

### Read state

**Screened-out and spam are marked read — on your server too, not only on this screen.** Mail you
never asked to see was counting against you as unread. It is marked read now, and the change is
written back to your mailbox so every other mail app agrees. **And you can mark a whole view read**
in one action.

### Tags

**Your tags and the messages under them sync in full — including on an install set up before tag
sync existed.** A tagged message that fell outside the recent-mail window the app keeps on your
machine now still reaches this device, so a tag page is the whole tag rather than only its recent
part.

### Settings

**Settings names your mailboxes and lets you manage your tags.** The Mailboxes pane lists what you
are connected to and labels each as Cloud or Local, and you can create a tag, rename it, change its
colour and delete it from the same place — the colours are one set, the same here as on the web.

### Rules

**The Rules screen is something you can search and sort.** A long list of the senders you have filed
can be searched, grouped by where their mail goes, and worked in bulk — including revoking several
rules at once — rather than scrolled from the top.

### Signing in

**Signing in from your browser no longer loops.** Linking the desktop app to a hosted account could
bounce you back through the sign-in page instead of finishing; it now completes in place.

### On the web

**A "Get ohmail for desktop" prompt when you are reading on the web,** and **a folder overview** that
shows exactly how ohmail arranges your own mailbox into its handful of folders — the same six folders
the app files your mail into on your server.

## [0.8.1] — 2026-08-09

A follow-up to 0.8.0, mostly about reading mail: how a message is drawn, how a conversation opens,
and messages that used to stall on their way to the screen.

### Reading

**Plain and business mail is drawn as text, at the app's own reading size — only a true newsletter
keeps its own layout.** A message that carries a design of its own still renders in its own frame;
everything else, which is most mail between people, is now the app's own type. A **Show original**
control on any message restores the sender's full formatting for that message when you want it, and
leaves again on the next press.

**A conversation opens at its latest message and shows every message in full.**

**A message that would not finish loading now loads, and offers a Retry if one ever fails.** Some
messages used to sit on "loading the full message" with nothing to do about it.

**A picture in plain mail is reachable again.** A photo, scan or chart pasted into an otherwise plain
message had stopped being openable when that mail became text; it is listed and opens again, and
leaves the list when Show original brings its frame back.

### The Screener

**The suggestion tools stay available even after every sender has a suggestion, and you can re-run
them.** They used to disappear once there was nothing left to suggest, which is exactly when you
might want to look again. On a hosted account signed in from the desktop app, the suggestion tools
now work too.

**The Screener no longer waits for ever on a message that will not load.** A held message whose
preview could not be drawn used to leave the Screener spinning.

### Tags

**Your tags now appear on the desktop, including on installs set up before tag sync existed.** An
install that was already running when this arrived asks for its tags rather than waiting for a fresh
one, and the messages it already holds regain their chips.

### What is held back

**Far fewer ordinary messages are mistakenly held back as sensitive.** The name of a two-factor
scheme, a link to a sign-in page inside a document, and several kinds of notification and archive
link were being read as secrets and hidden; they are ordinary mail and are now treated as such.

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

[Unreleased]: https://github.com/trafficflowhq/ohmail/compare/v0.9.3...HEAD
[0.9.3]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.9.3
[0.9.2]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.9.2
[0.9.1]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.9.1
[0.9.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.9.0
[0.8.2]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.8.2
[0.8.1]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.8.1
[0.8.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.8.0
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
