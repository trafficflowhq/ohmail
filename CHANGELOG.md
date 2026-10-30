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

What has changed since the last release is in [changelog.d/](changelog.d/), one file per change, until the
release gathers those files into its own section below.

### Still to come

Signed installers — a real Apple Developer ID and an Authenticode certificate. See
[Roadmap](README.md#roadmap).

## [0.30.17] — 2026-10-30

### Older letters made only of html and pictures get their words too

Letters stored before the previous change, with html and no plain-text part, now get the words the
reader draws as their text, once, in the background: the list shows their preview and search finds
them by their words. They stay where they were filed; nothing is sorted again. The desktop and the
phone do it from the mail they already hold, only while nobody is using the app and, on a laptop,
only on power. ohmail Cloud and your own server do it in the worker.

### The Screener's open Junk lists a letter you just marked spam

The 0.30.16 note said the Screener's Junk, open while a sender is marked spam, lists the letter once ohmail
has filed it. It did so only for letters held in ohmail/Quarantine: a letter filed into your mail server's
own Junk folder appeared only after leaving the segment and coming back, up to a minute and a half later.
While the segment is open, ohmail now reads the Junk list again every five seconds for up to a minute
after a sender is marked spam, puts the letter on top of the list once it is there, and then stops. The
rows you already have, older pages included, stay where they are. Web and desktop.

### The phone suggests recipients as you type them

On the phone, typing in To, Cc or Bcc now lists up to six people you correspond with who match what you
typed, as the web composer does, from the mail the phone already holds, whether it is paired or runs on
its own. A tap puts the person in the field and keeps the addresses already there.
Back closes the list before the composer, and at large text the names and addresses wrap in full.

### News and Receipts on the phone match the web

On the phone, an open letter in News now has Reply and Forward. They open the same composer as the reader, and a letter flagged not to be forwarded still asks first. Receipts now has Mark all read, like News, with an Undo. The count over both streams now uses the web's wording ("3 new since you were here", or "Nothing new since you were here"), so it no longer reads as an unread count that disagrees with the unread rows below it.

### The phone's Screener says a mailbox is still being read on its own first pass

On a phone that connects to the mail server itself and organizes the mailbox, the Screener's Waiting
shelf showed "0 first-time senders waiting" while that phone was still reading the mailbox for the first
time, then jumped to the real count minutes later. It now says the mailbox is still being read until the
first pass is done, as it already did on a paired phone. A relaunch over a mailbox whose first pass
finished long ago is not taken for one. Its count line also no longer blames "the
organizing device's" unread settings on the phone that is the organizing device.

### A picture-only letter with invisible preheader filler no longer reads as words on the phone

On the phone, an older letter in a conversation whose html holds only pictures, a hidden preheader
(`display:none`) and zero-width filler characters was drawn as a blank card and turned read after the
pause, although nothing of it had been on screen. It now counts as a letter without words, like one of
pictures alone: its card shows its files and the line that opens it, and it turns read only by that open.

### A letter with deeply nested html no longer stalls mail sync

The html parser ohmail reads letters with (htmlparser2) kept the elements a letter had opened in a way
that slowed down with every level of nesting. A letter built to nest tens of thousands of elements, or to
close many that were never opened, could hold the mail sync for 2 to 21 seconds while its text was
read, and on Cloud that delay held up other mailboxes on the same worker too. The phone's message view
spent up to 4.6 seconds cleaning such a letter, and search indexing up to 0.75 seconds. ohmail now carries a
fix to the parser that makes this cost grow in step with the letter's size, so the same letters take
milliseconds. Ordinary mail reads exactly as before. On every app: desktop, web, phone, Cloud and your own
server.

### Your own letters count as yours when your Sent folder has another name

On a mailbox whose Sent folder has a localized or custom name, such as 'Envoyés' or 'INBOX.Verzonden', the
apps now recognise that folder by the name the server reported when the mailbox was connected, as the server
already did for correspondents. Your own letters show under Earlier and in their conversations, rows read
"Me → name", your reply no longer brings a set-aside conversation back as if someone else wrote, and a
screening press no longer calls the Sent folder a folder you made. This applies on desktop, web, phone, Cloud
and your own server.

### A screen reader calls an unnamed picture in a letter a picture

A picture in a letter that its sender gave no alt text was read out by its data on the phone, often a
long run of letters and digits. It is now called "Picture" ("Bild" in German) on the phone, the web and the
desktop app, and a tracking pixel or a 1×1 spacer is skipped. A picture with alt text keeps it.

### An Undo that waits to be sent says Undone, and the command palette reaches every place

On web and desktop, an Undo whose writes could not reach the server yet (a server that is down or
restarting) said "Nothing changed — that did not go through. Try it again." a few seconds later,
although the Undo stood and was sent once the server answered again. It now says "Undone.", as an
Undo the server took at once does.

The command palette (Ctrl+K, ⌘K on a Mac) now has a Go to row for Answer Later, Parked, Resurface,
Drafts and History, as it had for the Ohbox, News, Receipts and Trash, and Settings shows its `g ,`
key there too. Every word you type is matched on its own, so "go to ohbox" finds "Go to the Ohbox"
and "zu historie" finds "Zur Historie". The Screener's row reads "Go to the Screener" and the
Settings row "Go to Settings", as in the shortcut list.

## [0.30.16] — 2026-10-30

### Sign-in notes reach every open window

Web and desktop, on ohmail Cloud and on your own server: the note that ohmail signed out an older copy of
your sign-in now leaves a window that is already open once you press OK on another device. The window asks
again when you come back to it, and every five minutes while the note shows; until now it kept the note
until it was reloaded.

Web, on ohmail Cloud: a tab opened within 15 seconds of a sign-in ending on this browser now shows the
sign-in form and the reason, for example "You were signed out on this browser.", instead of the start
page. The browser keeps a short-lived cookie that holds only the reason for those 15 seconds.

### The sign-in card after a refused session fits the desktop window

On the desktop, when ohmail Cloud or your own server ended the sign-in while the app was open, the
"Sign in" card was drawn a few words wide, one word per line, with its buttons below the window. It
now takes the same width and place it has after a relaunch. When the window had not shown any mail
yet, the card now stands on the window's own page instead of over an empty Ohbox. The keyboard and
screen readers now start in the card and cannot reach the mail behind it, and focus goes back where it
was once the card closes.

### The first click on Screened out or Spam does less work on the desktop

The first click on Screened out or Spam after opening the Screener spent most of its time on the desktop
working out the look of rows and letters it had not drawn before. The Screener now does that once, unseen,
right after it opens, so less of it is left for the first click. A letter's attachments and invitation now
show with its text, a moment after the list, instead of in the click's own frame. Desktop and web.

### The Screener opens faster the first time

The first time you opened the Screener after starting ohmail, most of the wait went on working out the
look and the type of rows and letters the window had not drawn yet. ohmail now draws them unseen while
you read the Ohbox, a piece at a time and only when you are not typing, clicking or scrolling, so the
Screener's first open no longer waits for that work. Leaving the Ohbox also no longer recounts every
pile before the next one appears, and moving between the menu, the list and the open message, by
key or by click, no longer redraws the whole view. Desktop and web.

### Mark unread stays when an earlier Mark read is sent again

On the web and desktop apps, Mark unread on a message you had just marked read now stays. When saving the
read failed for a moment, after a server error or a dropped connection, the app sent it again after your
Mark unread, so the message turned read again on the server while the list still showed it unread. The same
holds the other way round, for Mark read after a Mark unread. Your newest press now decides each message,
and only the messages it did not name are sent again.

### The desktop window follows older and low-contrast Omarchy themes, and says when it cannot

On Omarchy, switching to an older theme that only ships the sixteen terminal colors (mars), or to a theme
whose text color is dim on its background (netrunner), left ohmail in the previous look with no word why.
The terminal colors now stand in for the named ones, a dim text color is lightened (or darkened) until it
reads, and a theme that still cannot be made readable leaves one line in `engine.log` naming the theme and
the reason. Desktop app on Linux.

### Letters on the phone open again after a quick flick at the top of the list

On Android, two or three quick flicks toward the top of a list that was already at its top left every
letter in it unpressable, the Screener knock too, until the list was scrolled a little. A press on a
letter now opens it straight after such a flick, and News and Receipts read the letters resting at the
top by the usual rule.

### A letter you send to yourself shows once in its conversation

A reply or letter sent to your own address could show twice in its conversation, once as the Sent
copy and once as the delivered copy, with its text repeated in the reader and two rows in search.
It happened whenever the send took more than a moment: ohmail dated the delivered copy and the Sent
copy separately, a second or more apart, and then treated them as two letters. Both copies now carry
the same date, and two copies of one sent letter that differ only by their date are kept as one,
whichever reaches ohmail first. The kept letter is the one in your Inbox, unread until you read it,
also when your Sent folder has a name in another language, such as "Envoyés". This holds on the desktop, web and phone apps, on ohmail Cloud and
on your own server. Letters that differ in anything else stay separate. Letters already shown twice
stay as they are.

### Search opens the letter you pressed, and Trash and Junk show what you just moved there

On the web and the desktop:

- A Search result that opens in Receipts or News lands on the letter you pressed. Among short cards
  sharing one time, the cursor could settle on a card below it, so a Delete pressed next would have
  hit that other letter.
- Trash, open while a delete is still held for its Undo, lists the letter once the server has taken the
  delete, without leaving the view or reloading.
- The Screener's Junk, open while a sender is marked spam, lists the letter once ohmail has filed it,
  without leaving the segment.
- The command palette matches a phrase word by word: "go to ohbox" finds "Go to the Ohbox".
- Draft reply no longer quotes a price on an account the Screener already knows has no AI credits left;
  it says so instead.

### Rule dates, Send later on the night the clocks go back, and scheduled letters on the desktop

- Settings > Rules dated a rule (and a Screener decision) by the UTC day, so a rule made after midnight read
  yesterday's date. It now reads your own day, like every other date (web and desktop).
- On the night the clocks go back, Send later refused a time in the repeated hour ("That time has passed")
  although it was minutes ahead. During that hour a typed time now means the one still to come (web and desktop).
- On the desktop signed in to ohmail Cloud, Drafts > Scheduled now says when each letter sends, and keeps it
  after a sync.
- On the desktop, an open Settings > Screener or AI pane now follows a switch changed on the web or the phone:
  it reads the account again when the window comes back to the front, and every 30 seconds while it is open.

### Forwarding a letter with a long run of blank lines or deeply nested quotes no longer stalls

Turning a letter's html into its plain-text half took seconds when a code block held a long run of blank
lines: 100,000 of them cost about six seconds before the forward or send went out. It now takes a few
milliseconds and gives the same text. A letter nesting thousands of quotes or lists no longer turns into a
text part hundreds of megabytes long, or fails to forward: the text shows at most 32 levels of `> ` and
of list indent, as the reader already does. This applies on the desktop, the web, the phone, ohmail Cloud and
your own server.

## [0.30.15] — 2026-10-30

### The notice about signed-out older copies is one line

When ohmail signs out an older copy of your sign-in (a browser or the app restored from a backup, copied
to another computer, or closed at the wrong moment), the window says so in one quiet line above the mail,
at any window width, instead of a block that took the whole top of the window. Details shows the whole
sentence, each signed-out copy with its date and what to do; OK puts the notice away. On the desktop app
and the web.

### A browser that crashes right after renewing your sign-in stays signed in

The web app renews your sign-in in the background while you use it. If the browser crashed, was
force-quit or lost power shortly after a renewal, before it had saved the renewed sign-in to disk, it came
back with the one it had already used, and the server ended the session in that browser as if its sign-in
had been copied. The browser now writes down which renewal it sent before the request leaves, and keeps
that note until the next renewal, so after a restart the server sees the same browser finishing its own
renewal and the sign-in continues. An older copy of a sign-in is still refused, as before. On ohmail Cloud
and on your own server.

### Signing in again on a browser ends that browser's earlier sign-in

Signing in again on a browser whose sign-in had lapsed left the earlier one live on the server for up to
ninety days, where an old copy of that browser's profile could still use it. A completed sign-in now ends
the earlier sign-in of the same person on the same browser; one made before this release takes part once
it has renewed. Your other browsers, the desktop app and paired phones stay signed in. A browser profile
that was reset or reinstalled keeps no trace of its earlier sign-in, so that one still lasts until ninety
days without use, or until you press "Sign out all" beside your other web sessions in Devices. On ohmail
Cloud and on your own server.

### Every tab on an ended sign-in says the same reason

Web, on ohmail Cloud and on your own server: when two tabs open on a sign-in that has ended, both now say
why at the sign-in form, for example "You were signed out on this browser." Until now only the tab that
asked the server said so; the other said "This browser holds no sign-in." or gave no reason. A tab opened
within 15 seconds of the first gives the same reason. The form still shows at once.

### A signed-out browser tab stops asking the server to renew its sign-in

A browser tab left open after its sign-in had ended, for example after a sign-out on another device, sent
the server a renewal request every five minutes for as long as it stayed open, and each one was refused. It
now asks nothing more until somebody signs in again in that browser; the tab then picks the new sign-in up
within five minutes, as before. A renewal that failed because the server was busy or out of reach is still
retried. On ohmail Cloud and on your own server.

### A browser paired with your computer stays paired after a crash right after it renews

A browser paired with the desktop app renews its access in the background. If the browser crashed, was
force-quit or lost power shortly after a renewal, before it had saved the renewed pairing to disk, it came
back with the one it had already used, and your computer ended the pairing as if it had been copied, so
the browser had to be paired again. The browser now writes down which renewal it sent before the request
leaves, and keeps that note until the next renewal, so after a restart your computer sees the same browser
finishing its own renewal and the pairing continues, however long the restart took. An older copy of a
pairing is still refused, as before. Desktop app only.

### News and Receipts on the phone read only what rests on screen

On the phone, a letter in News or Receipts turned read when a scroll you drove carried it past the read line,
so a few fast flings marked letters you never looked at. The phone now follows the rule the web and desktop
apps follow: an item turns read once its first lines have rested on screen for 0.7 s, and a fling's glide
counts nothing. A fling or a quick scroll past leaves it unread, so does leaving with only its sender line
showing at the foot, and a scroll the app makes reads nothing; the list holding its place while mail arrives
does not stop the rest. An item you mark unread stays unread until you leave the stream. The line under the
News title and the one at the end of the stream say so. Android and iOS.

### A letter marked unread right after a dropped connection stays unread

When you opened a letter and the connection to your mail server dropped while ohmail was telling the
server it was read, pressing Mark unread before ohmail reconnected could be lost: the server kept the
letter read, and after the reconnect ohmail showed it read again. The unread is now sent, and the letter
stays unread in ohmail and on the server. On the desktop, the phone, ohmail Cloud and your own server.

### Undo takes back every letter of a conversation

On Android and iOS, Undo now takes back every letter of a conversation after Later, Park, Resurface or Done.
An Undo pressed while the conversation's letters were still being sent could leave some of them filed, so the
conversation showed up in Parked again and stayed there after the app was restarted. A press on one of its
letters made in that moment now also lands after the conversation's own, and a press on an open message no
longer waits while the phone saves that you have read it.

On every app, Mark unread on a message you had just opened, while the app was still saving that you read it,
now stays: when that save failed and was sent again, after a server error or a dropped connection, it marked
the message read again.

On the web and desktop apps, Undo after a press on a whole conversation or a selection now also takes back a
letter whose save was still being retried after a failed attempt; that letter used to stay where the press put it.
When every save of such a press failed for a moment, it said nothing had changed and offered no Undo, while the
letters stayed where it put them; it now says what it did, counts the letters still being saved and offers Undo.

### A reply typed in tabletop keeps its buttons off the crease

On an Android foldable half open like a laptop, a reply or a sheet that takes text now ends above the
crease while the keyboard is up, so Cancel, Send + Done and Send are no longer drawn across the fold.
Also on the phone app: in two panes the Sidebar button works while the "could not be saved" line stands
under it; a message or sender page in a pane ends a scrolled line in a fade under the status bar instead
of a bare cut; New mail shows no extra Back on the rail beside its own Cancel; a letter that goes on below
the composer's edge fades into it; and a sentence that appears after the earlier ones cleared lands over
the buttons at once.

### The phone's sentences say what is true

On the phone, several screens said something that was not so. The Tag sheet now marks the tags a message
already has, before each name, and a screen reader hears each as a checked or unchecked box, so a tap no
longer removes a tag you meant to add. A phone that is its own mailbox's only app no longer says drafts are
in your account on every device, or sends you to ohmail on the web or the desktop to finish one: it says
they are kept on this phone, and what the card itself can do. With no network the Ohbox says so once, at
the top, instead of again under the title, and "Connection lost. Reconnecting…" is no longer said twice.
The Servers page counts the messages on the device without an internal sync marker beside them, a restore
the server has already finished says "Restored to …", and a Screened out card calls its time the newest
letter's, which it is. The Screener's knock wraps its sentence at large text instead of cutting the count.
Connect names a refused certificate on the outgoing server as it does on the incoming one, says when a
switch to encryption was interfered with or did not finish rather than that the server offers none, and
tells a phone with no network that it is offline rather than to check the address. In English and German.

### Letters made only of html and pictures show their words in the list

A letter that has no plain-text part, such as a newsletter of pictures with its html beside them, now
keeps the words the reader draws as its text. The message list shows them as its preview, search finds
them, and body rules and screening read them, on the desktop, the web, the phone, ohmail Cloud and your
own server. Hidden preview filler, stylesheets and link targets are left out. Letters you already have
keep an empty preview for now; a later release fills them in.

### Search answers faster on mail its index has not reached yet

A search on an account whose mail the search index has not started on yet reads only the older
columns that hold that mail's words, and no longer plans or checks the index's documents it does not
have. The first page answers in about half the database time, with the same results in the same order.

### Counts say what they count

Several numbers said something other than what was on screen. On the web and the desktop app:

- Selecting a conversation in the Ohbox counts one row, not every message in it.
- The Answer Later, Parked, Resurface, tag and Drafts counts on the rail, and the Screener's Waiting tab,
  now say what they count to a screen reader and in their tooltip, as the Ohbox and Screener counts did.
- With one unread message, Mark all read is read out in the singular. "1 held message" and "1 message listed
  under History" are singular too, in English and German.
- The first-run summary no longer counts your own sent mail as screened.

On every app, the offer to screen mail from senders you never decided about says "at least" when there is
more such mail than one press takes, instead of giving the press's limit as the total. On the phone, the
Screener no longer says nobody is waiting while a mailbox's first import is still running. It says the
mailbox is still being read.

### The Screener counts the messages it shows, not "held" ones

A waiting sender's card and row in the Screener said "12 held messages — all shown" while some of those
letters were not held at all: mail from a sender you have not decided about that is still in the Inbox on
your mail server is listed on the card, and your decision moves it too, but it was counted as held. The card,
the row and the first decision in setup now say "12 messages — all shown" ("12 Nachrichten" in German),
which is what they list, on the desktop app, the web and the phone. Which letters stay out of the Ohbox is
unchanged.

### Five controls now say what they do, or do what they say

On the desktop and the web:

- Deleting a message in a mailbox that has no Trash folder said "Moved to Trash." and, seconds later, took it
  back with no reason. The refusal now names it: the mailbox has no Trash folder, and ohmail never erases
  mail. A second delete in that mailbox is refused at once, with the same sentence.
- The notice about who organizes a mailbox had a button named "Mark read" that marked no mail read. It is
  named "Dismiss" now (German "Ausblenden").
- On the desktop, a door to your own server asked you to "Sign in to ohmail Cloud" after its address step,
  forgot the address you had typed and spoke of a copy of your mail that a fresh install does not have. It
  now opens your server's own sign-in with the address kept, and that sign-in says which changes still wait
  on this computer, as the Cloud one does.
- `w` and the palette's "Switch layout" did nothing you could see in a window wider than 1023 or narrower
  than 392 pixels, where the two layouts look the same. There the palette leaves it out, and the shortcut
  sheet greys `w` and says why.

On the desktop, the web and the phone, the search box says "Search everything". It said "typos welcome",
but on the desktop and the phone a one-letter typo of a word in your mail finds nothing.

### The News list's last line states the read rule it follows

The line under the News list said scrolling past an item marks it seen, which stopped being true when
News began reading only what rests on screen in the stream. It now says so: an item turns read once it
rests on screen, and a quick scroll past leaves it unread. The demo's About text says the same. Desktop
and web, English and German.

### A downloaded attachment is no longer served from the browser cache to the next account

On the web app (ohmail Cloud and your own server), an attachment's bytes were kept in the browser's cache for an
hour without being tied to the session, so after a sign-out and a different account's sign-in on the same browser
the same attachment link could in a narrow case still be answered from that cache. Attachments are now keyed on the
session, as remote images already were.

### The .deb, .rpm and Flatpak builds no longer vanish when an accessibility tool reads their window

The Linux AppImage already carried an accessibility bridge with the upstream fixes for a crash: with a
screen reader, an automation tool or another accessibility client coming and going, the app could close
without a word. The .deb, the .rpm and the Flatpak now carry the same bridge too, and load it ahead of
your distribution's or the runtime's. Nothing else about how they use your system's libraries changes.

### A pull request under a Next route group runs only the tests it reaches

For contributors: a maintainer's pull request that changed a file under `apps/webapp/app/(product)/` or
`apps/mobile/app/(tabs)/` ran the whole test suite, because the per-PR test selector refused every path with
parentheses. It now reads a route group, a whole path segment `(name)`, as part of a path, and selects the
tests that file reaches, including the tests that read it by name. Parentheses in any other shape still run
the whole suite.

## [0.30.14] — 2026-10-29

### The sidebar no longer spends a line on the version number

The desktop sidebar showed "ohmail" and the running version under Command at all times. That line is gone.
The version stays in Settings, in the Updates section, and while an update is downloading or ready, pointing
at the update line at the foot of the sidebar names the version you run.

### A letter you stop on with the arrow keys turns read in History, folders, tags and the piles

In History, a folder, a tag, Answer Later, Parked and Resurface, a letter reached with ↓ or ↑ (or j and k in History) stayed unread however long you read it; only a click, → or a scroll in it read it. Now a letter the cursor stays on for 1.3 seconds with the window in front counts as opened, and it turns read once its first lines have stayed on screen for 0.7 seconds, as in the Ohbox. Scrolling the open letter with ↓ or ↑ in the reading column counts as opening it too, and in the Ohbox the same now goes for a conversation shown with j or k. Moving on sooner reads nothing, so passing rows still marks nothing. In a folder, a letter read this way keeps its place under New while the cursor is on it and moves under Earlier once you move on, so ↓ carries on through New. Its embedded pictures load once you stop on it or open it, not while you pass. This replaces the 0.30.9 rule that stepping through these lists with the arrow keys reads nothing. Trash and the Screener still leave a letter as it was. Desktop and web.

### A conversation you mark unread stays unread when j or k comes back to it

In the Ohbox on the desktop and the web, a conversation you marked unread with u or Mark unread turned read again about two seconds after j, k or the arrow keys brought the cursor back to it, because since 0.30.12 a conversation the cursor rests on counts as opened. It now stays unread while you stay in the Ohbox, however long the cursor rests on it, and scrolling it with ↓ or ↑ in the reading column does not read it either. A click, ↵, a press in the message or a scroll with the mouse or trackpad opens it and reads it as before. The same holds for a letter you mark unread in History, a folder, a tag, Answer Later, Parked and Resurface, and for one marked unread on another device while it is open here. News already kept a letter you marked unread.

### ohmail says why a sign-in was ended everywhere

When a browser or a computer presents a sign-in that was already renewed, which is what a restored
backup, a copied browser profile or home folder, or a stolen sign-in looks like, ohmail ends that sign-in
everywhere. Until now the sign-in form and the desktop app only said you were signed out. They now say
what happened and what to do: sign in again, and change your password if you did not restore or copy
anything. After you sign in again, on the web or in the desktop app, ohmail also lists the sign-ins it
ended this way in the last 14 days, with the kind of app and the time, until you press OK. On ohmail
Cloud and on your own server.

### A browser stays signed in for the full ninety days without use

A browser signed in to ohmail Cloud stays signed in until it goes ninety days without being used, but the
clean-up that ends old sign-ins ended it after sixty: opened again after two or three months, the browser
asked you to sign in with "You were signed out on this browser." The clean-up now ends a browser's sign-in
only once its ninety days have run out, and a browser that comes back after that reads "Your sign-in on this
browser has expired." A server of your own does the same when it runs that clean-up. A browser the old rule
already signed out asks you to sign in once more.

### The desktop app's ohmail Cloud sign-in stays on the computer that saved it

A copy of the desktop app's data opened on another computer (a copied, synced or restored home folder)
used to present a sign-in the first computer had since renewed. ohmail Cloud treats that as a stolen
sign-in and ends it on both computers. The saved sign-in now belongs to the computer that saved it:
another computer asks you to sign in, and the first one stays signed in. Updating keeps you signed in.
This covers sign-ins saved by this version and later; going back to an older copy on the same computer
is not covered.

### A letter delivered just before a restart or an IMAP outage reaches Sent once it can

When your mail server had accepted a letter but its copy could not be put in your Sent folder yet, Cloud
and your own server kept retrying only in memory, so a restart or a deploy at that moment lost the copy:
the letter went out but never appeared in Sent or its conversation. Now the copy is kept and filed once
your Sent folder takes it: on your own server for every letter, on Cloud for letters without attachments,
because Cloud never stores attachment bytes. While your mail server refuses every copy, for example a full
mailbox, the waiting copies are tried together after a minute, ten minutes, an hour, six hours and then
once a day, and a copy it refuses does not hold the others back. A refusal counts against a copy only when
the server says it is about that letter, for example that it is too large, or when your mailbox took
another waiting copy at the same time; after eight refusals that count, the copy is given up. Every copy is
kept for at most seven days: one that is still not in Sent by then is deleted. Each copy is filed once,
after a look in Sent.

### A letter with embedded pictures and no plain text reads whole in a phone conversation

On the phone, an older letter in a conversation whose body is HTML with embedded pictures and no plain-text
part showed only its subject and time, and turned read at the open although none of it had been on screen.
It now shows its text like any other letter, its pictures stay in its files, and it turns read only once you
have read it. A letter whose HTML holds no words the phone can show (only pictures, or HTML too large to
read) shows its files and says so in its card; a press on the card or its square opens it on its own, and it
turns read only once you have read it there, never because its card or its files were on screen.

### Undo after Mark all read in News keeps the new letters new, and two phone fixes

Undo after Mark all read in News or Receipts now puts back the "seen up to here" line where it was.
Before, the letters became unread again, but the header said "Nothing new", the tab lost its count
and the line sat above letters you had not seen. This was the same on the web, the desktop and the
phone.

On the phone, a reply to a letter in Answer Later now takes the letter out of Answer Later once the
reply is delivered, as on the web and the desktop. A phone that runs on its own, without an account,
no longer offers "Apply on all devices" for the Look, and no longer says the look applies on all your
devices: the look stays on that phone.

## [0.30.13] — 2026-10-29

### The sign-in form shows at once when a sign-in has ended

In Chrome, opening ohmail after your sign-in had expired, or had been ended on another device, could sit
on "Checking your sign-in…" for a minute or more before the sign-in form appeared. The sign-in form now
shows at once, with the reason, and the browser still clears its cache for this site, in the background.
A second tab that was checking the same sign-in goes to the sign-in form too, with the same reason. On
ohmail Cloud and on your own server.

### Signing out and deleting your account finish at once

In Chrome, Sign out could take seconds, on a long-used browser up to its ten-second limit, and then say
the server had not confirmed it, although it had. Deleting your account could wait just as long on its
receipt, and other tabs could not sign in meanwhile. Both now finish at once. The browser still clears
its cache for this site afterwards, in the background. On ohmail Cloud and on your own server.

### The Linux AppImage no longer vanishes when an accessibility tool reads its window

With a screen reader, an automation tool or another accessibility client coming and going, the Linux
desktop app could close without a word: the accessibility bridge it bundles (at-spi2-core 2.52.0) kept
entries for parts of the window that were already gone, and the next client that looked at the app made
it read freed memory. The AppImage now carries that bridge with the upstream fixes, and also lets go of
clients that have left instead of keeping their connections. This is the AppImage only (x86_64 and
arm64); the .deb and the .rpm use your distribution's bridge.

### A device that reconnects is no longer refused live updates by its own earlier connection

When a page was reloaded or a tab reopened, the server could still be counting the connection the page
had just left, and after a few reloads the newest page was refused live updates for up to four and a half
minutes and fell back to polling. A device's new connection now takes the place of its own earlier one
when the account's limit is reached, so up to four devices keep live updates however often they
reconnect; only a fifth device with a connection of its own is refused. Every live connection is also
ended by the server within its lifetime, even when its first database read was slow. On Cloud and your
own server.

### A letter you read is marked read on the mail server at once

On the desktop and the phone without ohmail Cloud, a letter you read or mark unread reached your mail server 8
to 21 seconds later, so your other devices and mail apps kept showing it unread for that long. ohmail now sends
the change as soon as you make it, within about a second when nothing else is being synced, and right after
the sync in progress otherwise. A read followed by an unread still reaches the server in that order, and a
change made offline waits as before and goes out when the connection is back.

### The keyboard keeps working after a click into a designed letter

A click into the text of a designed letter in the Ohbox reader or in News left j, k, Escape and g o dead until
a click outside the letter. Once the click is over the keys go back to ohmail, also when you selected text in
the letter: Ctrl+C (Cmd+C on a Mac) still copies that text, and Ctrl+A (Cmd+A) after a click into the letter
selects the whole letter. A link reached with Tab keeps the focus in the letter. Desktop and web.

### The search speed test no longer fails on a busy machine

The test that holds a search page to 100 ms read the machine's speed only before and after each round of
measurements, so load that came and went in between could fail it on code that was no slower. It now reads a
fixed reference beside every measurement and judges a round only when that reference stayed steady
throughout and the machine's load average stayed under a quarter of its processors. A run with no such round
says SKIPPED-LOADED in its log instead of passing quietly. Every night the test also runs alone on a machine of
its own, where a run with no such round fails instead. The 100 ms budget is unchanged, and a search slower than
it still fails on a quiet machine.

### The nightly search speed test judges a slower machine fairly

The nightly run that always judges the 100 ms search budget runs on a machine about twice as slow as the ones
the budget was measured on, so it could never find a round it counted as quiet and failed every figure over
100 ms. On a machine slower than the calibrated one, a round now counts as quiet against that machine's own
quietest reading, and each figure's computing time is scaled to the calibrated machine before it is held to 100 ms;
the simulated network round trips in a figure take as long on any machine and are not scaled. A dispatched
whole run no longer includes this job unless asked for it, so a release does not wait on it. The 100 ms budget
is unchanged, and the test on every other machine is unchanged.

## [0.30.12] — 2026-10-29

### A conversation you stop on with j or k turns read

In the Ohbox on the desktop and the web, a conversation shown by j or k, or by the cursor moving on after Park, Answer later, Resurface or Delete (or back after Undo), stayed unread however long you read it; only a click, ↵ or a scroll in it read it. Now a conversation the cursor stays on for 1.3 seconds with the window in front counts as opened, and each message whose first lines then stay on screen for 0.7 seconds turns read, so what you see turns read about 2 seconds after you stop. Moving on sooner reads nothing, so passing rows with j and k still marks nothing. A key that does something, or a click outside the message, before then leaves it unread until you open it. Its embedded pictures load once you stop on it or open it, not while you pass. This replaces the 0.30.0 rule that j and k read nothing however long the cursor rests.

### Embedded pictures wait for a free connection instead of failing

Opening a conversation with several letters that carry embedded pictures could show "ohmail already has
this mailbox's connections open" in place of some pictures, because every letter asked for its pictures
at once and ohmail opens at most two connections to one mailbox. The apps now ask one mailbox for no
more than that, keep a free connection for the file you press, and wait when the mailbox is busy, so
the pictures arrive. A picture your mail server could not serve says so and is tried again on its own
a few times. On web, desktop and phone.

### Resurface takes the whole conversation out of the Ohbox

Resurface (`b`, or the Resurface button and its Tomorrow, Next week, Pick a date and Now) on a conversation
in the Ohbox booked only its newest message, so the rest of the conversation stayed in the Ohbox, often
moving down among older mail. Resurface now books every message of the conversation the Ohbox shows as one
row, your own reply included, the way Park and Answer later do: the row leaves, the next one is selected,
and one Undo (`z`) brings it all back. The Resurface pile lists a conversation as one row, dated by its
soonest return, and Done or a new date on that row acts on all of it. When the conversation comes back,
Done or Mark as read on it releases every message that came back with it. So does any way of filing one of
those messages: moving it, marking it as junk, deleting it, sending its sender somewhere from the sender
sheet (also while that sender waits in the Screener), and the sheet's Move them and Move it too. A message
of the conversation booked for a later return keeps its time, and mail of the conversation filed elsewhere
stays where it is. This is the same on desktop, web and phone.

### The Linux desktop window no longer freezes when an accessibility client is slow to answer keys

On the Linux desktop app, with a screen reader or another accessibility client running, the window could stop
repainting for good while you typed: each key waited on the accessibility service, and keys arrived faster than
it answered. Keys are now offered to accessibility clients within a time budget. A client that answers in time
still gets every key; one that answers late stops getting keys for a few seconds, and longer each time it stays
late, so the window keeps answering you.

### j after coming back to News starts from the letter on screen

Coming back to News or Receipts opens the stream at its top, on the newest letter, but the first j
jumped to the letter after the one you had reached on your last visit, skipping every letter that had
arrived since. The cursor now moves to the letter the stream opens on, so j steps to the next one, and
the highlight and the message keys follow it too. Opening a letter from search or a link still lands on
that letter. Desktop and web.

### Spam shows your Junk folder at once, without waiting for the mail server

With Use folders on, Spam lists your mail server's Junk folder. ohmail used to read it when you opened the
Screener, so a click on Spam right after that could wait most of a second. ohmail now reads it when it
starts and keeps that page, so Spam shows it on the click. A letter that ohmail sets aside as spam or lets
back out with Not junk is read again a few seconds later, once the mail server has moved it, and once
more when you next open Spam, so that page shows it there or gone. Only a click on Spam in the first
second or so after ohmail starts can still wait for the mail server. Web and desktop with an ohmail Cloud or own-server account.

### The web app's "Get ohmail for desktop" link opens the download page

On the web, the link at the foot of the sidebar opened a second ohmail tab at the Ohbox instead of a
download. It now opens the latest release page on GitHub, which lists the installers for every platform,
in a new tab.

### On a device that only reads your mail, the Screener and Move change the organizer's rule

When another install organizes your mail, the phone's Allow and Not spam in the Screener, and Move, now
decide by the rules that install files your mail by, as the sender sheet already did. Before, they read
this device's own copy: a rule made on the other install was left in place, so the mail came back to
Screened or Spam and the sender's next letters were filed there again. Undo after such a Move puts that
rule back where it was. When the press changes only that rule, the phone says it waits for the other
install's next pass, rather than that it is done.

On every app, a Screener press for a sender whose mail is already in the Inbox now does the same. An old
rule on this device no longer makes the press read as already done while the sender stays undecided.

### A reply cancelled from another window keeps one draft

A reply or forward still waiting to send, cancelled from a second window that had opened it before that
window caught up, could leave two drafts with the same words. Cancelling it now keeps the words in the one
draft the send made, in whichever window you press Cancel (web, desktop).

### The desktop drops "Images blocked" once a letter's pictures are shown

On the desktop app for macOS and Linux, pressing Show images on a letter from a sender you have not let in
loaded the pictures but kept the "Images blocked" label on the letter. The label now goes away once every
picture has arrived, as it does on the web; a background picture the desktop cannot draw keeps it.

### The ✓ beside Screen out and Spam on the phone marks the mail read again

On the phone, the sender sheet's "Screened out, and mark read" and "Spam, and mark read" filed the letters
but left them unread since Screener decisions stopped marking mail read. They now mark the letters the sheet
shows read, the same way the ✓ beside News does. The plain Screen out and Spam presses still only file, and
web and desktop have no ✓ on those two.

### The phone says a draft changed elsewhere was kept, not that saving failed

On the phone (Android and iOS), a draft edited offline whose save was still waiting when another device
changed the same draft is kept as a new draft beside the other version, as before. The phone now says so
("A letter you were writing when ohmail stopped is in Drafts as a new draft…", or the composer's own
sentence while the sheet is still open), on a slow connection too, instead of "That change could not be saved. Try it again.". The
phone's attachments go with its words to the new draft rather than staying on the other version, and words
typed after the waiting save join that same new draft instead of making a third one.

### A reply arriving into an open conversation on the phone no longer moves the reader or turns read

On the phone, a conversation opened on its newest message and left untouched could scroll by itself when a
reply arrived, and the reply then turned read without being looked at. The reader now stays where it stands:
the reply is drawn below with its square on the rail and stays unread until you scroll to it. The same holds
after a rotation, a fold or a press on the list row's squares.

### A letter dated after it arrived, or with no date, is listed by its arrival

A letter whose Date header lies in the future (two days ahead, say) no longer sits above every newer
letter until that day comes: it takes its place by when your mail server received it, and its row,
reader and conversation squares show that time instead of the future date, in the exact form too. The
reader's details still give the Date header as the sender wrote it. A letter with no Date header now
shows the time it arrived, in the list and in the reader, where it showed none. On the phone, the web app, the desktop app,
Cloud and your own server. A store updates its arrival index on the first start of this version.

### The SQLite test run splits into five measured shards

For contributors: the second store's test run in `ci.yml` now runs in five shards of about nine minutes
of tests each, packed from a recent whole run, instead of four whose longest had grown to over sixteen
minutes and ran into its job's 20-minute bound on a busy runner. The shard map records each shard's
measured time, and `node test/support/ci-shards.mjs --check` refuses a shard over twelve minutes.

## [0.30.11] — 2026-10-28

### Scrolling the News list no longer marks letters read

In News and Receipts, scrolling the list of letters with the mouse wheel, a touch or the keyboard marked
read every unread letter whose row passed by, while the reading stream beside it stayed where it was and
never showed them. Scrolling the list now marks nothing, as in the Ohbox.

j and k, and ↓ and ↑ in the list, marked each letter read the moment they stepped onto it, a quick pass
included, though the 0.30.9 note said j and k mark nothing. A step now marks nothing by itself. The
letter it stops on turns read by the rule of 0.30.9, once its first lines have been on screen for 0.7
seconds and its sender line or the end of its text has been on screen; a letter you step past stays
unread. The other letters on screen follow the same rule only once you have opened a letter with a click
or ↵, pressed in the stream or scrolled it yourself, and a step counts as none of these.

A click, ↵ or Space on a row no longer marks its letter read at once either. It opens the letter, and
that letter and the ones shown whole below it turn read by the same rule; before, the ones below stayed
unread until you scrolled.

Leaving News or Receipts marked read the letter resting at the foot of the screen with only its sender
line and subject showing. Leaving now marks only letters the visit itself read.

A letter you mark unread stays unread until you leave, as the 0.30.9 note said. Before, stepping back
onto it, resting on it or leaving could mark it read again; now it stays unread for the rest of the
visit unless you mark it read yourself.

A letter showing only its bottom edge at the top of the stream, after a jump or while scrolling back up,
could turn read while it rested there. It now stays unread until its first lines have been on screen.
Desktop and web.

### Screened out and Spam show their list on the first click

The first click on Screened out or Spam after starting ohmail drew the list only once the newest sender's
letters had been cleaned and laid out, a fifth of a second or more on the desktop. The list and the letters'
headers now show in the click's own frame, and the letters' bodies follow a moment later. The same holds when
you move from one sender to the next. Desktop and web.

With Use folders on, Spam lists your mail server's Junk folder, which ohmail reads from the server each time.
That read now starts when you open the Screener instead of on the Spam click, and coming back to Spam shows
what was read last while it is read again. A click on Spam in the first second or two after opening the
Screener can still wait for the server. Web and desktop with an ohmail Cloud or own-server account.

### News and Receipts name their unread letters on your first visit

On a new device, News and Receipts said "Nothing new since you were here", with no count beside them in
the sidebar, while letters that were already in the mailbox at setup were still unread. Until your first
visit to a pile, every unread letter in it now counts as new: the header and the sidebar show the same
number on desktop, web and phone. Once you have visited, the count works as before.

### The reply editor in News and Receipts no longer covers the end of the letter

Answering a letter in place in News or Receipts docks the reply editor at the foot of the stream. A letter that grew after the editor opened, such as a newsletter whose layout sized itself late or an editor gaining lines, slid its last lines under the editor. The stream now follows that growth, so the end of the letter stays above the editor, until you scroll away yourself. On desktop and web.

### A screen reader is told when the desktop window was reloaded

On the desktop, "ohmail's window stopped and was reloaded." now stays until you press its Dismiss button
instead of leaving after eight seconds, and the accessibility tree shows it as a status named by its sentence.
Every other notice and Undo capsule, on the desktop and the web, is named by its sentence the same way.

### The Look follows your account on every signed-in device

Choosing paper or ohmarchy in Settings → General → Look on the web or the desktop now stores it on your
account, and your other signed-in devices take it when they start and while they are open, so the newest
choice wins. Before, the choice stayed on the device where it was made, although Settings said it applied
on all your devices; a look kept for one device by an earlier version gives way to the account's look.
Until a look is chosen, a Linux device still starts in ohmarchy, and Settings now says that this is the
device's own default. The phone keeps its separate "this device only" choice.

### The phone's Look follows your account too

On a phone signed in to ohmail Cloud or your own server, choosing paper or ohmarchy in Settings → Look now
stores it on your account, and the phone takes the account's look when it starts and after each sync, so
the newest choice made on any of your devices wins. The phone keeps the account's look for its next start,
so it opens in that look at once, offline too. A look kept for the phone alone by an earlier version
gives way once your account holds one, and a choice the account could not save stays on the phone and says
so. A phone running on its own, with no account, keeps its look to itself.

### Compose and mail links keep the message you are writing

A mail link opened while you were writing a message, or one that started the app over a message left
unsaved, replaced what you had written. ohmail now saves those words to your drafts first, and if they
cannot be saved (words typed after a send we could not confirm included) it leaves them where they are
and says so. A link that starts the desktop app now opens over a message that is already in your drafts.

While a message waits to be sent, Compose now opens a new one beside it as soon as the waiting message
is in your drafts. The new message can be written and saved at once; its Send waits until the first
has gone, and says so. A waiting message that is not in your drafts yet (written and sent offline)
stays on screen with a sentence saying why, and a draft of it reopened from Drafts is read-only until
its send ends. A message sent while its first save was still on its way stays on screen until its send
ends, so no copy of it is left in Drafts to be sent twice (web, Cloud, desktop).

### A send you cancel on the phone with no network is in Drafts at once

On the phone app, Cancel send on a message waiting for the network said it was in Drafts, but Drafts listed it
only once the network was back or the app restarted. It is now listed at once, as one draft with its files
and with the words you sent, also when you changed a draft from Drafts just before pressing Send.

### The phone's sidebar opens beside the rail on a foldable

On a foldable or tablet showing two panes, the sidebar opened under the floating rail, which covered the start
of Ohbox, Screener, News, Receipts and Answer Later. The sidebar now opens past the rail's column and covers
the list pane to its edge. Phone app.

### The settings document in ohmail/_meta names the app version that wrote it

The phone and the desktop app wrote `0.0.0` as the writer's version in the "ohmail settings for this mailbox"
document they keep in `ohmail/_meta`. They now write their own app version, so another device can tell which
build saved the settings.

### Gmail setup says what to do when an account cannot create an App Password

Gmail connects only with an App Password, and some Google accounts cannot create one: work or school
accounts whose administrator turned App Passwords off, Advanced Protection accounts, and accounts that sign
in with security keys only. The Gmail note on
the mailbox step and Google's refusal after a failed sign-in now say that ohmail cannot connect those
accounts yet, and what to do instead: ask the administrator to allow App Passwords, or connect another
address. The refusal Google gives most often, for any password it does not accept, says so too. In English
and German, on the web, the desktop app, your own server and the phone.

### The server no longer ships a command that marks screened-out mail read

The worker carried a one-off operator command that marked every unread letter in Screened out and Spam as
read, a cleanup for the time when a Screener decision itself marked letters read. Since screening out and
Spam leave letters as they were, running it would have undone that, so the command is gone. Nothing changes
for anyone who never ran it; on your own server it leaves with the next server update.

### A lower storage limit on Cloud waits 14 days before old letters are emptied

On ohmail Cloud, moving to a plan with less storage or removing the storage add-on used to lower the
limit at once, and the next trim emptied the text of old letters without a word. Now ohmail keeps the
previous limit for 14 days after the change, and the storage notice in the app says until when it keeps
it and what the plan keeps from then on, with the way to more room. Going back to the bigger plan or the
add-on inside the 14 days cancels the change, and nothing is emptied. Your own server and the desktop and
phone apps have no storage limit and are unchanged.

### Search answers faster for words in a few percent of your mail

Search answers faster for words in a few percent of your mail, two-word searches and file-name parts;
another account's mail no longer slows yours. The server's setup builds one new search index, without
holding up mail while it builds. On ohmail Cloud and your own server.

### A closed tab no longer holds a live-update stream on ohmail Cloud

On ohmail Cloud, a browser tab that was closed or reloaded, or a desktop app that restarted, kept its
live-update stream for up to four and a half minutes after it left. With a tab and the desktop app open,
the next connection could be refused in that time, and new mail waited for the regular check instead of
arriving at once. Cloud now ends a stream within seconds of the app on the other side going away, which
frees its place for the next connection. Your own server already ended such streams at once and is
unchanged.

## [0.30.10] — 2026-10-28

### A reply to a large group folds its earlier messages

A reply whose quoted Outlook header lists a dozen or more recipients showed its whole quoted history,
because a `To:` or `Cc:` line that long was not read as part of the header. Such replies now fold their
earlier messages behind the toggle like any other reply, on desktop, web and phone, whether the header
sits at the top of the reply or inside a quote (as when Thunderbird answers an Outlook message).

### ohmail on Linux keeps running when an accessibility tool stops while you type

On the Linux desktop app, a screen reader or another accessibility tool that quit or restarted while
you were typing could take the whole app down with it: GTK freed the tool's key listener while it was
still handing that key press to it. ohmail now holds such a removal until GTK has finished with the key,
then completes it. Every key still reaches every running tool once, as before, and accessibility stays on.

### A message sent just before ohmail closed gets its copy in Sent when ohmail starts again

When the mail server took a message and ohmail then closed, crashed or lost the connection before the
copy reached the Sent folder, the message went out but never appeared in Sent or in its conversation.
ohmail now keeps that copy on the device until it is filed, and puts it in Sent once, at the next start
or when the connection is back (desktop, and the phone on its own).

### Pictures from a sender you have not let in wait for Show images

Mail in the Screener, Screened out and Spam no longer loads its pictures on open or in a preview, even
with Load images in messages on, so a first-time sender cannot learn that you saw their message before
you decided. Show images still loads one message's pictures; once you let a sender in, their mail
follows the setting. Web, desktop, ohmail Cloud and your own server; the phone app already asked first.

On the desktop, Show images now works: it was missing on macOS and Linux and did nothing on Windows.

### Screening a sender out or marking them as spam leaves their letters unread

Screened out and Spam used to mark every letter the sender had waiting in the Screener as read on your
mail server, so letters you never opened showed as read in your other mail apps too. ohmail now files
them and leaves them as they were: a letter turns read when you read it. The same holds for letters the
Screener files on its own when you let it act on its suggestions, and for screen-outs that arrive with
imported settings, whose card no longer says they are marked read. The Ohbox badge and the Screener's
counts are unchanged; they never counted Screened out or Spam. Letters marked read this way before stay
read. This is on the web, the desktop app and the phone; on ohmail Cloud and your own server it needs the
server updated with the apps.

### On a device that only reads your mail, every rule can be changed, and a takeover drops removed rules

When another install organizes your mail, Settings → Rules lists that install's rules. A rule made there had
no Change or Revoke here and asked you to change it on the other install. Every rule on the page can now be
changed, removed, lifted over its domain's rule or included in Revoke all; the change goes to the install
that organizes your mail, and the page says it waits until that install has made it.

On such a device the sender sheet now decides a press by the rules that install files your mail by, not by
this device's own copy. A press to where an old local rule pointed no longer reads as already done while
the mail goes somewhere else, and Remove can take that install's own subject rule. A second press made
before that install has carried out the first one is decided over the first, so pressing back to where
the mail was always filed is sent too and wins.

When this device takes over organizing ("Organize here instead") and imports the other install's settings,
a rule this device still held but that the other install had removed is no longer brought back to file
mail. Rules made on this device during the takeover stay, and so do this device's rules when you chose
"Not now" first and organized with them, or when it also organizes a mailbox you removed. Desktop, web
and phone.

### Closing a reply or forward under a letter saves it to Drafts at once

A reply or a forward typed under a letter and closed with Esc, Cancel or the Reply button before the
usual pause, or left by switching to another view, stayed only in this browser: Drafts on your account
never got it. The same happened when you pressed Send before the pause and then cancelled the send while
it was still waiting to go. Both now save it as a draft right away, and only once: a cancelled send that
had already made its draft keeps the words in that draft, also when you cancel it in another window. A
new message whose cancel is answered later keeps its draft the same way, instead of leaving a second
one. Words typed while an earlier save was still on its way are saved once that save lands, instead of
waiting for the next change (web, desktop).

### A letter the phone restores after a stop no longer overwrites a draft changed on another device

When ohmail on the phone stopped while you were editing a draft, and the same draft was then changed on
another device, the next launch could put the phone's words over the newer ones, and those were lost. The
phone now restores the letter as a new draft beside the other version, with its attachments, and says so.
Android and iOS alike.

### The reading column stays inside its frame in the Ohmarchy look

In the Ohmarchy look, a scrolled conversation or News and Receipts stream no longer runs above the other
columns' top edge up to the window border, and the focus ring's top line no longer crosses its text. In
Screened out, Spam and Waiting, the newest letter now opens below the decision bar instead of half under it.
Desktop and web.

### Live mail with a browser tab and the desktop app open together

On ohmail Cloud, a browser tab and the paired desktop app open at the same time could use up the
account's live-update streams: each time the tab came back to the front or the desktop app reconnected,
the stream it left kept its place for minutes, and after a few switches the next one was refused, so
new mail waited for the regular check instead of arriving at once. A reconnecting tab or desktop app
now ends the stream it left, so both keep their live stream.

### The first sync after launch no longer holds the desktop app for most of a second

On a large mailbox the first sync after the app starts read every message location the mailbox holds in one
query, and the desktop app could not answer anything else while it parsed the result (74,000 locations held it
for about 0.9 s). The read now goes in pages of 5,000, so each pause is short (about 60 ms at that size), and
the desktop store takes the statistics that read needs once, so the pages use the index instead of sorting
the mailbox again for each one. The same paged read runs on the phone, the self-hosted worker and ohmail
Cloud.

### Cloud can record how connecting a mailbox ended

On ohmail Cloud, each press of Test or Connect, and each start or finish of the Microsoft sign-in, can
leave one record of how it ended: which of these it was, the provider from the setup list or "another",
whether it worked, if not why as one word from a fixed list (such as a refused password or a server that
did not answer), which side refused (incoming or outgoing mail), and the time. A record holds no address,
no server name, nothing the mail server said, no IP address and no browser details. It is kept for 30
days and deleted at once with the account. Staff can read the counts and one account's records over the
console's content-blind connection, and nothing else of it.

Recording starts off: an operator sets `TF_CONNECT_ATTEMPTS=record` on the API once
[ohmail.app/privacy](https://ohmail.app/privacy) describes it. A self-hosted server and the desktop app
record nothing of the kind; a self-hosted server's next migration creates the table and leaves it empty.

## [0.30.9] — 2026-10-27

### Pressing End in News no longer makes the Linux desktop window reload

In the Linux desktop app, pressing End in a long News or Receipts stream while a screen reader or another
accessibility tool was reading the window could crash the window's web process. The window then showed
"ohmail's window stopped and was reloaded." and you lost your place. The stream rebuilt its letters on every
frame of End's scroll animation. It now holds still while End, Home or a fast scrollbar drag moves it more
than a screen at a time, and shows the letters where the scroll stops. Scrolling with the mouse wheel or the
arrow keys loads letters as before. This applies to the desktop app and the web.

### A letter you read in News or Receipts turns read where it stands

In News and Receipts, a letter you opened with a click or ↵, or clicked into, and read without scrolling
stayed unread, and kept its blue line. With the mouse wheel, a letter shown whole on screen stayed unread
until you scrolled it to the top. Now every letter on screen follows the same rule as in the Ohbox, once
you have scrolled, pressed or opened a letter in the stream: it turns read once its first lines have
stayed on screen for 0.7 seconds and its sender line or the end of its text has been on screen. Nothing
counts while the window is in the background, and a letter you mark unread stays unread until you leave.

After End, or another scroll from inside a letter, leaving News or Receipts could mark read the first
letters, which had been on screen for only a moment while the stream opened. Now leaving after such a
scroll marks only the letters you read. Desktop and web.

### News and Receipts read with the keyboard alone

Reading News or Receipts only with the keyboard marked nothing read: scrolling keys typed inside a
letter, or pressed after clicking a letter's text or its sender line, scrolled the stream, but ohmail
did not count them until you had scrolled once with the mouse wheel or a touch. Now they count like
the wheel, by the same rule: a letter turns read once its first lines have stayed on screen for 0.7
seconds, and nothing that was never on screen turns read. The app's own j and k still mark nothing.
Keys typed inside a letter count from the first one, so the 0.30.8 note that they mark nothing until
you have scrolled with the wheel, a touch or a key outside the letter no longer holds.

After End, a letter just above the screen you stopped on could briefly push that screen down as its
content loaded, and one to three letters you had only flown past were then marked read, mostly when
you left News. They now stay unread. This applies to the desktop app and the web.

### A letter turns read in every reader, not only in the Ohbox

The read rule of 0.30.7 ran only in the Ohbox, though its note said every message. It now runs in
History, a folder, a tag, Answer Later, Parked and Resurface, and in the reader that opens over them in a
narrow window: a letter you open, press in or scroll yourself turns read once its first lines have stayed
on screen for 0.7 s and its sender line or the end of its text has been on screen. Each message's ⋯ menu
there has Mark unread. A letter opened from Search into a folder or into that reader turns read the same
way. Stepping through a list with the arrow keys, the letter a list shows before you open one, and a link
to a message read nothing. Trash and the Screener's preview still leave a letter as it was. Web and
desktop.

### The Ohbox keeps your place after Resurface, Park, Answer later or Delete

On desktop and web, a verb on a conversation row whose letter is older than the row (a conversation you
answered today, say) moved the cursor to a row next to where that letter arrived, often several rows
down, and the list scrolled there. The cursor now goes to the row directly below the one you acted on.

### Restart to Install in the desktop menu saves the letter open in the compose form first

On the desktop, picking Restart to Install from the app's menu now saves the text of a letter open in the compose form before ohmail restarts, as the Restart in the sidebar and in Settings already did. It still waits while a message is being sent or a draft holds attached files. If the window does not answer within a few seconds, ohmail restarts as before.

### Restart saves the reply or forward you are writing under a letter first

Words typed into a reply or a forward under a letter were saved to your account only after the usual
pause, so a restart inside it could leave the last of them unsaved there. Restart in the sidebar and in
Settings on the desktop, and Reload in the browser, now save it first, as they already did for the
compose form (web, desktop).

### A stray key on "ohmail's window stopped" no longer quits ohmail

When the desktop window stopped a second time within a few minutes, ohmail asked whether to relaunch,
with Relaunch and Quit. Escape, the dialog's close button and any key that dismissed it counted as Quit,
so a person still typing lost the app. The question now has one answer, Relaunch, and every way out of it
brings the window back. ohmail still quits the usual ways, from its menu or tray or by closing its window.

### News on the phone keeps your place when new letters arrive

On Android, new letters arriving at the top of News no longer move you. If they arrive while another tab is open, News comes back at the letter you left. If they arrive while you are at the end of News, the last letters stay on screen and you can still scroll to the end. Before, the view jumped up and the end could not be reached again until the app was restarted.

In two panes, Back with the sidebar open now closes the sidebar instead of leaving the app.

### The phone's open Settings and Ohbox follow a settings block as it starts and ends

On the phone, a Settings screen or Ohbox that was already open kept saying Organizing when this mailbox's
settings stopped saving to the mail server, and kept the failure sentence after the next save worked. Both
now change at the next check, without leaving the screen. A stop waiting for another copy of ohmail to let go
of the mailbox now shows its note on an open screen the same way.

### A connection lost during a large first import no longer ends the import early

On the desktop and the phone, a mail server connection that dropped between two commands of a large
mailbox's first import could leave the import marked complete with only part of the mail read, and the
rest was then treated as mail that arrived after the import. A lost connection now fails that pass, and
the import goes on over the next connection. A new connection that has served mail also counts as
reconnected at once: a drop after that retries at the first step instead of waiting longer each time, up
to five minutes, and the connection check now watches it even when the launch's own import was the one
cut off.

### Agreeing on two computers at the same moment no longer lets both organize the mailbox

When two computers agreed to organize one mailbox within the same moment, both could file its mail for
one pass before one of them stood down. Now the computer whose claim reached the mail server second waits
a few seconds for the first, then reads the folder again and names the computer that organizes. On
desktop, phone, Cloud and your own server.

### Signing up continues in one tab, and the plan step names a trial only when there is one

Confirming your email address from the mail used to open the setup in a new tab even when the tab
that said "Check your email" was still open, so two tabs could walk the setup side by side and the
recovery codes one of them showed could be cancelled by the other. The tab already waiting now
carries on by itself and the confirming page says so; it opens the setup only when no tab is
waiting. A tab whose step was done in another (a passkey added, codes saved) moves on instead of
adding a second factor or a second set of codes, and says when codes for the account already exist.

The plan step offers "Start my 14-day trial" only to an account that never had a trial or a
subscription; an account whose trial ended, or that has paid before, is sent to its account page
without trial words. After a return from the account page the setup waits about two minutes for the
trial or plan to start, says it is starting meanwhile, and only then says "not yet". The progress
rail ends with Organize, the decision that follows setup. Web and ohmail Cloud.

### Screener tabs switch with less work per click

Switching to Screened out or Spam draws a short list once before it shows, not twice, and a letter's
dark-mode setting is written into its preview only once the letter has loaded there. Desktop and web.

### A first sync over long conversations reads less

When a device syncs a mailbox for the first time, the server now reads only what it needs about the
other letters in each conversation it sends, instead of every one of them whole. A first sync over
long conversations finishes sooner, and how much it reads no longer grows with the size of those
letters. On desktop, Cloud and your own server.

### The desktop app's log says when its last run ended without closing

When ohmail on the desktop vanished without closing, for example after a crash in the system's
window toolkit, its log said nothing about it. The next start now writes one line saying the previous
run ended uncleanly, how long ago that run started and which process it was, so a crash report can be
matched to it. A normal quit, an update's restart, and logging out or shutting down leave no such
line: on Linux, ohmail now quits the same way as from its menu when the session ends. The line
carries no file paths and no account data.

### The test suite refuses Postgres-only SQL in code the phone carries

A query only the server's database understands, in a file the phone app's mail engine bundles, now fails
the main test suite, not only the Android build. On the phone the store is SQLite, where such a query
fails or answers a different question. Phone.

### The desktop store's crash tests run again

The tests that kill the desktop app's local store mid-write and open it again (a first start killed at
each step, a kill in the middle of a sync, a kill mid-ingest, the data-directory lock) are back in the
suite, and so is the check that the API host keeps its mail and database drivers out of the bundle.
Nothing changes in the apps; these guard the desktop app and ohmail Cloud against regressions.

### The phone app's tests can mount its components

For contributors: `apps/mobile` now carries `@testing-library/react-native` and `react-test-renderer`
(19.2.3, the app's React), and `apps/mobile/test/helpers/rn-host.ts` stands in for React Native's
primitives, so a test renders a phone component, presses it and reads its styles. The "could not be
saved" notice is the first one tested that way: it renders, its Try again and Discard sit inside the
bounded scroller and stack on a narrow screen, a press reaches the engine, and a send whose outcome is
unknown keeps its warning on screen after its row is gone. Nothing changes in the app.

### ohmail Cloud stays up when one window loads hundreds of pictures at once

Opening many letters with pictures at the same moment (a sender's held letters in the Screener, for example) could fill ohmail Cloud's database connections and make it refuse everyone for several minutes. A picture request that names no valid letter or address is now refused before it reaches the database, the server lets go of idle database connections within about 20 seconds, and a full connection limit is answered as "busy, try again" instead of as an error.

For operators: a connection pooler at its client limit (`EMAXCONN`) or Postgres at its connection limit (`53300`) is answered `503 db_busy` with `Retry-After: 5`, recorded as `DbConnectionCapError` and counted by `pooler_refusals`. `/health` answers `503 database_refusing_new_connections` when a fresh connection is refused while the instance's held ones still work, and reports `dbFreshConnectMs` otherwise. Pooled connections close after 20 seconds idle (was 120), and the hosted API keeps an instance awake 22 seconds after its last answer so they close before the platform suspends it.

### ohmail Cloud answers "busy, retry shortly" when the database pooler turns a request away

When the database pooler gives up on a statement it never passed to the database, ohmail Cloud now
answers "busy, retry shortly" instead of a server error. That statement did not run; an earlier
statement of the same request may already have been written.

### The 5xx poll keeps working when ohmail Cloud is busy

For operators. When the API served more requests than one poll can page through, the platform-signals poll
answered 502 after 40 seconds although it had written the newest window, and the organizer paged
`api_cron_stale` for it. A window the poll has no time left for now waits for the next poll (`deferred` on the
`platform_signal_pass` line), and a window that stopped at its page budget is not read again.

### The sign-in record says why a session ended

For operators. The clean-up that ends sign-ins unused for 60 days now leaves one `session_reaped` row in
`auth_events` for each session it ends, naming the session, its refresh family and the days it went unused
(`idle_d`); the operator console's account page lists it by name. The row a reused refresh token leaves
(`refresh_reuse_revoked`, and `refresh_attempt_revoked`) now also says how many renewals behind the presented
token was (`depth`) and how many seconds had passed since the family's last renewal (`tail_age_s`). Neither
says who renewed, and an ordinary renewal leaves no row saying where it came from. A `tail_age_s` under 900, one
access token's lifetime, means something renewed the family just before: a second copy, or the same client
presenting its previous token right after renewing (an answer it lost or never stored, or two of its own
renewals racing). A longer `tail_age_s`, whatever the `depth`, fits a client whose stored sign-in went back and
equally a copied profile or a stolen token that renewed elsewhere and then went quiet. Nothing reads the new keys
back: the reuse alert fires on every `refresh_reuse_revoked` row as before. The new keys carry no token, and a
`session_reaped` row has no IP. No migration, and nothing changes for the person signed in.

## [0.30.8] — 2026-10-27

### A reply in News or Receipts is written where the letter is

Replying to a letter in News or Receipts no longer opens it on a separate page over everything else.
The letter becomes a conversation right where its card was, laid out like a conversation in the
Ohbox, and the reply editor sits under it. Once sent, your reply joins the conversation below the
letter with its square beside it, and the letter's row in the list reads "Me → …". Press Esc
before sending and the card comes back as it was. The rest of the stream stays where it was
(desktop and web).

### Screened out and Spam open at once

Clicking Screened out or Spam in the Screener could take several seconds when the newest sender there had
many letters, because every one of them was drawn, and its body and file list asked for, in the click
itself. The preview now opens on that sender's newest three letters and adds older ones as you scroll up to
them, so every letter is still there to read and the counts still cover all of them. A letter you open again
is no longer cleaned and laid out a second time. Allow and Not spam still act on every letter the sender
has. Desktop and web.

### Desktop updates now install on the next restart, and the sidebar says when one is ready

ohmail on the desktop now installs a verified update when you quit it, instead of asking first; the AppImage also installs it when it next starts. Where replacing ohmail needs your password, the update waits for Restart instead. A short line at the foot of the sidebar, above Command, says when an update is ready, with Restart to install it at once. An open draft's text is saved first, and Restart waits while a message is still being sent or a draft holds attached files. An update that could not install by itself is said in the same line, with Retry, and is not tried again at every quit. To be asked before every update again, turn off "Install updates automatically" in Settings → About → Updates.

The strip across the top of the window is gone: in the browser, the offer to reload into a newer ohmail moved into the same line. The AppImage now replaces itself with a single rename, so an update interrupted by a crash or a power cut can no longer leave an app that does not start. Installs updated by a package manager, Flatpak or the App Store are unchanged.

### In a long conversation the squares follow the message you are reading

When a conversation has more messages than its squares have room for, the squares in its list row and
beside the reader no longer scroll sideways or show a square cut at the edge. They now show the part of
the conversation around the message you are reading, which stays whole in the middle. At an edge that
hides more, the last two or three squares get smaller, and a quiet +N counts the hidden ones. As you
read on, the squares move along with you. In the open conversation's list row they start at the
subject's left edge, +N included, rather than under the sender's circle. On desktop, the web and the
phone.

### The focused conversation's border no longer runs through the thread squares

With the Omarchy look, the accent border of a focused conversation ran along the column of thread squares
beside it and across the top of that column, so two lines lay on top of each other. The border now starts
at the messages, over their own border, and the squares stand on their own between the list and the
conversation (desktop and web).

### A letter opened from Search turns read

A letter opened from Search or from an address page, with Return or a click on the result, now turns
read by the same rule as one opened in its own list: once its first lines have stayed on screen for
0.7 s and its sender line or the end of its text has been on screen. Before, it stayed unread until you
pressed in it or scrolled it, in the Ohbox, News and Receipts alike. A link to a message still opens it
without reading it. Web and desktop; the phone app already read these.

### End and Home in News and Receipts mark only the letters they stop on

End, Home, ⌘↓ and ⌘↑ (Ctrl+↓ and Ctrl+↑ on Linux and Windows) scroll a News or Receipts list or stream in
a short animation, and every letter that animation carried past the top of the pane was marked read, also
letters that were never on screen once it stopped. Now a jump to an end marks only what it stops on. This
applies to the desktop app and the web.

In the desktop app on Linux and macOS, and in Safari, a key typed inside a letter (after clicking into it)
does not reach ohmail, so End cannot be told from the other scrolling keys there. Once you have scrolled
News with the mouse wheel, a touch or a scrolling key outside a letter, scrolling with the keyboard inside a
letter marks a letter once its first lines have stayed on screen for 0.7 seconds. Before that, keys inside
a letter mark nothing, as before. When you leave News, the screens you stopped on count as read, even a
short stop, but the letters a jump or a fast run of keys carried past without stopping stay unread. What
you read before still counts. A key pressed there while a mouse-wheel scroll is still settling counts as
part of that scroll.

### News and Receipts on the phone mark only what you scrolled through

On the phone, letters that arrive above your place in News or Receipts, and your place coming back
when you return to the tab, no longer mark anything as read. A fling marks only what was on screen
while your finger moved and where it comes to rest, not every letter it flew past. Your own scrolling
marks letters as before.

### When ohmail Cloud ends your sign-in, the sign-in screen says so

On the web, a sign-in that ohmail Cloud had ended showed "Checking your sign-in…" and then the front
page, without a word. It now goes to the sign-in page, which says that you were signed out on this
browser, or that your sign-in here expired.

In the desktop app, the reason was lost when the app was restarted after ohmail Cloud ended its sign-in:
it opened on the sign-in dialog as if it had never been signed in. The dialog now says why at the next
start too (signed out from another device or after a security check, or expired after a long time
without use) until you sign in again, sign out yourself or switch to another account.

On ohmail Cloud, a desktop app signed in with version 0.11.0 or 0.11.1 was signed out after 60 days
without use, by the clean-up meant only for browsers. It now keeps its sign-in for 400 days without
use, like every desktop sign-in.

### Fewer sign-outs after a crash or a forced restart

After a crash, a power cut or a forced restart, the desktop app or the browser could come back with a
sign-in that had already been replaced. The server refuses such a sign-in the way it refuses a stolen
one, so you had to sign in again.

The desktop app now writes each renewed sign-in to the disk before it uses it. On the web, tabs that come
back together, after a restart or a sleep, renew the sign-in once instead of once each, which leaves much
less for a crash right after to undo (desktop, web, Cloud, your own server).

### Pictures in mail load a few at a time on the web

On the web app, the pictures of the messages on screen, background pictures included, are now fetched
through the image proxy at most six at a time instead of all at once. Opening a sender in the Screener with many picture-heavy newsletters sent
more than a thousand requests in a few seconds, and on 26 October that briefly took ohmail Cloud down for
everyone. Every picture still loads; pictures in the message you just opened go first. A picture address the
proxy would refuse on sight (not http or https, or longer than the proxy takes) is no longer asked for.

### The desktop log says why its window stopped

When "ohmail's window stopped and was reloaded." shows on Linux, the app's log line for it now also
carries how long the app had been running, how much memory the computer had left once the window's
process was gone, and how many of ohmail's own processes the system ended for lack of memory since the
window last stopped. Kills of other programs are not counted. That tells a crash in the window apart from
the system reclaiming ohmail's memory, which both looked the same before. On desktops that start each app
in its own systemd unit, a memory kill ends the whole app, so the message there means a crash. The numbers
stay in the log on your computer.

### The desktop log says how the window's process ended

When "ohmail's window stopped and was reloaded." shows on Linux, the app's log now gets a second line
a moment later. It says how the window's process ended: the signal that stopped it, and whether that
was a crash or a kill, or the exit code it left with. ohmail reads this from the system without
disturbing the process. What the window's libraries print to the error output just before they stop
was thrown away when ohmail was started from a launcher. It is now kept in `stderr.log` beside the
app's log, at most 256 KiB plus one older file, with a marker at each start and at each window process
that ended. The diagnostic file gets the new numbers and none of that text. Nothing leaves your
computer. Set `OHMAIL_STDERR_LOG=0` to keep the old behaviour; a terminal's output is never moved.

### Shorter pauses while the desktop app stores a first sync

While the desktop app stores its very first sync, its local database no longer fills each new
log file with zeroes. That was disk work on the same thread that answers the window, so
opening a message waited behind it. Nothing is written to disk less safely than before. The app's
diagnostics now also record how long the engine was held during a sync and how much of that was
the local database syncing to disk (desktop).

### A large letter no longer holds up new mail on a busy computer

On a heavily loaded computer, a letter of a megabyte or more with large inline pictures could take
longer than 30 seconds to read in. ohmail then gave up on it, and the folder it sat in stopped
receiving new mail until that letter was gone. The 30 seconds now count only time in which the
letter made no progress at all, so a slow letter is read whole and the mail behind it arrives; a
letter that truly stops is still set aside as before, and no letter takes longer than 10 minutes
(desktop, phone, Cloud, your own server).

### Letters that reached your mail server just before Stop organizing here are offered after Start

On every app and on ohmail Cloud, Stop organizing here, and a phone handing its mailbox back, now
start the window of letters to offer where the last finished organizing pass began, by the mail
server's clock, rather than at the press. A letter that reached the server after that pass and
before Stop was neither filed by your rules nor offered; after Start it is offered with the others.
Nothing moves until you choose File. A letter one of your devices has already filed is never offered
again. Letters that arrived after the last device to organize the mailbox finished its last pass are
offered, even when another of your devices had already taken them in; the offer now says that no
device organized them.

On Android and iOS, letters the phone stored before it read the server's arrival time now get that
time from the server, a page at a time while the phone syncs, and nothing else about them changes on
the server. They then sort by arrival in the Ohbox and count in the Screener as they do on the
desktop, and a window of letters to offer waits for them instead of closing without them. Letters
stored before ohmail kept arrival times at all keep their place.

### A phone that organizes a mailbox shares its rules and screening window again

On Android and iOS, the phone organizing a mailbox failed to write its settings to the mailbox since
0.25.11, so its rules and the Screener's window never reached your other devices. The phone now writes
them as the desktop does, and another install picks them up on its next pass.

### Rules made on the computer that organizes your mail show on your other devices

Settings → Rules now lists the rules your mail is filed by. On a device that only reads a mailbox
another computer organizes, those are that computer's rules, including ones made or changed there;
before, the page listed only the rules this device wrote (desktop, web). The page says a change made here
goes to that computer only while that computer can take one; otherwise it says these are the rules that
computer last published, and why a change can't be made here. On the computer that organizes
your mail, the page lists its own rules, as before. A rule made there is listed without Change or Revoke
and says to change it there. A change you make here shows as you made it until that computer's next copy
includes it; an organizing computer on an older release is followed once its copy agrees. On such a
mailbox the sender sheet's "Their rules" no longer names an older rule of this device beside the one that
files the mail (desktop, web, phone).

### A forward left unfinished is a draft with its recipients, note and files

A forward started in the reading pane and left unfinished is now saved to your account after the same
pause as a reply: it is listed in Drafts, keeps its recipients, its note and the files you kept, and
opens whole when you press Forward again, after a reload or on another device. Sending it sends that
draft with only the files you kept and leaves no copy in Drafts. Before, it stayed in that browser only,
lost its To after a reload, and another device opened a fresh forward. A forward or a reply sent from
another device while it is open here now closes and says so, and is not sent a second time (web, desktop).

### A click anywhere on a Screener row selects that sender, so s opens their menu

On desktop and web, a click on a waiting sender's address or avatar in the Screener opened the sender
sheet instead of selecting the row, and s then did nothing. A Screener row is now one target at every
width, as it already was on a phone: the click selects the sender, and s, o, r, c, n and x act on them.
In a narrow window, where the click opens the full letter, s now leaves the letter and opens that sender's
menu; it did nothing before.
The sender sheet still opens from a press on the sender in the preview.

### A sender filed somewhere and back takes every letter along

Filing a sender from the sender panel or the Screener card with "Also move the mail already in your
mailbox", then filing them somewhere else the same way, left one letter behind: the one the first
decision was made on (and, from a Screener card, the Inbox letters it listed). Releasing a sender from
Screened out or Spam left the released letters behind the same way. The letters a sender decision or a
release files now stay that decision's, so the next one moves all of them. Letters you moved yourself
still stay where you put them. A letter left behind before this update stays where it is; move it
yourself. On desktop, web, phone and Cloud.

### A month chosen on History's rail opens at that month, also on a large mailbox

On web and desktop, a year and then a month pressed quickly on History's rail could open the list some fifty
messages below the month, with its first message nowhere in sight and the keyboard still on the rail. That
happened when the History pages arrived before the list had moved, and the rows above the month were sized again.
The list now goes to the month's first message wherever it stands, and that message takes the cursor and,
from the keyboard, the focus.

### Adding a mailbox another install organizes never takes it over without asking

Setup now waits until ohmail has checked whether another computer or your own server already
organizes the mailbox before it shows the consent statement, and asks the claim question when one
does. Before, Agree could be pressed in the seconds before that check answered, and a mailbox your
server organized was taken over without the question being asked. If the check takes longer than a
minute, setup says so and offers to try again; it never offers Agree without an answer. On desktop
and web.

Agree without "Organize here instead" also no longer takes a mailbox whose organizer is still active
when the mail server shows that organizer's claim a moment late: the desktop looks before it agrees,
and an install that starts organizing steps back if the claim turns up as it starts. On desktop,
phone, Cloud and your own server.

### Tests that migrate a database refuse the shared test database

For contributors: the test files that apply the migrations to the database they are handed (the
repository adapter, the rules schema, the worker's leader lock and its end-to-end mail tests) now take
their database through the same refusal as the other Postgres tests. In a checkout without its own
database (`scripts/lane-db.sh`) they stop at collection with the remedy, instead of migrating the shared
`trafficflow_test` database another checkout is testing on.

### A maintainer's dispatched test run uses the maintainers' own runners

For contributors: when the maintainers' own runners are switched on, a test run a maintainer starts by
hand on `main` or on a `pr/` branch now runs its Linux jobs there, as the nightly does, instead of on
GitHub's runners. On those runners six suite shards run at once instead of three. A dispatch on any
other branch or tag, a bot's run and a fork's pull request still run on GitHub's runners.

## [0.30.7] — 2026-10-26

### A message you read turns read, under a long To list or with its sender line scrolled off

A message sent to many people kept its unread dot in the Ohbox, and the blue line beside it in the
reader, after you had read it: a To or Cc list taller than the reader kept its sender line and its
first lines from being on screen at the same moment. In a long conversation, which opens at its newest
message, the message above the newest stayed unread the same way when its sender line sat just above
the top of the reader while the rest of it was on screen. The read rule is now one and the same for
every message on web, desktop, ohmail Cloud and the phone, which gains it too: A message turns read
once its first lines have stayed on screen for 0.7 s and its sender line has been fully on screen or
the end of its text has been on screen (a preview counts), in either order. Nothing that was never on
screen turns read; Mark unread starts it over. On web and desktop the 0.7 s count starts once you open
the message, press in it or scroll the reader yourself, so a message you only pass with j and k stays
unread.

### A letter to many people no longer fills the reader with addresses

The reading pane names the people a message went to instead of listing every address: To and Cc each take
one line, and a field of more than three folds to its first names and a count, as in "To you, Alain Gozzer,
Onanong Hemsiri and 31 others". Pressing the count shows everyone as names that wrap in a block of about
eight lines, which scrolls on its own for very long lists, so the message text stays in reach. Your own
address reads "you" and comes first in its field. Each name still opens its contact menu, and the address
shows on hover. The keyboard stays on the control that folds the list back, and a screen reader hears the
field, the names and the count. Cards in News and Receipts fold the same way at two names. Desktop and web.

### Typing a reply in the reader no longer flickers the window

Replying to a letter opened in the reader, as from News or Receipts, made the sidebar and the
rest of the window flicker with every keystroke, most visibly in the desktop app on Linux. The
sidebar and the page behind the reader now stay still while you type (desktop and web).

### A picture in the attachment preview fits the window whole

A picture taller or wider than the preview is shown whole, scaled down to fit with its proportions kept, and
no longer needs scrolling; a smaller one keeps its own size. This holds on the web at a larger Text size too.
PDF pages and text still scroll. Desktop and web.

### A long conversation's squares in the list are whole, and the older ones are counted

In the message list, a conversation too long for its row's squares showed a sliver of a square at the
left end, or simply hid the oldest without a sign. The row now draws only whole squares, keeps the
newest, and starts the line with a quiet +N for the older messages that do not fit. On desktop and the
web, in both looks.

### The phone's list rows say how many squares a long conversation leaves out

On the phone, a closed row's conversation squares now keep the newest ones that fit and lead with a quiet "+N" for the older ones they leave out, so a long conversation in the two-pane list no longer shows fewer squares than it has messages without a sign. In the open conversation's row, a reply that arrives is scrolled into view whole beside the square you stopped at, where both fit, instead of sitting cut at the row's edge.

### The Omarchy frame matches Hyprland's gaps

With the Omarchy look, the gap from the window edge to a column's border now equals the gap between two
columns, measured as Hyprland measures its own gaps: to the outer edge of the border. Before, the 2px
borders stood inside the gaps, so the edge read 8px and the gap between columns 6px where Hyprland's own
windows sit 10px apart. A gaps change made with `hyprctl` or a reloaded Hyprland config now reaches an
open window within a few seconds, not only at the next launch (desktop). The thread squares between the
list and the open conversation keep the same 10px to the border on each side.

### Drafts open on two devices keep both versions, and Discard cancels a send that waits

A reply draft open in the web app or the desktop app, and any draft open in the phone's composer, no
longer writes over words another device saved into it meanwhile. Saving or sending over the newer
version keeps that version in the draft and keeps what you typed as a new draft, and says so (web,
desktop, phone). That holds for a phone send that waited and was refused after its composer closed.

A draft whose save was refused keeps its words when you open it again from Drafts. Opening another
draft, or writing to a contact, over words no save holds is refused with a sentence instead of
replacing them (web, desktop).

Discard in Drafts on a letter whose send is waiting to go cancels that send first, so nothing goes and
no "Sending didn't work" follows. When the send is already on its way, or the cancel cannot be
confirmed, nothing is discarded and the row says why. A draft whose send waits says "Waiting to send",
and a reply waiting to go with no draft of its own no longer shows up in Drafts as an interrupted send
(web, desktop, Cloud).

### Folding the phone keeps the conversation you are reading

On a foldable phone, folding to the outer screen with a conversation open now shows that conversation, and Back
returns to the list. Before, a sender left open in the Screener on the inner screen was put on top of it, with
its decision buttons, and the conversation was only one Back away. The Screener now opens that sender when you
go back to the Screener tab.

On an iPad in a resizable window, the Ohbox title and Mark all read now sit below the window controls instead of
under them (phone).

### The phone's account notices stay clear of the status bar and the rail, and a draft sent from Drafts › Edit leaves its page

On a foldable's inner screen the storage notice could sit under the status bar, and with two panes
under the navigation rail, which cut its first words and put Dismiss over the Screener tab. The
storage notice and the trial or payment notice now stand below the status bar and beside the rail.
After a draft opened from More › Drafts › Edit is sent, the phone returns to Drafts instead of staying
on a page that said the draft was no longer there (phone).

### A waiting send you cancel or discard on the phone stays the way you left it

On the phone, a message waiting for the network that you cancelled and then discarded in Drafts came
back as a draft the next time ohmail started, with its subject and text, and stayed after the network
returned. A discard now sticks. Cancel send keeps the message as one draft, with its files, instead
of a second copy that says to check Sent first after a restart. Nothing was sent either way.

### The phone says when it cannot keep a mailbox's settings

On a phone that organizes its own mailbox, Settings and the Ohbox showed only "Organizing" while every write
of the mailbox's settings to the mail server failed, so the rules and screening choices made there never
reached the person's other devices and nothing said so. The phone now reads the same block the desktop does
and says that the settings cannot be saved to or read from the mail server, with the refusal's code where
there is one. Stop stays offered, and the sentence goes away at the first settings write that works.

### A letter filed elsewhere while another device reads its Inbox shows in its new folder

When another device moved a letter out of the Inbox (into News, for example) while this device
was reading the Inbox and the destination folder, ohmail could see both copies at once and then
keep showing the letter in the Ohbox, unread, with the destination folder not listing it. Pull new
mail did not change that. The letter now follows its remaining copy as soon as the Inbox copy is
gone, whichever order the server reports the two in (desktop, web, phone, Cloud, your own server).
A letter already left behind this way moves to its folder the next time it is moved on the server.

### Back from a letter at phone width keeps the cursor on that letter

On the web app and the desktop app at phone width, Back from a letter opened in the Ohbox left the
list's cursor on the next row, so the next key or verb acted on a letter you had not read. The
cursor now stays on the letter you just read, as it does at wider widths, and goes with it when it
files under Earlier; j and k then move on from its place there.

### Embedded pictures draw from servers that answer nested parts' headers wrongly

A picture embedded in a message, such as a signature logo or a pasted screenshot, was refused as
"could not be verified" and drawn as an empty box when the mail server answered the headers of a
nested part with its parent's. GreenMail does this. The picture's bytes then arrived still encoded.
They are now decoded by the encoding the server's own message structure declares, and served only
when they match the file stored at sync, on every app. On the phone the reader also redraws as soon
as an embedded picture arrives. Pictures from the web still wait for Show images.

## [0.30.6] — 2026-10-26

### A foldable keeps your place and marks nothing read when a pane change shortens the conversation

On a foldable phone, the reader could lose your place when it moved to a pane where the conversation ends before the point you stood at: rotating back to one pane, unfolding from the half-folded book posture, folding the book posture shut to the outer screen, or unfolding from the outer screen into two panes. It came back at the conversation's first message and marked the messages there read on the server. 0.30.4's notes said rotations and folds kept your place "(and back)" with nothing marked read; that was not true on these paths. The reader now returns to where you were and reads nothing until it stands there.

### Parked and Answer later hold a conversation as one row

A conversation in Parked or Answer later is now one row, showing the newest letter from the other side,
where it used to be one row per message, each saying how many messages the conversation had. The counts
on the rail, on the pile tabs and in More count conversations. Taking the row out, moving it to the other
pile, or resurfacing it acts on every message of the conversation in that pile at once, with one
sentence and one Undo. Answer later on a conversation in the Ohbox now takes the whole conversation,
your own reply included, the way Park does, so the conversation leaves the Ohbox instead of staying
there. This is the same on desktop, web and phone.

On desktop and web, sending a reply now takes the whole conversation out of Answer later, not only the
message you answered.

### News and Receipts mark only what you saw after a jump

Jumping deep into News or Receipts, from a search result for example, and then scrolling no longer marks
the letters between where you were and where you landed as read, and neither does dragging the scrollbar
or pressing End. Only letters that were on screen after the landing count, and leaving a pile never moves
its "new since you were here" line back above letters you had already passed. On web and desktop.

### Forward on the web and the desktop lists the original's files

Forwarding on the web and in the desktop app now lists the files of the message you forward, embedded
pictures and calendar invitations included, and lets you remove any of them before you send; only the
ones you kept go. Nothing removed sends every file, as before. A forward trimmed on another device and
finished here sends only the files kept there. A server that cannot leave files out keeps the list
read-only and says that every file goes; a send that names its files there is refused in words and
nothing is sent. Forwarded files over the forward limit, or more than your mail server takes, are said
when you press Send, and nothing goes.

### Forward on the phone lists the letter's files, and sends only the ones you keep

On the phone, Forward sent every file of the original letter without listing any of them, past the sheet's
own "Up to 3.0 MB total". The sheet now lists the original's files under "Forwarded with it", each with its
size, and a file you remove is not forwarded when you send from the phone. The sentence under the files says
what goes: the size of the forwarded files, and how much more you can add from the phone. Your choice stays
with the forward when it is kept as a draft or the app is closed, and when the phone opens without a
connection. If the letter's files cannot be read, the sheet says that all of them go. Against a server older
than this release the files are listed without remove and all of them go, as before; if the server stops
honouring the choice, the phone says so and sends nothing. If a forward with files removed could not be
confirmed as sent, Send again sends nothing rather than every file: make it a draft again from the Drafts
card and send it, and the files you removed stay out.

### A forward trimmed on the phone sends only the kept files from any device

A forward draft kept on the phone now saves the files you kept with the draft, so finishing it on the
web or the desktop app sends only those. A forward draft trimmed on the web or the desktop opens on the
phone listing only the files kept there, and sends only those. This needs a server with the matching
update.

### The Screener keeps the sender you are reading, and Mark all spam asks first

A sender who arrives in the Screener while you are reading another one no longer takes the
selection, so `o` or any other decision key files the sender on screen. A newer letter from the
sender you picked keeps them selected, and so does a suggestion that moves them out of the filter
you are working in. After a decision the selection moves to the next undecided sender down, else
the one above, never onto a sender already decided and never to the top of the list; when nobody
is left, nothing is selected until you pick a sender (web and desktop).

`s` in the Screener list now opens the selected sender's destinations, as it does in the reader,
and moves no mail; `o`, `r`, `c`, `n` or `x` then files that one sender. Mark all spam has no key
and asks first, naming how many waiting senders it moves; a sender who arrives while it asks is not
one of them, and Cancel or `Esc` leaves them all waiting. It also no longer reaches a sender whose
decision is still open in another tab.

### The keyboard ring stays on the message your next key acts on

After u (Mark unread) moved a message up under New, the focus ring stayed on the message that slid
into its old place, so a screen reader announced one message while the next key acted on another.
The ring now goes with the message. When a key files a message and nothing is selected after it
(Close after an action, or a narrow window), the ring rests on the list instead of on a message
nobody picked, and j takes it from there.

In History, choosing a year or a month by keyboard now selects that period's first message and puts
the focus on it, and j and k walk History as the arrows do.

z right after Park, Later or another action now undoes it, also when pressed before the Undo toast
appears.

On the Linux desktop, a screen reader now hears each message's time, read state, attachment, thread
size and tags, not only the sender and the subject (WebKitGTK did not pass them on).

On the desktop signed in to ohmail Cloud, the diagnostics under Help & contact now carry the account
id, as on the web; a standalone install still says none.

### A big first import keeps setup's promises about the Screener

When you agree on the window step, every letter inside the window from a sender you have not decided
about now reaches the Screener, however large the mailbox, not only the newest thousand. Mail ohmail
finishes reading after you agree is included. Before, senders whose letters sat further back stayed
in the Ohbox as new mail.

"Screen N" now takes only letters inside the window you chose, as the window step said. A letter
counts as inside only when both its date and its arrival on the server are, so mail a migration tool
copied in recently keeps its place, and changing the window while the first sort runs never widens
it. Older mail stays in the Inbox and is not moved on your server.

On the phone, the Ohbox offers "Screen N" as the import fills it, without leaving the tab and coming
back.

While the first import runs, the window step names the whole count, not a figure stuck at 1,000.
When the mail server cannot be reached, setup says that ohmail is reconnecting, and says so again
when the connection is back. On desktop, web, phone, Cloud and your own server.

### A message sent just before closing keeps its Sent copy when the mail server was slow or had stopped answering

A message sent shortly after another one, while the mail server was slow or had stopped answering,
could go out without its copy in Sent if ohmail closed within the next seconds. It now waits the way
the first message does, and goes with its copy when ohmail starts again (desktop, and the phone on its
own). While the server stays silent, such a message is not sent, and ohmail says so.

### ohmail Cloud brings back the text of emptied letters when there is room again

When an account's stored letter text reaches its plan's limit, ohmail Cloud empties the text of the oldest
letters. Until now that text stayed gone after an upgrade, the storage add-on or erasing a mailbox. ohmail
Cloud now fetches it back from your mail server once there is room, newest letters first and a little at
a time, up to nine tenths of the plan's storage. During a trial's 4 GB of storage and the 14 days after the
first payment, it fetches text back only up to nine tenths of your plan's own limit, so nothing it brings
back is emptied again when that limit applies. It only reads your mailbox and changes nothing there.
Letters no longer on your mail server stay without their text, and so do the letters of a mailbox you
removed, which ohmail no longer reads. The web app, the desktop app on ohmail Cloud and the phone show the
text as it returns. The storage notice says that more room brings the text back, or that there is room
again and it is coming back, for the mailboxes ohmail still reads; it says that a bigger plan does not bring
emptied text back only when ohmail reads none of your mailboxes, and says neither while a mailbox is still
on its first import. The note on an emptied letter says its text comes back when there is room, and on a
removed mailbox's letter that it does not. A count of emptied letters carried over without a date gets
one at the next emptying.

### Importing saved settings no longer fails a press made at the same moment

Importing another ohmail's saved settings, or the organizer finishing or refusing such an import, could
abort a triage or Screener press made in the same instant, which then failed with a server error. Both now go
through. Cloud and your own server.

### A press made beside a mailbox change no longer fails

Renaming a mailbox or changing its password, signing it in again, agreeing again to organize it, saving
settings for two mailboxes at once, or deleting the account could abort a triage, delete, restore, folder or
thread-merge press made at the same moment, and one side failed with a server error. Both now go through.
Cloud and your own server.

### A folder change made beside a Screener decision no longer fails

Creating, renaming or deleting a folder, or saving a mailbox's folder or signature settings, at the same
moment as a Screener decision in the same account could abort, and the press failed with a server error. Both
now go through. Dismissing a failed folder change while the account was being deleted no longer leaves a sync
record of the deleted account behind. Cloud and your own server.

### The web app runs Next.js 15.5.28

Next.js 15.5.28 fixes two cache-poisoning flaws in self-hosted servers, where a crafted request could
leave another visitor a wrong or broken copy of a page, and a denial of service through Server Actions.
The web image for your own server and the web app on ohmail Cloud are built on it.

## [0.30.5] — 2026-10-25

### Every conversation's row has rounded squares in the paper look

On desktop, web and the phone, the small squares under each conversation's preview in the list now have
softly rounded corners in the paper look, in proportion to their size, and the outlined square for your own
message is rounded the same way. They stay square in the Omarchy look. In 0.30.4 the release note said the
list row's squares were rounded, but only the open conversation's row was. The other rows kept sharp corners.
On desktop and web, the hover box of a square beside a conversation in the narrow reader is now rounded too.

### The open conversation's row shows one strip of squares and one box

On desktop and web, the open conversation's row in the list could show its small squares and the
walking strip under them at once, with the keyboard ring round the row alone and a second frame round
the strip below it. The row now draws its squares once, as the strip while the conversation is open,
and the keyboard ring, a pick and the slide to Earlier take the row and its strip together.

### Search finds a letter when your words sit in different parts of it

A search of two or more words found a letter only when every word was in the same part of it: all in the
subject and sender, or all in the text. `kai lanternfish` missed a letter from Kai whose text mentions
lanternfish, and `aquarium food` answered "Nothing matched exactly" for an invoice titled "aquarium
supplies" whose text says "food". Each word may now sit anywhere in the letter: subject, sender,
recipients, file names or text. A quoted phrase still has to appear as written in one place, and a word
with a minus in front (`-lanternfish`) now keeps out every letter that holds it anywhere, closest-word
guesses included; before, it was checked in one part only. A single typed term such as an address
(`anna@club.ch`) or a hyphenated word still has to appear in one place. On the desktop app, the phone,
Cloud and your own server. While search is still indexing your mail, a letter it has not reached yet is
read one part at a time until it has. On the phone, a word found only in a sender's display name, a
recipient or a file name still cannot take part in a search of several words: the phone's word index
holds the subject, the sender's address and the text.

### A message sent from another device no longer comes back in Compose

On the web and the desktop, a message you started here and then sent from another device no longer reopens when you press Compose. Before, Compose showed it again with its recipients and words, and a new message typed into it went to both the old and the new recipients with the old words. Compose now opens an empty message. Anything you wrote here after the last save is kept once in Drafts, and you are told. The same holds for a reply: Reply no longer brings back a reply that already went from another device.

On the device you send from, the message now leaves Drafts as soon as it is sent. Before, a save that arrived just after the send kept it in Drafts with its words and Discard for up to a minute and a half, one press away from sending it again.

On your own server, update the server before the web app and the desktop app; an older app keeps working as before.

### A draft saved while offline belongs to its message when it reaches your account

On the web and the desktop, a reply or message written without a connection is saved as a draft once the connection is back, and the reply or message on screen now keeps using that draft. Before, a second reply written offline could be sent without it, and its draft stayed in Drafts after the reply went, one press away from a second copy. A draft saved twice while offline now ends up as one, and a draft that was already on its way when you pressed Send is removed once the message has gone. A reply closed and opened again, with Reply or from Drafts, before its draft reached your account keeps using that draft too: it is sent once and leaves no copy behind. The same holds for a message reopened from Drafts while its draft was still on its way, which no longer leaves a second copy with older words, and for a reply or message whose page was reloaded before the connection came back. Cancelling a send that was waiting on a slow first save leaves one draft of a reply, and nothing of a message you discarded.

### ohmail Cloud says when storage is nearly full, and what adds room on your plan

The storage notice on the web app, the desktop app on ohmail Cloud and the phone now also appears at 90% of
your plan's stored-text limit, before any text is emptied, and again when the limit is reached. It names
what keeps more text from now on for your plan: a bigger plan, or the storage add-on, or on the largest plan
the storage add-on alone (during a trial on the largest plan, once the subscription is paid). Put away, it
comes back when the storage gets fuller or when you are nearing a new limit. During a trial's 4 GB of
storage and the 14 days after the first payment, it says in time when your plan's own limit applies and
that the text of the oldest letters beyond it is emptied then. After a move to a bigger plan, text emptied
under the old limit is no longer described as being emptied now. Well below the limit the notice offers no
purchase and shows no Manage subscription button. Where no emptying was recorded with a date, it says only how
many letters' text is not stored here, not that they were the oldest. A notice you put away in 0.30.4 stays
away until the storage gets fuller. Mac App Store and phone store builds still
name no plan and offer no purchase; your own server has no limit and shows nothing.

### Connecting a mailbox starts with your address

The connect forms now ask for your address first: on the web's setup and in Settings → Mailboxes, in the
first-run add form, and in the desktop app's door for your own mail server. An address at a provider ohmail
knows (Gmail, Outlook.com, iCloud, Yahoo, Fastmail, GMX, Infomaniak, WEB.DE, t-online, bluewin) chooses its
tile for you, and you can still pick another. On ohmail Cloud, an address at your own domain is looked up
as you type: a domain on Google Workspace chooses Gmail and one on Microsoft 365 chooses Microsoft, even
when you pressed the manual "Any other IMAP mailbox" before the answer came. Only the domain is sent. A
slow or failed lookup leaves the choice to you, and a Proton address says why it cannot connect.

Each provider's note now opens with what you'll need before you type a password. A refused password on a
named provider says that provider's own sentence, and when the server you typed for "Any other IMAP
mailbox" cannot be reached, the form offers the servers your domain's DNS names, with a button that only
fills them in. The sign-up page's account step now links to sign-in for people who already have an
account.

### A forward shows the message it forwards, and folds only the thread below it

Forwards from Outlook, Outlook on the web and Samsung Email write no forward wording into the body, so
ohmail took their forwarded message for a reply's quoted history and hid it behind Show history. ohmail
now also reads the subject: when it starts with a forward's prefix in any of the common languages (Fwd,
FW, WG, TR, I, RV, Doorst), the forwarded message stays open. Below it, the older messages of a
forwarded thread fold behind Show history, for these forwards and for Gmail, Apple Mail and Thunderbird
forwards alike, which before showed every level in full. A forward of a forward ("WG: WG:", "Fwd: Fwd:")
shows the letter the inner forward delivers. A forward of a letter that is already in the same
conversation still shows it. In every reader, News and Receipts included, on the desktop app, the web app
and the phone.

### Send again looks in Sent first and sends the same message, with its files

When ohmail could not confirm a send, Send again used to mark the held send as not arrived and send the
letter as a new message, without looking in Sent and, on the phone, at times without its attachment. A
letter that had in fact been delivered then reached its recipient twice. Send again now asks the server to
send the held message itself: it looks in your Sent folder first and sends nothing when the message is
there, it goes under the same Message-ID, and it carries the files that went the first time. A Send later
message that could not be confirmed can be sent again too. If the message cannot be matched to the one
that was held, or Sent cannot be checked, nothing is sent and the press says why; on the phone you can then
make it a draft again and send it as a new message. One press sends at most once, however often it is
retried, and a press that sent it says "Sent.", never that nothing went.

On the phone, the sheet of a send that could not be confirmed now offers Send again and Close; Close leaves
the message in Drafts. A delivered letter whose copy could not be put in Sent says so. Drafts says it is
checking your Sent folder for twenty minutes after a send could not be confirmed, looking one and fifteen
minutes in, and then that the message is not there; it used to say "checking" for a day. A copy that
reaches your mailbox's Sent folder later that day still settles the send by itself.

If your mail server does not keep the mail it sends in Sent, and the server took a message whose answer
was lost, no check can see it: Send again then sends it once more under the same Message-ID, and the
phone says so beside the button, in the sheet and on the Drafts card. Send again on the web and desktop apps still sends a new message; they
follow in a later release.

### Shortcut keys do what the sheet says, and "Tomorrow" after midnight means this morning

In Answer Later, `d`, `⌫` and `⌦` now delete the letter on screen as they do in the Ohbox. `⇧R` on a
letter from one person opens the reply to that person instead of doing nothing. `z` after the Undo
window has closed says "Nothing to undo." rather than staying silent. The shortcut sheet lists
`Ctrl ↵` as "Send the reply" outside the Reply Run, where it does not move to the next message
(web and desktop).

Between midnight and 05:00, Resurface's "Tomorrow" and Send later's "Tomorrow morning" now mean the
coming morning, on web, desktop and phone. Resurface's "Pick a date" offers today while the chosen
time is still ahead. On a Sunday, Resurface ("Next week") and Send later ("Monday morning") no
longer offer the same Monday a second time beside "Tomorrow".

### A letter held at the gate is dated by when it arrived

A letter the Screener held could carry an old `Date:` (a calendar stamp, a re-sent letter)
and be filed under History at once, read or unread, so its sender was never asked about. The Screener
now dates a held letter the way the gate did, by when your server received it: such a sender waits in
the Screener, on the web, the desktop app and the phone, and the count beside it agrees. Mail your server
received before the window, and mail a mailbox's first import brought in, still waits in History, read
or unread. Settings > Screener now says so: the
note under "When a sender goes quiet" no longer claims that unread mail always shows. On Cloud and your
own server this needs the server updated with the apps.

### Changing where a rule files mail moves only the mail it filed

Settings > Rules > Change, with "Also move the mail it filed" on, now moves the messages the rule
filed in its old place to the new one, and nothing else. Before, it moved the sender's messages that
were left in the Ohbox when the rule was made, and left the message the rule had filed behind. Messages
you replied to, filed in another mail app or set aside stay where they are, and so does mail another
rule filed. The pane and the toast name the place the mail comes from and count only that mail, in the
mailboxes ohmail organizes. The move waits out the toast's Undo, so an Undo moves nothing. When a press
in the sender sheet asked for a sender's earlier mail and that is not finished, a Change moves the mail
the rule matches to the new place, and its Undo sends it back where it was going. Web and desktop, on
Cloud and your own server.

### Every press that needs a fresh second factor asks for it in place

On the web, on Cloud and on your own server, a few presses answered a sign-in older than a few minutes
with a refusal and nothing else: taking a mailbox over from the setup's "Organize here instead", testing
and connecting a mailbox in setup, forgetting it from setup's Start over (which went on to an empty
start while the mailbox stayed connected), replacing recovery codes, replacing or removing the authenticator app,
making or withdrawing an invite link, and confirming the desktop app's sign-in. Each now asks for your
code or passkey right there and, once it verifies, does what you pressed, without signing in again.
Cancel leaves everything as it was and says so. In Settings → Mailboxes, the code prompt behind "Take
over" now opens in the mailbox's own card and says it is for the take-over, and cancelling it says that
nothing changed; before, it opened under the list while the card looked as if the press had done nothing.

### The desktop app asks about an update in its own window

When the desktop app has downloaded and verified an update, it now asks inside the ohmail window, with the
update strip and its Restart button, instead of opening a separate dialog. That dialog had no parent window on
Linux, so on a tiling desktop such as Omarchy (Hyprland) it opened on whatever workspace was in front rather than
where ohmail runs. "Later" still leaves the update ready, and the strip asks again at most once a day, or at once when
Check for Updates or Try again finds the update ready.

### The desktop columns keep an even frame on Omarchy

On Omarchy the rail, the list and the reading column now sit inside the window with the same gap
around them as between them, whatever Hyprland's gaps read: an outer gap of 0, one side set
narrower than the others, or Omarchy's own window-gaps toggle left the columns pressed against the
window edge or against each other. Toggling the window gaps now reaches an open window without a
restart (desktop).

### Cloud erases a closed account only after its erasure warning was delivered

ohmail Cloud erases the account data of a subscription that stayed closed past its retention period, and
mails a warning in the week before. The erasure now waits until that warning was delivered. A warning that
never went out, because the mail limiter held it back or a run stopped before sending, goes out late and
names a date a week ahead, and the erasure waits for that date. After the erasure ohmail keeps when the
warning was delivered, under the account's random id only (no address, name or mail), for ten years, as
long as the billing record; then the hourly maintenance deletes it. A lifecycle mail that reached nobody is
no longer recorded as sent, and a later run sends it. Deleting your account yourself is unchanged.

### Cloud can remind a new trial once to connect its mailbox

On ohmail Cloud, a trial that has connected no mailbox a day after it began can get one mail that says so. Its
button signs in if needed and opens the setup's mailbox step. Gmail addresses get the app password steps, a
Microsoft 365 work or school mailbox is pointed to Connect Outlook under Settings → Mailboxes, Outlook.com and
Hotmail addresses are asked to reply for help, and a reply reaches a person. It goes out at most once per trial,
never to a trial set to cancel or with two days or less left, and carries no tracking. It starts switched off:
until it is switched on, the nightly run only logs which trials it would remind. Switching it on names the time
it starts from, and a trial that began before then is never sent it.

## [0.30.4] — 2026-10-25

### The thread squares follow your reading, and the open row in the list shows them too

In the Ohbox on the web and the desktop, the ring on a conversation's squares now walks from the first message at the
top to the last at the very end, one message at a time and never backwards, even when the last message is a single
line. Pressing a square brings that message to a steady reading height and keeps the ring on it until you scroll.

The open conversation's row in the list now carries the same squares under its preview, ringed where you are reading.
Pressing one scrolls the conversation there. Once the conversation is closed, the row keeps the ring where you
stopped, and pressing a square opens the conversation at that message. A reply that arrives, or a conversation marked
unread, shows on the row's squares right away.

Pointing at a square, or reaching it with the keyboard, shows who sent that message and when.

The squares now stand an equal gap from the list and from the message, and their corners follow the theme, so they
are square in the Omarchy look.

### On the phone the squares follow you through a conversation, and the list row carries them

On Android and iOS, the ringed square beside a conversation in the Ohbox now walks it from first to last:
at the top the first message is ringed, at the very bottom the last one, even when it is a single line,
and it never steps back while you scroll one way. A press on a square brings that message's top to the
reading line and keeps its ring until you scroll. Back on the list, the conversation's row shows the same
squares, ringed where you stopped; a press on one opens the conversation at that message. Under ohmarchy
the squares have square corners.

### Softer thread squares in the paper look, and a fuller name card on each

On the web and the desktop, the squares beside a conversation and in its list row have softly rounded corners in the
paper look, with the ring around the current one rounded to match. They stay square in the Omarchy look.

Pointing at a square, reaching it with the keyboard, or holding a finger on it now shows two lines: who sent the
message ("you" for your own) with a friendly date such as "yesterday 17:40", and the message's first line, with a
paperclip when it has an attachment. Holding a finger on a square no longer jumps to the message.

### On the phone, holding a thread square shows who wrote that message and when

On the phone, the squares beside a conversation and in its row in the Ohbox list have softly rounded corners in the
paper look, with the ring around the current one rounded to match; they stay square in the Omarchy look.

Holding a finger on a square now shows a small card beside the squares or under the row: who sent that message
("you" for your own) with a friendly date such as "yesterday 17:40", and its first line, with a paperclip when it has
an attachment. Holding does not jump to the message; a tap still does.

### A message you send stays in view while it goes, and a forward shows what it forwards

On the web and the desktop app, the line at the bottom of the sidebar that says "Sending to …" and
then "Sent to …" now stays at the bottom of the window. With a few mailboxes, folders and tags it was
drawn below the sidebar's fold, so after the editor closed nothing said the send was on its way. The
folder list now scrolls above it. On a short window, several sends at once scroll inside the line, with
the newest send always in view, so Compose and the folder list keep their room.

A forward with a note ("---------- Forwarded message ---------", "Weitergeleitete Nachricht", "Begin
forwarded message:") shows the forwarded message whole again on the web, the desktop app and the phone,
instead of folding it behind Show history. Replies still fold their quoted history, including a reply
that quotes a forward.

### Answers typed inside a quoted Outlook mail stay in view, and GMX replies fold their history

On the web, the desktop app and the phone, a reply whose answers sit inside the quoted mail, in the
same black text and marked only with the writer's initials or name ("[AE] Yes, …", "[Ana Example]
Yes, …"), no longer hides those answers behind Show history. A one-line "[EXTERNAL]" notice or an image
placeholder in the quoted mail does not count as an answer, so such replies still fold.

Replies from GMX, WEB.DE and mail.com now fold their quoted history when the reply is one sentence
("Ja, Dienstag um 10 Uhr passt mir gut."); before, the whole history stayed open below it.

### News and Receipts stay ready between visits on the web too

On the web, News and Receipts were built again from scratch at every visit, so switching to them took as
long as opening them for the first time. They now stay ready while you are on another pile, as
on the desktop: a switch back shows the list where it was built, with any mail that changed meanwhile. A
pile you are not looking at marks nothing as read.

### The desktop's columns keep their outer borders when Hyprland reports no outer gap

On Omarchy the desktop app takes the edge around its columns from Hyprland's outer gap. When that read
came back as 0, the rail, the list and the reading column stood flush against the window, their outer
borders drawn outside it, so only the seams between the columns showed their doubled lines. The edge is
now never narrower than the columns' border, so every column keeps its whole frame.

### The phone keeps the newest message in view when a foldable opens to two panes

A conversation opened on the phone lands with the newest message in view. Rotating or unfolding a
foldable from one pane to two (and back) moved the reader into the middle of the longer message above
it, and the newest left the screen. The reader now lands on the newest message's top again after that
switch, or at the conversation's end where the newest is shorter than the screen, also when its body
arrives after the switch; a place further up still keeps the message under the top line. Nothing is
marked read on the way.

### Folding the phone half open or to its outer screen keeps your place and marks nothing read

On a foldable phone, a conversation you were reading kept its place when you half-folded the phone
(the book posture) or folded it to the outer screen, and no older message turned read on the way. Before,
the reader could come back at a spot inside an earlier message and mark that message read on the server
although you never saw it. While the reader finds its way back after a fold, a rotation or a new width,
it now reads nothing until it stands at your place again or you scroll yourself, and a message you had
only begun to look at before the fold needs its full look again. A conversation opened from one of its
squares on the list keeps that message through a fold, and one that fits the unfolded screen whole reads
as usual.

### Sent to … also appears when a send's first answer was lost

When the server delivered a message but its answer never reached the app, the retry under the same key was
answered from the server's record of that delivery, and the sidebar's foot went blank instead of saying
"Sent to …", with a note that the message "had already been sent". The retry of your own press now ends the
way any delivery does: the foot says "Sent to …" (or the editor that waited says "Message sent."), and a
single press no longer gets the "already been sent" note. A press that joins or resumes an earlier send still
says so. On the web and the desktop app.

### The desktop app sends at once on ohmail Cloud

On the desktop app signed in to ohmail Cloud, or to a server of your own paired the same way, a new
message no longer waits about two seconds before it goes out, and the foot no longer says "Still sending
to …" after the account has already taken it. The app used to wait for this computer's copy of the mailbox
to catch up with each half of a send before going on; a send now goes on as soon as the account answers,
and the copy catches up behind it. "Sent to …" appears about as quickly as on the web.

### A slow send keeps its Sent copy, and a dropped upload says it was not sent

A send whose mail server took a long time to accept it was delivered but could lose its copy in Sent: the copy went over the mail connection opened before the send, which had timed out by then. The copy is now filed after the server accepts the message, on a fresh connection when the first one has died, and every retry looks in Sent first, so there is exactly one copy. Cloud files it before it answers; the desktop app, the phone and your own server answer at once and keep trying in the background.

When the connection drops while the message is still uploading, ohmail now knows the message was not sent and says so ("the connection dropped before the whole message reached your mail server"), and the draft is a draft again. Before, this read as "We couldn't confirm this send". Only a drop in the last moment, once every byte has left your device and before the server answers, still asks you to check Sent. A recipient the server refuses is named the same way.

A slow upload is no longer checked while it is still running: its draft stays "sending" until the server answers, instead of turning "We couldn't confirm" after ten minutes and being sent a second time by Send again. On Cloud, several letters scheduled for the same minute no longer run past the time a scheduled pass is given; the ones it cannot finish go out on the next pass.

On the phone and the desktop app, a large attachment on a slow link no longer times out while it is still uploading: the phone hands the network at most 16 KiB at a time, and the local send waits up to two minutes for the server instead of 25 seconds.

### Large attachments leave from the browser, or the send says why not

On ohmail Cloud in the browser, a message with more than 3 MB of attachments never left: the page's
security policy blocked the upload to storage, the send kept retrying with "Not sent yet. ohmail is still
trying.", and Compose kept reopening that message, so no other could be written. The page now admits the
storage upload path, and nothing else on that host. A page that cannot upload offers 3 MB of attachments,
what a send carries without the upload, and a send it cannot upload ends with "Not sent", the draft kept and
Compose free again. An upload whose storage cannot be reached gives up visibly instead of retrying for ever,
in the browser and in the desktop app on an ohmail Cloud account.

### Park takes the whole conversation out of the Ohbox

Park (`e`, or the Park button) on a conversation in the Ohbox parked only its newest message, so the
conversation stayed in the Ohbox, still selected, and each further message needed its own press. Park now
parks every message of the conversation the Ohbox shows as one row, your own reply included: the row
leaves, the next one is selected, and one Undo (`z`) brings them all back. Mail of the conversation filed
elsewhere (archived, or under Answer later) stays where it is. On the phone, a second press of Park in the
open message brings the whole conversation back. Desktop, web and phone.

### A filing into an ohmail folder another app deleted is filed again

When another mail app deleted one of ohmail's own folders (say an empty `ohmail/Screened`), every
letter filed there afterwards stayed in the Inbox on the server, and ohmail said "your mail server
refused it". The organizer now makes its own folder again, once, and files the letters there. A
folder of yours that is gone is never made again; the filing waits with the reason "the folder is not
there". All apps.

### The desktop and the phone say which filings wait, and why

Letters your mail server has not taken into their folder yet are now listed in Settings on the
desktop and on the phone, as on the web: how many, into which folder, since when, why ("the folder
is not there", "the mailbox is full", …) and where they are now, with Try again now and Leave them
where they are. The phone also shows the strip over the Ohbox that it never had, and Check this
mailbox on the phone counts the filings that still wait.

On a desktop signed in to ohmail Cloud the strip and the list now show the filings Cloud holds;
before, that desktop always said none were waiting. On a phone with more than one account, Settings
lists the waiting filings of the account you are looking at.

### Letters deleted in another mail app leave ohmail, Spam included

On Cloud and the desktop app, a letter you marked as Spam that another mail app then deleted from the
provider's Junk folder stayed in History and Search. ohmail now checks the letters it filed into Junk
and lets the deleted ones go; a Junk folder it cannot read in full deletes nothing. The Screener no longer
offers letters that are already gone from the server, and deleting a letter that is already gone says so
instead of listing it in Trash.

### A draft you discard stays discarded

On the web and the desktop, deleting a draft from Drafts now also empties a message or reply that still held it, together with the copy the browser keeps of it. The words no longer come back the next time you open Compose or reply to that message, and a reload no longer saves them again as a new draft that reached your other devices. When the delete is refused because the draft is still being sent, the draft stays in Drafts and says so, and the editor stays empty.

A message or reply whose draft was deleted on another device is no longer saved again when it reopens, also when its last changes were saved while offline and ohmail saw them reach the draft. Changes it never saw arrive stay on screen with a note that the draft was deleted, and are saved as a new draft once you edit them. If you had typed something there that the draft never held, it is kept as a new draft and the message says why.

### A draft open in two places no longer overwrites itself

On the web and the desktop, when a message you are writing is changed in another window or on another device, what you type here no longer silently replaces it. The draft keeps the other version, what you typed is kept as a new draft beside it, and the message says so. Send does not send the other version, and what is on screen is kept as a new draft there too; "Send as a new letter" sends it. Edits made offline that come back to a draft changed elsewhere are kept as a new draft as well, and you are told once. Your own saves, including ones made offline or retried after a lost connection, never count as a change elsewhere.

A send whose save was refused now says it was not sent, and no longer says your draft is kept when the draft holds different words.

On your own server, update the server before the web app and the desktop app; an older app keeps working as before.

### Phone: a message waiting for the network is in Drafts, and Discard cancels it

On the phone, a message or a reply sent with no network is listed in Drafts at once as Waiting to send, with
Cancel send beside it; Cancel send keeps the words as a draft, also when the server cannot be reached to
cancel, and says so when they could not be kept. Discard on it cancels the send, deletes the draft
and says that nothing was sent. It no longer ends in "Sending didn't work" and a "could not be saved" banner
that stayed on every screen. A send already on its way when Discard is pressed says so, and nothing is deleted.

### Letters that arrived while a phone had handed its mailbox back are offered after Start

On Android and iOS, a letter that came in after Stop organizing here and before Start organizing here
was never filed by your rules and never offered, unless its sender was new. The phone stored every
letter without the time it reached your mail server, because its date parser refused the form the
server writes that time in. The phone now reads that time itself, so after Start the letters from
senders with rules are offered to be filed, and the new senders' to be screened, as on the desktop.

The phone also reads the server's time on its organizer claim now, as the desktop does: a phone whose
clock is more than about two and a half minutes off the server's stops syncing, and its card and its
notification say so in the desktop's words until the clock is set.
Letters a phone stored before this change keep no arrival time; when such a window closes with
nothing to offer, the organizer logs how many it could not see.

### Letters on the phone show the date they were sent, whatever form their Date line takes

On Android and iOS, a letter whose Date line had no weekday, no seconds, the zone written `UT`, `Z` or
`+02:00`, a month in lower case, or a two-digit year was stored with the moment the phone read it as its
sent date, or with a date in the year 26. The phone now reads these dates as the desktop does, so such
letters show and sort by the time they were sent, and the Junk and Trash lists show their dates. Letters
the phone already stored keep the date they were stored with.

On every app, a Date line whose zone is a common name such as `CET`, `CEST`, `MEZ` or `JST` is read at
that zone's offset, instead of as the moment the letter was read. An ambiguous or unknown name is read
as before.

### The Ohbox count on the rail includes letters brought back by Resurface

A letter brought back to the top with Resurface > Now was left out of the rail's Ohbox number, and out of the
dock badge, while the Ohbox header counted it, and a reload did not fix it. The rail, the header, Mark all read,
the badge and the phone's Ohbox now count the same unread letters (web, desktop, phone).

### Unread messages in a conversation are no longer blue in ohmarchy's light themes

In the ohmarchy face's light themes an unread message in a conversation sat on a pale wash of the
theme's accent, light blue in Flexoki Light. It now sits on the theme's own surface, the panel taken a
step toward its ink, beside the accent edge it already had; a message you have read settles back to the
panel as before. Its text, the sender's address, the time and links included, keeps at least 4.5:1 in every
light theme, which the old wash missed in Catppuccin Latte, Rosé Pine, Lupine and White. Desktop, web and
phone; the paper face is unchanged.

### A letter filed in another client stays in News or Receipts

A letter from somebody you let in that first shows up in News, Receipts, Screened or Quarantine, because
another mail client, a server filter or a plus address put it there, now stays where it was filed. Before,
ohmail moved it back to the Ohbox within a minute and said nothing. The Ohbox's "Since you were here" line
does not count it as ohmail's filing. Mail from senders you have not let in still goes to the Screener, and
a sender you quarantined still goes to Quarantine. On the desktop app, Cloud and your own server.

### Phone: people you have written to get through to your Ohbox

A phone that runs its own mail engine never asked about the people you had written to before you
connected, so each of them counted as a first-time sender: their next letter waited in the Screener, and
the rest of their mail left the Ohbox with it. Once the first import has finished, the phone now shows the
people from your sent mail, as the web does, and asks whether they may get through. Everyone not yet
decided starts ticked, people you already decided about are shown and left as they are, and the addresses
left out are listed with the reason. Confirming adds a rule for each ticked person and moves anything of
theirs waiting in the Screener back to your Ohbox; nothing else moves. "Not now" is kept for that account
on this phone, and Settings, "People you write to", opens the list again. The "Screen" offer in the Ohbox
waits until this is answered, so it cannot hold the people you are about to let through.

A phone already in use asks once after the update, and a yes returns their held letters.

### A letter being written on the phone survives a force-stop, and a kept draft keeps its files

On the phone, a letter was kept only when its sheet closed, so a force-stop, a reboot or a crash lost what
was typed and any picture attached to it. The phone now writes the open letter to its own storage half a
second after each change, and at once when the app leaves the screen; the next launch turns a letter left
that way into a draft and says so once. A letter that was being sent is never sent again by that launch:
if its send still waits it goes once, and if it is unclear whether it went, it is kept in Drafts with a
note to check Sent first. A send the server could not confirm stays the one row Drafts shows for it, with
its attachments.

A letter kept in Drafts now keeps its attachments on this phone (a draft on the server holds no files),
up to 12 MB for all drafts together; opening the draft again brings them back, and sending it sends them.
Files past that limit are named before the draft is kept.

### Screening a thousand letters no longer stops the phone saving new mail

On a phone running on its own, pressing Screen on a large Ohbox (up to a thousand letters) wrote its
bookkeeping one letter at a time while holding the phone's mail store. On a slow device that took
minutes, and every other write waited behind it: new mail could not be saved, filing paused, and the
Ohbox said "New mail could not be saved on this phone" until the press finished. The press now writes
the whole batch in a handful of statements, so it holds the store for a moment instead. When a
write does have to wait, the phone's diagnostic file now says so by name and records what held the
store and for how long.

### A photo attached on the phone keeps a real name

On the phone, Attach a photo listed and sent a picture under the photo picker's media number, such as
"19.jpg". A picture now keeps its own file name; where the picker gives only a number or a cache name, it is
named "Photo" with the date and time of the pick ("Foto" in German), and a second picture of the same name
in one pick gets " (2)". Picking the same picture again still says it is already attached rather than
listing it twice. Attach files was not affected.

### Settings has a Help & contact section

Settings on the web, the desktop and the phone gains Help & contact, beside About. Write to us opens a new
mail to support@ohmail.app from your own mailbox, with a subject and a short diagnostics block: the app
version and build, the platform, your account id, which kind of mailbox is connected and the kind of its
last sync error. The block never holds an address, a host, a subject, a folder name or any mail content; it
sits in the message where you can read it, and one press removes it. Where there is no mailbox to send
from, Write to us opens your mail app with the same subject and block; on the desktop, which would
open its own composer instead, it offers the address and the block to copy. A self-hosted server's web app has
no such section, since its operator, not ohmail, runs that server.

### Setup picks up where it stopped when no mailbox is connected yet

On the web (ohmail Cloud and your own server), an account that signed up but never connected a mailbox no
longer comes back to an empty mail client. Once per browser tab, opening ohmail takes it to the setup page,
which resumes at the mailbox step. "Do this later" on that page is respected for the rest of the tab. It never
happens over a link to a particular place in the app, or while a mailbox sign-in is finishing. A signed-in
account never sees the sign-up form there: the page waits until the server has said where setup stands, and
if the server cannot be reached it says so, with Try again.

An empty Ohbox with no mailbox now shows a "Connect your mailbox" card. Its button, and the link in the sync
bar, open the setup page on the web and Settings → Mailboxes in the desktop app. The setup dialog on the web
hands its first connect to the setup page, which can ask for your second factor in place. The ohmarchy theme
offer waits until a mailbox is connected, on every app.

### Sign-up offers Sign in with Microsoft for a Microsoft mailbox

On ohmail Cloud and on servers set up for it, the sign-up's mailbox step now connects the Microsoft tile by
signing in with Microsoft, as Settings → Mailboxes already did. An app password is still there behind "Use an
app password instead". After the sign-in the browser comes back to the sign-up, which names the mailbox once
it is connected or says in its own words why it was not, with the Microsoft tile ready to try again. A
password Microsoft refuses points to the sign-in instead of to app passwords. A server whose only Microsoft
door is the device code points to Settings → Mailboxes after setup.

The mailbox step also has a way out: "Do this later" opens ohmail without a mailbox, and on ohmail Cloud "or
write to us" starts a mail to support that names the provider and the last refusal's code, nothing typed.

### WEB.DE, t-online and bluewin get their own tiles, and Proton Mail says why it cannot connect

The provider picker on the web, in the desktop app and on your own server now offers WEB.DE, t-online and bluewin, with their servers filled in and what each needs before you type a password: WEB.DE's IMAP switch, Telekom's separate e-mail password. On the phone, an address at web.de, t-online.de or bluewin.ch fills in its servers. A Proton Mail tile explains that Proton reaches other mail apps only through Proton Bridge, which ohmail cannot connect through yet, so a Proton address no longer fails without a word. The "Any other IMAP mailbox" tile now tells you to choose Gmail or Microsoft when your own domain's mail is hosted by Google Workspace or Microsoft 365.

ohmail Cloud can now look up which provider hosts a domain's mail from that domain's DNS records alone (MX, and the SRV records of RFC 6186), for the connect forms to suggest a provider. Only the domain is sent, never the part before the @, and nothing about a lookup is stored or logged.

### The sign-in screens show a new person where to sign up and set up

On the web, where anyone can sign up, the sign-in page now has a "Create an account" link next to
"Have an invite code?". In the desktop app, the ohmail Cloud sign-in offers "Create one in your browser"
when you have no account yet, and a Cloud account with no mailbox gets an "Open setup in browser" button
under Settings → Mailboxes. The Mac App Store build shows neither button and says where mailboxes are
connected instead. On the phone, the ohmail Cloud door now says to connect your mailbox on the web before
pairing.

### Trial mails no longer promise to keep organizing a mailbox that was never connected

On ohmail Cloud, the "trial ends in two days" mail told an account with no mailbox connected to subscribe "to keep
ohmail organizing your mailbox", and the closing mail said ohmail had stopped organizing it. Such an account now
gets its own version of both: it says no mailbox is connected, its button signs in if needed and opens the
setup's mailbox step, it names Connect Outlook under Settings → Mailboxes for a Microsoft 365 work or school
mailbox, and a reply reaches support.
Accounts with a mailbox get the same mails as before, and the "Open your ohmail account" button in every account
mail now opens the account settings instead of a missing page.

### Erasing a mailbox frees its storage on ohmail Cloud

On ohmail Cloud, "Remove and erase" deleted the mailbox's letters but left their size on the account's
storage count. The count then stayed too high for good, and once it neared the plan's limit ohmail emptied
the text of older letters in the mailboxes the person kept, to make room it did not need. Erasing a mailbox
now takes its letters off the count, the background trim waits while an erase is still running, and for an
account that has erased a mailbox the count is checked against the stored letters before any text is
emptied. The release recounts those accounts too. The letters themselves always stayed complete on the
person's own mail server.

### ohmail Cloud checks its storage count before emptying older letters

On ohmail Cloud, an account at 90% of its plan's storage now has its count checked against the stored
letters once a day, before any older letter's text is emptied to make room. A count that had drifted above
the real total no longer empties the text of letters the person kept. For each account ohmail Cloud also
records how many letters' text it has emptied for space, when it last did so (and first, for accounts where
that happens after this release), and the month from which every letter still keeps its text. Letters that
arrive while the storage is full and are stored without their text are counted apart and never move that
month. The letters themselves stay complete on the person's own mail server.

### ohmail Cloud tells you when it stops storing the text of older letters

When an account's stored letter text reaches its plan's limit, ohmail Cloud empties the text of the oldest
letters to make room for new mail. Until now nobody was told. The web app, the desktop app on ohmail Cloud
and the phone now show a one-time notice when that first happens: how many letters, the month from which
text is kept (and how many letters arrived while the storage was full and were stored without their text),
that those letters stay complete in your mailbox on your mail server and stay listed and findable, and what
keeps more text from now on (a bigger plan during a trial, a bigger plan or the storage add-on on an active
subscription). Once the account is well under its limit again, after an upgrade for instance, the notice
says the text was emptied under the plan at the time and offers nothing. Settings → Subscription on the web
shows the stored text against the plan's limit, with the same count and month. The note on an emptied
letter no longer suggests that a bigger plan brings its text back.

### A forward can send only the files the person kept

The send route takes the list of the original's files a forward should carry, and the server sends exactly
those; without the list every file goes, as before. A file named in the list that is not one of the
original's own is refused and nothing is sent. `GET /hello` announces it as `features.forwardParts`, so
the apps can offer removing a forwarded file only where the server honours it. On your own server this
needs the server updated with the apps.

## [0.30.3] — 2026-10-24

### News and Receipts open again on the web and the desktop

In 0.30.2 a press of News or Receipts on the web showed "This view didn't load" instead of the list, and the
Ohbox showed the same card until the page was reloaded. The change that kept both lists ready between visits
used a part of React that the web app's build does not have. News and Receipts now open as they did before on
the web, and on the desktop they stay ready between visits as 0.30.2 intended.

## [0.30.2] — 2026-10-24

### A letter filed from the sender sheet stays filed

Filing a letter you are reading to Receipts, News or any other place from its sender's sheet now moves that
letter at once, and it no longer jumps back into the Ohbox a few seconds later. This holds with "apply to
mail already here" on or off, for one address or the whole domain, on the web, the desktop and the phone.
When another letter from that sender is still waiting in the Screener, the letter moves as soon as that
decision is sent. For one address, Undo still takes back the move and the rule together; a press for the
whole domain has no Undo, as before. The sheet says before the press that the letter moves now. The sender's
other letters stay shown where the rule sends them while ohmail files them, and a rule ohmail learned is no
longer switched off by the press that retargets it, or by that press's Undo.

The next letter from that sender lands where your rule says, sign-in notices and codes included: a rule you
made yourself, a Screener decision included, now outranks the "keep sensitive mail in the Ohbox" default.
Rules ohmail inferred still keep such mail in the Ohbox.

### Quoted history folds in every message of a thread

Each message in a thread and the opened message now fold the earlier history they quote behind one "Show history" toggle, on desktop, web and the phone. This covers Outlook, Exchange, Yahoo, Lotus, Samsung, Zimbra, GMX, WEB.DE and mail.com histories that sit unquoted under a From/Von/De header block, Gmail and Thunderbird forwards, Apple Mail replies, mail laid out as HTML only, and long bodies. Answers written between the quoted lines (announced, coloured, highlighted or prefixed), comments under a pasted message, a body that is only a forward, and a signature, list footer or disclaimer below the quote stay visible, also where a message shows its text part. A folded history loads no pictures until it is opened.

### The squares beside a conversation stay still while it scrolls

On desktop (Linux), the column of squares beside a conversation in the Ohbox could flicker and jump for a
frame while the conversation scrolled, most often while messages were turning read. The column now stands
beside the reading column instead of inside it, so scrolling never moves it. A wheel over the squares still
scrolls the conversation.

### Send closes the message at once and finishes in the sidebar

On the desktop and the web, pressing Send no longer keeps the message open until your mail server has taken it, which could take several seconds. When the connection is fine, the message or reply closes as soon as it is safely queued, and the bottom of the sidebar says "Sending to …" and then "Sent to …". If it cannot be sent, the sidebar says why and which message it was, by whom it was for and its subject, with an Open button that brings it back. It stays there while you send other messages, which show beside it. Every way back to such a message, the Open button, replying to it again or its row in Drafts, brings back its words, recipients, sender and attachments, as long as ohmail has not been restarted in between. On a narrow window, a reply sent from an open message says how it went in a notice, since the message covers the sidebar. When ohmail cannot reach your mail server, the message stays open and says why, as before.

You can open the next draft while a message is still sending. It can be edited and sent once the first one has gone, and says so. Opening another draft in the moment a send finished could delete that draft; it no longer does.

A message you sent just before closing ohmail while your mail server was slow to answer could stay in Drafts with "We're checking your Sent folder" for good, and never go out. A send that had not reached your mail server yet now goes when ohmail starts again, once. On ohmail Cloud and your own server, such a send is back in Drafts after ten minutes instead of being reported as unconfirmed, unless it carried large attachments.

A message that was not sent now keeps saying so in Drafts until it is sent or discarded, not only until you open it.

### News and Receipts open at once

On the web, the desktop and ohmail Cloud, pressing 2 or 3, or clicking News or Receipts, no longer takes about a second over a large mailbox. The list shows in the frame after the press and the stream follows behind it. Going back to News or Receipts after visiting the Ohbox or the other one no longer builds the view again: it is kept while you move among the three, with its messages already drawn, and still opens at the top. A stream now starts with one screen of messages and draws a message's own design only once it comes near the screen.

### Waiting filings are named, explained and can be retried or left where they are

When messages you filed have not reached the folder on your mail server yet, the sidebar now names the mailbox (or how many mailboxes) and the reason on record, and no longer says "your mail server refused it" when the last attempt only failed to go through. Long waits read in hours. Its link opens Settings → Mailboxes at that mailbox, where ohmail Cloud on the web shows how many messages wait, since when, for which folder, why and where they are now, with two buttons: Try again now, which ohmail retries on its next pass, and Leave them where they are, which keeps the messages in the folder they are in. A message you deleted is never left that way. Check this mailbox also says how many messages are still waiting to be filed.

A message filed somewhere new now starts with a fresh retry schedule instead of inheriting the wait and reason of an earlier failed move.

### Letters left in the old News folder reach News

A mailbox that still had an `ohmail/Reads` folder beside News after the rename to News kept the letters in it out of every view, History and Search. The organizing install now moves them into News on its next pass, not only when it connects, on Cloud, your own server, the desktop and the phone. "Check this mailbox" no longer reports a gap for the old folder's name once the rename is done, and while letters are still there it says they are in News' folder before the rename, not yet moved.

On a mail server without the IMAP MOVE command, a folder sweep the server refuses, for example on a full mailbox, no longer deletes the letters it could not copy.

Older News letters whose mail server renumbered the News folder could no longer be filed, deleted or marked read on the server, and nothing said so. They are found again under the new numbering and file on the next pass. A letter the mail server no longer holds stays in ohmail with its text, marked as missing on the server, instead of disappearing.

A filing that waits now gives its real reason. A dropped connection no longer reads as "your mail server refused it", a move the server refused is recorded instead of being sent again every pass, and a move ohmail could not confirm says so.

### A sender's other letters stay where you left them when a later rule applies to past mail

Filing a letter from the reader into News or Receipts makes a rule for that sender and leaves their other
mail where it is. A later rule about the same sender with a subject or body term, applied to mail already
here, filed those other letters too, by the first rule, over the following minutes. Applying a rule to
past mail now carries out only that rule, and once its walk is finished it is not walked again every few
minutes on an account with a mailbox another install organizes (Cloud and your own server). Moving a
sender's rule elsewhere with past mail left in place also ends that rule's unfinished walk, so connecting or
removing a mailbox later no longer files the rest of their mail by the changed rule.

### A dead connection no longer freezes sync or your changes until a reload

After sleep or a network change, a request sent over a connection that had silently died could wait for ever: sync stopped ("Can't refresh. Retrying." or a mailbox that never moved), changes said they were done but none went out, and Try again did nothing until the page was reloaded. Now a sync request ends after 30 seconds without an answer and is asked again, a change waits at most 75 seconds on a request that never answers before it is sent again under the same key (Try again sends it sooner, once the request is a minute old), and a session renewal that never answers ends after 75 seconds without signing you out. The request a change stops waiting for is cancelled, so it can no longer land after a newer change or after you discarded it. A message being sent is never cut off: on a slow connection its attachments can take longer than that to upload, so it keeps its one request, and the changes made after it stop waiting for it. On the web and ohmail Cloud.

The Unsaved changes panel now lists every change that has not gone through yet, such as a Screener decision, each with its own reason instead of always "could not reach your account". A Screener decision ohmail gave up on returns to Waiting marked "Not saved" instead of looking undecided.

### Phone: a message sent without network still goes after you close the composer

On the phone, a message sent without network said it would go once the network was back, but closing the
composer (Back, a tap outside it, or Cancel) quietly cancelled it, and it never went. Closing the composer
now leaves the send waiting: it goes once when the network returns, also after the app was closed and
opened again, and the composer repeats that as it closes. A new reply or forward of the same message with
other words, other files or a later time is sent as a message of its own and does not replace the waiting
one. While a send waits, the composer offers Cancel send instead of Cancel, and that is the only way to
cancel it. It says the send was cancelled only when it was, and where the words were kept, that the
message is in Drafts. When Cancel send cannot reach the server, closing the composer keeps the words in
Drafts.

On a phone that runs its own mail engine, Discard in Drafts failed with "request body must be
application/json" and the draft stayed. The same error hit deleting a message, a rule, a tag or a folder,
cancelling a scheduled send, and downloading all of a message's attachments. They all work now. A new mail
that waited for the network now says "Sent." when it goes, not "Reply sent.".

### Restoring a letter before its delete reached the server brings it back

Deleting a letter and pressing Restore in Trash before the mail server had moved it (an offline
or slow organizer) could leave it in no view at all, while the server still held it in its folder,
and a second Restore was refused. Restore now cancels a delete that has not reached the server:
the letter is back in its folder at once and nothing is sent. A delete that already reached the
server restores as before. On the web app, Cloud and the desktop app.

### A phone or computer on a bad network keeps organizing its own mailbox

After a few minutes of a bad connection, ohmail on a phone or computer could stop organizing its own mailbox and say another phone organized it. It now always recognises a claim it wrote, and takes back one it can no longer prove once that claim lapses, with no press.

### The phone keeps your place in a conversation through a rotation, a fold or a display size change

On the phone app, rotating, folding to the outer screen or changing the display size kept the old scroll
offset, so the open conversation showed another message, and a landing on an unread message's top could mark
it read. The reader now keeps the message you were reading and how far into it you were, lands there again
once the new layout is in, and marks nothing read while it is on its way. A search now opens at the top of its
results, with the count and the newest matches in view. On a foldable's inner screen, Back closes the open
message first, and a message opened from Search returns to the search and its query.

### Opening a message no longer keeps the previous mailbox screens in memory

On the web and the desktop, every message opened and closed kept the whole previous state of the mailbox
screen in memory, each one linked to the next. The list of keyboard shortcuts the screen reads for its key
hints held that link; it now holds only the keys and their labels, and a message you have left takes nothing
with it. This covers opening and closing messages only: growth while searching is a separate matter and is
not changed here.

### Park and Later open the next message, and Search's filters work from the keyboard

With "After acting on a message: Next message" (the default), Park and Later on the open message now
open the next one, as Trash and the other verbs already did; the reader no longer rests on "Nothing open."
(desktop and web).

Enter on a reply's "Change recipients" opens To, Cc and Bcc with the cursor in To. Focus used to fall to
the message list, so the next letters typed ran list verbs such as Later or Park.

Search's From, Folder and "Has attachment" filters are buttons: Tab reaches them, Enter or Space turns one on,
and the one in force is marked and turns off on a second press. `from:` and `in:` typed into the search
field are searched as words, and the field now says so and points at the filters.

### A Google or Thunderbird invitation lists invite.ics once

On the desktop app, the web and the phone, an invitation's attachments no longer show its own calendar text as a second invite.ics that would not open (the event card and the invite.ics file already carry it). An Outlook invitation, whose calendar text is its only copy, keeps its one invite.ics to open or save, and a calendar file someone attached stays and opens.

## [0.30.1] — 2026-10-24

### A letter filed into the folder it is already in is no longer deleted from your mail server

Filing a letter into the folder it was already in made ohmail take the letter for its own copy at the destination and delete it from your mail server. It happened when one side of a filing named the News folder by its name before 0.22, ohmail/Reads, and the other by ohmail/News, which are one folder on the server, and when a filing named one folder twice. ohmail now records such a filing as done and sends the mail server nothing. This holds on ohmail Cloud, on your own server, in the desktop app and in the phone app.

### A conversation always opens on its newest message, pressing a verb no longer reads the message you are only previewing, and the phone's squares hit what you press

On the desktop, the web and the phone, a conversation always opens on its newest message, also when you open it again; older messages you have not seen stay unread, their squares solid, until their top has been on screen for a moment.

On the web and the desktop, a press on the action bar, a message's ⋯ or the reply box while you move through the list with j and k no longer counts as opening the conversation, so choosing Later, Resurface or Move there leaves the previewed message unread. A press or a scroll on the messages themselves still opens it. On the phone, a press on a square in a long conversation now lands on that square rather than its neighbour, and on two panes (an unfolded foldable, an iPad) a reply that arrives while Search, Settings or another tab stands over the reader stays unread until you see it.

### A send that did not go out says so, and a letter past the size limit is never lost unsaid

On the desktop and the web, a reply or message that ends "Not sent" after you moved on, for example because your mail server could not be reached, now says so in a notice with an Open button that brings the message back with your words and Send ready, also in a narrow window. Its row in Drafts says it was not sent until you open it, and several that were not sent are named together. A send ohmail could not confirm, or one your server refused as a copy of a message already sent, keeps its own sentence and is never counted as not sent. Nothing is sent again without you pressing Send. A message past the 262 KB text limit is no longer answered "your draft is kept. Try again": the composer and the reply editor name the limit and send nothing until the text is shorter, also when your signature is what takes it over, and so does the Reply Run; the reply editor names it while you type.

A reply or message sent while offline from ohmail Cloud goes once when the connection is back, and no longer also stays in Drafts on the web and on a paired desktop, where it could be sent a second time. In the Reply Run, a reply that went says "Reply sent." instead of "Sending didn't work".

On the phone, the composer names the 256 KB limit while you type, and Send and Cancel say why nothing was sent or kept instead of "Try again" or no reason at all. A draft opened from Drafts and written past the limit says so when you close it, and Drafts keeps the earlier version.

### Connecting Gmail says you need an App Password, and why Google refused

Gmail signs in only with an App Password, and the connect forms now say so before you press anything, with
links to turn on 2-Step Verification and to create the App Password, on the web, on your own server, on the
desktop and on the phone (which said nothing about it before). When Google refuses the sign-in, ohmail now
says why in Google's terms instead of "the mail server refused the password": your Google password was used
where an App Password is needed, Google wants the sign-in confirmed in a browser first, or IMAP is turned off
for the account. Accounts that cannot create App Passwords (some work, school and Advanced Protection
accounts) are told that ohmail cannot connect them yet. An App Password pasted with its spaces now works, and
a Gmail mailbox whose password stops working says that a changed Google password ends every App Password.

### Preview shows the top of a tall PDF page

On the desktop and the web, a PDF page, picture or text taller than the Preview window now starts at its top and scrolls to its end. Before, its top was cut off out of scroll reach, so an invoice whose text sits near the top of the page previewed blank. A preview that fits stays centred.

### Operators: an old encryption key version can be retired

Once `run-kek-rewrap` reads no stored secret below the newest key version, its last lines name the exact change that retires the older versions, and the API and the worker then start without them (removing the first version used to stop both from starting). While a stored secret still names a retired version, the worker refuses to start, and the API keeps serving and answers 503 on `/health`; the self-host compose file does not pass the retirement setting on yet.

### Contributors: the Mac build no longer runs beside the signing identity

The macOS build job holds no Apple secret. Signing, notarizing and stapling the app and its disk image move to a separate job that runs no checkout, npm or cargo and takes the build by the ID its upload returned, so no other job of the run can swap what it signs. It signs only once the Apple signing secrets are set up, and they are not yet: the Mac app is still not Developer ID signed or notarized, and the Mac downloads stay the build's own ad-hoc app, byte for byte.

## [0.30.0] — 2026-10-23

### A conversation opened from the Ohbox shows which messages are new, and reads them as you see them

When you open a conversation from the Ohbox, every message in it that is still unread sits on a softly tinted panel with an accent edge, and a column of squares beside the messages shows the whole conversation at a glance, one square per message, oldest at the top: solid for unread, dimmed for read, hollow for your own. The square of the message most in view is ringed, and pressing a square brings that message to the top. The list row shows the same squares under its preview.

A message now counts as read once you have seen its top: its sender line and its first few lines (the top of a designed message) have been on screen together for a moment, about 0.7 seconds, in a conversation you opened. You do not have to scroll to its end. Its tint and square then settle slowly. A message you only scroll past quickly, or that never comes on screen, stays unread, and so does one whose top you leave within the moment. Before, opening a conversation marked only one message read, and the others turned read unpredictably as you scrolled. Mark as read still reads the whole conversation at once, and each message's ⋯ menu now has Mark unread beside Reply and Forward; a message you mark unread stays unread until you leave the conversation. A message on its own follows the same rule, without the squares, and opens at its top rather than where the conversation before it was scrolled.

Three things behave differently. Moving through the list with j and k only previews: nothing is marked read however long the cursor rests, and opening the message (↵, a click or scrolling in it) is what reads it. Nothing is read while the window is in the background, unless you are scrolling it; a reply that arrives while the conversation is open is read the same way, once its top has been on screen for the moment. On the phone, opening a message from the Ohbox no longer marks it read by itself: it is read by the same rule, the conversation reads oldest first with the newest at the bottom, in the order of its squares, and the reader shows the same tint and squares there, with Mark unread in each message's ⋯. This applies to the web, the desktop and the phone.

### A message whose formatting was removed can be sent again

On the web, the desktop and ohmail Cloud, a message or reply that once held formatting and was then cleared could not be saved or sent; it now saves and sends as plain text, also when it was cleared while offline. A formatted draft reopened from Drafts now opens with its formatting and is sent with it, and Compose's note says when a draft could not be saved.

### The desktop's opening line stays inside the sidebar

On the desktop, the "Opening your mailbox" line shown at the foot of the sidebar while the app starts no longer reaches past the sidebar into the message list for the first moment of a launch, with a narrow sidebar, a smaller window or the Zero layout.

## [0.29.0] — 2026-10-23

### Send leaves a resurfaced conversation where it was

Send no longer marks a resurfaced conversation done, and no longer cancels a Resurface you set. The
conversation stays where it was until you press Done or Send + Done. Answer Later still lets go once your reply
has gone. This is on the desktop and the web; the phone already worked this way.

### A meeting invitation shows its event once, at the top of the message

A meeting invitation now shows its event card (what, when, where, who) right above the message on the
desktop app, the web and the phone, instead of at the foot of the attachments, where a long Outlook or
Teams invitation pushed it out of view. An invitation that carries the same event twice, as Google
Calendar and Thunderbird send it, shows one card, not two. On the desktop app and the web an event
embedded in the message is shown too, and the phone shows the card for the first time. The calendar
files stay in the attachments. On the phone the card also appears once the connection
comes back after a drop, and an invitation with a malformed duration can no longer stop a message
from opening on any device. A title, place, name or time zone far longer than any real
invitation's is cut short with an ellipsis, so a crafted invitation cannot stall the phone as the
message opens.

### The images for your own server, the Cloud mail worker and the desktop app's engine run Node.js 22.23.4

Node.js 22.23.4 is the October 2026 security release of Node.js 22; among its fixes are an out-of-bounds
write in its Brotli decoder and two flaws in matching a TLS certificate to its host name. The server, worker
and web images are built on it, ohmail Cloud's mail worker runs the same worker image, and the desktop app
carries it as its mail engine's runtime on macOS, Windows and Linux.

### Later and Park on a conversation you answered file the letter, not your reply

In the Ohbox, Later, Park and Resurface on a conversation whose newest message is your own reply now act on the letter you received, on the desktop, the web and the phone: the letter goes to the pile and your reply stays where it is. Before, they filed your reply and left the letter in the Ohbox, so the pile and Reply Run asked you to answer your own message. Such a conversation now opens at that letter, and its row shows the letter's tags.

This also holds after you mark the conversation unread from its row (a swipe on the phone, or selecting it and marking the selection unread on the desktop and the web): Mark unread now marks the letter and leaves your reply read. Replies that were filed into a pile this way before stay there until you take them out.

### Removing a mailbox keeps its unsent drafts

On the desktop, removing a mailbox used to delete its unsent drafts without a word, although no mail server holds them. They now stay in Drafts on this computer, and the confirmation says how many. A kept draft can still be edited from a paired phone, and a reopened draft whose mailbox is gone, on the desktop or the phone, says which address it will send from instead. On the phone, removing its own mailbox names its unsent drafts and asks before deleting them.

### Setup's counts agree with the Screener, and count the mailbox you are setting up

At the end of setup, "What ohmail did" and the Screener now use the history window you just chose. Before, an open
window could go on using the window it had read before you pressed Agree, so a sender you had not heard from in
months could be counted under History while the Screener listed them as waiting, or the other way round. When you
add a mailbox to an install that already has one, the first decision now says how many senders who wrote to this
mailbox are waiting, as the step before it does, and names the total across your mailboxes in its second sentence.
This applies on the desktop, the web, ohmail Cloud and your own server.

### Mail at providers other than Gmail and Microsoft can be confirmed by its sender's own signature

At a mailbox whose provider ohmail does not read a verdict from (every provider but Gmail and Microsoft),
ohmail now checks the DKIM signature the sender's own domain put on the message, for mail arriving from now
on: a letter from a company's own address, and a one-click newsletter while a screen-out may unsubscribe.
Where the signature holds, the sender counts as confirmed: the one-click unsubscribe a screen-out sends, and
acting on a confident suggestion for a company's own address, now happen there too, and the "Your mail
provider did not confirm that." line no longer shows on such a letter. A signature that is missing or does
not hold changes nothing; it never counts against a sender. The check looks up the signing key in DNS
through your system's resolver, and a sender whose name server does not answer holds up new mail by a
few seconds at most. This applies on the desktop, ohmail Cloud and your own server; a phone organizing
its own mail does not check signatures.

On the desktop the one-click unsubscribe a screen-out sends goes out from your own computer, so the list
sees the computer's network address; a screen-out made in a browser paired with the desktop app is sent
from that computer too. The note under the Settings switch and the fine print of the screen-out confirm
said it went from ohmail's servers, which is true on ohmail Cloud only; on the desktop, and in a browser
paired with it, they now say it goes from your computer, in English and German.

### The phone's Connect says when it cannot trust your mail server's certificate

On the phone, Connect now opens a mailbox only after it has signed in to your incoming server. If the
phone refuses the server's certificate, Connect says so in the desktop's words (not issued by a trusted
authority, expired, not valid yet, or for another host) and sends no password; if it cannot reach the
server, it says that. Either way nothing is saved. Before, Connect went on to an Ohbox that only said
"Connection lost. Reconnecting…". A mailbox that is already connected now names a refused certificate in
the Ohbox and in Settings instead of reconnecting for ever.

### Links in the desktop app open only on your own click

On the desktop app for Windows, macOS and Linux, a link opens in your browser only when you click it or press Enter on it, and only if it is a link the app shows you. Nothing running inside the app's window can open one without an action of yours. Opening your subscription or account page now takes two presses: the first prepares the page, the second, on Open in your browser, opens it.

### Letters from new senders that arrived while nothing organized a mailbox go to the Screener when you file them

When a device starts organizing a mailbox again, the offer for the letters that arrived in the gap now also counts the ones from senders you have not decided about, and names both numbers. Pressing File files the first by your rules and puts the others in the Screener, where their senders wait for your answer; Leave moves nothing. Before, those letters stayed in the Ohbox and the Screener never asked about them. This applies on the desktop, the web, the phone, ohmail Cloud and your own server.

### Letters that arrived after a hand-back are offered on the install that organizes next

When you hand a mailbox back on one install and organize it from another (desktop, phone, ohmail Cloud or your own
server), the offer to file the letters that arrived in between counts from the moment you pressed hand back, not
from when the other install first looked. Quitting the app, or the phone app leaving the screen, now leaves the
moment it let go in the same way; if an install stopped without letting go (it crashed, or a laptop lid closed),
the count starts at its last sign of life. So a phone or computer that was asleep while another install organized
no longer counts letters from that install's turn. ohmail Cloud now also saves your latest settings into the mailbox
before it lets go, and quitting the app saves them too, as handing back already did. The moment travels in the
mailbox's settings message, so the install that lets go needs this version; with an older one the count starts as
it did before. Nothing moves until you press File.

### Closing the desktop app on a slow mail server no longer leaves the mail store to be recovered

On a mail server slow to answer, closing the desktop app could take longer than the five seconds the app
waits for its engine, so the engine was stopped before its local mail store had closed, and the next start
had to recover the store. The store now closes first and the goodbyes to the mail server run beside it,
so an ordinary close finishes inside those five seconds. An organizing install that is closed in the
middle of a sync still hands the mailbox back, so your other install can take over at once.

A message you send just before closing still goes out. If it has gone within the first two seconds of the
close it is recorded as sent at once; if not, the app checks your Sent folder for it as soon as it starts
again, as it now does for any message a crash left reading "Sending…", instead of waiting ten minutes.

A mailbox you remove just before closing no longer keeps its mail on this computer: the removal clears the
mail first, and one that a close, a crash or an older version left unfinished is finished when the app
next starts. Removing such a mailbox again now clears its mail too.

### A second engine can no longer open the same mail store on macOS and Windows

On macOS and Windows the desktop app's engine now holds its local mail store with an operating-system
lock for as long as it runs, so a second engine started on the same store is refused instead of
opening it beside the first and corrupting it. A store left behind by a crash or a power cut opens
again by itself.

### New mail arrives at once again after a delete on Dovecot and other QRESYNC servers

On Dovecot servers and providers built on them, such as Infomaniak, deleting or filing a message from the inbox, in ohmail or in another app, left ohmail counting one message too many, so the next new message waited 15 seconds to 2 minutes for the next check. It now arrives within a second, on the desktop, the phone and ohmail Cloud. On the desktop and the phone, a message arriving in the 15 seconds after the connection check ohmail makes every 30 seconds also waited; it now arrives at once too.

### A mailbox keeps syncing when the server sends more for its mail than it stated

When a mail server sends more for a batch of messages than their stated sizes allow, ohmail keeps the mail that arrived and syncs the rest over a new connection, on the desktop, the phone, Cloud and your own server. That holds in INBOX, in Sent and in your own folders, including a folder read for the first time and one the server has renumbered. Before, the mailbox stopped syncing until the server changed, and the desktop app said it could not reach the server. A message still too large on its own is set aside as before.

### A rule change no longer waits on a mailbox you removed

When you change or remove a rule on a device that does not organize your mail, the Rules page shows the change once every computer still organizing your mailboxes has made it. It used to keep showing the old rule until you made the change again if you removed or switched off one of those mailboxes before its computer answered, or if that computer's answer reached this device only after this device had stopped waiting for it. One case still needs the change made again: if you changed the same rule a second time and the second change showed first, the first one is not added afterwards. On the desktop, the phone and ohmail Cloud.

### Cloud: checking mailboxes costs less again

Each open window checks your mailboxes every 30 seconds. To report the moves your mail server has not made yet,
that check read every message of each mailbox; it now reads only those moves, so a large mailbox costs what a small
one does. The desktop and phone apps answer faster too.

### Building and testing from a fresh clone is checked every week on Linux, macOS and Windows

A scheduled workflow clones the repository on clean runners per platform and runs the build in the
[README](README.md) and the install and test commands in [CONTRIBUTING.md](CONTRIBUTING.md), word for word,
with no credentials; a test keeps the documents and the workflow equal. For contributors three things change:
the documented install is now `npm ci --ignore-scripts`, as in CI; the documented suite can run in parts
(`PART=2 PARTS=4` runs the second of four), one machine each; and every text file now checks out with LF line
endings on Windows too, which is what most of the suite's file-reading tests expect.

### Without the test services, the suite skips what needs them instead of failing

For contributors: `npm test` on a machine without the test services in `docker-compose.yml` no longer fails
about 535 files. Each run checks once whether Postgres, GreenMail, Dovecot and RustFS answer, prints a line
for each one that does not, and skips the files that need a missing one, naming the service and its address.
A service that answers but is broken still fails, and `TF_REQUIRE_PG`, `TF_REQUIRE_GREENMAIL`,
`TF_REQUIRE_DOVECOT` and `TF_REQUIRE_RUSTFS` set to `1` turn a missing one into a failure, as CI does.
[CONTRIBUTING.md](CONTRIBUTING.md) says how to run the suite either way.

## [0.28.0] — 2026-10-22

### ohmail Desktop opens a PDF in the preview

On the desktop a PDF now opens in the in-app preview, as on the web, instead of being saved. Download, beside the
file and in the preview, still saves it to your Downloads folder and leaves the preview as it is: a PDF stays on
the page you were reading, and a file that could not be saved stays on screen while ohmail says so.

### A message you mark read goes to the top of Earlier

Mark read, or ⇧I, on the message you are reading now counts as reading it in ohmail, as opening it does.
It keeps its place while it is open and goes to the top of Earlier when you move on, on every device. Mark
all read and reading several selected messages keep arrival order. Web, desktop and phone.

### A message you read anywhere goes to the top of Earlier

A message you read in ohmail now goes to the top of Earlier on every path, not only when you open it.
On the web and desktop, stopping two seconds on the message an action moved you to reads it, as moving
there with j does, and Mark read in the reader over a tag, a sender or History counts too. On the
phone, swiping one row read, or its Mark read action, counts. Mark all read and reading several
selected messages keep arrival order.

### The offer to file letters that arrived while nothing organized stands where you see it

On the web and in the desktop app it now stands in the sidebar right under Resurface, together with the
notices about who organizes your mailboxes. At the foot, folders or tags pushed it below the window's edge.
Narrow windows keep it above the top bar.

### Letters that arrived while nothing organized wait for your settings answer

When an install starts organizing a mailbox another install organized before, its offer to file the letters that
arrived while nothing organized it now waits until you have answered whether to import the other install's
settings, instead of closing before you could answer. Rules imported from settings saved by this version keep the
age they had where they were made, so the offer counts the letters they would have filed. Desktop, phone, Cloud and
your own server.

### The Screener opens faster on large mailboxes

The Screener finds which held senders are still worth a decision from an index of each sender's mail by date,
instead of reading every message they ever sent.

### The web app asks for new mail first when you come back

When you come back to a web tab, it asks for new mail first and its other reads a few at a time. A message,
attachment or search you open in that moment is asked for ahead of them.

### No automatic spam rule because other senders used the same subject

When two first-time senders' mail shares a subject, such as two shops' "Your order has shipped", the Screener
advises Spam for each of them. "Act on confident suggestions for me" then wrote a rule for each address that
kept filing its later mail to Spam, even when your mail provider had confirmed the sender. It now files only the
message that advice was about, writes no rule, and lists it under Filed automatically, where Put back returns it
to the Screener; that sender's other and later mail waits for you. Advice ohmail stored before this change is
treated the same way. Rules it already wrote this way stay, and keep filing that sender's mail to Spam until you
change or revoke them under "Decided for you by ohmail" in Settings → Rules, on the desktop and the web. Spam
advice about the sender's own message, such as a name claiming a company its address does not belong to, still
writes the rule. Your own Screen out or Spam press is unchanged. This applies on the desktop, the phone and
ohmail Cloud.

### A changed search answers sooner in the desktop app

A changed search no longer waits for the previous search's count to run first while mail is syncing.

### Operators: the pager reaches you when the database is down

Every alert pass starts by reading the database, so a database outage used to silence the pager, leaving only
`alert_pass_failed` log lines. Now the API's alert pass pages `alert_db_unreadable` on its configured channels
when it cannot use the database, without touching the database: a database that is stopped or unreachable, one
that answers but refuses the pass's work (read-only, out of disk, memory or connections, shut down), and one too
slow for the pass's reads to finish within 30 seconds. It pages again at most once an hour while it lasts (mail
at most every 6 hours), and sends one resolved notice to the webhook and Telegram when it is back. On a
self-hosted install this needs `TF_ALERT_SECRET` set beside the channels. The organizer stops with a stopped
database, because its leader lock lives there, and pages only when its lock outlives the fault (a hung, read-only
or full database, too many connections). New and optional, `TF_ALERT_HEARTBEAT_URL`: a ping URL from an outside
check service, requested after every completed pass, so a dead box or database alarms there
(`deploy/selfhost/.env.example` explains it).

### Operators can drill the alerts and see who acknowledged them

On ohmail Cloud and on your own server, `POST /internal/alerts/drill` with the `TF_ALERT_SECRET` bearer sends
every kind of alert once, marked `[DRILL]`, through each alert channel that is set up: the server's channels at
once, the worker's on its next alert pass. Every message carries one link. Opening it shows a page and records
nothing; pressing the page's button records, once and within 24 hours, that the message reached a person.
`GET /internal/alerts/drill` lists the last five drills with what each channel answered and which messages were
acknowledged. One drill an hour. A drill is kept apart from real alerts: it opens, closes and changes none of
them.

### A database outage no longer stops the worker or the self-hosted server

If the database closed a connection while ohmail was still opening it, the worker and the self-hosted server
could stop (when the next attempt was refused, or the database said it was starting up or shutting down), or try
again hundreds of times a second until the database was back. They now wait between attempts as for any other
dropped connection, and when the database gives a reason for the close, the work waiting for that connection
fails with it at once.

### Cloud: an unchanged mailbox costs less to check

When nothing has changed, each check the apps make for changes now costs the server two database statements
instead of four: the two that record when a sync last finished run only when that record is due, once every five
minutes.

### Cloud: checking several mailboxes costs less

Each open Cloud window checks your mailboxes every 30 seconds, and that check now costs the server the same few
database queries whether you connected one mailbox or ten, instead of four more for each mailbox.

### Changes waiting for the next release are listed in changelog.d/

Each change now brings its own release note as a file in [changelog.d/](changelog.d/), and the release
gathers them into this changelog. Contributors: add `changelog.d/<slug>.md` to your pull request instead of
editing `CHANGELOG.md`; [changelog.d/README.md](changelog.d/README.md) has the format.

## [0.27.5] — 2026-10-20

### The first start is faster

The desktop app writes its new local store to the disk once, when it is complete, instead of after every index
it builds. A first start opened the store in 2.2 s instead of 3.7 s on a Linux test machine, and saves more on
macOS and Windows, where each of those 241 writes waited for the drive. A store that already holds your mail is
still written to the disk after every change.

### A send that failed before reaching your mail server is retried for you

If your mail server could not be reached, was busy or answered too slowly before anything was sent, or a
forward found all of ohmail's connections to that mailbox in use (downloads or images open at the time), ohmail
now tries the same send again by itself: up to three attempts within two minutes, still one message. Meanwhile
it says "Not sent yet. ohmail is still trying."; Cancel stops it. If your device stays offline past those two
minutes, ohmail says once it is back that the message was not sent, and keeps it for you to send again. The
Desktop, Cloud and phone apps all do this.

### Letters an empty message stood in for are imported

Reading or flagging a message in another app while ohmail imported your mail could leave an empty message in
a letter's place; 0.27.4 stopped new ones. The syncs after this update repair the ones already there, a few
at a time: the empty message leaves your list, each letter it stood in for is imported, and a letter ohmail
moved into the ohmail Screener folder because of it goes back to your Inbox, where your rules sort it as
usual. A message that really has no content is left alone.

The repair runs in the desktop app, on Cloud and on your own server. The phone app gets it in a later version;
it already has the 0.27.4 fix, so it stores no new empty messages.

On your own server, `OHMAIL_BLANK_REPAIR` sets what the organizer does: unset, it repairs; `dry` reads each
affected message once while the organizer runs and logs counts of what the repair would do, changing nothing;
`off` turns the repair off. Any other value stops the organizer from starting.

### The Ohbox says when mail was last checked and where it went

Under the Ohbox title: when your mail was last checked and, since you were here, how many letters went to News,
Receipts, Screened out and Spam. Each count opens that place. With "Use folders" on, the web and desktop apps leave
the Spam count out, because the Screener then shows your mail server's own Junk folder, which may not hold those
letters. If the sync is behind or failing, the line says that instead. Enter on a focused link now follows the link
instead of opening the selected letter.

### A meeting invitation that arrives as an Outlook link says so

When a Microsoft 365 or Exchange server delivers a meeting invitation as an Outlook Web App link instead of
the event, ohmail now says so above the message on the desktop, the web and the phone. It names the Outlook
setting that makes future invitations arrive with the event and, on Microsoft 365, links to Microsoft's own
settings page (never to an address taken from the message). A desktop signed in to Cloud showed nothing for
these invitations before.

### The Junk segment also lists the spam ohmail keeps itself

With "Use folders" on, the Screener's Junk segment now also lists what sits in ohmail/Quarantine: spam ohmail
filed there on its own, spam from a mailbox without a Junk folder, and earlier verdicts not yet moved, with the
same Not spam choices. Coming back to the segment reads your mail server's Junk folder again, so mail filed there
since shows up without reloading.

### Signing out also ends a sign-in being issued

Signing out everywhere, changing your password or removing your authenticator now also ends a sign-in whose
code or confirmation was being issued at that same moment.

### The pager reads the billing program's own failures

For operators with `ENTITLEMENTS_URL`. Both alert drivers now read the entitlements program's `POST /v1/ops` on
each pass (the organizer from its first shard only) and page a cron pass that stopped (`plane_pass_stale`), each
billing alert the program holds (`billing_alert`), and a program they cannot read five passes in a row
(`plane_ops_unreadable`). A program without the route pages nothing. A self-hosted server reads no program and
logs `plane_ops_watch` off once at boot.

## [0.27.4] — 2026-10-19

### A letter you read elsewhere during an import is now imported

If you read or flagged a message in another app while ohmail was importing your mail, ohmail could store an empty
message in that letter's place and never import the letter. ohmail now ignores such updates while it reads your
mail and no longer stores an empty message in a letter's place. Every install that organizes the mailbox (Cloud,
your own server, the desktop or the phone app) has to run this version to be protected.

A letter this already happened to is still on your mail server, in the folder it was in or in the ohmail Screener
folder, and ohmail shows a message with no sender or subject in its place until a later version puts it back.
Leave that message alone: deleting or moving it moves real letters, and deleting it puts them in the Trash.

### Fewer background refreshes

Cloud could confirm a mailbox it already organizes on every pass, so the web app reloaded that mailbox's setup
several times a minute and 'Apply to existing mail' could start over each time. It now confirms once.

### The address view finds mail sent to someone in your whole mailbox

Address view: 'To them' and 'All' now reach the whole archive, not only this device's mail. On a server
that has not upgraded yet, the view still says the archive can only be searched by sender.

### A slow mail server no longer holds up the other mailboxes

For operators. The organizer now reconnects up to four mailboxes at once, one per mail server at a time, and
gives up on a connection attempt after three minutes, then retries on its usual backoff. A slow mail server
delays only its own mailboxes; the others reconnect at once. `TF_ATTACH_CONCURRENCY` (1 to 8, default 4) sets
how many connect at once. A restart still connects every mailbox before its first round, now several at a time.
Stopping the organizer no longer hangs on a connection that is still being set up.

### The first decision waits for the Screener

After you agree, setup now waits a few seconds for the senders it will hold in the Screener before it says
everything is sorted, also when the first pull ended before you agreed. "Your first decision" is no longer skipped
when they arrive late. This applies to an install with one mailbox.

### The pager reports its own failures

For operators. Each alert driver now pages through its own channels when every channel of the other one
refused three passes in a row (`alert_driver_undeliverable`; it clears once a repaired channel delivers). A
pass that asked only some of a driver's channels, such as a re-page held back from mail, does not count
toward it. A driver also names a channel that keeps refusing beside one that works (`alert_sink_degraded`).
The organizer pages when an API pass it schedules has failed twice in a row past its cadence, or not run for
three (`api_cron_stale`), and either driver when the platform-signals poller stops writing
(`signal_source_dark`). `/health` on the api and the organizer publishes `pager` (`ok`, `unarmed` or `dead`),
and a pager that reaches nobody now logs `alerts_undeliverable` every hour instead of once. A channel that
cannot be built at boot is listed as `misconfigured`, the pager reads `dead` when nothing else is left, and a
service with no channel that builds counts as having none. On upgrade: where only one of the two services
has a channel, `/internal/alerts` lists the other as a warning signal that pages nobody; with no channel on
either, nothing new is listed.

### Staff with only the operations role see no mailbox sender name

Staff whose only role is operations no longer see a mailbox's sender name, and the account list's search matches
only what they are shown of a login (its domain). Owners, support and billing see both as before.

### No automatic screen-out or spam rule from an unconfirmed message

"Act on confident suggestions for me" could screen out a sender, or file them to Spam, on advice about a message
that only claimed to come from them, and then write a rule that kept filing that address's real mail there. When
the advice is about a message your mail provider did not confirm came from its sender, it now files only that
message and writes no rule; the sender's other and later mail waits in the Screener for you. When the advice is
about a confirmed message, the unconfirmed messages beside it are filed on their own first, then the rule is
written. A message filed without a rule is listed under Filed automatically, where Put back returns it to the
Screener and it is not filed automatically again. ohmail reads this confirmation from Gmail and Microsoft
mailboxes only, so for mail at other providers the act no longer writes such a rule at all. Your own Screen out
or Spam press still writes the rule.

### Forwarding right after opening a message

Forwarding a message with an attachment could fail with "Sending didn't work" and go through on the next press,
most often just after you opened the message (seen with iCloud). Opening it marks it read, and when your mail
server reported a change like that while ohmail was reading the attachment, the read stopped early: the file no
longer matched the one that arrived, so nothing was sent. Opening or saving an attachment could fail the same
way. ohmail now reads through such reports, and reads an attachment once more when your mail server's own
description of the message says it is the right file. When a forward still cannot go, or your mail server does
not answer in time, the message now says so instead of "Sending didn't work".

### Signing out cancels sign-ins still waiting

Signing out everywhere, revoking a device or your other web sessions, and removing your authenticator now also
cancel sign-in codes, desktop links, device-pairing codes and confirmed desktop approvals that were still open.
When you sign out everywhere, change your password or remove your authenticator, a sign-in already being
completed with one of them is now signed out as well; signing out your other web sessions does the same for a
browser sign-in. A desktop signed in from the browser, by a link or by confirming it there, keeps the browser's
verification time instead of starting a fresh five-minute window.

## [0.27.3] — 2026-10-19

### Narrower link opening on the desktop

A web address now goes to your browser only when the window reported it as a link it draws — in a message,
a draft or a signature — or it is one of the app's own help links. This limits what a bug in the window can
open; it does not stop a script already running in the window. The links you click open as before.

### Unconfirmed mail from a company's own address

When your mail provider did not confirm that a message from a company's own address really came from there,
the open message, the sender sheet and the Screener now say so. They name the company, or, for a government
domain many offices send from, such as admin.ch or bund.de, the domain. "Act on confident suggestions for me"
no longer lets such a sender through, and a screen-out sends a one-click unsubscribe only for a sender your
provider confirmed; the Unsubscribe button works as before. ohmail reads this confirmation from Gmail and
Microsoft mailboxes only, so a screen-out sends no unsubscribe by itself for mail at other providers, and no
longer says it will when none of your mailboxes is at either.

### Confident suggestions acted on per sender

"Act on confident suggestions for me" no longer keeps every sender it would let through waiting because some
other held message claims a company it does not come from. Each sender is judged by their own messages.

### A self-hosted server pages you when the organizer stops

With `TF_ALERT_SECRET` set, the api now runs its own alert pass every minute, so a stopped organizer pages you
within about three minutes, and `/internal/alerts` answers instead of 503. The api pages on the webhook, on
Telegram, and by mail to `TF_ALERT_EMAIL` through your SMTP settings; `/health` lists the channels it pages on,
and `deploy/selfhost/.env.example` says which service pages on which.

### Coming back to ohmail.app after signing out no longer shows an empty page

After a sign-out the server had not confirmed, or while a saved sign-in was being checked, ohmail.app could show
an empty page for 20 seconds or more before the sign-in page. The sign-in page now appears at once and ends the
session on the server behind it, as do the sign-up and email confirmation pages; the sign-up page no longer reads
or changes the signed-out account. If the session cannot be ended, the page says so and offers Sign out again,
and signing in, creating an account or confirming an address on that browser starts only once it has ended. The
check of a saved sign-in shows the ohmail card while it waits. Opening ohmail.app from a link on another site, an
invitation included, no longer signs you back in after such a sign-out.

### Change your password

Change your password from Settings; your other sessions are signed out, and sign-ins still waiting to finish are
cancelled, such as one made with the old password that waits for its second factor, a desktop link or approval,
or a pairing code. It asks for your current password and your second factor, and a wrong current password counts
toward the same lockout as signing in.

### Back stops the account deletion

Leaving the account deletion while your second factor was being checked (Back on the account wall, or another
pane in Settings) could still delete the account once the check came back. Leaving now stops it, as Cancel does.

## [0.27.2] — 2026-10-18

### Signing up in German stays in German

A German signup was answered in English at almost every turn: the confirmation mail, the "you already have an
account" mail, every refusal on the signup screens ("email must be a valid address", "invalid TOTP code"), and
the instructions for each mail provider. The mails are now written in the language of the screen you signed up
on, the signup and confirmation screens say each refusal in their own words, and the provider instructions are
written in German. Two lines that were not true are gone: the password hint no longer says a passkey is the
next step (on ohmail Cloud the next step is the confirmation mail), and the confirmation page no longer says
"no password to leak" under a password field.

### Smaller fixes to signing up

- The authenticator app step shows a QR code to scan, the setup key in groups of four with a Copy button, and
  says a wrong code under the code field.
- A likely typo in a common mail domain (gmailcom, gmial.com) is named with the address it was probably meant to
  be, and "Check your email" has a way back to correct the address.
- The progress line shows Email as the second step on ohmail Cloud, marks the account done on "Check your
  email", and tells screen readers which step is current.
- Recovery codes can be copied or downloaded as a text file, and on a phone each code stays on one line.
- The confirmation page has a Sign in button where it says to sign in for a fresh link.
- The payment provider's session id no longer stays in the address bar after returning from the account page.
- Small text buttons on the signup screens are at least 24 pixels tall.

### The staff console can see more of how the service is used, and still none of anyone's mail

The admin API answers new questions for the people who run an ohmail server: how many accounts signed up inside
a chosen window, and of those how many verified their address and connected a mailbox, week by week; how many
accounts were in use over the last day, week and month; how much stored mail each account holds; the staff audit
across all accounts, where an owner sees every staff member's actions and every other role only its own; for
an owner, the list of staff logins with their roles, last sign-in and whether a second factor is set up; and each
alert's latest resolved episode (one entry per alert, not a full history). Each answer is recorded in the staff
audit before it is given, and none of them can carry a message, a subject or a sender.

Looking up accounts by id, and opening one account in the console, now read only the accounts asked for instead
of every account on the server.

### Staff with only the operations role see mailbox addresses masked

The admin API already showed staff whose only role is operations an account's login address masked to its domain.
The mailboxes on an account's page, the worker's list of mailboxes and the mailboxes offered for a release are now
masked the same way for them.

### Staff can send an account's owner a link to the subscription page

Staff with the support, billing or owner role can mail an account's owner a link to the app's subscription page,
at most three times per account in any 24 hours. The mail goes to the account's own login address in the
account's language, and the link carries no sign-in: the page opens only after signing in to ohmail. Each send
is recorded in the staff audit before the mail leaves.

## [0.27.1] — 2026-10-17

### The desktop window can no longer be navigated away from the app

The desktop window now refuses to load any page that is not the app's own; links still open in your browser.

### Signing out of the web app no longer hangs, and ohmail.app no longer reloads in a loop afterwards

Signing out could stay on "Signing out…" while another tab was renewing the session or the server was slow to
answer, and when the server never confirmed a sign-out, every later visit to ohmail.app reloaded the page over and
over. A sign-out now always ends and removes the mail this browser holds; if the server could not confirm it, the
next visit to ohmail.app finishes it first and then shows the sign-in page.

### A picture or attachment opened while its message was being filed no longer shows blank

Opening a message can file it (the Screener's pending move to the Inbox), and a picture or file read from the
mail server at that moment came back cut short and was refused as "a different part of the message": the
picture stayed blank and a download failed. A read cut by a move is now seen for what it is, and the part is
read again where the message went.

### Signing up for ohmail Cloud keeps your place when connecting a mailbox

During signup, a mailbox the server could not use — one on your own network, or a port that carries no mail —
sent you to the invite-code step, and so did an address the server could not accept. Making an app password took
longer than the few minutes the mailbox step allowed, and then signup ended on a sign-in screen that led to an
empty inbox. Each of these is now said on the step it happened on, with everything you typed kept, and when a few
minutes have passed, ohmail asks for your passkey or authenticator code right there and connects the mailbox.

### A new ohmail Cloud account that has not started its trial is offered the trial

Someone who signed up and chose "Do this later" on the plan step, or came back before starting the trial, saw the
screen for a closed account: "This account is not active", "ohmail has stopped organizing this account", and a move
to self-hosting. They now see "Start your free trial" with the 14 free days, no card, a button that opens the account
page, and Sign out. The plan step's "Do this later" is now "Not now" and says the account is kept.

### Signing up from a plan on ohmail.app remembers the plan

Choosing Solo, Plus or Pro, monthly or yearly, on ohmail.app and then signing up lost the choice on the way: the
plan step named no plan and said nothing about the trial. The choice is now kept through the confirmation mail,
the plan step names it next to "14 days free, no card", and opening the account page asks for that plan to be
selected. The account page also opens in the app's language from the plan step, the trial reminder and Settings.

### German now says Mail, not Post

The German web, desktop and phone apps called your messages "Post", which is not how anyone writes about email.
They now say Mail and Mails ("deine Mails", "neue Mails"), and use the words German-speaking people use
anyway: Account, Inbox, Credits, Button, Tracking-Pixel, Handy, Dark Mode, API-Key. "Postfach" stays where it
means the mailbox itself.

### Mail keeps syncing after the database drops a connection mid-write

When the database dropped one of the server's connections while a write was on it, that connection could stop
answering for good, and the next sync that used it waited for ever: new mail stopped arriving until the server was
restarted, and nothing reported it as down. Now only the write that was on the connection fails, and the next one
reconnects and carries on.

## [0.27.0] — 2026-10-17

### Other mailboxes keep syncing while one works through a large import

On a server with several mailboxes, one mailbox working through a large import could hold up the regular check of
every other mailbox until its batch finished, so read marks and moves made on another device, and mail in folders
other than the inbox, showed up late. Each mailbox now gets its regular check on time while the long batch runs. New
mail in the inbox was not affected: it already arrived within seconds.

### Opening a message full of pictures takes far less memory

On the desktop and in the web app, the pictures embedded in a message were copied into the message's page as
text, and every step that read the page copied them again: on Linux, opening a message with twelve pictures of
16 MB in all grew the desktop window by about 1 GB. The page now names each picture by a link to the copy the
app already holds, which only that window can read, so a picture is no longer copied into it. The phone shows
pictures as before.

### A server alert nobody was told about is sent once the server can say it

An alert that opened while its only notification failed, and whose measurement then went missing, stayed open
without ever being sent. It is now sent on a later check until a notification lands, the condition is seen to
clear, or it closes unconfirmed. A self-hosted server's `GET /internal/alerts` also lists both alert checkers
with the longest time each went without running in the last 30 days, kept per day for 100 days.

### Long conversations take far less of the desktop window's memory

Everything the desktop window asked the app's mail engine for came back as a list of numbers, one per byte,
which takes many times the memory of the bytes themselves: on Linux, twenty long messages of a conversation
loaded together could hold about 700 MB in the window. Those answers now cross as bytes, over the app's own
in-process command channel, and the same load holds about 100 MB. The window's content policy admits that
channel, in the spelling each platform's webview uses, and still no address off this computer. If a build ever
falls back to the slow path, the diagnostic file says so.

### Away and signature edits are kept until you save or discard them

On the web and the desktop, an away message typed before a save that could not reach the server stays in the
field under the sentence that says it did not save, as on the phone. An edit made while a save waits for the
computer that organizes the mailbox is kept when that save lands, and leaving asks first. Leaving Settings →
Signatures with an edited signature now asks before it is dropped.

### The desktop app can use OpenCode Go

The desktop app can now make suggestions and drafts with your OpenCode Go key: choose it in Settings → Desktop,
under *AI for suggestions and drafts*, then one of the models your Go workspace offers. Contributed by Daniel
Muñoz in #42.

### Draft reply works in the desktop app

In the desktop app, Draft reply always answered "Drafting needs a connected account." It now writes the draft
into the editor with the model you set up, or through your ohmail Cloud account. Contributed by Daniel Muñoz
in #39.

### A self-hosted server can use OpenAI, OpenCode Go or Ollama

The self-host server stack took an Anthropic key and nothing else. It now offers the four providers the desktop app
does: `TF_AI_PROVIDER` in `.env` names `anthropic`, `openai`, `opencode-go` or `ollama`, each with its own key or
address, and `TF_AI_CLASSIFY_MODEL` and `TF_AI_DRAFT_MODEL` choose the models. An install that sets only
`ANTHROPIC_API_KEY` runs as before. A model server has no default address and needs `TF_AI_ALLOW_PRIVATE=1` to be
reached on the stack's own network. Workflow proposals need Anthropic, as on the desktop, and ohmail Cloud is unchanged.

### A first start, a renamed folder and a resync lose nothing quietly

On the desktop, a power cut soon after ohmail made its local store for the first time could leave a store that
would not open; the new store is now on the disk before ohmail counts it as made. A folder renamed on the mail
server, on a mailbox with more folders than one sync reads, no longer has its mail leave ohmail until the new
folder is read. On the web, a draft deleted on another device while the tab re-synced from the start is now said
to be deleted, and what you type is kept as a new draft.

### New mail shows up on the desktop within seconds again

When the desktop app talked to the mail server itself, a new message often waited up to two minutes before it
appeared, because the app stopped listening for new mail after its first check and only found it on the next one.
It now listens again after every check, so a new message shows up within a few seconds.

### The phone keeps a saved change through a power cut
<!-- changes: one-oh-phone-engine-store-durable.md -->

On a phone that organizes its mailbox itself, a power cut or a system crash just after ohmail saved a change could
undo that change when the app next opened: a filed or deleted message, a decision, a sent message's record. The
phone's mailbox database now syncs to the disk at every save, as its copy of the mail list already did, and if the
phone's database will not do that, ohmail says so and does not open the mailbox.

### A self-hosted install keeps attachments in RustFS
<!-- changes: selfhost-rustfs.md -->

The self-host and Umbrel stacks now hold attachments on their way into a sent message in RustFS instead of
MinIO, whose repositories are archived and whose last release gets no more fixes. RustFS runs with its update
check and its web console off. An existing install updates with no edit to `.env`. The new store starts empty,
so a message whose attachment was uploaded before the update needs that file attached again; the old store's
container and volume can then be removed, as "Updates" in `docs/self-host/VPS.md` shows. Contributed by sysrex
in #43.

### A self-hosted update reaches the proxy
<!-- changes: selfhost-proxy-reload.md -->

An update that changed only the proxy's routes never reached a running self-host proxy: `docker compose up -d`
left it running on the configuration it started with. The proxy's configuration now lives in
`deploy/selfhost/proxy/`, mounted as one directory, and the compose file carries a digest of it, so the documented
update restarts the proxy whenever that directory changes. The Umbrel app does the same for the Caddyfile its
start hook renders. If you keep your own compose file, "Updates" in `docs/self-host/VPS.md` has the one line to
change.

### An attachment up to 40 MiB opens and saves on the desktop
<!-- changes: desktop-attachment-open-ceiling.md -->

The desktop sends files up to 40 MiB, but opened or saved one only up to 32 MiB, so a file you sent could not be
saved when it came back. One attachment can now be opened or saved up to 40 MiB, the most ohmail sends. On the
desktop, Download writes the file to your Downloads folder as it arrives from the mail server, so a large
attachment no longer passes through the app's window.

### Previewing a large attachment on the desktop no longer costs a gigabyte of memory
<!-- changes: attachment-preview-no-json.md -->

Looking at a picture attachment on the desktop handed the whole file to the app's window as a list of numbers,
one per byte: a 40 MiB picture took the window about 1.3 GB of memory for a moment, and an 8 MiB one about
330 MB. The desktop now saves the attachment to a private file first and the window shows it from there, which
costs about 116 MB for 40 MiB and 27 MB for 8 MiB. A text attachment is shown up to 2 MiB; a larger one says it
is too large to preview and offers to save it. A PDF is not fetched to be previewed at all. The file is removed
when the preview closes or the app quits, and one left by a crash or an update is removed at the next start.
The desktop also no longer carries a command that could write a file the window chose and open it.

### The desktop app writes its store to the disk when you pause

On a large mailbox, a list, an open or a search in the desktop app could wait up to about two seconds while the
app wrote its local store to the disk. That write now waits until nothing you asked for has run for two seconds,
or at most 30 seconds.

### Long values in Settings wrap

In Settings, a long value wraps inside its pane instead of running past its edge. Contributed by Daniel Muñoz in
#37.

## [0.26.1] — 2026-10-16

### The Cloud deploy installs with the build host's npm

The Cloud deploy installs with the build host's npm: an optional package no installed package needs may be absent.

## [0.26.0] — 2026-10-16

### Self-built servers and workers start from the built files
<!-- changes: one-oh-node-resolves-dist.md -->

After `npm run build`, starting the server or the worker with Node (`node apps/worker/dist/index.js`) stopped at once
with a TypeScript syntax error, because Node loaded the shared packages' source instead of their built files. They
load the built files now. The published images were not affected: each runs one bundled file.

### The Screener answers in a fraction of the time on a large mailbox
<!-- changes: one-oh-screener-reads-fast.md -->

On a large mailbox the Screener's count and its offer to screen the Ohbox each took most of a second to
read, and the desktop app answered nothing else meanwhile. They now take a fraction of that.

### The desktop app shows your mail sooner after it starts
<!-- changes: one-oh-start-to-list-window-wait.md -->

On a large mailbox the desktop app waited about two seconds after it started before it asked for the first
page of your mail, while its engine answered the Screener's counts. The list now comes first and the counts
follow it.

### Rules and drafts on the desktop survive a power cut
<!-- changes: one-oh-local-store-fsync.md -->

On the desktop, a power cut or a system crash shortly after ohmail opened, or shortly after its regular
housekeeping, could lose the rules, drafts and other changes saved on the computer since, or leave the local copy
unopenable until it was set aside and read again from the mail server, without what only the computer kept. On
Windows the same could happen to anything saved in the seconds before a cut, at any time. ohmail now syncs its
local database to the disk at every save, on Linux, macOS and Windows alike, so what you saved survives. If the
disk refuses a write, ohmail stops its engine on the spot and starts it again, which recovers what was saved; a
save caught in that moment is never reported as done.

### PDF previews work on a self-hosted install
<!-- changes: split-s9p-product-inputs.md -->

A self-hosted install showed "Can't show this PDF here" for every PDF attachment, because the web image
did not carry the PDF viewer's worker. It does now, and a PDF attachment opens in the preview.

### A text field in a dialog keeps its focus on Linux
<!-- changes: pr13-import.md -->

In the Linux desktop app, clicking a text field in a dialog, such as the address field under Settings >
Mailboxes > Add mailbox, no longer sends focus back to the dialog's first control, so what you type
reaches the field. Contributed by Daniel Muñoz in #13.

### Screener purchases in the desktop app stop at the price you confirmed
<!-- changes: one-oh-desktop-suggest-quote-ceiling.md -->

In the desktop app on ohmail Cloud, a Screener suggestion purchase did not carry the price you confirmed, so it could
cost more than that price. It carries it now, as in the browser, and the purchase stops there.

### Automatic suggestions skip mail kept out of automatic AI
<!-- changes: one-oh-screener-no-ai-auto.md -->

With automatic suggestions on, opening the Screener no longer asks the model about a sender whose mail is kept out of
automatic AI, such as a message with a sign-in code; pressing Suggest still asks, with the code removed.

### Text size, and the same size on every Linux build
<!-- changes: one-oh-ui-scale.md -->

Settings → General → Text size scales the whole app, from 90% to 150%, on this device. It applies before
the first frame, in the desktop app and in the browser. On Linux the desktop app no longer follows the
desktop's text-scaling factor, which newer GTK versions applied to the whole window: a distro, AUR or
self-built package now draws at the same size as the AppImage. (#14, #7)

### Larger attachments from the desktop app
<!-- changes: one-oh-desktop-cloud-staged-attach.md -->

The desktop app signed in to a hosted account sends attachments the way the browser does: a file too large
for one request is uploaded to the account's storage first, so the compose form states the same limit as the
browser, up to 42 MB per message. On your own mail server the limit is your server's, up to the same 42 MB.
A mail server that announces no size limit is no longer held to 3 MB of attachments: the form allows about
19 MB, a typical provider's limit, and the server's own answer decides.

## [0.25.24] — 2026-10-14

### Your own Anthropic key sends each model its own thinking setting
<!-- changes: fix-026-ai-follow-ups.md -->

On the desktop with your own Anthropic key, the model you chose is sent the thinking setting it
accepts, so Haiku 5.5 sorts with thinking off and Sonnet 5.5 drafts without a refused first request.
With an Anthropic or an OpenAI key, a message the model declines is now sorted as it is with AI off,
and AI sorting is not paused for it; with an Anthropic key, so is a message whose answer stops at the
output limit.

On ohmail Cloud, the credit for a Screener suggestion the model declined, or one that could not be
saved, is now written down before it is returned, so a return the billing service does not receive
is made on a later pass. If it cannot be written down, the return is still tried.

### Text size, display size and foldable fixes on the phone
<!-- changes: fix-026-layout-sizes-r3.md -->

Changing the text size while the Ohbox is open re-lays the list at the new size on iPhone and iPad; before, the rows
kept the size the app started with. On Android, changing the display size and density together no longer leaves the
screen laid out wider than the window, with the reply bar or the navigation missing. Unfolding a foldable with a
reply open brings the keyboard back on the first unfold too. Half open like a book, the "Kept in Drafts" note stands
on the reading side of the fold. On a wide inner screen, the first screen and the connect form are centred. At the
largest text sizes "Mark all read" moves under the list title instead of running off the screen. On an iPad, the
space kept clear of the window controls is the one iPadOS reports.

### A phone that reads a mailbox says who organizes it
<!-- changes: fix-026-phone-card-follows-the-look.md -->

A phone reading a mailbox that a computer organizes went on saying "Nothing organizes this mailbox",
with Start organizing here, after that computer handed the mailbox back and took it again. It now
names the computer and offers Start only while nothing organizes the mailbox. Later, Park and tags on
a mailbox the phone only reads no longer say "Queued in Answer Later" before they are refused; the
phone says it only reads the mailbox and who organizes it.

### A credit is returned even when its refund cannot be written down
<!-- changes: fix-026-refund-survives-a-failed-obligation-write.md -->

On ohmail Cloud, a credit spent on a draft that failed, or on an automatic Screener suggestion the model
declined, is now returned even when writing that refund down fails. A failed draft says your credits will be
returned only when the return is on record, and says they are back whenever the return went through.

### Every device screens a mailbox by the window of the device that organizes it
<!-- changes: fix-026-the-organizer-window-travels.md -->

A device that only reads a mailbox now applies the screening window of the device or service that
organizes it, so its Screener lists and counts the same senders. A phone that only reads a mailbox
therefore shows the organizing device's count, no longer every sender in the Screener folder. The
window travels in the settings message ohmail keeps in the mailbox, and a change to it reaches your
other devices within about fifteen minutes, without a reload. When the organizing device runs an older
ohmail, or its settings have not been read yet, the Screener lists everyone in the Screener folder and
says so.

### Folders deleted on the mail server leave the folder list
<!-- changes: fix-026-deleted-folders-leave-the-list.md -->

A folder deleted on your mail server or in another mail app leaves the folder list on every device
at the next sync, empty or not, and mail that was only in it leaves with it. A folder made on the
mail server appears without a re-sync. A folder listing that fails changes nothing. An empty
folder's page no longer claims the folder exists on your mail server, and a folder that disappears
while it is open says so.

### Revoking a rule that filed letters after a hand-back works
<!-- changes: fix-026-rule-revoke-after-a-gap-file.md -->

Revoking a rule that had filed the letters arriving after a hand-back failed with a server error and
the rule kept filing. It is removed now. When the server refuses a revoke or a change, the Rules page
keeps the rule on screen and says so, instead of saying you are offline. The Screener, the sender
sheets and subject rules say the same when the server refuses the rule they make.

### Hand the mailbox back lets go within seconds
<!-- changes: fix-026-hand-back-rings-the-pass.md -->

Handing a mailbox back no longer waits for the organizer's next scheduled pass. On a server and in the
desktop app the organizer lets go within seconds, so another device can organize the mailbox straight away.
When a stop could not save a device's settings to the mailbox, the line saying so now stays until that device
organizes the mailbox again.

## [0.25.23] — 2026-10-13

### Layout fixes on tablets and phones
<!-- changes: fix-026-layout-sizes-r1b.md -->

The website's header fits the window at every width: on a tablet in portrait it no longer runs off the right
edge, and Get ohmail. stays on screen. On a touch screen, primary buttons such as Continue on the sign-in
page are at least 44 px tall at every width. On the phone, History's year list stands beside the messages
instead of covering their dates, the Screener's tabs keep their whole names with large text, and the server
settings form scrolls above the keyboard so the focused field and Connect stay reachable.

### A first search after a pause on ohmail Cloud reads less from disk
<!-- changes: perf-026-search-page-rows-read-cold.md -->

The search page no longer reads each candidate message a second time to sort it, so a search whose
data has left the database's memory reads fewer pages from disk. A first search after a long pause
can still take longer than a search right after another one.

### Android foldables keep the reply through every posture
<!-- changes: fix-026-foldable-postures-keep-the-reply.md -->

Unfolding an Android foldable with a message open no longer closes the app. A reply being written keeps its
cursor and keyboard when the phone is unfolded, and stays open, with what was typed, when the phone is half
folded flat on a table; going back to book or flat keeps it too. Half open like a book, the list and the
message meet at the fold on inner screens narrower than 700 dp as well, such as the Galaxy Z Fold's; where a
side is too narrow for a pane, the app keeps to one side of the fold with the navigation rail beside it.
Settings, Search and the other full-window pages, and the sheets, keep to one side of a book fold.

### The offer to file letters that arrived after a hand-back is shown
<!-- changes: fix-026-gap-offer-reaches-the-web.md -->

After a mailbox was handed back and organized again, the offer to file the letters that arrived in between
was counted but not shown. It now appears in the browser, the desktop app and on a paired phone, with File
and Leave.

### Mailboxes nothing organizes say so in the Ohbox and on the sender sheets
<!-- changes: fix-026-gap-offer-reaches-the-web.md#2 -->

When nothing organizes your mailboxes, the Ohbox heading says so even when senders wait in the Screener, and
the sender sheets no longer promise that future mail files where you choose. On the phone, the note that
another device organizes the mailbox goes away once that device hands it back.

### The phone's Screener counts every waiting sender
<!-- changes: fix-026-phone-screener-counts-every-waiting-sender.md -->

On a phone that only reads a mailbox another device organizes, the Screener left out senders whose
mail was all older than 60 days and already read, so its count was lower than the organizing device's.
Such a phone now lists and counts every sender waiting in the Screener folder.

### A deleted letter leaves Answer Later
<!-- changes: fix-026-answer-later-forgets-a-deleted-letter.md -->

A letter in Answer Later, Parked or Resurface that was deleted on the mail server, or moved out of
the folders ohmail reads, stayed counted in that pile and showed up as a row with a long code and nothing
to open. It now leaves the pile and its count at the next sync. A letter moved to another folder ohmail
reads stays in its pile.

### A screen-out says its unsubscribe request before you press
<!-- changes: fix-026-screener-unsubscribe-said-before-the-press.md -->

Screen out and Spam now say, before you press them, that ohmail asks the sender to unsubscribe you where
they offer one-click unsubscribe, now and for their later mail: on the Screener card, in a row's menu and
on its Accept, beside the bulk buttons, in the sender sheet, and on the phone. Where a waiting letter
offers one-click, the request is named as sent; a sender past the Screener, whose press only makes a rule,
is promised nothing. The note after the press says that Undo stops the request until it is sent, and that
a sent request cannot be taken back.

### Enter works on every setup step
<!-- changes: fix-026-setup-dialog-enter-and-count.md -->

- Enter on each setup step does what the step's button does, including Open ohmail on the last step, and
  after a click on the dialog's text.
- The first decision in setup says how many senders are waiting in the Screener instead of always one.

### The AI features move to Anthropic's 5.5 models
<!-- changes: fix-026-claude-5-5-defaults.md -->

On ohmail Cloud, and on a self-hosted server with an Anthropic API key, mail sorting and the Screener's suggestions
now use Anthropic's Haiku 5.5 model, and reply drafts its Sonnet 5.5. The desktop and phone apps keep the models
chosen in their own AI settings. Contributed by Paweł Orzech.

When the model declines a request, that answer now stays with the one message: the message is sorted as it would be
with AI off, the Screener says which sender the model declined, a declined reply draft says so, and any credit the
request used is returned.

### Layout fixes for replies, touch screens, large text and the iPad
<!-- changes: fix-026-layout-sizes-r2.md -->

With a reply open, the message's actions sit in one row at the letter's width above the editor, and the editor
opens where it no longer covers them or the letter's last lines. On a touch screen every rail row, Compose, the
consent buttons, Undo and the sender sheet's choices are at least 44 px tall at every width, and folder names
keep their room beside their controls. Settings notes no longer sit on the line above them, the reply's
recipient address is no longer squeezed on a small phone, the Screener's delivered-to address gives way to the
subject, the sign-up steps name the current step in full when the window is narrow, and the reader's Back no
longer covers the sender at high zoom. The desktop window can be made as short as 400 px. On the phone, the
dock's unread count stays readable at the largest text sizes, the reply sheet stays below the status bar with
the keyboard up, on an iPad in Split View or Slide Over the window controls no longer cover Back, and an iPad's
wording names an iPad. On iPhone and iPad, Settings → New mail no longer mentions push distributors.

### Organize here starts organizing within seconds
<!-- changes: fix-026-organize-here-wakes-the-pass.md -->

Pressing Organize here no longer waits for the organizer's next scheduled pass. On a server and in the desktop
app the mailbox is organized within seconds, and the offer to file letters that arrived in between follows.

### The Screener's row menu stays on screen on small phones
<!-- changes: fix-026-screener-menu-stays-on-screen.md -->

A row's menu in the Screener no longer runs past the bottom of a small phone's screen, so the note that
Screen out and Spam also ask the sender to unsubscribe you is always shown in full before you press. The
folder list's menu follows the same rule.

## [0.25.22] — 2026-10-12

### Search on the desktop answers at once while mail syncs
<!-- changes: fix-026-desktop-search-waits-behind-a-drain.md -->

A search typed while the desktop app is syncing a large mailbox no longer waits for the sync to
finish a step: its first page comes back in its own time, and the sync waits for it instead.

### Idle syncs cost less CPU
<!-- changes: perf-026-idle-drain-enumerates-every-uid.md -->

When nothing changed in the mailbox, a sync now checks each folder's counters instead of listing
every message in it. On a large mailbox an idle sync takes about a sixth of the CPU it did where
the server supports CONDSTORE, and about 40% less where it does not. Mail added, deleted or marked
read in another mail app still shows on the next sync.

### Agreeing to organize screens what setup counted
<!-- changes: fix-026-organize-decision-does-what-it-says.md -->

The "How far back" step of setup now says how many letters from how many senders you have not decided
about will wait in the Screener, and agreeing moves exactly those once ohmail organizes the mailbox.
Older mail, and mail you moved, tagged, put in a pile or answered, stays where it is. Over 1,000
letters, the newest 1,000 move and the Screener offers the rest; while ohmail is still reading the
mailbox, the step shows the count so far and says so. Until you decide, setup asks again each time you
open ohmail, and a key pressed behind it no longer closes it. On the phone, "Organize on this phone"
says what agreeing does to mail already there.

### The Screener says what a decision does
<!-- changes: fix-026-screener-says-what-it-does.md -->

An answer to a message you sent, from an address you had not written to, stays in the Ohbox when that
address writes again: only the new letter waits, and screening the sender out no longer moves the answer.
When a Screener decision is answered, the letters its card shows move with it, a decision refused when you
press moves nothing, and the sender's mail already filed elsewhere stays where it is, including a letter
you filed elsewhere while the app was closed; the sender sheet and Settings → Rules still offer to move
mail already filed, and doing so skips letters you filed yourself. A whole-domain decision names, before
you press, the other senders whose waiting letters it files and how many, and keeps that domain's letters
held for claiming a company's name in the Screener. The offer to screen mail still in the Ohbox leaves
letters you filed there and answers to your own mail. "A suggestion is coming" now shows only while one is
being bought, and a missing AI allowance is said one way. On the phone, a waiting sender whose name claims
a company shows the claim on the list, and a decision for everyone at a shared mail provider is no longer
offered.

### A draft deleted on another device says so in the editor
<!-- changes: fix-026-web-draft-elsewhere-rest.md -->

When a draft open in ohmail was deleted from another device or tab, the editor kept saying it would save it,
and saving and Send went nowhere. The editor now says the draft was deleted, anything you type after that is
saved as a new draft, and Send offers to send the letter as a new one. And reopening a tab after another device
sent its draft no longer clears what you typed there before it was saved: those words are kept as a new draft,
and the editor says why.

### The worker reports a database outage wherever it meets one
<!-- changes: fix-026-tail-stages-announce-a-database-fault.md -->

When the database stops answering during the worker's end-of-cycle passes, `/health` now reports the worker
degraded until a sync cycle completes again. A slow query or a refused value on one account is still that
account's failure alone.

### The list cursor stays on screen, and dialogs keep their keys
<!-- changes: fix-026-keys-reach-what-is-in-front.md -->

- `j`, `k` and the arrow keys keep the message under the cursor on screen in the Ohbox,
  scrolling the list only as far as that message needs, also in a short or zoomed window.
- While a dialog is open (setup, the command palette, the Reply Run), keys meant for the list no
  longer act on the mail behind it.
- Setup takes focus when it opens, and a step that replaces its own button puts focus back in the
  dialog, so Enter no longer opens a message behind it.

### The first company-name letter through a mailing list waits at the Screener
<!-- changes: fix-026-list-address-first-letter.md -->

The first letter that uses a company's name through a mailing list's address you have written to now waits at
the Screener with the mailing-list line, like the letters after it; before, it could reach News. The Screener no
longer says "first contact" over a sender some of whose mail is already in your lists.

### Letters that arrive after a hand-back are offered for filing
<!-- changes: fix-026-organizer-state-and-the-hand-back-gap.md -->

After Hand the mailbox back, the offer to file letters by your rules now counts the letters that
arrived from the moment you pressed, not only those after the next device first looked; letters that
arrived while the app saw another device organizing the mailbox are left out.

### A handed-back mailbox is no longer called all clear
<!-- changes: fix-026-organizer-state-and-the-hand-back-gap.md#2 -->

The Ohbox and the Screener say a mailbox was handed back, or that nothing organizes it, instead of
All clear while first-time senders go straight to the Ohbox; with several mailboxes, the one nothing
organizes is named.

### The desktop's Mailboxes chip says when a phone stopped organizing
<!-- changes: fix-026-organizer-state-and-the-hand-back-gap.md#3 -->

When the phone that organized a mailbox stops, the chip says nothing organizes it, as the sentence
beside it does.

### Organize on this phone shows Starting
<!-- changes: fix-026-organizer-state-and-the-hand-back-gap.md#4 -->

After Organize on this phone, the phone shows Starting until it organizes the mailbox, which now
begins at once, instead of Nothing organizes this mailbox for a minute.

### A phone connected to a mailbox starts organizing it within seconds
<!-- changes: perf-026-phone-first-sync-and-claim.md -->

On a phone set up on its own, reading a mailbox for the first time took minutes for a large one:
about nine and a half minutes for 1,500 letters, during which the Ohbox said that nothing organized
the mailbox. The same mailbox is now read in under a minute, and organizing starts as soon as it is
read. Agreeing to organize, or pressing Start organizing here, no longer adds a wait of its own.

### Search on ohmail Cloud finds the closest words to a mistyped word faster
<!-- changes: perf-026-search-typo-tier.md -->

When no message holds the word you typed, the closest words now come back sooner on a large mailbox,
inside the 100 ms a search page is allowed. The words found are the same as before.

## [0.25.21] — 2026-10-11

### Mail under a company's name through a mailing list's address waits at the Screener
<!-- changes: fix-026-list-address-is-not-a-person.md -->

Having written to a mailing list no longer lets mail through that list's address use a company's name: it
waits at the Screener with a line saying that anyone on the list can write as this address. Allowing it
admits that company's name from that address only. A delivery report that quotes a message you sent to a
mailing list in its To or Cc waits at the Screener too.

### Letters arriving together all show within seconds, and a read on the web reaches the mail server within seconds
<!-- changes: perf-026-cloud-burst-latency.md -->

When several letters arrived close together, the server's organizer showed the first few at once
and the rest only minutes later, after the mail server already held them. They now all show within seconds. Marking mail
read or unread on the web now reaches your mail server within seconds instead of at the next
scheduled visit.

### Live updates
<!-- changes: fix-026-sse-refused-tab-retries.md -->

- A web tab that was refused live updates asks again once a minute, instead of checking for new mail
  every few seconds until it is reloaded.

### A short first message is marked read when you scroll up to it
<!-- changes: fix-026-thread-read-first-letter.md -->

Scrolling a conversation from its first message to its last left a short first message unread. It is
now marked read once you scroll up to it and stay there for two seconds, as the last messages are at
the end. On the phone, the messages listed under the open one are headed Later, or The rest, when
they are not all older than it.

### News and Receipts count only what is new since you were there
<!-- changes: fix-026-waterline-ignores-a-moved-in-letter.md -->

Moving a letter you had already read into News or Receipts no longer clears the "new since you were
here" count, and the phone no longer draws "Seen up to here" above it. On a new device, mail that was
already in your mailbox when it first synced is not counted as new, whether you read it or not.

### Keys and a resized window keep your place
<!-- changes: fix-026-keyboard-and-resize-agree.md -->

- After the window narrows to phone width and widens again, the open message, the list cursor and
  the list agree, and `j` goes on through New.
- The `?` sheet closes when `j` moves the cursor behind it.
- After `1` or `g o`, Enter opens the message under the cursor, not the menu item pressed before.
- Enter on setup's last step no longer starts setup over.
- At phone width, ← opens the menu, a letter laid out wider than the screen fits it, and the
  message's actions sit after the letter at full strength instead of over its last lines.

### Restarting the desktop app keeps it organizing your mailbox
<!-- changes: fix-026-organizer-handback.md -->

An update's restart, a recovered window and turning hosting on or off no longer hand your mailbox to
a phone that happens to be open; quitting still lets it go.

### A phone organizes a mailbox only where you agreed to it
<!-- changes: fix-026-organizer-handback.md -->

An open phone no longer takes over a mailbox it never organized; an agreement you give while another
device is organizing is kept, and the phone asks you once that device lets go.

### Letters that arrive while nothing organizes are offered for filing
<!-- changes: fix-026-organizer-handback.md -->

When no device was organizing a mailbox, new letters used to stay in the inbox for good. The next
device to organize it now counts the ones your rules would file and asks before moving any.

### Search on ohmail Cloud answers faster
<!-- changes: perf-026-cloud-search.md -->

A search no longer reads every account's newest unindexed words before it answers, a part of a word
that few messages hold is read off the index instead of walking the newest mail, and a search made
within two minutes of the last one reuses its connection to the database. On the desktop paired with
ohmail Cloud, the first key of a search opens the way to your account while you type.

### Search finds ß and ss alike, and says what it found
<!-- changes: perf-026-cloud-search.md -->

`Strassenbahn` finds `Straßenbahn` and the other way round, on the web, the desktop and the phone.
Messages found by a close word are counted as such, never as matched. The time on the result line
is how long you waited for the answer to appear. An empty result says so once, and says that a long
message is searched in its first 65,536 characters.

### Changing your statistics choice on the website
<!-- changes: web-026-consent-change-is-where-you-press.md -->

The footer's Change and the privacy page's "change your choice" now open the Accept and Decline choice at the
bottom of the window, wherever you are on the page, with the keyboard focus on Decline. Escape closes it and puts
the focus back.

### The phone keeps its editor on a draft sent or deleted on another device
<!-- changes: fix-026-phone-sent-elsewhere-draft-says-so.md -->

0.25.20 said the phone handled a draft sent from another device like the web. It did not: the phone closed
the editor and said the draft could not be edited here. The phone now matches the web: the editor stays and
says the draft was sent or deleted on another device, anything you type after that is saved as a new draft,
and Send offers to send it as a new letter.

### Changing the text size keeps the open screen on both phones
<!-- changes: fix-026-phone-text-size-changes-live.md -->

Changing the system text size or display size while ohmail is open re-lays the open screen at the
new size: an open message stays open, the composer keeps its text, and nothing is cut or left
oversized.

## [0.25.20] — 2026-10-10

### The Linux app no longer crashes at launch without GPU rendering
<!-- changes: fix-026-issue-9-webkit-crash.md -->

On systems where WebKitGTK runs without GPU rendering, such as some NVIDIA setups, the Linux app
crashed about a second after its window appeared. The theme change now fades without the API that
triggered the crash.

### On Android, a long html message scrolls with the reader
<!-- changes: fix-026-phone-reader-frame-drag.md -->

An html message used to sit in a box of its own inside the reader: a swipe that started on the
message scrolled the box, and the rest of the conversation below it was reached only by swiping
beside it. The message now takes its full height and the reader scrolls as one page, so swiping
through a message reaches the end of the conversation, and the messages read on the way are marked
read. A message too tall to draw that way is shown as text, with the sentence an oversized message
already shows.

### Mail servers that do not state message sizes import faster
<!-- changes: fix-026-sync-lows-1008.md -->

On a mail server that does not report how large each message is, a sync pass now takes up to a full
batch instead of one message per folder.

### Warnings show in the warning colour again
<!-- changes: fix-026-identity-lows.md -->

The warnings in the subject rule sheet, under a tag name that is already taken and on a folder whose
change did not go through are drawn in the warning colour again instead of grey.

### Mail from people you wrote to is released on time after the clock is set back
<!-- changes: fix-026-engine-wall-clock-timers.md -->

When the computer's or phone's clock is set back, ohmail now releases mail held from people you have
written to at its usual hourly cadence, instead of holding it for as long as the clock moved.

### Answers to your mail arrive; only the people you wrote to are remembered
<!-- changes: fix-026-reply-arm-names-the-author.md -->

An answer to a message you sent still reaches your Ohbox, but only an address the message was sent
to is remembered as somebody you know; an answer from another address waits at the Screener when it
fails its sender check or carries a company's name. A delivery report that quotes your own sent
message reaches the Ohbox. One sent under a company's name does so only when the name is your own
mail provider's (Gmail or Microsoft, connected directly), or Microsoft's or Google's from your own
domain; under any other company's name it keeps its warning and waits at the Screener, as does a
report that names only the failed recipient. A copy of your own sent mail no longer merges with a
received message that carries the same Message-ID.

### Search on the desktop answers faster
<!-- changes: perf-026-desktop-search.md -->

The desktop's whole-mailbox search and every list page read from the device's store no longer scan an
index for each row they show. Once the first sync after a launch has settled and the window has been
quiet for three seconds, the first search no longer pays for opening the store cold. A typed search
asks the store 100 ms after the last key instead of 250 ms; Enter, a pressed facet and a sort change
ask at once.

### Marking a message unread puts it back where it arrived
<!-- changes: fix-026-unread-returns-to-its-place.md -->

Marking a message unread puts it back in New where it arrived, on the device you marked it on as well
as on your others. It used to go to the top of New there.

### A picture inside a letter appears once the connection is back
<!-- changes: fix-026-inline-picture-heals.md -->

If the connection dropped for a moment while a letter with a picture in its text opened, the text
showed without the picture until the letter was closed and reopened. The picture is now fetched again
when the app reaches the server, and appears in place. The same applies to a meeting invitation's
event card, to letters opened from News, and to the phone's reader.

### A later name check no longer returns a sender to the Screener
<!-- changes: fix-026-screener-claim-term-followup.md -->

When the company-name check reached held mail stored before it existed, the Screener could list that sender
again, including senders you had added as contacts or admitted by domain. From this release on, a check that
reaches mail after it was stored no longer does; mail an earlier version marked this way leaves the list once it
is older than your screening window. New mail held for a name that claims a company is listed, also when your
mail server gives no receive time, and a desktop paired with Cloud places it as the web does. Held mail from a
contact you added is offered for release again, and releasing it moves exactly what the offer counted. A message
from a contact's address that claims a company and fails authentication stays in the Screener.

### The away responder's switch no longer says On before you save
<!-- changes: fix-026-away-switch-says-what-is-saved.md -->

In Settings → Away responder, pressing the switch changed the line beside it to "On. Replies to new mail"
although nothing was saved, and leaving the page dropped the change without a word. The line now states
the saved responder; an unsaved change is named under the switch with its own Save, and leaving with one
asks whether to discard it. The same holds on the phone, where the end-date line and a failed save's
sentence now also state the saved responder.

### The Screener says when nothing is screened yet
<!-- changes: fix-026-selfhost-first-run-asks-to-organize.md -->

Until you agree to let ohmail organize a mailbox, nothing screens it, and first-time senders go
straight to your inbox. The Screener and the Ohbox now say so, with a button that opens the
agreement, instead of saying first-time senders wait in the Screener. The last setup screen names
that agreement as the step left rather than reading "You're set up".

### Moving your own letter writes no rule about your own address
<!-- changes: fix-026-move-never-writes-an-own-address-rule.md -->

Moving a letter you sent moves that letter and changes no rule, on the web, the desktop and the phone.
Moving a conversation whose newest letter is yours moves the replies in it and leaves your sent
letters in Sent. A rule about your own address can be paused or removed, and is not changed otherwise.

### A draft sent from another device no longer leaves a dead editor
<!-- changes: fix-026-sent-elsewhere-draft-says-so.md -->

When a draft open in ohmail was sent from another device or another tab, the editor stayed on it, said it
was saving while it saved nothing, and Send did nothing. The editor now says the draft was sent, anything you
type after that is saved as a new draft, and Send offers to send it as a new letter. The same on the phone.

### A year press in History fills the rows around it
<!-- changes: fix-026-phone-history-jump-fills.md -->

Pressing a year on History's rail left the messages just above that year grey until the list was
scrolled, and on Android a small swipe back from there could blank the list. The press now loads
the rows above and below its landing, loading continues after scrolling stops, and a row that could
not be fetched says so. History's heading sentence and link wrap beside the year list instead of
running under it, at any screen width and text size.

### Visit statistics on ohmail.app, only if you agree
<!-- changes: web-026-landing-analytics.md -->

The ohmail.app website can now count visits with Google Analytics. Nothing loads until you accept the
one-line notice, and you can change your choice from the footer or the privacy page. Self-hosted
installs carry no analytics.

### What the website's visit statistics count
<!-- changes: web-026-landing-engagement-events.md -->

If you accept the website's statistics, it counts the pages you open, which sections you see, the plan,
download or way of running ohmail you choose, the questions you open, a first use of the live demo, a language
switch and the steps of the website's sign-up form. Never what you type, never your mail and never in the apps.

## [0.25.19] — 2026-10-09

### Older mail no longer appears in the Screener
<!-- changes: hotfix-026-screener-old-mail.md -->

After the update to 0.25.18, the Screener listed older held mail again when the sender's name claims
a company, some of it years old. That mail had been in the Screener folder all along; nothing was
moved. Held mail from before your screening start no longer appears in the Screener; new mail is
still held and listed when it arrives, and Screen no longer offers Inbox mail from senders you have
already admitted.

## [0.25.18] — 2026-10-08

### The phone app's download is smaller
<!-- changes: perf-026-phone-engine-trim.md -->

The mail engine inside the phone app no longer carries the server-only parts of the health check,
the database layer and the live event stream. Nothing a phone does changes.

### Signing out ends that session's live updates within seconds
<!-- changes: fix-026-sse-auth-4.md -->

Signing out, removing a device, signing out everywhere or deleting the account now stops that
session's live updates within two polls, on ohmail.app and on a self-hosted server, in the browser
and in the desktop app in Cloud mode. They ran on for up to four and a half minutes.

### Live updates on the web
<!-- changes: fix-026-sse-stream-liveness.md -->

- A web tab whose live connection goes quiet behind a proxy goes back to checking every few seconds
  instead of waiting up to a minute and a half.

### The buttons in an open message are easier to tap on a tablet
<!-- changes: fix-026-history-821-restore-capsule.md -->

On an unfolded phone or a tablet, Reply, Restore and the other buttons under an open message take
the same 44 px height they have on a phone. With a mouse the bar keeps its desktop size.

### The sender's address stays on screen in the Screener and the open message
<!-- changes: fix-026-review-02517-lows.md -->

A Screener row shows the sender's address on its own line under the name, at every width. In the
open message's header and on the messages the Screener shows, the address is never cut beside a long
display name: where the two do not fit on one line, the address takes the line under the name, and
its domain is never cut.

### A draft kept by folding the phone keeps its Cc and Bcc
<!-- changes: fix-026-review-02517-lows.md -->

When New mail on a phone is closed by a fold or an unfold rather than by Cancel, the draft it keeps
now includes its Cc and Bcc.

### Lists keep their subjects readable on fold-width screens, and tabs stay in one row
<!-- changes: fix-026-web-ladder-polish.md -->

On an unfolded phone or any window from 700 to about 900 px wide, the list beside the reader keeps
at least 16 characters of every subject: tag chips and state notes leave the row first, and the
protected mark shows its shield alone. Tabs (Screener, Answer Later and the others) stay in one row
there, and where a tab strip cannot fit it wraps onto a second row instead of becoming a list. The
AI draft's source line wraps at words, and the Tags settings keep Add beside the new tag's name.

### Enter after narrowing the window keeps the message open
<!-- changes: fix-026-web-ladder-polish.md -->

With a message open beside the list, narrowing the window below 700 px brings it up full-screen;
pressing Enter there now keeps it open instead of closing it.

### The desktop app opens its mailbox faster
<!-- changes: fix-026-desktop-launch-store-open.md -->

The desktop app opens its mailbox faster, by skipping maintenance it did not need at every start.

### A move or delete pressed offline no longer lands over a newer one a day later
<!-- changes: fix-026-state-verb-replay-age.md -->

A move, delete, read, triage or tag change sent more than a day after it was made no longer undoes a
newer move, delete, restore, read, triage or tag change made in ohmail, or a move made in another
mail client. Screener decisions and approvals, a read change made in another mail client, and a tag
put back after it was later removed are not covered. A change replaced by a newer one no longer says
it could not be saved.

### Senders you allowed stay yours in settings an older ohmail saved
<!-- changes: fix-026-person-decides-import.md -->

Settings an older ohmail saved to the mailbox bring a sender you allowed from Junk or let in through
the Screener as your own rule, unless this ohmail already had its own rule for that sender. A rule
such settings brought in before this release is your own too, unless this ohmail had screened or
learned that sender itself. A sender you allowed from Junk after marking their whole domain as spam
or screening it out is your own rule too.

### Your own mail is never filed by a rule about your own address
<!-- changes: fix-026-own-mail-and-the-rules-door.md -->

A rule naming one of your own addresses no longer decides where your own mail goes, whenever it was
made. Screening is no longer offered on a message you sent, on the phone or the web, nor a rule by
its subject on the web, and the rules and the Screener refuse a new rule about your own address. A
rule about the address of a mailbox you removed or erased files its mail as for anyone else.

### A removed rule leaves at once
<!-- changes: fix-026-own-mail-and-the-rules-door.md -->

Removing a rule whose sender had a second copy of it takes both off the screen at once rather than
at the next sync.

### A mailbox keeps syncing after the server sends a message ohmail cannot read
<!-- changes: fix-026-local-runtime-redial.md -->

When the mail server sends more for one message than ohmail accepts, that message is set aside and
the rest of the mailbox syncs over a new connection, in every folder, on the desktop, the phone and
a self-hosted server. The mailbox's settings row says how many messages were set aside. Before, a
desktop or phone mailbox stopped syncing until the app was restarted, and ohmail asked for the same
message again on every attempt.

### Messages set aside no longer slow a mailbox or show a storage error
<!-- changes: fix-026-overrun-hold-and-ladder.md -->

After a message the mail server sent more of than it declared is set aside, ohmail reconnects after
a short wait, without reporting the server as unreachable, so newer mail behind it arrives within
seconds per message. Such messages no longer make the desktop or phone say that ohmail could not
store mail, and no longer hold other messages back. A self-hosted server no longer pauses the
mailbox for each one.

### Mark read in the Ohbox marks the whole conversation read, and messages you scroll through are marked read
<!-- changes: fix-026-thread-read.md -->

In the Ohbox's reader, and on the phone, Mark read marks every unread message of the open
conversation read, with one Undo. Messages you scroll past, or stop on for two seconds, are marked
read too, and so are the last ones once you reach the end of the conversation and stay there.

### Paused accounts
<!-- changes: fix-026-sse-after-the-wall.md -->

- Live updates come back by themselves after a paused account is resumed or paid.
- On ohmail Cloud, live updates stop within about a minute of an account being paused, and the page
  says so.
- The desktop app shows why a paused account stopped syncing, instead of saying it is offline.

### A change made during an ohmail Cloud outage waits for the service
<!-- changes: fix-026-sse-after-the-wall.md -->

The desktop app keeps a change made while ohmail Cloud cannot be reached and sends it when the
service returns, also when the service's host answers with an error page of its own. A check that
meets an error in the middle of an outage no longer marks the app connected and sends the next
change into the outage.

### A message you open and read moves to the top of Earlier
<!-- changes: fix-026-earlier-top-after-read.md -->

A message you open and read moves to the top of Earlier when you move on; everything else stays in
arrival order. Mail you mark read all at once, mail the Screener lets in as read, mail you read in
another app and anything you mark Done after resurfacing keep their place. Marking a message unread
puts it back in New. A desktop or phone that runs on its own, without an ohmail account, remembers
only what you read on that device.

### A mail server running on this computer gets time to finish its own sign-in
<!-- changes: fix-026-local-imap-gateway.md -->

In the desktop app, when the IMAP host is this computer (localhost, 127.0.0.1 or ::1), Test
connection, Connect and Sign in again now wait up to two minutes for the server to answer the
sign-in, and a refusal from it is reported as that server's, with the gateway named as the place to
look, instead of as a wrong password. Remote servers keep the 20-second check. On DavMail, the
`ohmail` folder is created before the folders under it.

### A name claiming a company from another address waits at the Screener
<!-- changes: fix-026-impersonation.md -->

Mail whose sender name, address before the @ or subject opening claims a company on ohmail's list,
from an address that is not that company's, now waits at the Screener and says so, also when only a
rule for the whole domain, a rule ohmail learned or a contact it added would have let it in. A rule
or contact you made for that exact address still lets it through. Mail from your own addresses keeps
its place and still shows the warning. Decisions about everyone at a shared mail provider are made
per address.

## [0.25.17] — 2026-10-07

### New mail, the rail and attachments fit an Android foldable
<!-- changes: fix-026-android-fold-broken.md -->

On an Android foldable's cover screen held sideways, and on any Android phone held sideways, the New
mail sheet scrolls inside the window and Send and Cancel stay on screen. With a foldable open, flat
or half open, Settings, Search, More and New mail start past the navigation rail instead of under
it, and the message or sender beside the list starts below the status bar. A long attachment name
in a message is shortened in the middle, so the end of the name and its size stay visible. Settings,
History and the other pages with their own heading no longer repeat it in the bar above.

### Sheets on an open Android foldable stand over the reading pane
<!-- changes: fix-026-android-sheets-and-polish.md -->

With an Android foldable open, the reader's More sheet and New mail rise over the reading pane, past
the list, instead of standing across both panes; folded, they stay full-width sheets. Folding or
unfolding with New mail open keeps what was typed. On every phone, Android and iPhone, New mail now
opens as a sheet over the screen it was opened from and shows its title once, and every sheet dims
the screen behind it. A message without a subject no longer leaves a blank line in the list. On a
short window, such as the cover screen held sideways, the Screener's decision buttons stay on one
row that scrolls, with the sender or whole-domain switch on a row of its own when the first row
cannot hold it, so the held message keeps most of the screen. The last row of a list or message
rests clear of the floating bars at the end of a scroll, the selected option of a segmented control
stands out of its track in light and dark, and a sender's name on the Screener page takes a size
that suits the pane.

### Two panes on an unfolded foldable and a small tablet
<!-- changes: fix-026-web-width-ladder.md -->

Between 700 and 1023 pixels wide the web app shows the list beside the open message, under the top
bar; below 700 it is the phone layout, from 1024 the three-pane desktop, both as before.

### Folder names readable in the sidebar, and one title on a phone
<!-- changes: fix-026-web-width-ladder.md -->

Folder rows in the sidebar and in the phone's drawer keep their names at every width, the drawer is
up to 320 pixels wide, and a screen's name is shown once, in the top bar; Settings on a phone is a
list of sections, each opening on its own page with a way back.

### The reader's menu stays on screen
<!-- changes: fix-026-web-width-ladder.md -->

On a phone the message menu opens downward or scrolls when it would leave the top of the screen, and
Mark unread moves into that menu on narrow bars instead of standing as a bare dot.

### Names and dates readable on every list row and card
<!-- changes: fix-026-web-lists-and-cards.md -->

On list rows outside the Screener, News and Receipts cards and the open message's header, the
sender's name and the date are shown whole on one line at every width; the address gives way first
and is left out where it would be cut to a few letters; where the open message's header leaves it
out, it is shown on its own line under the sender. On a phone, which mailbox a News or Receipts card
was delivered to is shown on the open card instead of beside the sender.

### Short newsletters and receipts no longer hold an empty card
<!-- changes: fix-026-web-lists-and-cards.md -->

A collapsed News or Receipts card ends where its message ends, up to the usual height; Expand and
the fade appear only on a card whose message is cut, and a short card still opens from the keyboard,
which then lands on its first action. On a phone a designed newsletter is laid out at the card's
width rather than shrunk, so its text stays readable.

### Lists in the two-pane layout keep their words
<!-- changes: fix-026-web-lists-and-cards.md -->

In the narrow list beside an open message (an unfolded foldable, a small tablet), Screener rows show
the sender and subject with Accept underneath, History rows keep their subject instead of where the
message is filed, and the News suggestion shows its sentence across the card with Approve and
Correct below it. On a touch screen the open message's close button sits on the sender's line.

### Lists keep their rows clear
<!-- changes: fix-026-web-lists-and-cards.md -->

A scrolled list shows a thin line under its title and above the shortcuts strip while rows pass
them. History's month rail no longer covers the first rows, a highlighted draft includes its Discard
button, and on a phone the first-sync notice no longer covers the last row or control.

### A sender you decided on stays decided
<!-- changes: fix-026-person-decides.md -->

Pausing or removing a rule ohmail learned now ends what it learned about that sender in every
folder. A paused rule keeps ohmail's learning from filing that sender; after a removal it files
them again only after as many approvals as the first time, through a rule you can see. On an
install that has this release, a rule "Not junk, always allow" wrote there before it is your own
rule too, unless ohmail itself had let that sender into the Inbox and you had not marked that
address as spam or screened it out since. From this release on, re-running or undoing a HEY import
leaves alone a rule you pause and a sender you allow or decide on in the Screener. Moving a message
at the same moment as you pause a learned rule, or reject a proposal for the same sender, no longer
fails.

### Cancel asks the server
<!-- changes: fix-026-send-cancel-asks-the-server.md -->

On the web, the desktop app and the phone, Cancel on a message waiting to send asks the server
first, with one case still open: a message sent from a browser window that had only just opened can
still go after Cancel in another window, which closes without asking. A message that already went,
or is being handed to your mail server, is reported as on its way, not as cancelled, and ends as
sent, or as not sent if sending it then fails. If the server cannot be asked and the message may
already have gone, it stays held and is not sent again while ohmail keeps asking; when the server
answers without deciding, it is set aside as unconfirmed after a while. Cancel in another window of
the same account asks the server too, except for a message a window still on an older version is
sending, where Cancel says to reload that window. An identical reply sent again after the first went
is judged by the server like any other send.

### Live updates and conversation counts on the web
<!-- changes: fix-026-wake-stream-and-row-count.md -->

- On a self-hosted server, the web app opens its live connection on every page load, so a change
  made on another device shows within seconds. Before, a page load after signing in checked for
  changes every 8 seconds until the tab was hidden and shown again.
- A conversation row in the Ohbox, on the web and on the phone, no longer counts a message from the
  same thread that the Screener, screened-out mail or quarantine is holding on this device. Messages
  of the conversation the device has not loaded are still counted.

### Settings, compose and search fit a phone
<!-- changes: fix-026-web-settings-polish.md -->

On a phone, a settings switch stays beside its label, the new-tag colour is a small swatch beside
the name field, the away responder's two choices stay side by side, and a mailbox's Sync now, Edit
and Remove stay together beside or under its sync time and inside the settings page at every width.
Account, Devices and Security are as wide as every other settings page. The formatting toolbar stays
on one row in compose and in signatures, and under 300 px the To field's hint is just the example
address. Search says its count and time once, and never splits a number from its word. In a dark
theme, a held Screener message's Original button sits beside its date instead of over the message.

### The phone says what a press did
<!-- changes: fix-026-phone-press-rows.md -->

On the phone, Later and Park on a conversation that holds your own reply act on the rest of the
conversation and say what they did. Undo on a Move that a later choice for the same sender replaced
puts the mail back. A delete that was still waiting to be sent when the app closed is no longer
reported as not made the next time it starts. A `mailto:` link in a message opens the phone's
composer with its Cc and Bcc. On Android, while ohmail organizes in the background, its notification
says when the `ohmail/_meta` folder is full or cannot be cleaned, in the app's own words, instead of
"Organizing".

### A change is kept when another tab signs in or your sign-in cannot be renewed
<!-- changes: fix-026-session-tabs-after-the-late-renewal.md -->

If your sign-in could not be renewed, or another tab signed in to a different account, while a
change was on its way, the change was undone. It is now kept and sent once that account is signed in
again. A change on its way when another tab signs out is still undone, and so is one for a deleted
account. On the desktop, a correct two-step code entered while the session renewed is no longer
reported as wrong.

## [0.25.16] — 2026-10-06

### A sign-in renewal that finishes after a reload no longer signs the browser out
<!-- changes: fix-026-late-answer-repaired-by-the-live-tab.md -->

If a page was reloaded or a tab closed while it was renewing your sign-in, its answer could arrive
after the page that renewed next, and the browser could be signed out at its next renewal. The tab
that renewed next now renews once more when that answer arrives within a minute of its own renewal,
so you stay signed in; only a tab that renewed within that minute does this.

### Sign-in records are deleted after they expire, and a code that adds a device lasts five minutes
<!-- changes: fix-026-retention-prunes-and-the-kept-list.md -->

- Sign-in links and codes, desktop sign-in requests, OAuth and pairing codes and unused invitations
  are deleted 30 days after they expire.
- A session is deleted 30 days after it is signed out. One that was not signed out, or one a later
  deletion of the account would still have to reach, stays until 400 days after its sign-in ran
  out, so an app that was offline is still told its account was deleted.
- A device keeps its name, and the IP address it was added from is cleared once its last session
  is gone. The privacy and subprocessors pages say how long each of these is kept.
- A code that adds a device works for five minutes at most; the server refuses a longer one.
- On the phone, the sender sheet and Reads say why a message's text is not stored, as the reader
  does.

### ohmail/_meta is cleaned when it needs it, and the phone names a full one
<!-- changes: fix-026-meta-folder-residue.md -->

ohmail now cleans its `ohmail/_meta` folder once a day, or when the folder nears its limit, instead
of on every pass, and dates that cleanup by the mail server's clock rather than the computer's. A
mailbox another of your devices sends requests through is still cleaned on every pass. When
that folder is full on a server that also refuses deletes, the mailbox asks for delete permission
instead of asking you to move mail. On the phone, a full or undeletable `ohmail/_meta` now shows the
same sentence as the desktop, in place of "Organizing" or "Nothing organizes this mailbox"; Stop
organizing here stays available, and Start organizing here waits until it is fixed. The desktop
cleans a full folder at launch rather than at its next check. A phone or computer that only reads a
mailbox now leaves room in that folder for the one organizing it.

### The update menu can no longer freeze the desktop window
<!-- changes: fix-026-desktop-doors.md -->

Pressing Check for Updates, in the menu or in Settings, just as an update check finished could stop
the window responding for good. The menu's label is now written by the window itself, and nothing
waits for it. Closing the window while the app restarts for an update or a relaunch no longer
freezes it for up to six seconds: the window goes at once, or, while the update is still being
installed, says so and goes when it is done. On Linux, Unlock and retry no longer keeps the lock of
a mail engine that has stopped just because another program now runs under its old process number,
except for the first engine of a new copy of the mail and one started while another copy's engine
was still running.

### An update whose installer does not start no longer closes the app
<!-- changes: fix-026-updater-plugin-bump.md -->

On Windows, when the installer for an update could not be started, ohmail closed without installing
anything. It now stays open and says the installer did not start, and Try again downloads the update
again, checks its signature and starts the installer once more.

### The alert mail sends what matters, at most once per kind of problem every six hours
<!-- changes: fix-026-pager-mail-policy.md -->

The operator alert mail sends one message per kind of problem at most every six hours, sooner only
when the problem gets more severe. It mails nothing when a problem clears, and sends a daily
summary of every problem since the last one, those already mailed included. Where alerts go only
by mail, an alert the six hours hold back is not recorded as sent, so it is mailed when they end.
Webhook and Telegram alerts still receive every problem, at times one check later while an alert
mail of the same kind is being sent.

## [0.25.15] — 2026-10-05

### Fewer presses fail beside another change, and a rule keeps its place

Two "Not junk" presses on one mailbox at the same moment both go through, and a Screener decision
made while ohmail lets through someone you wrote to, resetting screening beside a Screener decision,
and deleting your account while ohmail files a waiting sender no longer fail. A rule ohmail learns,
and confirming People you write to, no longer add a rule beside one you already have, and creating a
rule without choosing where it ranks keeps an existing rule where it ranked. Pausing or removing a
rule ohmail learned ends what it learned for the folder that rule files to, so learning it there
again takes the full number of approvals, and from now on "Not junk, always allow" writes your own
rule, not one ohmail learned.

### Behind your own terminator, the proxy alone decides who a visitor is
<!-- changes: fix-026-selfhost-door-defaults.md -->

Behind a TLS terminator of your own (`OHMAIL_EXTERNAL_TLS`), the stack believes a forwarded address
only from the address the terminator reaches it from: the stack's network gateway, found when the
proxy starts, so a terminator on the same box needs no setting and Docker networks outside
`172.16.0.0/12` need nothing now. The proxy takes the rightmost address the terminator added, and
the server believes the proxy alone. A relay on the same box that adds no header still arrives from
that gateway, so a visitor's own `X-Forwarded-For` is believed through it: set
`OHMAIL_TLS_TERMINATOR=0.0.0.0/32` with one. `OHMAIL_TLS_TERMINATOR` is addresses and CIDRs
separated by single spaces; a value the proxy and the server could read differently (a comma, other
whitespace, an IPv4 address written in IPv6 form, a word such as `private_ranges`) refuses the start
and says what to write. A terminator that is itself a container
on the stack's network must now be named in `OHMAIL_TLS_TERMINATOR`; until it is, every visitor
through it shares one address and the server log names it once as `forwarded_address_collapsed`. If
you keep your own compose file, take the proxy's `entrypoint:` line and its `proxy-entrypoint.sh`
mount from the bundled one, and give the `api` service the proxy's two `OHMAIL_` lines.

### A message waiting for a connection goes from one window
<!-- changes: fix-026-send-across-windows.md -->

On the web, a message waiting for a connection goes from the window that pressed Send, once; other
windows of the same account see it waiting, and Cancel there stops it unless that window has
already begun sending it.

### The phone and the desktop app say when a message could not be read
<!-- changes: fix-026-set-aside-and-write-off-said.md -->

When the phone or the desktop app could not read a message and set it aside, nothing said so. The
phone's top line and the desktop app's mailbox list now say how many messages were set aside. When
the desktop app's own storage refuses to save mail, its mailbox list now says "This computer cannot
store mail right now" instead of "Not connecting".

### A wrong code is never retried as a session renewal
<!-- changes: fix-026-late-renewal-keeps-the-session.md -->

A wrong password, code or passkey is refused with its own error code, and no app retries it as a
session renewal.

### Held messages stay out of Ohbox conversations
<!-- changes: fix-026-a-reference-is-not-a-place.md -->

A message held in the Screener no longer appears in, leads, or brings back a conversation in the
Ohbox.

### The ⋯ button in a message's header is a plain icon again
<!-- changes: fix-026-header-menu-class.md -->

Since 0.25.9 the ⋯ button in a message's header drew an outlined box with a second row of dots,
and the Show more button under a very long message was squeezed into a narrow column. The ⋯ button
is a plain icon again and Show more draws on one line, on the web and in the desktop apps.

## [0.25.14] — 2026-10-05

### Deleting your account no longer fails when a device renews its sign-in or signs out at the same time
<!-- changes: fix-026-erasure-lock-order.md -->

If one of your devices renewed its sign-in, signed out or was paired while you deleted your
account, the deletion could fail after your subscription was already cancelled. Those no longer
make it fail. If a deletion does fail after the cancellation, the page says what was cancelled and
that nothing else was removed, or that it could not confirm whether the account was deleted.

### A changed rule takes effect where an older copy of it existed

Changing or pausing a rule takes effect even where an older copy of it existed, and a Screener
decision or "Not junk, always allow" updates the rule you already have instead of adding another.

### A message this device could not save is no longer given up on
<!-- changes: fix-026-write-off-store-error.md -->

A phone or desktop whose own storage refuses a write no longer gives up on that message; the mailbox
shows that mail could not be saved on this device.

### The subprocessors page names the database that holds your mail
<!-- changes: fix-026-subprocessors-name-the-database.md -->

- The subprocessors page names the database that holds your mail and where it is, Zurich in
  Switzerland, and lists the former database until its copy is deleted, with the accounts and
  addresses that copy still holds.
- The subprocessors page lists each kind of record the service keeps and for how long, and no
  page promises a backup window that is not confirmed.
- As your plan's storage fills, the bodies of your oldest messages are emptied to make room for new
  mail; the messages stay findable, because their headers, preview and the words search finds them
  by are kept. The landing page now says so.
- The privacy page and the landing page say your account and mail are stored in Switzerland, where
  they said EU servers.

### A message with a long run of text inside a table no longer stalls the phone's reader
<!-- changes: fix-026-one-html-tree-budget.md -->

Before the phone draws an html message it counts the elements the message would build, a little at a
time so the app stays responsive. Text placed directly inside a table was counted all at once, so
one such message could hold the phone for about a tenth of a second in one go. That text is now
counted in the same small steps as the rest of the message.

### A mailbox whose ohmail/_meta folder is full says so
<!-- changes: fix-026-meta-folder-full.md -->

When the `ohmail/_meta` folder on your mail server holds more messages than ohmail can read, the
mailbox now says so on the web and on the desktop, instead of "ohmail cannot read its own folder".
Move mail that was filed into that folder to another folder and leave the messages ohmail wrote;
ohmail starts again on its own. On the desktop, a computer clock too far from the mail server's is
now named as the clock, as it already was on the web.

### ohmail stops filling an ohmail/_meta it cannot clean, and shrinks a full one
<!-- changes: fix-026-meta-renew-and-shrink.md -->

On a mail server that will not let ohmail remove its own messages from the `ohmail/_meta` folder,
ohmail now stops writing new ones after three tries instead of filling the folder, and on the web
and the desktop the mailbox says so: give that folder delete permission, or ask your provider. ohmail starts again on its own
once a delete goes through. When the folder is too full to read, ohmail now removes its own records
older than a day from it by itself and starts again with no press. On the desktop, these states and
a wrong computer clock no longer read as a lost connection.

### Forwarding a message that just moved goes out on the first press
<!-- changes: fix-026-forward.md -->

A forward whose original had just been moved to another folder could fail with "This was not sent —
your mail server could not be reached" and go out when sent again. It now goes out on the first
press when ohmail can find where the message went.

### A server port saved as digits works
<!-- changes: fix-026-forward.md -->

A mailbox whose server port had been saved as text, such as "993", could not send or open
attachments through the server. The port is now read as the number it spells.

### A conversation opens at the message its buttons act on
<!-- changes: fix-026-web-reader-anchor.md -->

On the web and in the desktop apps, a conversation now opens at the message it was opened at, the
one Delete, Later and the other buttons on the bar act on, instead of scrolling to its newest
message. That holds wherever a conversation opens: the Ohbox, a folder, Sent, a link or a search
result.

### Requests no longer race the web app's session renewal
<!-- changes: triage-026-ux-boot.md -->

When the web app renewed its session while other requests were leaving, those requests could be
refused once and the session renewed a second time. They now wait for the renewal under way, and a
request a renewal overtakes in flight is sent once more on the renewed session without renewing
again.

### Pressing Send again while ohmail reconnects no longer sends the message twice
<!-- changes: fix-026-one-key-per-send.md -->

A reply, forward or new message pressed again while ohmail was still sending it after
reconnecting or restarting could reach the recipient twice. The second press now joins the send
already under way. A reply edited and pressed again while its earlier version was already being
sent now says so, instead of saying the newer words would go.

### A message that waited without a connection goes out once when ohmail reconnects
<!-- changes: fix-026-kept-send-releases-the-composer.md -->

On the web and the desktop app, a message sent without a connection goes out once when ohmail
reconnects, however long it waited.

### The privacy pages say what is kept and what reaches the AI model
<!-- changes: fix-026-retention-prunes-and-the-kept-list.md -->

- The subprocessors page names the mail the AI model reads without a press, and says it happens
  only while your AI switch is on.
- It says what a deleted message leaves behind, how long device names, their IP addresses and
  invitation addresses stay, and that a code adding a device can work for up to 15 minutes.
- The privacy page says what a sign-in records and for how long; the account page's Kept list
  names the sign-in token hashes and the staff record an account deletion keeps.
- A message whose text is not stored says its headers, preview and search words are kept.

## [0.25.13] — 2026-10-04

### The approval page says when a computer asked from another network
<!-- changes: fix-026-approval-names-a-different-network.md -->

On the hosted service, when you confirm a computer's sign-in in the browser, the page now says when
that computer asked from a different network than the one your browser is on, when it can tell the
two networks apart. A self-hosted server no longer takes these browser approvals: the desktop app
asks only the hosted service for one, and the server's approval page says so.

### A reply that has gone keeps the words that went
<!-- changes: fix-026-repress-edited.md -->

If a reply was waiting to send and you changed it and pressed Send again, the server could record
the newer words for a reply that had gone with the earlier ones. A sent reply's record now keeps
the words that were sent.

### A self-hosted server tells its visitors apart
<!-- changes: fix-026-selfhost-client-ip.md -->

Every visitor of a self-hosted server reaches it through the bundled proxy, and the server took them
all for one visitor: five wrong passwords from anyone locked an account on every device, one signup
limit covered the whole server, and the server's sign-in records named the proxy. The server now
takes a visitor's address from the proxies named in `TF_TRUSTED_PROXIES`, which the compose file
sets to its own proxy, and from nobody else. If you keep your own compose file, add
`TF_TRUSTED_PROXIES: ${TF_TRUSTED_PROXIES:-proxy}` to the `api` service; until you do, the server
log names the variable once.

Behind a TLS terminator of your own (`OHMAIL_EXTERNAL_TLS`), the proxy and the server take a
forwarded address only from `OHMAIL_TLS_TERMINATOR`.
The terminator must set or replace `X-Forwarded-For` with the visitor's address; Caddy does on its
own, nginx with `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`. A relay that only
passes the connection through, such as socat, stunnel or a TCP load balancer, adds nothing: set
`OHMAIL_TLS_TERMINATOR=0.0.0.0/32` with one, and no forwarded address is believed.

### Restarting the desktop app waits for its mail engine
<!-- changes: fix-026-desktop-restart.md -->

Installing an update or relaunching after the window stopped could start the new copy while the old
mail engine was still closing, and Unlock and retry could then start a second engine that signed the
app out. A restart now waits for the engine to close, and Unlock and retry keeps a lock that a
running copy still holds. Closing or quitting the app while an update installs now waits for the
install to finish (up to a minute) instead of ending it partway, which left an AppImage that would
not start.

### A Move is sent before the folder check
<!-- changes: fix-026-standalone-move.md -->

On a phone or computer that organizes its own mailbox, a Move reaches the mail server at the start
of the next sync instead of after ohmail has checked every folder for new mail.

### Undo puts a message back where it was in the Ohbox
<!-- changes: triage-026-web-undo-row.md -->

After a message had been open for two seconds, undoing Delete, Park or Answer later put it under
Earlier, often out of sight, and undoing a Delete left the selection on another message. Undo now
puts it back in its place in New, selected and open, unless you have moved on since; it moves to
Earlier when you move on, as any message you have read does.

### One rule per sender, and a rule change waits for every organizer

Adding a rule that already exists updates it instead of adding a copy, and a rule changed on a
device that does not organize your mail shows as changed once every computer that organizes it
has made the change.

### A phone with less memory keeps a margin when it shows a long message's images
<!-- changes: fix-026-phone-frame-ceiling-by-heap.md -->

How long a message the phone draws with its images now depends on the memory the system gives the
app: on Android its memory class, 50,000 characters per MB of it; on iPhone the app's memory limit.
It is never more than 8 million characters, and a phone that reports low memory, or does not say,
draws at most 4 million. A message that would be longer
with its images is drawn without them and says why, also after Show as text and Show original.

## [0.25.12] — 2026-10-03

### The sender sheet counts mail filed in another mail app where it is
<!-- changes: fix-026-sheet-counts.md -->

When a rule moves a sender's mail already in your mailbox, a message another mail app had filed
in a folder of yours stays there. On the web and the desktop, the sender sheet now counts it in
that folder, for example "6 messages — Ohbox 5 · Fixture 1". On every surface the sheet names the
reason, filed in another mail app, with "Move it too". On the web and the desktop, the sentence
once the rule has finished says where such mail stayed, or "several places" when it stayed in more
than one, where it used to say all of their mail was in the Ohbox; its "Move them" moves exactly
the mail it counts. Mail of theirs in Trash or Junk is not counted.

### A lost session renewal no longer signs the browser out
<!-- changes: triage-026-ux-suite-session-revoked-at-first-load.md -->

- When the answer to a session renewal is lost on the way back, as when a laptop lid closes or the
  network drops mid-request, the browser retries it under the same name and stays signed in. It used
  to be signed out as if its session had been stolen.
- A refresh refused as expired is now recorded with the other session events.

### The address check refuses every IPv6 range that is not public internet
<!-- changes: fix-026-ssrf-ipv6.md -->

Before a server connects to a mail server, a remote image, an unsubscribe link or a push endpoint on
your behalf, it checks every address the name points to. The IPv6 check now admits public internet
addresses only: site-local (`fec0::/10`), reserved, documentation and protocol-assignment ranges are
refused, and an address that carries an IPv4 address, such as 6to4 or the NAT64 prefix, is judged by
that IPv4 address. A self-hosted server with `TF_PROBE_ALLOW_PRIVATE=1` still connects to mail
servers on its own network.

### The engine log no longer writes a line per received message
<!-- changes: fix-026-mime-parse-quiet.md -->

A first sync no longer fills the engine log with one line per message. A message that takes longer
than 2 s to read is still logged as a warning.

### The Rules page says what is waiting for your other computer

When the computer that organizes your mail is another one, a rule you remove or change waits for
it. The Rules page and the phone now list those changes, say on each rule whether one is waiting
or was refused, and say when a sender rule outranks a domain rule. A rule is found however its
address was typed, and once that computer carries a change out, this device's rules follow it.

### The desktop app stays signed in when a session renewal is interrupted
<!-- changes: triage-026-desktop-session.md -->

An interrupted renewal of the desktop app's session could sign it out and ask for the password
again; the server now finishes a renewal or changes nothing, so the app's next try renews the
session.

### The organizer's log no longer names your mail server
<!-- changes: fix-026-dial-door-census.md -->

When the background organizer starts connecting to a mailbox, or cannot remove an old claim or
settings copy from the mailbox's `ohmail/_meta` folder, its log line names the mailbox and the kind
of error, never the mail server. A failed automatic unsubscribe is logged the same way, without the
mailing list's server.

### A new rule reaches the computer that organizes your mail

A rule added on a device that does not organize the mailbox now reaches the computer that does.

### A message that cannot be saved no longer holds up the rest of the mailbox
<!-- changes: freeze-02512-phone-b-note.md -->

On the phone and the desktop app, a message that kept failing to save was retried on every sync and
the mailbox never moved past it. Such a message is now set aside after repeated attempts, or at once
when the device cannot store it, and the next version of the app reads it again. If new messages keep
failing with none saved in between, the app stops setting them aside and says that new mail could not
be saved. A full or locked storage on the device is never taken as the message's fault, and a failure
that is not the connection's no longer says the app could not reconnect.

## [0.25.11] — 2026-10-03

### Automatic filing out of the Screener reads less
<!-- changes: db-026-folder-state-account.md -->

The hourly check that files obvious bulk mail out of the Screener no longer re-reads held mail it
has already judged, which lowers database load on large mailboxes. Upgrade with
`pnpm db:setup:prod` so its index is built.

### Changes made on a second install reach the organizer past 500 records
<!-- changes: fix-026-meta-folder-window.md -->

A screening decision, move, rule or setting made on an install that does not organize the mailbox
is handed over and its answer read back however many records the ohmail/_meta folder holds, up to
20 000. The settings message there spells names and addresses as JSON escapes; ohmail rewrites an
existing one once.

### A reply pressed again while it is still sending goes once
<!-- changes: fix-026-repress-once.md -->

Pressing Send again on a reply the app was already sending, waiting in the queue or on its way to
the server, could deliver it twice. The second press now joins the send under way.

### The phone answers every press
<!-- changes: fix-026-phone-says-every-press.md -->

On a phone organizing its own mailbox, a Move starts a sync at once instead of waiting for the next
one. A link nothing on the phone can open says so, and a mailto link opens ohmail's composer. A
conversation row's swipe verbs act on the conversation, and where it holds other people's mail,
Junk, Later and Done leave the reply you sent where it is. A row you sent reads "Me → …", Allow and
Not spam offer Undo, and a sheet longer than the screen scrolls with Cancel in view.

### Signing out of the desktop app ends its session at the server
<!-- changes: fix-026-desktop-sign-out.md -->

Signing out of the desktop app forgot the session on the computer but left it open at the server, so
Settings → Devices on the web went on listing the computer as signed in. Signing out now also ends
the session at the server when it can be reached. When it cannot, the computer is signed out all the
same, and the screen that follows says where it may still be listed.

### Changes waiting for a sign-in are kept, and the screen says how many
<!-- changes: fix-026-desktop-sign-out.md -->

A change made in the desktop app that had not reached the server when its session ended could be
lost without a word: one still on its way when you signed out, or one waiting while the session was
ended elsewhere, for example under Settings → Devices on the web. Sign out now gives a change on its
way a moment to arrive first. A change that still waits is kept on the computer for its account and
server, also while another account signs in there, and is sent when that account signs in again. The
screen after Sign out, and the sign-in or pairing card, say how many changes wait, and for whom.

### The organizer checks a mail server's port, and Settings says why it will not connect
<!-- changes: fix-026-every-dial-guarded.md -->

Syncing now refuses an incoming mail server set to a port that does not carry mail (other than 143
or 993), as sending already refused one, and the check that learns how large a message your outgoing
server accepts goes through the same checks (25, 465 or 587). Settings → Mailboxes says whether the
address or the port was refused instead of saying the server is not available, and receiving no
longer depends on the outgoing server's settings. A self-hosted server with
`TF_PROBE_ALLOW_PRIVATE=1` dials any address and port on its own network, as before.

### The desktop app no longer closes its local store under a write when it quits
<!-- changes: fix-026-cloud-mirror-drain-stop.md -->

Quitting the desktop app could shut its local store down while a write was still running, and
quitting could then leave the engine stuck until it was stopped. The store now finishes the writes
it has started before it closes, and turns away anything that arrives after the quit began. A write
still running after three seconds leaves the store for the next launch to recover instead.

### An html message on the phone is shown as text when drawing it would stall the app
<!-- changes: fix-026-phone-html-tree-bound.md -->

Some html messages build hundreds of thousands of elements out of a few thousand tags: an 18 KB
message could make the phone's reader build 600,000 elements and stall for several seconds. The size
of a message is now judged by the tree the reader would build from it, so such a message is shown as
plain text with a note instead. A message nested thousands of elements deep no longer breaks the
reader.

### Showing the images of a message no longer closes the phone app
<!-- changes: fix-026-phone-html-tree-bound.md -->

A message that names one picture many times could close the phone app when its images were shown,
because the picture is copied into the message at every place it appears. The phone now works out
how long the message would become before adding the pictures. When that is more than it can draw,
the message stays as it was and says why the images are not shown.

## [0.25.10] — 2026-10-03

### A long message no longer stops the phone from syncing
<!-- changes: hotfix-0.25.10.md -->
<!-- changes: fix-026-phone-one-message.md -->

On the phone, a message whose formatted part was larger than 256 KB could not be saved, and the
mailbox then stopped syncing and said it could not reconnect. Such a message is now saved with its
formatted part cut at the limit, like on every other app, and the rest of the mailbox syncs. A phone
that lost track of its messages after the mail server reset a folder now finds them again.

## [0.25.9] — 2026-10-02

### A message a rule screens leaves the phone's inbox when its body arrives
<!-- changes: fix-026-bundle-and-placement-key.md -->

On the phone, a message a rule screens by what its text says moves out of the inbox as soon as its
body arrives, not at the next change to the mailbox.

### Closing a tab while your session renews no longer signs you out
<!-- changes: fix-026-web-session-survives-navigation.md -->

If you closed the ohmail.app tab, or followed a link out of it, at the moment your session renewed,
coming back a few minutes later could ask you to sign in again. The renewal now finishes after the
page is gone.

### A self-hosted desktop manages its mailboxes on its own server
<!-- changes: fix-026-app-says-what-happened.md -->

On a desktop signed in to a server you run, Settings → Mailboxes names that server's web app and
opens its Mailboxes page, instead of sending you to ohmail.app.

### A Mark read that did not go through says why
<!-- changes: fix-026-app-says-what-happened.md -->

When a Mark read on an organizer note does not go through, the note stays and one line under it
says why: you're offline, the account is not active, or try again.

### Undo on the phone says "Not deleted" once it is saved
<!-- changes: fix-026-app-says-what-happened.md -->

After Delete, Undo on the phone says "Not deleted" only once the undo is stored on the device, so
closing the app at that moment no longer moves the message to Trash on the next launch. If the undo
cannot be stored, the phone says the message is in Trash. An undo still being stored is no longer
sent to Trash when the app reconnects in that moment.

### Sign out always ends the session
<!-- changes: fix-026-b-sign-out-sticks.md -->

Pressing Sign out in one tab moments after another tab renewed the session could leave you signed in
after the page reloaded. Sign out now ends the session this browser holds, whichever tab renewed it.

### The phone app is smaller
<!-- changes: phone-engine-size-pass.md -->

The mail engine inside the Android and iPhone apps is about 530 KB smaller. It no longer carries
the zip archiver behind "download all attachments", which only the desktop and web apps offer, or a
CSS parser that sanitizing outgoing mail never reaches.

### The IMAP library is updated
<!-- changes: deps-026-upgrade.md -->

The IMAP library is updated to imapflow 1.7.8, which hardens how a server's replies are read. A
received message that takes longer than 2 s to read is now written to the log as a warning.

### Attachments in nested messages open again
<!-- changes: attachment-sections-026.md -->

Attachments in nested messages that the previous version refused to open download, zip and forward
again. The app now records where the mail server keeps each file, and corrects an older entry the
first time it is used. A file it still cannot verify is refused, as before.

### A sender you screen out stays out of the Ohbox while your mail is still syncing
<!-- changes: fix-026-screener-first-sync.md -->

Screening a sender out in the Screener, on the desktop or on another device, no longer puts their
mail in the desktop app's Ohbox while the app is still bringing your mail in; it is filed under
Screened out as soon as the app has the decision. The Waiting tab no longer stays on "Loading your
mail." during a sync. It says that your mail is still on its way while it is, and whether anyone
is waiting once it is in. The Screened out and Spam counts appear once the sync is done.

### "Sign in with browser" works in a browser that is signed out
<!-- changes: fix-026-browser-signin.md -->

Opening the desktop's sign-in request in a browser that was not signed in to ohmail stopped on "This
browser has lost the name of the account this window is for". The page now takes you through
sign-in, your password and second factor, and back to the request. Confirming a new computer now
signs it in to the account the page names.

### A very long folder name no longer stops a mailbox's sync
<!-- changes: fix-026-server-names-bytes.md -->

A folder whose name is too long to store is skipped, and the rest of the mailbox keeps syncing.
Before, one such folder on the mail server stopped the whole mailbox.

### A message that cannot be parsed no longer stops syncing
<!-- changes: fix-026-parse-settles.md -->

A message whose parse fails inside the mail parser is now refused and skipped like any other
unreadable message, instead of stopping the worker or the desktop engine and holding every message
behind it. A parse that does not finish within 30 seconds is retried later rather than skipped.

### A very long message no longer stalls the window
<!-- changes: fix-026-huge-message-window.md -->

A plain-text message longer than 65,536 characters is shown one part at a time, with a "Show more"
button for the next, in the reading pane, the Screener and the News and Receipts cards. Before, the
whole text was laid out at once, and a 2 MB message held the window for up to a second each time it
was shown. A list row shows at most 300 characters of its preview.

### A very long message no longer freezes the phone app
<!-- changes: fix-026-phone-huge-body.md -->

On Android and iOS, a plain-text message longer than 65,536 characters is shown one part at a time,
with a "Show more" button for the next, in the reader, the conversation's earlier messages, the
Screener, the News cards and Drafts. Before, a 2 MB message froze the app for over a minute when it
was opened.

### The Android download on the website gives the newest APK again
<!-- changes: fix-026-android-download.md -->

Every release now carries the Android APK beside the desktop installers, so the website's Android
button always downloads the newest one.

### A message the mail parser fails on mid-part no longer stops syncing
<!-- changes: fix-026-parse-follow-ups.md -->

A message whose text or attachment the mail parser fails on while reading it is now refused and
skipped like any other unreadable message, instead of stopping the worker or the desktop engine.

### A sender you send to the Ohbox keeps their newsletters there

Choosing where all of a sender's mail goes now holds for the mail they send next as well. With "Keep
my Ohbox for what's relevant" on, a sender whose rule came from a Screener decision, or from mail
you had sent them, kept getting their newsletters filed to News after you chose the Ohbox for them,
while the sheet showed the rule pointing at the Ohbox. If a sender's newsletters still go to News
after you chose the Ohbox, open the sender and choose the Ohbox once more.

### Choosing where a sender's mail goes holds whichever switches are set

Choosing the Ohbox for a sender whose rule already sent their mail there now makes that rule yours
even with "Also move the mail already in your mailbox" off, so their newsletters follow it under
"Keep my Ohbox for what's relevant". A rule from a Screener decision that you moved to the Ohbox
before this release is made yours once, with nothing to press. Undoing a
Move on the phone after it was sent puts the sender's rule back exactly as it was. If a sender's
newsletters still go to News after you chose the Ohbox for them, open the sender and choose the
Ohbox once more.

### The sender sheet says why some of their mail stayed

When a rule has finished moving a sender's mail already in your mailbox, the sender sheet names
why each message it left stayed where it is: you replied to it, set it aside, or it failed the
sender's sign-in checks. "Move it too" moves those you may move. The
notes under the rule switches now say that only a filing made in another mail app stays; a
message you moved inside ohmail moves with the rest.

### The phone's sender sheet says why some of their mail stayed
<!-- changes: fix-026-phone-sheet-why-stayed.md -->

Once a rule has finished moving a sender's mail already in your mailbox, the sender sheet on the
phone names why each message it left stayed where it is, as the web and the desktop do, with "Move
it too" for those you may move. On every surface the line counts all of the sender's mail left in a
place; a sender with more than 100 such messages used to read, and move, only 100.

### "Sign in with browser" comes back after you sign in in another tab
<!-- changes: fix-026-signin-follow-ups.md -->

When the approval page sent you to sign in and you signed in in a different tab or window, the tab
you started in now returns to the computer's request by itself. If the browser's sign-in changes
while the confirmation asks for your second factor, the page checks the sign-in again instead of
telling you to reload.

### The Screened out and Spam counts are no longer a partial number during a sync
<!-- changes: fix-026-screener-counts.md -->

While the desktop app is still bringing your mail in, the Screener's Screened out and Spam tabs
no longer show a count of the mail it has so far, and an empty tab says your mail is still coming
in. The counts appear once the sync is done.

### The Sent, Trash and Junk folders ohmail uses stay the same
<!-- changes: fix-026-imapflow-special-use.md -->

On a mail server that does not mark its special folders, ohmail finds Sent, Trash and Junk by their
names. A folder ohmail already uses for one of them stays in use when another folder's name also
matches, and a server's own marking still comes first. A folder inside one of your own folders is
never newly taken for Sent or Trash; one ohmail already uses stays.

### Second-factor refusals in Settings are in your language
<!-- changes: fix-026-refusal-sentences.md -->

When the check for your second factor in Settings refuses, it now says why in your language: a wrong
code, a passkey that was not accepted, too many attempts, or a check that did not go through. The
Account pane's sign-in check says its refusals in your language too.

### A wrong verification code counts once
<!-- changes: fix-026-step-up-once.md -->

When the web app asks for your second factor again before a sensitive change, a wrong code or a
refused passkey now counts as one attempt toward the sign-in limit, not two.

### A very long html message is shown a page at a time
<!-- changes: fix-026-html-body-512k.md -->

A message whose html part holds more than one page of text is shown as plain text a page at a time,
with "Show more". A designed message with more than 2,048 elements or 131,072 characters of text
shows its plain-text version with a note, as a message over 512 KiB already did.

### An html message is shown as text when drawing it would stall the window
<!-- changes: fix-026-html-parse-bound.md -->

Some html messages build hundreds of thousands of elements out of a few thousand tags — an 18 KB
message could freeze the reading window for several seconds. The size of a message is now judged by
the tree a browser would build from it, not by counting its tags, so such a message is shown as
plain text with a note before it can stall the window.

### Send + Done files the conversation as it is when the reply goes out
<!-- changes: fix-026-send-and-done.md -->

A reply sent with Send + Done that goes out later, for example when the connection comes back,
files its conversation only if it is still in the Ohbox. A conversation you moved or filed in the
meantime is left as it is, and so is one you read, unless it was set for Later. Mail that
arrived after you pressed stays unread. Try again on a reply that did not go through now also
files its conversation and offers Undo. On the phone, pressing Send + Done again while offline is
no longer lost.

### A dropped mail server connection no longer closes the phone app
<!-- changes: fix-026-phone-socket-error-never-crashes.md -->

On a phone organizing its own mailbox over STARTTLS, a connection the mail server reset could
close the app. It now reconnects. When the phone does not accept the mail server's certificate
during STARTTLS, Connect now says so, where it said the server offers no encrypted connection.

### A mail server reached over TLS that the machine cannot reach no longer stops the organizer
<!-- changes: fix-026-pin-answers-later.md -->

When every address of a mailbox's server, reached over TLS, was one the machine could not reach,
such as an IPv6-only server on a host without IPv6, the background organizer exited and stopped
syncing every mailbox it served. That mailbox is now retried as unreachable and the others keep
syncing. A push notification endpoint it cannot reach no longer stops it either.

### The Microsoft sign-in note says where it applies
<!-- changes: land-batch-k88.md -->

The landing page and the README now say that Microsoft 365 and Exchange connect with your Microsoft
sign-in on ohmail Cloud and on self-hosted servers set up for it.

## [0.25.8] — 2026-10-01

### A crafted message body can no longer stall mail sync
<!-- changes: hotfix-0.25.8.md -->

A message whose text is a very long run of distinct words is now stored whole instead of being
fetched again on every sync while the mail behind it waits. A message that exceeds another storage
limit is set aside on its own: it stays on your mail server and the next version tries it again.
For mail stored from this version on, search reads the first 65,536 characters of a message's text.
Update the desktop app as well: an older one shows a mailbox as offline once the server has stored
such a message.

## [0.25.7] — 2026-10-01

### A crafted address header can no longer stall mail sync, and attachments are verified
<!-- changes: hotfix-0.25.7.md -->

A crafted address header can no longer stall mail sync. Attachments inside nested messages download
correctly for mail received from now on, except a file that is the whole body of a message attached
inline; for that file and for older mail, the app refuses a file it cannot verify instead of serving
the wrong one.

## [0.25.6] — 2026-09-30

### The AI call log is complete again
<!-- changes: plane-026-ai-usage.md -->

The worker writes one `ai_call` log line per model call again. The estimated cost in that line
prices Anthropic's Sonnet 5 model at $2 per million input tokens and $10 per million output
tokens.

### Edits made during a takeover reach the mailbox
<!-- changes: fix-026-edits-follow-takeover.md -->

After "Organize here instead", a rule, an away reply, a screening choice or a dormancy window
changed before the new claim lands is written on the install taking over, and that install's
settings reach `ohmail/_meta` beside the ones the previous install left, which stay until you answer
the import question. A decision refused by the install that organizes a mailbox now says why on the
device that made it instead of timing out. On a phone, a stop that waits on a copy of the phone's
claim says so, and a holder that let the mailbox go is no longer named.

### A browser sign-in in the desktop app waits through a closed window
<!-- changes: fix-026-doors-say.md -->

Signing in to ohmail Cloud with the browser from the desktop app kept waiting only while the sign-in
screen stayed open; closing or reopening it lost the wait and a confirmation made afterwards signed
nothing in, and starting it from Settings opened no browser page at all. The page now opens, the
screen picks the wait up again when it opens, and it says when the request was declined or has run
out. A request stopped with Back or Cancel before it is confirmed in the browser stays stopped.

### Refused and blocked states say what happened
<!-- changes: fix-026-doors-say.md -->

The "account not active" screen says why a sign-out did not finish, in the browser and in the
desktop app. The desktop app's keyring card has a Try again for after the keyring is unlocked. A
mailbox whose saved password the desktop app cannot use says so instead of "the mail server is not
available", and sending from a mailbox set to a port that carries no mail names the port and where
to change it.

### Signing in again asks before sending a password unencrypted
<!-- changes: fix-026-doors-say.md -->

On a mail server that offers no encryption, "Sign in again" in the desktop app now shows the same
consent as adding the mailbox, and the consent does not carry over to a server changed before the
next press. A password can no longer be set on a mailbox that signs in with Microsoft.

### Setup, Settings and a press follow what the app already knows
<!-- changes: fix-026-doors-say.md -->

The setup screen's first pull ends when the status bar stops saying the mailbox is importing. A
browser paired to a computer lists the settings answered "Not now" under Settings → Mailboxes. A
change to your mail made while the web session renews and the server is briefly unavailable is kept
and sent again, not refused; any other action taken then, a button under Settings → Mailboxes
included, says the sign-in could not be checked, and the browser page that confirms a desktop
sign-in says to reload it. A picture shown in a message is not kept for the next sign-in in a
browser that ignores the sign-out's cache clearing.

### Search on the phone finds the other forms of a word
<!-- changes: fix-026-search-reach.md -->

On a phone that keeps its mail, a search for "delivery" finds "deliveries" and "running" finds
"runs", as ohmail Cloud and the desktop do. The phone rebuilds its search index once after the
update.

### Search says where it looks for part of a word
<!-- changes: fix-026-search-reach.md -->

A search for part of a word that finds nothing, or only its closest words, says that parts inside a
word are looked for in subjects, senders, recipients and attachment names, not in the message text.

### Search keeps saying "synced so far" through a long first import
<!-- changes: fix-026-search-reach.md -->

A first import still fetching mail more than a day after the mailbox was added is searched as the
mail synced so far, not as the whole mailbox. A closest-words count says "at least" until it is
exact.

### The first search results on a device match what the full search finds
<!-- changes: fix-026-search-reach.md -->

A hyphenated word such as D-U-N-S is found as written and by its parts on every device. Its parts
run together (DUNS) no longer match it in the first results only to disappear when the full search
answers.

### The phone app no longer closes when the outgoing server refuses the settings, or when you stop and remove a mailbox
<!-- changes: fix-026-phone-outlives.md -->

On a phone organizing its own mailbox, a Connect whose outgoing server refused the settings ended
the app instead of naming the outgoing server on the form, and so did Stop and remove once mail had
arrived. The form now says what the outgoing server refused, the password it had just stored is
removed, and Stop and remove returns to the choice of how to organize.

### On ohmail Cloud, pictures in older messages are no longer listed as files
<!-- changes: fix-026-inline-pictures.md -->

On ohmail Cloud, a picture that an older message's text displays is no longer counted by the
paperclip or listed in Files; it keeps its "embedded" tile beside the message. Self-hosted servers
and the desktop and phone apps' own stores keep listing such pictures in mail stored before this
release.

### The Screener places mail by the same rules everywhere
<!-- changes: fix-026-client-places.md -->

A rule that looks at a message's subject or text now places that message in the browser, the
desktop and the phone where the mailbox files it. While a message's text has not arrived, it stays
where the mailbox has it and the Screener says a rule of yours may still move it, instead of
guessing. Screening a sender moves only the mail the list will show in its new place. A conversation
brought back to the top keeps its replies with it in New for you and in Power Through. Previews of
held mail in the Screener load first, and the phone on its own learns who you write to.

### Held mail from your contacts can be let in
<!-- changes: fix-026-client-places.md -->

Mail from somebody in your contacts that is waiting in the Screener with no rule is offered with the
rest of your held mail, one line per person. Releasing it lets that person into your Ohbox; the
mail follows in your mailbox when it next syncs. A held-mail offer you dismissed comes back only for
mail that arrives after the dismissal.

### Put back what the Screener filed on its own
<!-- changes: fix-026-client-places.md -->

With automatic filing on, Settings in the browser and on the phone lists the mail the Screener
filed out on its own. Put back returns a message to the Screener, in your mailbox when it next
syncs, and nothing automatic files it again.

### Stored-mail counts on the desktop, and arrival order below the list
<!-- changes: fix-026-mirror-counts.md -->

A desktop signed in to ohmail Cloud whose own copy could not store some of your account's mail
says how many items could not be stored, in the sync line and in both Settings panes, and says
when that is more than Sync now can retry; it no longer calls that state "Not connecting". Older
mail loaded below a list, History and its month rail, and a new device's first sync now follow
the same arrival order the lists show, so a message with an old or a future date is no longer
pages away from where the list put it. History is in arrival order now; every message still shows
its own date.

### A failed read no longer takes the way to subscribe away
<!-- changes: fix-026-payment-door.md -->

If the Subscription entry in Settings could not be loaded when ohmail opened, it now comes back on
its own the next time you return to the app, on the web and in the desktop app. A Subscribe press on
the trial or payment note that cannot open the account page now says why. After a renewal, the note
that ohmail is catching up on mail from the closure is shown on the web and on the phone even when
organizing had already resumed before you opened ohmail. The desktop app does not show it yet.

### A file fault says which side failed, and a tracking pixel is recognised in every picture format
<!-- changes: fix-026-fault-tracker-named.md -->

- A file from a mailbox that is not signed in here says so and offers no Try again; a send from it
  ends at once with the same sentence.
- A file from a mail server that took the connection and then would not serve it, or refused the
  request after the sign-in, says the server isn't serving the mailbox right now and offers Try
  again.
- A file that failed on ohmail's side offers no Try again.
- A tracking pixel is recognised in every picture format the image proxy serves, and a tracker's
  address is matched however it is spelled. An AVIF branded as a still picture is sized by its
  primary image, even when a track follows it. The help page, the FAQ and the tracking pixel setting
  say that a disguised pixel loads each time a message's pictures are fetched.

### Forwarding a message that is only attachments sends it with them
<!-- changes: fix-026-forward-sends.md -->

Forwarding a scanned PDF, a photo sent without words or a message attached as a file no longer
fails with "The original could not be loaded"; it goes out with every attachment. An older message
whose stored copy was dropped under the storage limit, and a message in Junk, forward with their
text read from your mailbox when you send. On the phone, a forward that is still refused says why.

### Builds install the dependency versions that were tested
<!-- changes: fix-026-published-build-tested-tree.md -->

The desktop apps, the Android app and the self-host images are now built from the dependency
versions the project is tested with. Before, the published lockfile was resolved from the package
registry each time a release was published, so a build could pick up newer releases of indirect
dependencies than the ones that were tested, among them native modules of the Android app. These
builds also run no dependency install scripts.

### Who organizes your mailboxes is said once, at the foot of the sidebar
<!-- changes: fix-026-notice-steps-aside.md -->

Nothing is said any more when this install starts organizing a mailbox, so reopening a paused
account no longer stacks a line per mailbox over the Ohbox. When another install takes a mailbox
over, or the one organizing it stops, a short note stands at the foot of the sidebar (above the top
bar on a narrow window), several mailboxes behind a count; Mark read clears it on every device, and
it comes back only for a new change.

### Forward stands beside Reply on the message bar
<!-- changes: fix-026-notice-steps-aside.md -->

On the web and desktop apps Forward is always on the message bar beside Reply, at every window
width; it was only in the More menu on a narrow window or a phone. On the narrowest screens Forward
and then Reply show just their icon rather than run off the bar.

### A first mailbox without encryption, set up on the first launch
<!-- changes: fix-026-first-door.md -->

On the first launch of the desktop app, "On this computer" now shows why a mail server on your own
network that offers no encryption was refused and offers the same consent line as adding a mailbox,
instead of opening the app over a mailbox with no password. With the line ticked, the mailbox is
connected and syncs. A "Sign in again" that the mail server refuses no longer keeps the refused
password in use, and the status bar says when a mailbox has no password instead of "Connected".
Setup asks about the mailbox just connected, and with several mailboxes connected, "Run setup again"
and the setup link on the web ask which mailbox the setup is for.

### The phone no longer signs itself out after a display, font or language change
<!-- changes: fix-026-one-bearer.md -->

The phone no longer signs itself out after a display-size, font-size or language change, or after
being closed while it was renewing its session.

### The phone keeps up with a large mailbox
<!-- changes: phone-026-fast-and-fits-on-a-foldable.md -->

On a large mailbox the phone app no longer redraws its lists after every sync when nothing changed,
so taps take effect at once instead of after several seconds. On a foldable's cover screen and at
large display sizes nothing is cut off: destinations without room move into More, the reader keeps
Reply and Forward on its bar, a reply stays open and above the keyboard when you fold or unfold the
phone, and the lists move on to the new day at midnight without a sync.

## [0.25.5] — 2026-09-29

### Large sync changes arrive in pages, and a desktop on Cloud logs the writes it sends
<!-- changes: fix-026-sync-pages.md -->

- A large set of changes, such as many long drafts saved at once, now arrives in pages. Before, it
  could arrive as one reply too large for the desktop's own connection to its engine, and the sync
  failed the same way on every retry. Snapshot pages were already bounded this way; now both kinds
  of sync page are.
- A desktop signed in to ohmail Cloud writes one line to its engine log for each change it sends
  to your account: the kind of change, the answer and how long it took. Nothing of the message
  itself is logged.
- On a desktop signed in to Cloud, a mailbox that another ohmail install organizes is now sorted
  by that install's rules, as on the web and the phone.
- After one request fails, a desktop on Cloud tries the account again on the next read instead of
  showing itself offline until its next sync.
- A draft replying to old mail keeps the message it answers on a newly set-up device.

### The dark sync link, the tag chips and the Screener's key hints meet the contrast minimum
<!-- changes: fix-026-dark-aa.md -->

In the dark themes the "Settings → Mailboxes" link in the sync box and strip sits on the theme's
darkest ground rather than a white lift; in the ohmarchy face a tag's name is coloured to read on
its own chip, over the tile and over the page; and the key hint on the Screener's suggested
decision is no longer faded. All three read at 4.5:1 or better in both faces, light and dark.

### The phone offers to screen senders already in the Inbox, as the web does
<!-- changes: fix-026-phone-tells.md -->

Mail that was already in the Inbox when you connected the phone stays in the Ohbox, and the Ohbox
now offers to hold its undecided senders in the Screener with one press, as the web app does.

### A Move pressed just before the app closes now keeps its rule
<!-- changes: fix-026-phone-tells.md -->

On the phone, a Move that decides where a sender's mail goes keeps that rule even when the app is
closed right after the press; the next launch makes it and says so.

### Screener presses show what they did, and a release can be undone
<!-- changes: fix-026-screener-presses.md -->

Allow, Not spam and back to Waiting in the Screener now offer Undo, as Move does. Mail you screen
from the Inbox shows in the Screener at once, a decision on a sender further down the queue lowers
the count when you press it, and a release pressed while your mailbox is still loading waits for it
instead of failing. A "Not junk" your mail server refused can be left in Junk.

### The desktop app says what it could not do instead of waiting
<!-- changes: fix-026-shell-deadlines.md -->

- A request from the window to the app itself now gives up after a minute with a sentence, where it
  could wait for ever. Try again on the "cannot open your mailbox" card starts the mail engine
  again; where there is no engine to start, the button reads Read again.
- Host mode no longer holds ohmail's launch when Tailscale does not answer; after ten seconds it is
  treated as not running.
- On Windows, a window whose web process stops is reloaded, and uninstalling ohmail removes the
  host-mode web client too.
- Settings → Mailboxes says when a stop left this computer's settings on this computer only, and
  Settings → Desktop names the mailboxes this computer holds.

### A new install opens faster
<!-- changes: perf-026-opens-fast.md -->

The first start of a new install makes its local copy of the mailbox in memory and writes it to
the disk once, instead of writing it a page at a time and waiting for the disk after each page. On
a Linux desktop, measured in the same minutes, a new install is ready in 1.8-3.5 s where it took
8.4-13.8 s, and its list appears in 2.7-4.8 s instead of 9.6-14.7 s. Starting an install that
already holds mail is unchanged.

### A mailbox connected without encryption is only ever dialled at an address on your own network
<!-- changes: fix-026-plaintext-private.md -->

A self-hosted mailbox connected without encryption keeps working while its server is on your own
network: every connection, for syncing, sending and attachments, checks where the server's name
points at that moment and connects only to an address on your own network. A mailbox whose server's
name now points outside it stops, nothing is sent, and Settings → Mailboxes says the server's
address is no longer on your own network. Add mailbox in the app now offers the same consent for
each half as setup and Settings → Mailboxes, and Settings → AI says when a self-hosted server has no
AI model.

### A reply you start is in your drafts, and News draws a letter's pictures
<!-- changes: fix-026-web-keeps.md -->

A reply typed in the message and left unsent is saved to your drafts after a short pause, as a new
message is, so Drafts lists it on every device. Reply on that message, here or on another device,
opens that draft and Send sends it, so one reply stays one draft. A letter opened in News or
Receipts draws the pictures it carries in its text. The sender sheet marks where the sender's rule
files their mail and names that rule when some of their letters sit elsewhere.

### A Move made just before the app closes keeps its place
<!-- changes: fix-026-paired-move.md -->

On a phone signed in to ohmail Cloud or to your own server, a Move made just before the app closes
keeps its place: the next launch finishes it once and says so.

### Sending from the phone
<!-- changes: fix-026-phone-send.md -->

A send the server has accepted says "Still sending.", and a mail server that could not be reached
says so in its own words. An answer that comes after the phone stopped waiting for it reaches the
composer, which then sends the draft the refusal left rather than writing a second one. Drafts
addressed in To alone, without formatting, open in the phone's composer from Drafts: what is typed
is saved into the draft as it goes, and Send sends that draft.

### Server alerts mail less, in one format
<!-- changes: fix-026-alerts-tell-the-truth.md -->

A server's alerts no longer count a timed-out access refresh behind a read as a fault, mail again
only when an alert gets worse, and arrive in one format whichever process sends them.

### Security update: the web app on Next 15.5, the web and desktop apps on React 19
<!-- changes: deps-026-next-15.md -->

- The web app runs on Next 15.5 and the web and desktop apps on React 19. Next 15.5 fixes two
  critical advisories in Next 14, in the image optimizer and on Windows-hosted servers; neither was
  reachable in ohmail's configuration.

### Pictures in a message are fetched once
<!-- changes: fix-026-a-picture-fetched-once.md -->

On the desktop, the pictures in an open message were fetched again and again while it stayed open,
and on macOS the reading pane's scroll bar flickered. Each picture is now fetched once.

### The Android build carries its TLS and mail-sender fixes
<!-- changes: release-026-patches.md -->

The Android app is now built with the two fixes this repository carries for its TLS connections
and its mail sender, so a mail server on a STARTTLS port (587 for sending, 143 for reading)
connects and sends, and a certificate issued for a different name than the server's is refused. A
build without them now fails instead of publishing. The desktop app and the self-host images are
built with the mail sender's fix the same way.

### One settings message per mailbox
<!-- changes: fix-026-one-settings-message.md -->

ohmail keeps one settings message per mailbox in `ohmail/_meta` and removes the older copies, its
own and the ones other ohmail installs left behind, a hundred at a time. Where a server refuses to
delete, the folder holds two at most. Before, on servers that answer ohmail's search for these
messages with nothing, every settings change added a copy that other mail apps showed and found in
searches.

### A full ohmail/_meta folder no longer stops organizing
<!-- changes: fix-026-the-lease-reads-every-claim.md -->

ohmail keeps organizing a mailbox whose mail server does not answer its searches, with up to 20 000
records in the ohmail/_meta folder. The organizer also removes the leftover organizer records other
installs wrote there, a thousand at a time.

### A conversation is one row in the Ohbox
<!-- changes: fix-026-one-row-per-conversation.md -->

A conversation is one row in the Ohbox: in New while anything in it is unread or open, under Earlier
once it is all read, at the time of its newest message, or of the one you just read in ohmail — in
the browser, in the desktop app and on the phone. Your replies ride the conversation's row, and
reading one of several new replies no longer moves that message to a second row under Earlier.

### Links in designed mail open your browser on Linux
<!-- changes: fix-026-a-link-in-a-message-opens.md -->

Clicking a link in a message shown in the sender's own layout did nothing on Linux. It now opens in
your browser, and an email address opens a new message.

### Settings lists Subscription as soon as you sign in
<!-- changes: fix-026-settings-and-suggest.md -->

Right after signing in with a password and a code, Settings lists Subscription without a reload,
and Settings → Mailboxes points there only while Settings lists it.

### The Screener says when suggestions need credits
<!-- changes: fix-026-settings-and-suggest.md -->

With automatic suggestions on and no AI credits left, the Screener now says so under its controls
and names where credits come from, instead of a notice that disappears.

### /health checks the sign-in address index
<!-- changes: fix-026-migration-markers.md -->

`/health` now also checks the unique index that keeps one sign-in address to one account. A
server whose database lacks it answers 503 instead of reporting itself healthy.

### A waiting draft discard is listed on the phone, and Send + Done files the conversation when the reply goes out later
<!-- changes: fix-026-outbox-state.md -->

A draft you discard while the phone cannot reach your account stays listed with the other changes
that have not gone through, with Try again and Discard; Discard keeps the draft. Send + Done on the
phone files the conversation when the reply goes out later, when the connection comes back, on the
next start or after Try again, not only when it goes at once.

### Closing ohmail during a pairing no longer turns start at login off
<!-- changes: fix-026-pairing-undo.md -->

A desktop that serves your other devices stops doing so while a pairing with another computer is
set up. When ohmail was closed or stopped during the pairing, the next start brought hosting back
but left start at login off. It now comes back too. When the pairing leaves this desktop listed on
the other computer, Settings → Switch names that computer and where to look.

### A pairing undone while the other computer answers keeps nothing
<!-- changes: fix-026-pairing-undo.md -->

If the pairing was undone while the other computer was still answering, for example by reopening
the window, the session that computer sent arrived afterwards and stayed, and this desktop stayed
on its Devices list. The desktop now keeps nothing from that answer and signs it out on the other
computer. A pairing refused because that computer names a different account is signed out there
too.

### A rule saved with spaces around its address counts everywhere
<!-- changes: fix-026-screener-decides-once.md -->

A rule whose address was saved with spaces around it is now honoured by the Screener's decisions,
Not junk and automatic filing, not only by the filing of new mail.

### After you pay, the trial and payment notes go away on their own
<!-- changes: fix-026-strip-follows-payment.md -->

After paying in another tab or on another device, the trial or payment note at the top of the web
app and the phone app is gone the next time you return to it, with no reload. The note that ohmail
is catching up stays until you put it away, a reload no longer loses it, and the phone shows it
too. Paying from the setup flow with a mailbox already connected finishes setup, and an account
with no mailbox is no longer offered the sent-mail review.

### Operators can grant roles to staff, and every staff read and write on the API is recorded
<!-- changes: admin-024-open-staff.md -->

Staff hold roles (support, billing, ops, owner), read on every request; an owner grants and
revokes them with a code from their authenticator. Every staff read and write on the API is
recorded before it is answered, and a request whose record cannot be written is refused. The
operator console gains search, accounts by id, a sync roster and a fuller account page. Needs
cloud migration 0047 and a re-run of `scripts/harden-staff-role.sql` with the API deploy.

### Webhook and Telegram alerts say when a critical alert has resolved
<!-- changes: fix-026-operator-sees-owed.md -->

A critical alert that stays resolved is now announced on the webhook and Telegram channels as well
as by mail. The notice is sent once: after any channel accepts it, a channel that refused it is not
asked again.

### Away replies held back are still sent
<!-- changes: fix-026-away-reply-one-door.md -->

An away reply held back because another device took over organizing is still sent afterwards, and
a reply whose message was removed while it went out is recorded as sent. Re-screening sensitive
mail no longer treats an automatic reply, or a reply to somebody else, as your answer.

### A file that could not be fetched says why
<!-- changes: fix-026-attachment-fault-side.md -->

- A file or embedded picture that could not be fetched now says which side failed: ohmail, your
  mail server not answering, a connection it would not secure, a sign-in it refused, a mailbox that
  needs reconnecting, a message no longer where your mailbox had it, or no connection to ohmail.
- Pictures a newsletter's mail service hosts, such as Mailchimp's or Constant Contact's, are shown.
  A picture is refused before it is fetched only when its address is a tracking pixel's or its host
  does nothing but track.
- A tracking pixel whose address is percent-encoded is recognised as one.
- A calendar reply that says so only in its calendar part is recognised as a reply.

### Search finds older mail in accounts that are not syncing
<!-- changes: db-026-does-less.md -->

An account whose mailboxes are all disconnected, or whose subscription has ended, now has its older
mail indexed for search like every other account.

### A computer whose clock jumps stops organizing on time
<!-- changes: fix-026-permit-one-clock.md -->

A computer whose clock is set back, or jumps forward, stops organizing a mailbox within the usual
window once it no longer holds it, rather than for as long as the clock moved. The settings page and
the apps name the computer that actually organizes a mailbox, and a claim written by a newer ohmail
is named as unknown. The note on a mailbox that is not being synced now appears after four minutes,
once the automatic reconnect has had its turn.

A self-hosted worker now refuses to start unless `TF_SYNC_BLOCK_GRACE_MS` is longer than
`TF_LEASE_UNAVAILABLE_DETACH_MS`, `POLL_INTERVAL_MS` and `TF_ROSTER_INTERVAL_MS` together.

### A draft keeps what it answers
<!-- changes: fix-026-draft-keeps-answer.md -->

A forward you save as a draft, on your phone or on the web, is sent as a forward when you open it
again: the original message is quoted and its attachments go with it. A reply saved as a draft
because its message was moved or deleted in another mail app keeps its subject and recipients,
reply all included, and is written into that reply's own draft. A message whose send was
interrupted is sent from its own draft after a reload, without making a second one, and a change
waiting in a tab you closed is sent by a tab that is still open.

### Every list says when the message you were reading has gone
<!-- changes: fix-026-view-says-gone.md -->

If the message you have open in a tag, History, a Triage pile, a folder or Trash is moved or deleted
elsewhere, the reading pane now says so instead of showing a different message or the old one. On a
phone-sized window every list gives the whole width to the list, Trash included, and the top bar
names Trash. After a short
connection drop, History, the address view and a letter's files recover on their own once the server
answers again. An open History keeps its count right when older mail arrives or a message is deleted
elsewhere. Enter in the command palette runs a "Go to" entry again.

### A delete pressed just before the phone app closes is kept
<!-- changes: fix-026-phone-says.md -->

On the phone, a delete you make just before the app closes is no longer lost: the next launch
moves the message to Trash and says so. Undo now shows "Undone." as soon as you press it.

### Turning off the phone's organizing notification stops background organizing
<!-- changes: fix-026-phone-says.md -->

On Android, turning off the "Organizing" notification category stops the phone organizing in the
background, and This phone says notifications are off, with the way to the setting.

### A long mail store update on the phone says how far along it is
<!-- changes: fix-026-phone-says.md -->

When an update reworks the mail store on the phone, the launch counts the steps and says when a
large mailbox may take several minutes.

## [0.25.4] — 2026-09-28

### Settings → About writes a diagnostic file you can send us
<!-- changes: maturity-026-m4-local.md -->

On the desktop and the phone, Settings → About has a Diagnostic file row. One press writes a single
file about how the app is running: its version and build, the platform, the number of messages and
other items it holds, each mailbox's sync and organizer state as codes, and the recent log events as
numbers and codes. It never contains an address, a subject, a folder name, a server name or a
sentence from your mail, and home-directory names are removed from crash traces. The desktop writes
it next to its log; the phone writes it next to its copy of your mail, so one backup setting covers
both, and offers the share sheet. Nothing is sent: the row says where the file is, and you decide
whether to send it to us.

### After an update on Linux, the previous version no longer stays mounted
<!-- changes: fix-026-update-no-old-image.md -->

The previous AppImage stayed mounted, with its deleted file still taking disk space, until the
updated app quit. It is now released as soon as the old version exits.

### A message at any number the server gives is stored
<!-- changes: fix-026-uid-bigint.md -->

A mail server may number a message anywhere up to 4,294,967,295, and ohmail could store numbers
only up to 2,147,483,647: a message above that was never stored and was downloaded again on every
sync, and "Not junk" on it answered an error. Every number the server can give is now stored.
The update rewrites four tables once: a large mailbox's first launch after it shows "Updating your
local mail store…" for a while, and on a server new mail waits until it finishes.

### A folder deleted in another mail app leaves with its letters
<!-- changes: fix-025-folder-deleted.md -->

A folder of your own that you delete in another mail app now leaves ohmail with its letters at the
next sync, on every device: they are gone from the list, the conversation and Search. ohmail asks
the mail server about the folder by name first and removes its letters only when the server says
the folder does not exist, and a folder you rename elsewhere keeps its letters under the new name.
A conversation's count no longer includes a letter deleted elsewhere.

### A large mailbox shows mail within its first sync instead of after several minutes
<!-- changes: fix-025-large-first-minute.md -->

Connecting a mailbox with tens of thousands of messages used to show nothing for several minutes
while ohmail worked out which messages were the most recent; on the desktop and phone apps a large
enough mailbox could show nothing at all. The most recent mail now appears within the first sync
and the rest follows behind it. This applies to Cloud, self-hosted servers and the desktop and
phone apps. On Cloud and self-hosted servers a newly connected mailbox also starts syncing within
seconds, instead of waiting up to half a minute for its turn.

### A Screening change made on another device reaches the one that organizes
<!-- changes: fix-025-reader-screening-edit.md -->

On a device that does not organize the mailbox, a change to the Ohbox posture, to your words for
it, or to the switch that files obvious bulk was sent to the organizing device and turned away
there. It now applies. A signature too long to be sent there is refused when you save it.

### The phone's Screener decisions offer Undo
<!-- changes: fix-025-phone-screener-fifty.md -->

On the phone, a Screener decision for a sender whose mail is past the gate no longer moves up to
50 of their messages itself. The rule it writes brings that mail along through the server, as on
the web. Every Screener decision now offers Undo for a few seconds before it is sent, including a
decision for a whole domain.

### Settings → Mailboxes can check a mailbox against your mail server and say which folders differ
<!-- changes: maturity-026-mailbox-self-check.md -->

Check this mailbox compares, for each folder ohmail reads, how many messages your mail server
holds with how many ohmail holds, and says one sentence: in step with your mail server, or which
folders differ and by how many messages, or why the server could not be read. A folder the server
renumbered is named as such. It only reads: nothing on the server or in ohmail changes, and a
difference is shown, never repaired. It is on the desktop, on the web and on a phone that opens
its mailbox itself. A diagnostic file written after a check carries its result as counts and
codes, with no folder names.

### Mail you wrote from a Sent folder with its own name counts
<!-- changes: fix-026-sent-folder-by-name.md -->

People you wrote to from a Sent folder your provider names in its own words — a translated
Outlook folder, for one — are no longer held in the Screener once the mailbox next connects.

### ohmail can act on confident suggestions, behind its own switch
<!-- changes: fix-026-auto-act-consent.md -->

Settings → Screener has a new switch under "Suggest for new senders automatically": "Act on
confident suggestions for me". While it is on, a waiting sender whose suggestion is at least 90%
sure is filed where the suggestion says, and the rule is written for you and listed in Settings →
Rules, where you can undo it. Senders you have written to and sensitive mail are never filed this
way, and turning automatic suggestions off turns this off too. When ohmail tries and cannot file a
sender, the Screener says so beside the sender's Accept.

### A Screening change made on another device says where it went
<!-- changes: fix-026-change-says-where.md -->

On a device that does not organize the mailbox, a change in Settings → Screening said "Saved."
although it had only been sent to the device that does. It now says it was sent, then "Applied."
once that device has taken it, or names the device that could not read it. "All time" in the
Screener's window now travels there too, instead of changing only this device. The away responder,
the Screener's window and each signature say the same: that a change was sent, and which device
could not take it. Settings → Rules lists the rules ohmail wrote for you under their own heading,
"Decided for you by ohmail", with the same Change and Revoke.

### A signature saved with formatting in the browser is kept
<!-- changes: fix-026-change-says-where.md -->

Saving a signature with bold, italic or a link in the browser cleared the signature for that
address. The formatting is saved now.

### Deleting an account or a mailbox leaves nothing owed and nothing stale
<!-- changes: fix-025-erasure-nothing-owed.md -->

- A refund still owed to you when you delete your account is kept, with nothing on it that names
  you, until it is paid.
- A device that was offline for longer than its sign-in window is told the account was deleted
  and removes its copy of the mail. On the desktop, signing in after the deleted-account notice
  clears it for good.
- Erasing one mailbox's copy no longer makes a retried request in another mailbox answer that its
  result was erased, and the typed confirmation travels in the request body, not the URL.
- The closure mail names an erasure date only when the erasure will happen on it.

### Confirming an action no longer signs you in again
<!-- changes: fix-026-confirm-step-up.md -->

Changing a mailbox, deleting your account or linking the desktop app asks for your second factor,
not your password, when a fresh confirmation is needed, and no longer adds a web session to
Devices each time. Deleting your account removes only that account's copy from this browser.

### A phone's incoming server can be changed while it organizes
<!-- changes: fix-026-phone-claim-restart.md -->

- Settings → Server settings changes the incoming server or login of a mailbox this phone
  organizes without stopping first: the phone claims the mailbox on the new server before the
  change is kept. If another install organizes the mailbox there, the change is refused and the
  sheet says so.
- On a phone that does not organize in the background, leaving the app while the sync it started
  on the way back in is running hands the mailbox back at that sync's next step.

### Every screen says who organizes a mailbox from what it has read
<!-- changes: fix-026-who-organizes.md -->

A desktop that cannot read its own folder on the mail server says so on the mailbox row. Web
setup offers Agree once the server has looked at who organizes the mailbox, and asks before it
joins a mailbox another install is organizing. An install that stopped organizing is no longer said
to file the mailbox, and the desktop does not say mail is being filed while the mail server cannot
be reached. A Screener decision made during a refused takeover goes to the install that kept the
mailbox.

### Replacing an authenticator works
<!-- changes: fix-026-authenticator-replace.md -->

Settings → Security → Replace authenticator answered with an error on an account whose authenticator
was already set up. It now shows a new key, and the authenticator you have keeps working until a
code from the new one is confirmed. A replacement not confirmed within 15 minutes has to be started
again.

### Waiting changes and refused sends say where they stand
<!-- changes: fix-026-outbox-row-state.md -->

A draft you deleted while the account could not be reached now stays listed with the other changes
that have not gone through, with Try again and Discard, instead of being mentioned once. A message
sent before its first save that is then refused keeps a single draft. On the phone, a reply sent
again with no connection replaces the waiting one rather than leaving a second draft. Discarding a
message whose send is not confirmed says the draft stays in Drafts, and opening Compose on a message
you left unfinished says so. Send + Done files the conversation even when the reply goes through on
a later start.

### The web works by keyboard, at zoom and in the dark theme
<!-- changes: fix-026-web-keyboard-zoom.md -->

- At phone width the closed navigation drawer is out of the Tab order, and its button says whether
  it is open. Open, it takes focus and keeps Tab inside until it closes.
- Sheets take focus, keep Tab inside and give focus back to what opened them: the Screening sheet,
  the letter sheet on a phone and the command palette. Escape out of Search returns to where it was
  opened. A message's menus close when Tab leaves them, and the shortcut list scrolls by keyboard.
- Buttons are named by their words, with their shortcut stated beside them, and a message's subject
  is a heading. A notice is read out each time it appears, and the Undo button names its key, z.
- At 200 % zoom the page scrolls as one, so the message list gets the screen instead of a strip.
- Under the Auto theme in a dark system the sync strip's link reads as it does in Dark, and quiet
  text on raised surfaces in the dark theme is easier to read.
- On touch screens, the More and message menus, a folder's controls, the Rules filters and the
  Settings sections are 44 px to press.
- Settings → Devices asks for the second factor once per action.

### Download all saves what it lists, and a found message's files show at once
<!-- changes: fix-026-files-everywhere.md -->

- Download all on a message opened outside the Ohbox could let go of the list it was saving, save
  nothing and say the files could not be fetched. It saves every file it lists.
- A message opened while a long conversation's files are still loading lists its own files first.
- On the phone, a message whose PDF the message itself displays lists that PDF.
- On touch screens the Download button on a file is 44 px to press.

### A computer switched off mid-import loses about the last second of it
<!-- changes: fix-026-store-flush-clock.md -->

While a first import runs, the app's copy of your mailbox commits without waiting for the disk and
writes that record out on its own once a second, so a computer that loses power mid-import loses
about the last second of the import, a few seconds when the copy is busy, and the next launch
fetches it again from the mailbox. It used to depend on how the import happened to commit. One
message's commit also holds the copy for less time while the search indexes catch up, so a list or
a search opened during a large import waits less, and the copy's change log is compacted once an
hour, so it stays the size of the mailbox rather than of its history.

### A message too large to download is listed, and says so
<!-- changes: fix-026-too-large-shown.md -->

A message larger than 64 MB, which ohmail does not download, is now in the list with its sender,
subject and date, and can be found, moved, flagged and deleted like any other. Opening it says it is
too large to download and to open it in your mail provider. Messages an earlier version skipped for
their size appear after the update.

### A mail server on your own network connects without TLS, with your consent for each half
<!-- changes: fix-026-selfhost-says.md -->

A mail server on your own network that offers no encryption can now be connected: the mailbox step
in setup and Settings → Mailboxes each show "Incoming mail (IMAP) without encryption" and "Outgoing
mail (SMTP) without encryption" for the half that refused, and each is consented on its own. A
server that is not on your own network is still refused, and the refusal says why; this also applies
on ohmail Cloud, where no such server is offered a plaintext connection any more. A mailbox already
connected this way keeps working. On a self-hosted server a refusal names what its operator can
change: TF_PROBE_ALLOW_PRIVATE=1 for a mail server on the local network, NODE_EXTRA_CA_CERTS for a
certificate from a private authority, and a port written after the server name, as
mail.example.com:1143. The sync strip's "Settings → Mailboxes" link opens Mailboxes. Setup no longer
says it creates an Ohbox folder: the Ohbox is the Inbox. A self-hosted server with no AI model no
longer offers AI in setup, and Suggest says no model is connected. Test connection asks for the
second factor in place when the confirmation window has closed. OHMAIL_MAIL_UI_PORT moves the
bundled mail sink's port for a second stack on one box.

### A reply draft opens where you can finish it
<!-- changes: fix-026-reply-draft-editor.md -->

Opening a reply draft from Drafts shows its conversation with the draft in the reply editor, ready
to type, and the window no longer shifts up. A reply refused for good keeps one draft instead of one
per attempt. A letter opened in History, Answer Later, Trash, a folder, a tag, News or Receipts is
in the address, so a reload reopens it and Back closes it. On a phone the list of rules scrolls with
the page. A decision taken in the sender sheet about someone in the Screener can be undone, like one
taken from the list.

### German screens say it in German
<!-- changes: fix-026-german.md -->

With the language set to Deutsch, the sentences ohmail writes itself (a connection that could not
be made, a passkey prompt that was closed) are German, as are the Screener's Spam-Ordner, the Stil
and Version labels, the default name of a desktop that paired without one, the phone's own name
and its Einordnen action. Every screen now addresses the reader as du. The keyboard hints under
the lists read whole in German, and the phone's Screener doorbell no longer says "Screener" twice.

### Answering the message you have open moves it to Earlier
<!-- changes: fix-026-an-answer-files-the-open-row.md -->

A reply, reply all or forward of the message you have open in the Ohbox now moves it to Earlier with your
answer as soon as the answer is sent; it no longer stays in New beside its own conversation until you move
on.

### Nothing tells you that you stopped organizing a mailbox the closure paused
<!-- changes: open-026-paid-reopens-b.md -->

While an account is closed, a mailbox ohmail paused reads "Paused while the account was closed —
organizing resumes on its own" on the web, the desktop and the phone. After you pay, the sync line
says it is catching up without a date from before the closure, a stale answer in that first minute
is not reported as a failed sync, and the catch-up note no longer lists mailboxes to start again.
The phone shows the catch-up note again.

### After you subscribe again, your mailboxes are organized again straight away
<!-- changes: open-026-paid-reopens.md -->

After you pay for a closed account, it opens as soon as you are back from the payment page, and
ohmail organizes your mailboxes again without a press on each one. A mailbox you had stopped
organizing yourself stays stopped, and one that another ohmail install took over while the account
was closed stays with it. The web app no longer says the subscription has ended right after you
pay, notifications turned back on after the payment are kept, and the catch-up note says since when
ohmail is catching up, without a count.

### Known issue — Android

Android builds up to 0.25.3 were made without two fixes this repository carries for the phone's TLS
transport and mail sender. On those builds an outgoing server on a STARTTLS port (587) does not
send, and adding a mailbox on port 143 fails and closes the app; implicit TLS on 465 and 993 works.
A valid certificate for a different name than the server's is accepted on those builds. The next
Android build carries both fixes. iOS and the desktop are not affected.

## [0.25.3] — 2026-09-27

### The desktop app recovers when its window stops
<!-- changes: fix-025-desktop-recovers.md -->

On Linux, focusing the New tag field with an accessibility tool could stop the window, which then
ignored every click until ohmail was relaunched. That field no longer does this, and a window that
stops is reloaded with a sentence saying so; if it stops again soon after, ohmail offers to
relaunch.

### The server does much less database work while nothing changes
<!-- changes: cloud-025-db-load.md -->

The Screener's automatic filing reads only the held mail that arrived or changed since its last
pass, and walks the whole queue at most hourly. `GET /consent` no longer computes per-sender counts
on every read; ask with `?counts=1` to get them. Marking many messages read costs the same few
statements for one message as for two hundred, a sync cycle writes a folder's cursor only when it
moved, and the stale-device alert costs the same for any number of devices and is logged once, not
on every pass.

### The phone names a mail server certificate it will not accept
<!-- changes: fix-025-phone-does-what-it-says.md -->

When the phone refuses a mail server's certificate, connecting stops with a sentence that says so,
before your password is sent. A mailbox whose certificate is refused later shows the same fact
instead of "Connection lost. Reconnecting…", and tries again the next time ohmail opens rather than
every few seconds.

### Closing the phone's composer keeps what you wrote
<!-- changes: fix-025-phone-does-what-it-says.md -->

Cancel, a tap beside the composer and the back gesture now keep your text as a draft before the
composer closes, with Undo on the confirmation to throw it away. A reply is kept under the message
it answers. Attachments are not kept in a draft, and a composer holding only files asks first.

### A Screener decision on the phone moves the older mail in your mailbox
<!-- changes: fix-025-phone-does-what-it-says.md -->

When you decide on a sender whose older mail is still in INBOX, the phone and the desktop's local
mode now move that mail on your mail server, so every mail app sees it in its new place.

### The phone's hand-back no longer fails on a dropped connection
<!-- changes: fix-025-phone-does-what-it-says.md -->

When the phone does not organize in the background (battery saver on, or notifications off), it
gives the mailbox back as it leaves the screen. When that had to wait until the app was open again,
it failed on a connection the mail server had dropped and your other computer waited about ten
minutes; it now goes over a fresh connection, and Settings says when it arrived late.

### Photos attach at the web's picture quality
<!-- changes: fix-025-phone-does-what-it-says.md -->

The phone makes JPEG and PNG pictures smaller before it checks the size limit, with the same
Picture quality levels as the web (Medium by default, in Settings). A picture that would not get
smaller is attached as it was, and Original never re-encodes.

### Renewing after a trial or a lapsed subscription takes you back to a working mailbox
<!-- changes: web-026-renew-flow.md -->

The account screen's Subscribe button now fetches a fresh link to your account page when pressed,
so it no longer lands on an expired link, and the page opens in your language. After signing in,
a closed account sees the account screen first rather than an empty Ohbox. Once the payment is
confirmed the screen lifts by itself, mail sync resumes where it stopped and the catch-up note
appears; the red "couldn't refresh" line no longer shows while the account is closed. Returning
from the payment page works whether or not the browser is still signed in.

### A sent message deleted in another mail app leaves ohmail
<!-- changes: fix-025-deleted-on-the-server-leaves-ohmail.md -->

A message you delete from Sent in another mail app now leaves History, Search and every device at
the next sync of that mailbox, as a deletion in any other folder does. Before, ohmail kept it.

### A removed mailbox's conversations leave every device
<!-- changes: fix-025-deleted-on-the-server-leaves-ohmail.md -->

When you remove or erase a mailbox, the conversations only that mailbox was in now also leave the
phone and desktop apps, not only the server. A conversation another mailbox is in stays.

### A computer that only reads a mailbox shows the organizer's arrangement
<!-- changes: fix-025-reader-shows-the-organizers-arrangement.md -->

When another install organizes a mailbox, a computer that only reads it now shows the Ohbox and the
Screener the way the organizer arranged them: a sender let in there is in the Ohbox here too, not
waiting in the Screener. The arrangement comes from the settings copy the reading computer refreshes
every few minutes, and it still moves and screens nothing itself.

### "Not now" keeps the settings saved in your mailbox
<!-- changes: fix-025-not-now-keeps-the-mailbox-settings.md -->

- "Not now" on "We found your ohmail settings on this mailbox" no longer lets this ohmail replace
  the settings another ohmail saved in the mailbox a few minutes later. They stay in the mailbox,
  and Settings → Mailboxes offers to import them or to save this ohmail's settings in their place.

### On the phone, the account screen lifts by itself once the account is open again
<!-- changes: mobile-026-renew-flow.md -->

The phone checks the account whenever you come back to the app and once a minute while the account
screen shows, and the screen goes away as soon as the account is active again, without signing in
again. After pairing, or when the account was closed at the last check, a closed account sees the
account screen before any mail list, and mail sync waits quietly instead of reporting a failure.

### ohmail unsubscribes you automatically only from senders you screened out
<!-- changes: fix-025-acts-only-on-what-you-asked.md -->

Mail that an import or the automatic filing placed in Screened or Spam no longer leads ohmail to
leave a mailing list on your behalf. Screening a sender out yourself still does, and the
Unsubscribe button still works on mail in Screened or Spam.

### The phone says when screening a sender out also unsubscribes you
<!-- changes: fix-025-acts-only-on-what-you-asked.md -->

Screening a sender out or marking them spam on the phone now says that ohmail is also unsubscribing
you, as the web does, whenever automatic unsubscribe is on.

### A rule's past mail is moved by the server, and mail you acted on stays put
<!-- changes: fix-025-acts-only-on-what-you-asked.md -->

Applying a new rule to mail already filed no longer moves up to 50 messages from the app at once.
The server moves the past mail and leaves alone messages you replied to, filed in another mail
app or set aside.

### An AI draft that cannot finish in time stops with a clear sentence
<!-- changes: fix-025-acts-only-on-what-you-asked.md -->

On a slow day a draft that could not be written in time now stops and says so, instead of running
out of time with no answer.

### Setup asks before it takes a mailbox over
<!-- changes: fix-025-takeover-setup-keeps-its-word.md -->

Setting up a mailbox that another computer organizes waits until it knows who organizes it, and
moves organizing here only after "Organize here instead". A Screener decision made before the
takeover lands is kept as a rule, and the last setup step says the takeover is under way.

### Mail over STARTTLS on the phone
<!-- changes: fix-025-phone-standalone-send-arrives.md -->

A mailbox reached over port 143 keeps syncing after its connection is secured, where it used to stop
after the first few kilobytes and show "Connection lost. Reconnecting…". A send whose outgoing
connection could not be secured, or whose sign-in was refused, now says which and can be sent again,
instead of "We couldn't confirm this send". Pressing Send over a send that could not be confirmed
says why nothing was sent a second time.

### A decision made where you read your mailbox reaches the install that organizes it
<!-- changes: fix-025-reader-decision-reaches-the-organizer.md -->

On a phone or a computer that reads a mailbox another install organizes, a Screener decision was
refused by the organizing install and nothing said so. It is now applied there, usually within a
few minutes. Until then the phone marks the sender as sent, and a refusal is shown with its reason.
A phone connecting to a mailbox another install organizes says at once that it reads it, stops
asking every minute to organize it, and no longer says in the composer that it organizes it.

### ohmail opens again after being closed while it set up a mailbox
<!-- changes: fix-025-early-kill-never-bricks-the-desktop.md -->

- Closing or losing ohmail in the first seconds after opening a mailbox could leave its copy of the
  mail on the computer half made, and ohmail could then not open on that computer at all. It now
  sets such a copy aside and makes a new one. When ohmail cannot open its copy for another reason,
  the window offers Start over on this computer instead of advice to restart that does not help.

### The phone says when it has no network, and catches up as soon as it is back
<!-- changes: fix-025-offline-and-rules-tell-the-truth.md -->

With no network, the phone's top line says so, a pull-down says so instead of doing nothing, and
search and History say the phone is offline rather than blaming the server. When the network
returns, the phone fetches new mail at once instead of after up to a minute.

### Changing a rule lists every place, and says what happens to the mail already filed
<!-- changes: fix-025-offline-and-rules-tell-the-truth.md -->

Settings → Rules → Change now lists every place a rule can file into, with the current one marked,
so a rule changed away from Screened out can be set back. It asks whether to move the mail already
filed, says how many messages match before you choose, and names what moves afterwards, with Undo.

### On the phone, a Move says when it decides where a sender's mail goes, and Undo takes back both
<!-- changes: fix-025-phone-move-says-it-decides-the-sender.md -->

Moving a message on the phone also changes where that sender's future mail goes. The toast now says
so, as the web app does, and Undo takes back the move and the sender's rule together for as long as
the toast offers it. Moving one message no longer also moves the sender's other mail already in that
place. A move that changes no rule still says only where the message went. Android and iOS.

### An open History shows new mail
<!-- changes: fix-025-open-history-shows-new-mail.md -->

- History left open now shows mail as it arrives, within one sync, on the web, the desktop app and
  the phone. The message you are reading and your place in the list stay where they are; new mail
  appears above.

### The staff-role hardening script can be run again
<!-- changes: cloud-025-admin-console-works.md -->

On a database an earlier version of `scripts/harden-staff-role.sql` provisioned, a rerun stopped at
the script's own check of the `admin` schema. It now drops the view that version created and
completes.

### Files are listed on a message wherever it is opened
<!-- changes: fix-025-every-file-is-shown.md -->

- A message with a plain-text body and a file showed no file when it was opened anywhere but the
  Ohbox: in the reader over History or Search, a folder, a tag or a pile. Every place a message
  opens now lists its files to look at or save, whatever the body's type. On the phone, a message
  opened from History or Search that is older than the mail kept on the phone lists its files too.

### The app says what happened
<!-- changes: fix-025-the-app-says-what-happened.md -->

Offline, the mail list says it cannot reach the mail server from the first minute, and Pull new mail
says so instead of spinning into silence. A download the desktop cannot save, and a computer whose
keyring is locked or missing, are said in plain words. A forward dates the original in the sender's
own time zone and language, and History counts its months by the calendar the dates on its rows are
read in.

### A message sent from the phone with no network waits, and goes once it is back
<!-- changes: fix-025-phone-offline-arrivals-are-filed.md -->

On a phone that organizes its own mailbox, Send with no network now says the message goes when
the network is back and sends it once the phone is online again, instead of failing without a
word and leaving another draft for every press. A message cancelled while it waits stays in Drafts.

### Files are shown on held mail and on every open card
<!-- changes: fix-025-files-on-every-card.md -->

- The Screener's preview of held mail and an open News or Receipts card now list the message's
  files to look at or save, whatever the body's type, so a receipt's PDF invoice is on the card.
  On the phone, the earlier messages of a conversation, the Screener's held mail and an open News
  card list their files too.

### Removing a mailbox leaves the other mailboxes as they were
<!-- changes: fix-025-removing-a-mailbox-keeps-the-others.md -->

Removing or erasing one of several mailboxes no longer leaves waiting senders missing from the
Screener of the mailboxes that stay, and the removed mailbox's settings card and its entry in
Settings → Mailboxes now go with it.

### Punctuated searches answer alike everywhere, and the closest words come sooner
<!-- changes: fix-025-search-hyphen-and-fallback.md -->

On a phone that keeps its mail on the device, a search holding an apostrophe, a colon, a bracket
or a word such as "the" or "not" now finds what ohmail Cloud finds for it. On ohmail Cloud and the
desktop, a search with no exact match reads its closest words in the same database request.

### A self-hosted server says only what it keeps after an account is deleted
<!-- changes: fix-025-self-host-says-only-what-it-keeps.md -->

On a self-hosted server, Settings → Account → Delete your account listed a billing row, a credit
ledger and a subscription record as kept, and the receipt said billing records were kept. A
self-hosted server has none of them. Both now name what it keeps: an account row with a random id
and no name, and until they expire, hashes of its sign-in tokens, so an app still signed in is told
the account is gone. The receipt's button reads Done instead of naming ohmail.app, and /join tells
a visitor who still needs an invite code to ask the person who runs the server.

### Security updates for the mail parser and the web pages
<!-- changes: cloud-025-dependency-advisories.md -->

- The mail parser is updated, so a message with a very long address list no longer holds up the
  server that reads it.
- A web page no longer accepts a request body: a request that could only reach the page framework's
  internal action decoder is refused before it is read.

### The Screener counts every waiting sender, however large the mailbox
<!-- changes: fix-025-screener-reads-the-store.md -->

The Screener's waiting senders and their count now come from the server's queue on every app, so
senders whose mail is older than what the device keeps are no longer missing and adding a second
mailbox no longer lowers the count; mail from someone you have written to shows in the Ohbox.

### New mail is filed without waiting for background work
<!-- changes: cloud-025-worker-tail-yields-to-new-mail.md -->

The server's per-account background passes run after each round of mailbox checks and give way
to a mailbox whose new-mail signal fired, so mail from a sender you already decided is filed within
seconds instead of after those passes finish.

### The phone answers for settings saved in the mailbox
<!-- changes: fix-025-phone-organizes-with-a-settings-document.md -->

- A phone organizing a mailbox that carries settings another ohmail saved there now shows "We found
  your ohmail settings on this mailbox" and lists a "Not now" in Settings, as the web and the
  desktop do; until you answer, it files no new sender into the Screener and saves none of its
  decisions to the mailbox.

### A found settings document no longer lets strangers past the Screener
<!-- changes: fix-025-held-routing-screens-strangers.md -->

- While "We found your ohmail settings on this mailbox" waits for an answer, a new sender those
  settings do not know is screened as usual. Mail from senders the settings let through stays
  where it arrived, and the card says so. Importing files the mail ohmail held in the Screener for
  the senders those settings screen out. Settings that already match this ohmail's own hold nothing.

### A change kept while Cloud is out of reach survives a power cut
<!-- changes: fix-025-review-0252-lows.md -->

A change the desktop keeps while ohmail Cloud cannot be reached is on the disk before the app
counts it as kept, so a power cut right after it no longer loses it.

### A code mail sent as HTML only is recognised again
<!-- changes: fix-025-review-0252-lows.md -->

A one-time code mail sent as HTML only, with the code in a table and nothing in its subject naming
it, is treated as sensitive again; a long document with a table of numbers still is not.

### The message you are reading keeps its place until you move on
<!-- changes: fix-025-a-read-row-stays-in-new.md -->

Opening an unread message in the Ohbox marks it read, and it now stays where it is in New while it
is open. It moves to Earlier, at its place by arrival, when you open another message, close it or
leave the Ohbox. It could leave New a moment after it was opened, while you were still reading it.
Mail read on another device still moves at once.

### Failed sign-ins lock the device that made them, not your account
<!-- changes: cloud-025-sec-code.md -->

Five wrong passwords now lock only the device they came from; many failures from devices that
never signed in to an address slow sign-in from new devices for a few minutes instead of locking
anybody out, and the devices you already use are never slowed. Wrong second-factor codes are
capped at twenty a day, and the account's owner gets an email when a lock is set. New passwords
are hashed at a higher cost, and older hashes are upgraded the next time you sign in.

### A paired device keeps the changes made while the computer is out of reach
<!-- changes: fix-025-paired-page-keeps-its-changes.md -->

A delete, move, read mark, draft or send made on a device paired to a desktop while that computer
cannot be reached is kept in the device's browser and sent once when the page next reaches it; a
change still waiting a day after it was made appears under unsaved changes.

### A phone started again shows its mail while it signs in
<!-- changes: fix-025-phone-shows-its-mail-at-once.md -->

On a phone that organizes its own mailbox, opening the app again showed a loading screen until it
had signed in to the mail server and finished a first pass. It now shows the mail it already holds
at once and signs in behind it; new mail follows within seconds. If the mail server refuses the
sign-in, the mail stays on screen and the phone says the sign-in was refused.

### Accepting a sender says how many of their messages are now there
<!-- changes: fix-025-the-count-is-what-you-gain.md -->

- Accepting a sender, from the Screener, the sender sheet or a selection, says how many of their
  messages are now in the place you chose, including mail that was already in your Inbox. It used
  to count only the messages that were moved.

### The demo's Earlier card describes the order read mail keeps
<!-- changes: fix-025-the-count-is-what-you-gain.md -->

- The landing page demo now says read mail sits under Earlier in the order it arrived.

### The app downloads less on every visit
<!-- changes: cloud-025-web-speed.md -->

A page of the app or a sign-in screen no longer carries the whole translation catalogue: it
carries the text its first screen shows, and the rest is a file your browser keeps until the
translations change. Pictures in a message you open again now come from your browser's cache for a
day instead of five minutes.

### Moving one letter leaves the sender's other mail where it is
<!-- changes: fix-025-self-host-move-and-resurface.md -->

Moving a single message to News or Receipts now moves only that message; the sender's other mail
stays in the Ohbox until it is moved, as the confirmation says.

### A refused decision says it was refused
<!-- changes: fix-025-self-host-move-and-resurface.md -->

When the server refuses a Screener decision, the app now says nothing moved and the sender is
still waiting, instead of confirming the move.

### b in the Resurface pile opens the chooser
<!-- changes: fix-025-self-host-move-and-resurface.md -->

Pressing b on a message waiting to resurface opens the same chooser as the Resurface button,
with Now first, instead of cancelling it.

### Move, Delete and Restore keys work in News, Receipts and Trash
<!-- changes: fix-025-self-host-move-and-resurface.md -->

In News and Receipts, m and d open Move and Delete on the card the cursor is on, and in Trash
⇧⌫ restores the selected message.

### A refused rule change says why
<!-- changes: fix-025-a-refused-revoke-says-why.md -->

On an install that only reads a mailbox nothing organizes, Revoke and Change on Settings → Rules
were refused with a notice that named no reason; the page now keeps the refusal with its reason and
what to do, and says so before the press while nothing organizes the mailbox.

### A Screener decision on a mailbox nothing organizes says so
<!-- changes: fix-025-a-refused-revoke-says-why.md -->

On an install that only reads a mailbox nothing organizes, a Screener decision said it was filed and
was refused a few seconds later; it now says at the press that nothing was filed and why, and a
decision the server refuses names the reason.

### A Screener row the phone holds no mail of can be decided
<!-- changes: fix-025-phone-screener-row-from-the-store-presses.md -->

- On a large mailbox the phone's Screener lists senders whose held mail is older than what the
  phone keeps; Let in and Screen out on such a sender now reach the server instead of saying the
  decision could not be saved.

### Your own mail leaves the Screener after a change of device
<!-- changes: fix-025-own-mail-never-at-the-phone-gate.md -->

- Mail from your own addresses that ohmail had filed into the Screener folder on another device or
  computer now moves back to your Inbox once this one organizes the mailbox.

### Signing out clears the browser's cache
<!-- changes: fix-025-sign-out-leaves-no-images.md -->

Signing out, deleting your account, or being signed out from another device now also clears this
site's pictures and files from the browser's cache, in browsers that support it.

### z undoes a Screener decision
<!-- changes: fix-025-z-undoes-the-screener-decision.md -->

Pressing z while a toast offers Undo takes back that act, as the Undo button does: a Screener
decision, a pile, a delete or a restore is not sent, and a Move keeps no rule.

### The found-settings card appears as soon as ohmail finds the settings
<!-- changes: fix-025-the-settings-card-shows-at-the-find.md -->

- "We found your ohmail settings on this mailbox" now appears on the web, the desktop and the
  phone within one sync of ohmail finding the document, instead of up to ten minutes later.

### A press made as the web session renews is carried out
<!-- changes: fix-025-a-press-survives-the-renewal.md -->

A press made in the moment the web session's short access expired — Done, Park or any other mail
verb — was refused and never sent again once the session renewed, so the message stayed where it
was. It is now sent once more after the renewal, and applied once; if the renewal fails, the press
says it did not go through. Mail sync resumes at once after such a renewal instead of a minute
later.

### Search says what it covered while the first sync runs
<!-- changes: fix-025-search-during-the-first-sync-says-so.md -->

While a mailbox's first sync is still bringing mail in, a search result reads "Searched the mail
synced so far" and adds that the rest of the mail has not synced yet, and the closest-words note
says nothing synced so far matched exactly. Once the first sync has finished, the line reads
"Searched your whole mailbox" as before.

### Deleting your account clears this browser
<!-- changes: fix-025-erase-wipes-this-browser.md -->

Deleting your account now removes the copy of the mailbox this browser kept and shows the receipt,
and it no longer fails while the account's first sync is still storing mail.

### Move from the command palette
<!-- changes: fix-025-news-and-trash-keys-do-what-the-sheet-says.md -->

The command palette lists Move to another place wherever m moves a message. In Trash and the
Screener the shortcut list no longer asks you to select a message for keys that cannot work there.

### Tags on the phone
<!-- changes: fix-025-the-phone-shows-its-tags.md -->

The phone shows a message's tags on its row and in the open message, and More lists your tags,
each opening the mail that carries it.

### Search on the desktop answers a common word in milliseconds
<!-- changes: fix-025-desktop-search-within-the-budget.md -->

On a desktop that keeps its mailbox in its own store, the first page of results for a word found in
thousands of messages now comes back in tens of milliseconds, where it took a quarter to over half a
second on a large mailbox.

### A picture with a size in its address is shown
<!-- changes: fix-025-a-sized-picture-is-not-a-tracker.md -->

A picture whose address ends in a size, such as `?w=120`, was labelled "Tracker blocked" and could
not be loaded. An image now counts as a tracking pixel only when it declares itself 1×1 or 0×0,
when its address has a tracking path such as `/open`, or when its query names the recipient. The
web app, the desktop app, the phone and the image proxy decide it the same way.

### A phone's server settings are checked, and can be changed after connecting
<!-- changes: fix-025-phone-server-settings-are-checked-and-editable.md -->

- On a phone connected straight to its mail server, a port outside 1-65535 is refused at its field,
  and a port field selects its value when tapped, so typing replaces it.
- Connecting now also tries the outgoing server's sign-in, so a setting that cannot send is named at
  Connect instead of at the first message.
- Settings → Server settings changes the incoming and outgoing server, port, encryption and password
  in place. A change is tried before it is kept; a refused one keeps the working settings.

### A Screener decision writes the waiting mail it moves in sets
<!-- changes: fix-025-a-domain-decision-writes-in-batches.md -->

A Screener decision moved the sender's waiting mail one message at a time, about eleven database
statements for each message, inside one transaction that holds the account's other changes until it
ends. It now writes fifty messages at a time, so screening in or out a domain with a large backlog
finishes in a few statements for every fifty messages. On the web, the self-hosted server, the
desktop app and the phone.

### A machine that stopped organizing is not called out of date
<!-- changes: fix-025-a-stopped-organizer-is-not-called-outdated.md -->

On an install that only reads a mailbox, a refused rule change, move or Screener decision told you
to update ohmail on the machine that had organized it, even when that machine had stopped; it now
says nothing organizes the mailbox, and the advice to update is kept for a machine still organizing
it on an older version. Settings → Mailboxes on the web no longer says a machine that stopped holds
the mailbox, and Take over no longer promises that machine will stop.

### A change already sent is not offered again after a power cut
<!-- changes: fix-025-the-emptied-outbox-stays-empty.md -->

Once every change waiting on the desktop has been sent, a power cut right after no longer brings
them back to be offered again. On the phone, a change the app has kept is on the disk before it
counts as kept.

### A burst of new mail no longer stops the phone's sync
<!-- changes: fix-025-phone-survives-an-arrival-burst.md -->

- When thousands of messages arrive at once, a phone connected straight to its mail server brings
  them in page by page instead of failing the same sync over and over with no new mail.

### A machine that stopped organizing is not named as the organizer
<!-- changes: fix-025-every-reader-sentence-knows-the-holder-stopped.md -->

On an install that only reads a mailbox, the Screener's refusals and its Screened out and Spam
notes, the refusal of Delete, Later and Park, the sender sheet, the connect form, the desktop's
Settings and About rows, its Screener settings and its Mailboxes pane, and a paired phone's card
and More banner no longer name a machine that stopped organizing the mailbox as the one that
organizes it; they say nothing organizes it and point to Settings → Mailboxes.

### The phone says when a message could not be sent
<!-- changes: fix-025-phone-offline-send-says-so-and-keeps-one-copy.md -->

When the phone cannot reach your mail server, pressing Send now says in the composer that the
message was not sent and that it is kept in Drafts. Pressing Send again, or Cancel, keeps that one
draft instead of adding another copy of the message. While the connection is down the composer
shows the same connection line as the top of the screen.

### The read repair pass writes its letters in sets
<!-- changes: fix-025-bulk-read-writes-in-batches.md -->

The repair pass that marks old screened-out mail read wrote each letter alone, about six database
statements for each letter, inside one transaction that holds the account's other changes until it
ends. It now writes fifty at a time, a few statements for every fifty. Marking letters read clears
their resurface pins in one write. On the web, the self-hosted server, the desktop app and the
phone.

### A letter sent on Gmail is one message in Sent Mail
<!-- changes: fix-025-gmail-keeps-one-sent-copy.md -->

Gmail saves every sent message itself, and ohmail used to add a second copy beside it. ohmail now
uses the copy Gmail saved. Letters sent before this release keep their second copy.

### Search on a self-hosted server answers a common word in its budget
<!-- changes: fix-025-search-says-what-it-covered-and-stays-fast.md -->

On a self-hosted server, the first page for a word found in many messages comes back in tens of
milliseconds again. During a mailbox's first sync, the address view counts "the mail synced so far"
rather than the whole mailbox. Enter in the search field asks at once instead of waiting out the
typing delay, and "about N matched" never names more messages than the mailbox holds.

### A deleted account leaves no copy on your other devices
<!-- changes: fix-025-an-erased-account-leaves-no-copy-anywhere.md -->

When an account is deleted — from another browser, or by its scheduled erasure — every browser,
desktop and phone that held it now removes its copy of the mail at its next contact with the
server and says the account was deleted. The mailbox on your mail server is untouched, and another
account's copy on the same device is kept.

### Self-hosted upgrades: the log says what migrated, and page loads wait through the swap
<!-- changes: fix-025-a-self-host-upgrade-says-what-it-did.md -->

After an upgrade, the api's boot lines name the migrations that start applied, the count the release
expects and each setup step, where before they showed only the total. While `docker compose up -d`
replaces the api or web container, page loads and other reads wait up to 10 seconds for it instead
of failing with 502; a form sent in that moment still gets a 502 at once and is never sent twice.

### Escape closes the reply editor again
<!-- changes: fix-025-escape-closes-the-reply-again.md -->

- Escape in the reply editor or in the body of a new message closes it again, as it did before
  0.25.1: an empty reply closes, and a written one closes and keeps its text. Escape in the address
  suggestions still closes only the suggestions.

### A screen that failed to load can be tried again
<!-- changes: fix-025-escape-closes-the-reply-again.md -->

- When Settings, a new message or the message editor fails to load, it says so and offers Try
  again, and opening it again tries again, instead of showing the same error until a reload.

### One press changes the language, and the 60-day default stays choosable
<!-- changes: fix-025-the-language-and-quiet-window-take-at-once.md -->

Choosing a language in Settings now switches the app at once and holds after a reload, in the
browser and on the desktop. The Screener's "When a sender goes quiet" setting always offers the
60-day default, marked as the default, after you have picked another number.

### Send says when your mail server could not be reached
<!-- changes: fix-025-a-send-outage-is-not-a-server-error.md -->

When your mail server cannot be reached while sending, the send stops at once, says the message
was not sent because your mail server could not be reached, and keeps the draft. It used to fail
with a server error after trying twice.

### On a phone, the last Screener decision returns to the list
<!-- changes: fix-025-last-decision-phone.md -->

Deciding the last waiting sender from the full-screen preview on a phone left a blank page that only
the system Back could leave. The preview now closes and the list shows that nobody is waiting. Undo
puts the sender back in the list.

### Importing saved settings finishes on a slow mail provider
<!-- changes: fix-025-import-settings-finishes-on-a-slow-provider.md -->

- On a slow mail provider, Import settings failed after 20 seconds and said "Try again." twice.
  It now finishes in the background: the card says it is importing, then shows what was
  imported, or why nothing was.

### Plain-text line breaks survive in every panel of a conversation
<!-- changes: fix-025-lines-in-threads-and-suggest-tells-the-truth.md -->

A plain-text letter's own line breaks — a signature, an address, a list — now show in every letter
of a conversation, not only the one you opened, and in the Trash reader.

### The Screener says why no suggestion is coming
<!-- changes: fix-025-lines-in-threads-and-suggest-tells-the-truth.md -->

When a suggestion request is refused, the waiting senders say suggestions are not available and
why: no AI budget left, AI switched off, AI not answering, or the request refused. They no longer
say a suggestion is coming. A run that stopped at the number you confirmed no longer says
suggestions are unavailable.

### A one-click unsubscribe the list refused no longer reads as done
<!-- changes: fix-025-a-refused-unsubscribe-says-so.md -->

- ohmail counts a one-click unsubscribe as done only when the list accepts it, for the Unsubscribe
  button and for the unsubscribe a screen-out sends. When the list refuses, the Screened-out preview
  says so and links to the sender's own unsubscribe page, and ohmail does not ask that list again.
  When the list cannot take the request, the preview says so and Unsubscribe can be pressed again.
  Before, both were recorded as sent and read "Already unsubscribed from this list."

### Saved settings travel on every mail server
<!-- changes: fix-025-settings-travel-on-every-provider.md -->

On servers such as Infomaniak a new computer or phone now finds the settings saved in the mailbox,
offers them for import and uses the newest copy. A large ohmail folder there is no longer read as
organized by nobody, and old acknowledgements in it are cleared again.

### The phone hands the mailbox back as it leaves the screen
<!-- changes: fix-025-the-phone-hands-back-when-it-leaves.md -->

When the phone does not organize in the background (notifications off, or battery saver on),
leaving the app during a sync now stops that sync at its next step and gives the mailbox back then,
so your other computer can take it. If Android freezes the app before that step, the mailbox goes
back when you return and the phone says it was late. Coming back shows "Handed back" until the
phone has taken the mailbox again. The Ohbox now says when the phone handed the mailbox back,
stopped organizing it, or another install organizes it, with "Start organizing here" where
Settings offers it.

### Sending says what your mail server refused
<!-- changes: fix-025-the-persons-server-refusing-is-not-our-fault.md -->

When your mail server refuses the sign-in, will not secure the connection, or cannot be reached
while sending, the send stops at once, says which it was, and keeps the draft. It used to fail
without saying why, or ask you to check your Sent folder for a message that never left.

### Keyboard focus follows what opens and closes
<!-- changes: fix-025-keyboard-focus.md -->

- The shortcut sheet and the screening sheet take focus when they open. Closing a sheet, the tag
  picker, the move bar or a new message, by Escape, by sending or by discarding, puts focus back on
  the message it was opened from, or on the next message when that one has left the list. Tab
  stays inside the shortcut sheet and the discard question, and Escape closes the confirm under a
  rule in Settings.

### The More menu shows which item has focus
<!-- changes: fix-025-keyboard-focus.md -->

- The focused item of a message's More menu is ringed in the theme's focus colour, visible in every
  theme.

### Address fields are named
<!-- changes: fix-025-keyboard-focus.md -->

- Screen readers announce the To, Cc and Bcc fields by name in a new message and in a reply.

### Alerts close by themselves when nothing confirms them, and a sampled 5xx window no longer clears one
<!-- changes: maturity-026-m4a-alerts.md -->

An alert that no pass has confirmed for thirty minutes now closes without a "resolved" notice, so an
alert for a shard or a driver that no longer exists does not stay open until someone removes it. A
5xx window the platform poller could only sample no longer clears an open 5xx alert. An alert driver
that has never recorded a pass is reported once the worker has been up for thirty minutes, where the
deployment runs that driver.

### The Screener and Settings → Rules fit a phone
<!-- changes: fix-025-screener-rules-phone.md -->

On a touch screen a tap anywhere on a waiting Screener row opens the letter's preview, and the
sender's screening sheet opens from the sender's name there; a sheet that fills the screen has a
close button. At phone width the row's subject gets the room, the delivered-to chip names the
mailbox briefly, and each rule shows its whole address above Change and Revoke. On a touch-only
screen buttons no longer wear keyboard shortcuts, and the composer's and the palette's key hints
are gone.

### What you type in the composer survives every way out of it
<!-- changes: fix-025-typed-text-survives.md -->

A message you were writing is kept when its tab closes before it is saved, and reaches your drafts
the next time ohmail opens; a tab that crashed gives its message back and says so, and a duplicated
tab starts its own. The composer stays open over a message too long to save. A reply whose send is
refused after its message was deleted in another mail app is saved as a draft, and a change that
waited more than a day to be saved is listed instead of dropped.

### A self-hosted server no longer quotes AI credits or calls another server ohmail Cloud
<!-- changes: fix-025-public-copy-true.md -->

On a self-hosted server, in the desktop app on its own and on a paired computer, the draft offer,
the Screener's suggestion quote, the auto-suggest confirmation and its done line state no credits,
because nothing is charged there. A server that holds a mailbox is called another ohmail server,
and the desktop app names a self-hosted door your ohmail server in Settings → Desktop, About, the
sync line and the Screener's offline notes.

### The self-hosted compose file pulls the release it came with
<!-- changes: fix-025-public-copy-true.md -->

`deploy/selfhost/docker-compose.yml` defaults the three ohmail images to its own release instead of
`latest`, so a pull never mixes two releases. Set `OHMAIL_IMAGE_TAG` to pick another; updating is
`git pull`, then `docker compose pull && docker compose up -d`.

### The umbrelOS draft says it is out of date
<!-- changes: fix-025-public-copy-true.md -->

The umbrelOS package pins the 0.11.0 images and is not in any store. Its README and manifest now
say it needs a repin to the current release before a submission.

### A letter you sent to yourself and deleted elsewhere leaves the Ohbox
<!-- changes: fix-025-deleted-while-closed.md -->

A letter you sent to your own address and then deleted in another mail app now leaves the Ohbox,
its conversation and Search at the next sync, on every device. Before, ohmail kept the copy it had
seen in Sent.

### A move for a letter the server no longer holds
<!-- changes: fix-025-gone-letter-move-voided.md -->

A move or Delete pressed on a message another mail app had already removed now closes at the next
sync, where it used to stay "not filed" for ever. The not-filed warning counts only the messages
that have waited, under their own time, and no longer says the mail server refused a message nothing
refused. A conversation whose last message was deleted leaves every device.

### A server's "not now" is shown as a wait, and the desktop app re-dials when the network returns
<!-- changes: fix-025-sync-state.md -->

When a mail server throttles ohmail, or answers that it is temporarily unavailable or at its
connection limit, a mailbox organized on a server, Cloud or self-hosted, now says it is waiting
instead of showing an error. On the desktop and phone apps the same answer at sign-in no longer
stops the mailbox as if its password had been rejected. The desktop app re-dials a lost connection
as soon as the computer's network comes back, instead of waiting up to five minutes. A first import
that runs into one of ohmail's read limits no longer sends a sync-lag alert while the mailbox is
still being read.

### The Screener and the Ohbox agree about who you have decided on
<!-- changes: fix-025-screener-one-predicate.md -->

Somebody who joined a conversation you answered someone else in is now offered for screening in
the Ohbox. A rule saved with spaces around the address applies to new mail. Earlier no longer lists
mail you set aside, scheduled or brought back. The Screener places mail with no date by when it
arrived. A sender whose own provider reports the From address as forged is no longer suggested as
someone who writes to you.

### Load older mail appears only where there is older mail, and lists only what this device does not hold
<!-- changes: fix-025-windowed-client.md -->

"Load older mail" at the end of the Ohbox is offered only when the server holds mail this device
does not. The press starts below what the device holds and lists only mail the Ohbox itself would
show: nothing already listed above, nothing the Screener is holding for a first-time sender. Rows it
fetches can be dragged to the rail, and a selection holding them moves, deletes, tags and screens
them like any other row. A link to a message the device no longer keeps opens it. While a reopened
tab is still catching up, the rail shows no counts, and setup's summary says its counts are this
device's when the device does not hold the whole mailbox.

### A letter to yourself shows in the Ohbox
<!-- changes: fix-025-self-sent-ohbox.md -->

A letter you send to yourself is in INBOX and in Sent. ohmail sometimes kept only the Sent copy, so
the letter never arrived as new in the Ohbox and counted as read. The INBOX copy now always shows,
with its own read state, and letters already affected are corrected on the next sync.

### The found-settings card appears on a slow mail provider
<!-- changes: fix-025-settings-card-no-door-clock.md -->

- The card offering settings saved in a mailbox now appears on a mail provider too slow to answer
  within one request. It reads what the mailbox's organizer found, without reading the mailbox
  again.
- A mailbox removed from ohmail is no longer checked for saved settings.

### Checking a pairing link works from every door and refuses a used link first
<!-- changes: fix-025-pairing-undo.md -->

From a desktop that reads its own mail server, Settings → Switch → Another computer stopped at
Check the link with "not found". The check now works on either door. It also asks the other
computer whether the link is still good, so a link that was already used, has expired or was taken
back is refused at Check the link, before anything on this desktop is set up. The link itself is
still sent only once, when the pairing finishes. A computer running an older version of ohmail
cannot answer that question, and there such a link is still refused when the pairing finishes.

### Every answer from Check the link reads in your language
<!-- changes: fix-025-pairing-undo.md -->

A computer that did not answer in time, a certificate for another name or one this desktop does not
trust, a name the network does not know, and ohmail not yet set up on the other computer each have a
sentence in English and German. They showed in English on a German desktop.

### A pairing that does not finish turns hosting back on
<!-- changes: fix-025-pairing-undo.md -->

A desktop that serves your other devices stops doing so while a pairing is set up. When the other
computer refused, the pairing ran out of time or ohmail was closed mid-pairing, hosting stayed off
and the tailnet route was withdrawn. Both now come back with the desktop's connection, and start
at login does too when the other computer refused or the pairing ran out of time.

### A pairing that does not finish leaves the other computer's Devices list
<!-- changes: fix-025-pairing-undo.md -->

When a pairing the other computer had already answered was then undone, this desktop stayed on
that computer's Devices list. The desktop now signs the pairing out there before it goes back,
when that computer answers within a few seconds.

### Signing out closes every tab
<!-- changes: fix-025-sign-out-every-tab.md -->

Signing out or deleting your account in one tab now closes the mailbox in the browser's other
tabs at once. A tab that missed it checks with the server when you next look at it.

### Signing in ends the session the browser held before
<!-- changes: fix-025-session-jar.md -->

Signing in on a browser that still held another session ends that session in the same step: a
renewal of it that reaches the server afterwards is refused, and one still waiting for its answer
is dropped by the browser, so neither switches the browser back to the previous account. On the
desktop, a second sign-in pressed while one is still finishing waits for it instead of running
beside it. A browser left with only its resume marker stops passing through the resume screen on
every visit, and a desktop whose ohmail Cloud account was deleted is told so even after a lost
renewal answer. The account settings say their "this window is for another account" refusals in
your language, and stepping back while a password is being checked stays back.

### The no-AI Screening switch no longer files on a suggestion
<!-- changes: fix-025-no-ai-switch.md -->

Settings → Screening's "File obvious bulk out of my Screener for me" says deterministic rules only,
no AI, and it also filed a waiting sender whose stored suggestion was confident, into any pile,
Spam included. It now files plain newsletters and receipts only; a suggestion waits for your Apply.
Senders it already filed keep their rule in your rules list, where you can undo it. The desktop app
called the same switch "Act on suggestions for me"; it now carries the web's name and words.

## [0.25.2] — 2026-09-26

### The first read after a pause no longer waits on the account check
<!-- changes: fix-025-read-routes-keep-a-held-verdict.md -->

On a server that checks accounts with an entitlements program, such as ohmail Cloud, the first
request after a minute without one, often a search, waited for that check. A read now answers at
once on a check less than ten minutes old and renews it in the background. Anything that changes or
sends still waits for a current answer, and so does an account the last check refused.

### Mail from your own addresses stays in your Inbox
<!-- changes: fix-025-router-never-gates-own-mail.md -->

- Mail from one of your own addresses is no longer filed into the Screener folder, so other mail
  programs show it in your Inbox too. Mail ohmail filed there earlier moves back on the next sync,
  unless you moved it there yourself.

### A last visit or an "as of" more than a week ago shows its date
<!-- changes: fix-025-past-instant-labels.md -->

- The last-visit line in News and Receipts, the "As of" note while mail catches up and the
  phone's "since" note for a lost connection show the date for a time more than a week ago
  ("3 Aug, 18:40"). Before, they showed only a weekday, which read as this week's. Today's times
  show the clock alone.

### The held-mail offer stays dismissed until new held mail arrives
<!-- changes: fix-025-held-offer-lows.md -->

- "Not now" on the Screener's offer to release mail from senders you already decided about now
  holds until new mail from them is held. Filing, deleting or releasing some of the held mail no
  longer brings the offer back for the rest.
- When new mail from such a sender is held, the offer comes back on an open Screener with the
  sync that brought it, instead of at the next reload.

### Setup's first pull ends when the import does
<!-- changes: fix-025-selfhost-first-pull-ends.md -->

- After answering "No" to AI, the First pull step could keep saying it was reading the mailbox long
  after the import had finished. It now goes on to the first decision (or the summary) as soon as
  the import is done, and says so once everything the server counted is read. Its two counters no
  longer add up to more mail than the mailbox holds.
- When the web app renewed its session in the middle of reading History or searching, it said your
  server did not answer and showed only recent mail. It now asks again once the session is renewed.

### The web stays signed in across page loads
<!-- changes: fix-025-session-renews-before-expiry.md -->

- The web app renews its session before it expires even after a reload or in a new tab, instead
  of after a request was refused.
- On the phone, History and Search ask again once the session is renewed, instead of saying the
  server did not answer.

### Long lists count from their first row
<!-- changes: fix-025-list-window-lows.md -->

A long list under a note or a pinned group — History, Drafts, the Ohbox under Resurfaced — could
leave a blank band at its top or move the row you were reading when a row above it changed
height. Lists now count their rows from the first one, and a search hit under a tall Resurfaced
group opens on screen.

### Drafts draws only the rows on screen
<!-- changes: fix-025-list-window-lows.md -->

Drafts drew every draft and scheduled send at once; it now draws the rows on screen.

### The phone's History year strip reaches the year
<!-- changes: fix-025-list-window-lows.md -->

Pressing a year in History on the phone could stop at the last row drawn so far. It now lands on
that year's first message.

### Sign out works on a desktop whose sign-in has expired
<!-- changes: fix-025-expired-bearer-sign-out-opens.md -->

On a standalone install whose sign-in on this computer had expired, Sign out was refused along
with everything else, and only quitting the app got out of it. Sign out now works in that state
and removes the stored passwords as it always did. Everything else still asks for a sign-in.

### The sender sheet asks before a press over a rule of yours that disagrees

The sender sheet now lists Their rules: every rule that decides where this sender's mail goes, with
how many messages each one files. When their mail sits in two or three places, the sheet says how
many are where. Pressing a place that one of your rules disagrees with asks first. For a rule on one
subject of theirs: All their mail, which removes that rule, or Keep the split. For a rule on
everyone at their domain: Only this address, or change that rule for everyone. For a domain press
over people there who have rules of their own: keep their rules, or change them too. Enter takes
the answer already chosen and Escape goes back to the list.

A press on one address can be undone for a few seconds, and your rules are left as they were. Once
the answers are in, the sheet says how many of their messages are at the place, which ones stay
elsewhere and why, or that ohmail is still applying the rule to the rest of their mail — and, on web
and desktop, later that it has. A rule you changed in the meantime is left as it is, and the sheet
says so. Deciding a sender in the Screener now outranks a rule for their whole domain, as a press
from the sheet does. Web, desktop and phone.

### On Linux the desktop's mail engine uses less memory
<!-- changes: fix-025-engine-rss-at-boot.md -->

The mail engine starts about 90 MB lighter and peaks about 90 MB lower during the first
import of a mailbox.

### Search finds the start of a word wherever the whole word is found
<!-- changes: fix-025-part-word-budget.md -->

From its fourth letter, the start of a word now finds every message the whole word finds, bodies
included, on ohmail Cloud, on the desktop and on the phone. On a phone that keeps its mail on the
device, a search holding an apostrophe, a hyphen, a colon, a star or a lone quote mark no longer
fails.

### Setup names an organizer that stopped
<!-- changes: fix-025-stale-organizer-step.md -->

Setting up a mailbox whose previous organizer stopped checking in no longer promises a hand-over
from it. Setup says nothing organizes the mailbox now and offers to organize it here.

### A long document is no longer mistaken for a one-time code
<!-- changes: fix-025-otp-classifier.md -->

A tax return, an invoice or a contract that only mentions a code, a PIN or a confirmation is no
longer flagged as sensitive; mail that carries the code or the link still is.

### The desktop app opens without a flash
<!-- changes: fix-025-desktop-launch-pink-flash.md -->

On Linux the window showed a blank light surface for a moment before the app drew itself, and on
some machines that moment was pink. The window now opens on the app's own colours.

### Pictures on a paired phone come through the server's image proxy
<!-- changes: fix-025-privacy-claims-hold.md -->

After Show images, a phone paired with ohmail Cloud or a self-hosted server loads each picture
through that server, so the sender's server does not see the phone's address. A phone running on
its own fetches pictures itself and says so before you press. Settings on the desktop and the help
page now say that the desktop app fetches pictures from your computer.

### Removing a mailbox on the desktop deletes all of its rows
<!-- changes: fix-025-privacy-claims-hold.md -->

Removing a mailbox on the desktop now also deletes the conversations only that mailbox was in, with
their notes, its send records, its cached settings and its pending requests. A conversation another
mailbox is in stays. The same happens when Cloud erases a mailbox this computer mirrors.

### Changes made on the desktop while Cloud is unreachable are kept until they reach it
<!-- changes: fix-025-desktop-outbox-durable.md -->

A delete, move, read mark, draft or send made on a desktop signed in to ohmail Cloud while Cloud
cannot be reached is kept on the computer and sent at the next launch, once. A change still waiting
a day after it was made appears under unsaved changes.

### A Move made just before ohmail closed is no longer lost on the phone
<!-- changes: fix-025-phone-routing-window-durable.md -->

On the phone, Move, File and Junk wait a few seconds before they set where that sender's mail goes,
so the toast can offer Undo. The waiting press is now saved on the phone before Undo is offered. If
ohmail is closed or stops during those seconds, the next launch makes the move and says how many
messages it moved; a press older than a day is not made, and ohmail says so. Android and iOS.

## [0.25.1] — 2026-09-26

### A desktop left open for days keeps syncing
<!-- changes: fix-025-paired-desktop-open-past-a-day.md -->

The desktop app keeps syncing when it is left open for more than a day, whether it is paired with
ohmail Cloud or reads your own mail server. It used to stop after a day and ask to be reopened.

### A sender's message list names the rule that decides
<!-- changes: fix-025-low-rows-clients.md -->

The list of every message from a sender says, for each message, which of your rules files that
sender's mail where it sits. It named the newest rule pointing at the message's folder, even when a
different rule decides: with one rule letting a sender into the Inbox and a newer one screening them
out, an Inbox message from before the screen-out named the Inbox rule. It now names the rule ohmail
applies, and no rule when that rule files the mail somewhere else. Such a message now says that
no rule ohmail can see would file it where it is, rather than that no rule covers it.

### A phone control that cannot be pressed now dims
<!-- changes: fix-025-low-rows-clients.md -->

On the phone, the attachment buttons in a message, Try again and Discard under unsaved changes, the
wake-up distributor rows in Settings and the remove button on a compose attachment were already
announced as unavailable to a screen reader while busy, and kept their full look. They now dim the
way the other buttons do.

### Every pairing refusal is in your language
<!-- changes: fix-025-low-rows-clients.md -->

When you pair a desktop with another computer and it turns the pairing away for too many attempts,
the card said so in English on a German desktop. The same held for six rarer refusals: the other
computer naming no account, returning no session, and four this desktop gives itself before
anything is spent. Each now reads in English and German.

### Pressing Ohbox on a screened-out sender brings their mail back

A sender can have two rules: one letting them into the Ohbox and one screening them out. The
screen-out decides, so their mail was screened, and pressing Ohbox on the sender said a rule was
already sending their future mail there and changed nothing. Pressing a place on a sender now
changes the rule that decides: every rule for that sender pointing somewhere else moves to the
place you pressed, and the Rules page lists them all there. "Already" is said only when the rule
that decides already files their mail where you pressed. The web and desktop apps share the
change.

### The sender sheet shows where their mail is, and a decision overrides older rules

The sender sheet's "now in" line and its check mark named the folder a sender's mail is filed in.
A rule can show that mail somewhere else — a screen-out shows Inbox mail in Screened, a News rule
shows it in News, and a stranger's old read mail sits in History — and the sheet now names the
place the lists show it in. Deciding a sender in the Screener wrote a new rule beside the ones
already there, so an older screen-out kept deciding: their waiting mail went to the Ohbox and
their next message was screened. A decision now moves every rule for that sender to the place you
chose, and the list shows them there as soon as you press. The web, desktop and phone apps share
the change.

### A pairing another computer refuses leaves your desktop as it was
<!-- changes: fix-025-switched-door-restores-the-replaced-door.md -->

When a desktop that already reads your mail pairs with another computer from Settings, it keeps
its connection and its copy of your mail until that computer accepts. If the other computer
refuses, the pairing runs out of time, or ohmail is closed mid-pairing, the desktop goes back to
the mailbox it showed, with the same copy. Until now the pairing replaced the connection before the
other computer answered and discarded the copy, and a refusal left the desktop showing "Not
paired".

### A retried workflow creation from a proposal returns its first answer
<!-- changes: fix-025-low-rows-server.md -->

- `POST /workflows` with `fromProposalId` now stores its answer under the request's
  `Idempotency-Key`, so a retry after a lost response returns the workflow it created instead of
  404.

### The first page of a broad search on ohmail Cloud comes back sooner
<!-- changes: search-025-server-budget.md -->

A search for a word in many messages no longer waits, before its first page, on the database's
estimate of how many match. The count that follows the page still says about how many, then the
exact number.

### Switching views is quick on large mailboxes
<!-- changes: fix-025-desktop-view-switch-renderer.md -->

Switching between the Ohbox, the Screener and History no longer waits on the size of the
mailbox. The Screener, tags and triage piles draw only the rows on screen, as the Ohbox and
History already did.

### Long lists scroll by exactly what you scroll
<!-- changes: fix-025-list-window-below-500.md -->

News and Receipts measure every row they draw, as the Ohbox has since 0.19.3, so a list of more
than 500 rows with and without a preview line no longer moves its rows faster than the scroll.
A list of a few hundred rows now mounts only the rows on screen, so switching to it is quicker.

### Screen readers hear how long a list is
<!-- changes: fix-025-list-window-size.md -->

A list of more than 50 rows draws only the rows on screen, and a screen reader counted only
those: a long Ohbox was announced as a list of a dozen or so rows, and a row's position as its
place among them. Every list now states its full length and each row's position in it — the
Ohbox, News, Receipts, folders, Trash, Rules, History, Search, the triage piles, tags and the
Screener. Reading a list line by line and the browser's find-in-page still reach only the rows
on screen.

### The desktop's first import makes far fewer file-system calls
<!-- changes: fix-025-engine-file-ops-per-message.md -->

- The desktop engine's local database no longer opens and truncates files in its data folder for
  every request it answers, so importing mail spends less processor time per message.

### The desktop's first import plans its database statements once
<!-- changes: fix-025-pglite-plans-size-once.md -->

- The desktop engine's local database keeps the plan of each statement an import repeats instead of
  working it out again for every message, so a first import makes fewer file-system calls and spends
  less processor time per message.

### The desktop engine's check for mail deleted on the server reads the mailbox once
<!-- changes: fix-025-orphan-scan-sizes-once.md -->

- The engine's check for messages the server no longer holds looked up every stored message on its
  own on every sync, and on the desktop each lookup measured a table on disk again. It now reads the
  mailbox's messages and their server copies in one pass, so a first import makes fewer file-system
  calls and each sync spends less time on the check.

### Pressing a year in History opens that year
<!-- changes: fix-025-history-rail-year.md -->

On a mailbox spanning several years, a year press in History's rail opened the newer year beside
it, so the oldest months were out of the rail's reach. A year or month press now puts that
period's first message at the top of the list and lists that year's months.

### Opening a message marks it read everywhere, even if you close the tab right after
<!-- changes: fix-025-open-saves-the-read.md -->

A message you open in the Ohbox, or rest on for two seconds in the split view, is saved as read at that
moment. The read used to be sent only when you opened another message, so the unread count and your
other devices kept it unread, and a reload or a closed tab lost it. The message keeps its place in the
list until you move on.

### Escape in the address suggestions closes the suggestions, not the message
<!-- changes: fix-025-escape-in-recipients.md -->

With the address suggestions open, Escape closes the suggestions and leaves the message open; the
next Escape closes it and keeps the draft. Escape in the link box closes only the link box, and ⌘K
in the message body opens it without the command palette.

### Search's empty state reads as separate sentences
<!-- changes: fix-025-search-empty-state-sentences.md -->

- When a search finds nothing, the note that search does not reach your mail server's own junk
  folder stands on its own line, and a screen reader reads it apart from the result line. On the
  web and the desktop apps.
- On a desktop paired with ohmail Cloud, a search answered by this computer's copy while Cloud
  cannot be reached no longer says that older mail is still being indexed.
- The desktop's View menu calls the Ctrl+2 view News, as the app does.

### The phone stays signed in through a Wi-Fi sign-in page or a blocked network
<!-- changes: fix-025-refresh-signs-out-only-on-a-refusal.md -->

The phone, and a browser paired with the desktop app, no longer sign out when a Wi-Fi sign-in
page, a firewall or a proxy answers while the session renews. They keep the session and try again;
only a refusal from the server signs them out.

### Editing a rule made before the News rename no longer moves it
<!-- changes: fix-025-server-lows.md -->

Rules made before News was renamed from Reads counted as moved when an edit named the same
folder, so the rule was renamed and the mail it had already filed was queued to be sorted again.
The rule keeps its folder now, and its earlier mail is sorted again only when you ask for that.

### The browser stays signed in when a proxy answers a session renewal
<!-- changes: fix-025-server-lows.md -->

A browser signed out when a proxy or a hosting platform in front of the server answered a
session renewal with an error code of its own. It keeps the session now and tries again; only the
server's refusal signs it out.

### The message list is no longer downloaded again on every sync
<!-- changes: fix-025-local-window-sync-410-loop.md -->

When the sync service refused to continue from the message list it had just sent, the app
discarded that list and downloaded it again on every sync. It now keeps the list it has and tries
a fresh one after a minute, then at longer intervals up to half an hour. On the desktop, the web
and the phone.

### A refused connection is said next to the Connect button
<!-- changes: fix-025-connect-refusal-where-the-press-was.md -->

When a mailbox cannot be connected during setup, the reason appears beside the Connect button
and takes focus, instead of at the top of a form that has scrolled away. The desktop's own-server
door does the same. A refused connection no longer asks you to check a port or a server the form
has no field for.

### An idle account no longer makes the app download its message list again
<!-- changes: fix-025-prune-keeps-the-newest-change.md -->

On an account with no new mail for a while, the server's clean-up of old sync history could
remove its newest entry, and every sync after that was refused until something in the mailbox
changed. The clean-up keeps that entry now, and an account it already reached recovers on its
next sync without anything to run. On the web, the desktop paired with a server and the phone.

### Rules that file into News are one place
<!-- changes: fix-025-one-news-chip-and-the-phone-history-chip.md -->

Rules made before News was renamed from Reads showed under a second News chip in Settings > Rules,
and Revoke all covered only one of them. They are one chip now. Screening a sender into News no
longer rewrites or duplicates a rule that already files them there.

### The phone's History shows each message's folder
<!-- changes: fix-025-one-news-chip-and-the-phone-history-chip.md -->

History on the phone cut the folder chip under each row to a sliver, and Search cut a result's
badge line the same way. The rows now make room for everything in them, so both read whole at any
text size.

### The phone's About says what the app does
<!-- changes: fix-025-phone-lows.md -->

About said writing a new message would come with a later update; it has shipped. On a phone that organizes its own
mailbox, About no longer says it is paired.

### No endless indexing sentence on the phone
<!-- changes: fix-025-phone-lows.md -->

A phone that organizes its own mailbox showed "Older mail is still being indexed" under every search, with a figure
that never moved. Its search finds all of the mailbox without that index, and the sentence is gone.

### History rows keep their own height on the phone
<!-- changes: fix-025-phone-lows.md -->

One History or Search row whose badges wrapped to a second line made every row taller. Each row now takes its own
height.

### Settings names who files each mailbox
<!-- changes: fix-025-mailboxes-pane.md -->

On the web, Settings → Mailboxes said "This computer files this mailbox" about a mailbox ohmail
Cloud organizes, which read as if closing the browser stopped the filing. The organizing sentence
and the stop control's sentences now name ohmail Cloud, or this server on a self-hosted install. The
desktop app says "this computer" for the mailboxes it organizes itself, and names ohmail Cloud or
the computer it is paired with where those organize.

### A mailbox's message count leaves deleted mail out
<!-- changes: fix-025-mailboxes-pane.md -->

Settings → Mailboxes counted each mailbox's deleted messages too, so its figures added up to more
than History's "every message you own". The count now includes only the mail you have.

### A self-hosted install no longer calls itself ohmail Cloud
<!-- changes: fix-025-selfhost-says-this-server.md -->

On a self-hosted server, Settings → Mailboxes said "Cloud" about the server itself: "Cloud is not
organizing this mailbox, but its claim is still on it", "This takes Cloud's claim off the mailbox",
"Another ohmail Cloud install has claimed this mailbox" and "Take over on Cloud…" with its effect
and answers. Those sentences now name this server, or another ohmail server for a claim held
elsewhere. The desktop app heads a self-hosted server's mailboxes "Mailboxes on this server" and a
paired computer's "Mailboxes on" that computer's name; it said "Cloud mailboxes" for both.

### A self-hosted server's certificate authority is read from one file
<!-- changes: fix-025-operator-ca-one-folder.md -->

The desktop app reads your own server's root certificate from one file, `cloud-ca.pem` in its data
folder, both when it checks the address and when it connects. The address step of "Your own
server" shows the file's full path, and a certificate refusal names it. A copy in the folder the
address check used to read is still used for one more release.

### Signing in again works on a mailbox that was signed out
<!-- changes: fix-025-sign-in-again-stores-the-password-on-a-bare-mailbox.md -->

After signing out of a computer with several mailboxes and reconnecting only one, the others
asked for a password and refused it with "imap host is required". Signing out now keeps where
each mailbox's server is, never its password, so entering the password under Sign in again
connects that mailbox and it starts syncing. Signing out also removes the outgoing server's
stored password, which it used to leave behind.

### Signing in again works for mailboxes signed out on an earlier version
<!-- changes: fix-025-sign-in-again-after-an-earlier-sign-out.md -->

A mailbox signed out on an earlier version kept no record of its incoming server, and Sign in
again refused its password with "imap host is required". Sign in again now finds the server from
the provider the mailbox was added with, or from its outgoing server. Where neither says, it asks
for the incoming server once, with the username filled in. The outgoing server's password those
sign-outs left stored is removed when the app starts.

### Forward is always offered
<!-- changes: fix-025-forward-is-always-offered.md -->

Forward no longer disappears from a message. A message ohmail flagged as sensitive says why and asks
once before you forward it.

### The phone answers under the option you pressed
<!-- changes: fix-025-phone-door-answers-under-its-option.md -->

On the phone's first screen, the answer to ohmail Cloud or Your own server now appears under the
option you pressed, below a heading that names what the four choices are, and Forward on a message
opened from History or Search loads that message before the forward opens.

### Messages with many images open without a wait
<!-- changes: fix-025-access-check-one-call-per-account.md -->

On a server that checks accounts with an entitlements program, such as ohmail Cloud, opening a
message with many images asked once per image, and a slow answer held the images and the text for
several seconds. The requests now share one check.

### An account is erased only when the entitlements program confirms it
<!-- changes: fix-025-access-check-one-call-per-account.md -->

At the end of a closed account's retention, the server asks the entitlements program again and
erases only on its answer. If the program cannot be reached, nothing is erased and it asks again
on the next run.

### Account reminders wait for the entitlements program's answer
<!-- changes: fix-025-lifecycle-notices-on-a-real-answer.md -->

On a server that checks accounts with an entitlements program, such as ohmail Cloud, the reminders
about a trial ending, a closed account and an upcoming erasure could go out on the last answer the
server remembered while the program was unreachable. They are now sent only on the program's own
answer, and otherwise on the next run.

### Server alerts repeat less and leave closed accounts out
<!-- changes: fix-025-alerts-page-only-what-is-on-duty.md -->

A server's alert mail no longer counts mailboxes it deliberately does not sync, pages a standing
critical alert three times and then daily, pages again when the condition doubles, and sends one
mail when an alert that paged has stayed resolved for an hour.

### Your own mail stays out of the Screener
<!-- changes: fix-025-own-mail-never-in-the-screener.md -->

- Mail from one of your own addresses that sits in the Screener folder now shows in the Ohbox. The
  Screener no longer lists it or offers Allow and Screen out for it.
- A resurfaced message that sits in the Screener folder shows once, pinned in the Ohbox.

### Settings shows Folders only where your server keeps the setting
<!-- changes: fix-025-selfhost-settings-and-counts.md -->

On a self-hosted install, Settings → Folders offered a "Use folders" switch whose every press
answered "Couldn't save that — try again". The pane now appears only where the server keeps the
setting, in the browser and in the desktop app connected to a self-hosted server.

### The sent-mail review asks nothing when there is nobody to ask about
<!-- changes: fix-025-selfhost-settings-and-counts.md -->

Right after setup, "You've written to 0 people" no longer covers every view: the review steps aside
when nobody you have written to is waiting for a decision. "Not now" is remembered on this device,
and Settings → Screener → People you write to opens the review again.

### The Screener says where older mail from undecided senders is
<!-- changes: fix-025-selfhost-settings-and-counts.md -->

The Screener said "N messages in your Ohbox are from senders you have not decided about" while the
Ohbox listed none of them. It now says that mail is still in the Inbox on your mail server.

### Dismissing the held-mail offer reaches every device
<!-- changes: fix-025-held-offer-dismissal.md -->

"Not now" on the Screener's offer to release mail from senders you already decided about now hides
it on every device signed in to the account on its next sync. It used to stay on the others until
they were restarted.

### A resurface set for a later date shows that date
<!-- changes: fix-025-resurface-names-its-date.md -->

- The Resurface pile, its confirmations and the "Back …" note show the date and time of a
  resurface past this week ("25 Dec, 10:00") on the web, the desktop and the phone. Before, the web
  and the desktop showed only a weekday ("Fri 10:00"), which on that weekday read as the same day.
  Scheduled sends and the phone's away end date use the same labels.

### An open phone paired to ohmail Cloud keeps receiving mail
<!-- changes: fix-025-paired-phone-keeps-draining.md -->

- A phone paired to ohmail Cloud and left open now fetches new mail every few seconds without a
  pull-down, and fetches at once when you come back to the app. Nothing runs while the app is in the
  background. The top line says "catching up" only while it is fetching.

### The Screener shows a held message's full text on the desktop app too
<!-- changes: fix-025-screener-held-body-loads-on-the-local-door.md -->

- On a desktop app with a quiet mailbox, every held message in the Screener could say "Couldn't
  load the full message" while History showed the same message in full. The preview now shows the
  text as soon as it is read, and Retry shows its own attempt. A waiting sender's row is read out as
  unread while its held mail is.

### Screening a sender into the Ohbox moves every message the list shows, and says what stays
<!-- changes: fix-025-screen-to-ohbox.md -->

Screening a sender from the sender sheet with "Also move the mail already in your mailbox" now
reaches their mail still filed under the old News folder name, and the rule it writes for their
address is no longer outranked by a higher-priority rule for their whole domain. After the press the
sheet reads the list again. If a rule of yours still keeps some of their mail elsewhere — a rule for
one subject of theirs, say — it says how many are in the Ohbox and how many stay where, and offers
Remove that rule when the rule is about that address alone; a rule for everyone at their domain is
named instead. Mail that did not move gets Move them, which moves all of it. Web, desktop and phone
share the change.

## [0.25.0] — 2026-09-25

### Mail resumes promptly after a database outage
<!-- changes: fix-024-worker-resume-tail.md -->

After the database drops its connections, the worker and the server reconnect on their next
attempt once it answers again. Before, a connection cut while a statement was being sent could
wait out its 30-second connect timeout several times in a row, and new mail arrived minutes late.

### A confirmation is not replaced by the automatic suggestions' summary
<!-- changes: fix-024-toast-notice-queue.md -->

After a Screener decision or its Undo, the summary of automatic suggestions that arrives meanwhile
waits until the confirmation has been shown, then appears. On the web and the desktop apps.

### Screen readers hear the phone's buttons become available

On the phone, a button that becomes available now reads as available to a screen reader: Connect
on the mailbox form no longer says it is disabled once the address and password are filled in.

### The Screener shows a held message's full text instead of saying it could not load

On a busy desktop the Screener could say "Couldn't load the full message" for a held message
whose text was there, and keep saying it for the rest of the session unless you pressed Retry.
The held messages you are reading now load ahead of background work, a load that failed is tried
again when you come back to the sender, and Retry shows the new attempt instead of the old
failure.

### A sender's rules decide the same way in the organizer and in every app
<!-- changes: fix-024-desktop-web-parity-twins.md -->

When a sender has more than one rule, the organizer and the apps now pick the same one: the rule's
priority first, then how narrowly it names the sender, then a screen-out over an admission. A
sender you allowed by name is no longer screened out by a rule on their domain, and a sender with
both a screen-out and an admission shows where the organizer files their mail.

### The away responder's replies stay out of the desktop's Ohbox
<!-- changes: fix-024-desktop-web-parity-twins.md -->

On the desktop app paired to ohmail Cloud, the away responder's replies no longer show in the
Ohbox's Earlier list, as on the web; an installed desktop corrects itself on its next sync.

### The desktop renews its ohmail Cloud sign-in on schedule
<!-- changes: fix-024-cloud-session-followups.md -->

After you sign in, the desktop app renews its ohmail Cloud session before it lapses, whether or not
the window is doing anything. Until now the first renewal waited for a request to meet an expired
session.

### A paired desktop keeps its mail on screen when the other computer removes it
<!-- changes: fix-024-cloud-session-followups.md -->

When the computer a desktop is paired with removes it from its Devices list, the app shows a card
over the mail it already has: it names that computer, says the pairing has ended, and offers Pair
again and Set up on its own. The mail no longer disappears behind "ohmail cannot open your mailbox".

### A paired desktop names the computer it is paired with
<!-- changes: fix-024-cloud-session-followups.md -->

A desktop paired with another computer called it "sidecar" in the sync line, Settings, the away
responder and its cards. It now names the computer the pairing link pointed at.

### New mail arrives faster while the app is busy reading
<!-- changes: fix-024-loaded-ingest-share.md -->

With several windows open and reading the local mailbox, the desktop app's sync no longer hands the
store to a window each time it pauses between two messages, so new mail comes in faster while you
read.

### Releasing one sender keeps the rule for their domain
<!-- changes: fix-024-release-keeps-the-domain-rule.md -->

When a rule for a whole domain screened a sender out or marked them spam, Allow and Not spam
changed that rule and released everyone at the domain. They now allow that sender alone: the
domain rule stays and keeps screening everyone else there, and the notice names it. Back to
Waiting for such a sender is refused with a pointer to Settings → Rules. The same holds on the
phone, for Move as well.

### A freshly paired desktop shows your mail right away
<!-- changes: fix-024-fresh-pairing-opens.md -->

After you pair a desktop with another computer through "Another computer", the app opens the other
computer's mail as soon as the pairing finishes. Until now it stayed on "Opening your mailbox…"
until you quit it and opened it again.

### A restarted desktop renews its ohmail Cloud sign-in on time
<!-- changes: fix-024-fresh-pairing-opens.md -->

A desktop signed in to ohmail Cloud that you quit and open again renews its session before it
lapses, and right away when the saved session has already run out. Until now it waited for a
request to be refused first.

### Pairing a desktop keeps its card until the pairing answers
<!-- changes: fix-024-pairing-chooser-held.md -->

When you pair a new desktop with another computer, the "Pairing…" card stays on screen until that
computer answers. Your mail then opens, or the card says why the pairing was refused — a spent or
expired link, the other computer out of reach, or the other computer turning it down — with Try
again and Choose another way, and the desktop is left as it was before you pressed Pair. Until now
the card gave way to a loading screen after a few seconds, and a refused pairing ended on the
ohmail Cloud sign-in form.

### A repeated Screener suggestion request is never charged twice
<!-- changes: fix-024-suggest-key-before-spend.md -->

A retry of a Suggest press under the same request key used to run a purchase of its own when the
first was still working, and a different sender set under a used key was refused only after its
senders had been charged. The key is now taken before anything is bought: a different set is
refused with nothing spent, a retry of the same set buys nothing and gets the first request's
answer once it is ready, and a run that fails hands the key back so trying again works at once.

### An organizer that has lost its lease makes no further change, even in the middle of a batch
<!-- changes: fix-024-organizer-lease-per-write.md -->

The install organizing a mailbox now checks its claim immediately before every change it makes on
the mail server. One whose claim ran out while it was busy — a laptop that slept in the middle of a
batch — or that learned another install had taken the mailbox sends nothing more; the next scan
checks the claim again and carries on or hands over. A copy-then-delete move always finishes both
halves. The one-time Junk sweep stops at its next batch when "Use folders" is switched off.

### Search on a desktop paired with ohmail Cloud covers your whole mailbox
<!-- changes: fix-024-paired-search-whole-mailbox.md -->

On a desktop paired with ohmail Cloud, Search asks your account, so its results and its count cover
your whole mailbox as they do on the web. While ohmail Cloud cannot be reached, Search covers the
mail on this computer and says so.

### Requests on ohmail Cloud answer faster
<!-- changes: fix-024-api-statements-one-round-trip.md -->

The database statements the server issues with values in them now reach the database in one
round trip instead of two, so lists, message bodies, search and rules come back sooner. Measured
against the production database, a whole-mailbox search page's 95th percentile went from
129-172 ms to 101 ms.

### An invite stays redeemable when others sign up from the same network
<!-- changes: fix-024-invite-throttle-keeps-its-slots.md -->

With public signup on, signups without an invite and signups with one were counted together per
network address, so enough strangers signing up from the same office or shared connection could
leave an invited person refused with "Too many signups from this connection" until the window
passed. The two are now counted apart, and a refused attempt no longer counts at all.

### The desktop says when its ohmail Cloud account was deleted
<!-- changes: fix-024-erased-account-said-on-the-desktop.md -->

A desktop signed in to an ohmail Cloud account that was deleted now says so, stops asking the
server, and offers to set the computer up on its own. Before, it showed an empty mailbox or asked
to sign in again.

### A self-hosted server's Screener quote no longer shows the hosted service's price
<!-- changes: fix-024-ledger-pricing-out-of-the-engine.md -->

On a self-hosted server the Screener's suggestion quote no longer shows the hosted service's credit
price: nothing is metered there, so it reads 0 credits.

### The desktop app starts on Linux without a keyring service
<!-- changes: fix-025-key-file-fallback-when-the-store-cannot-open.md -->

On a Linux session with no Secret Service (no session bus, or a window manager with neither GNOME
Keyring nor KWallet running) the app stayed unconnected and its log read that the keystore could not
be opened. It now keeps this install's key in the `install-key` file beside its data and starts. A
locked keyring is not stepped around: the app says it is locked and asks you to unlock it. The log
names the store each start used, as `key source file` or `key source platform:secret-service`.

### Search on a paired desktop is quick while your mail is still arriving
<!-- changes: fix-025-paired-search-seconds-while-the-mirror-fills.md -->

On a desktop paired with ohmail Cloud, a search made right after signing in, while your mail is
still arriving on the computer, answers about as fast as one made afterwards. It used to take one
to two seconds.

### A mailbox handed to another install stays with it
<!-- changes: fix-025-lease-not-supplied-is-test-only.md -->

When another install takes over organizing a mailbox from the server, the server only reads it:
read marks made in the web app reach the mail server, the mailbox keeps updating, and the server
does not claim the mailbox back when the other install lets go.

### A mailbox taken over during a scan is not reported as failing
<!-- changes: fix-025-lease-not-supplied-is-test-only.md#2 -->

A mailbox another install takes over while the server is scanning it is no longer counted as a
failed scan.

### Switching off Use folders stops pending Not junk moves
<!-- changes: fix-025-lease-not-supplied-is-test-only.md#3 -->

Switching off "Use folders" for a mailbox now stops the pending "Not junk" moves at the next
message, even when some of them are already being moved.

### A desktop paired with ohmail Cloud files your mail by your rules again
<!-- changes: fix-025-paired-ohbox-keeps-rule-placement.md -->

- On a desktop paired with ohmail Cloud, mail from a sender you have a rule for is shown where the
  rule puts it even when the app has not yet read your screening settings. Before, a failed read
  showed every unread message in the Ohbox. The read is now retried.

### A rule for some of a sender's mail files only that mail
<!-- changes: fix-025-split-rule-places-only-its-subject.md -->

- A rule that files one subject of a sender elsewhere, or screens it out, now places only the
  messages with that subject. The sender's other mail stays where it was.

### Answer Later and Parked list messages in the same order on every device
<!-- changes: fix-025-triage-piles-one-order.md -->

- Answer Later and Parked list messages newest first on the web, the desktop and the phone, and Reply
  Run starts on the same message on each. Resurface lists messages by when they come back, soonest
  first. Before, each device could show a pile in a different order.

## [0.24.0] — 2026-09-24

### Delete, move and tag work on every message in History and Search
<!-- changes: archive-024-client-followups.md -->

A message you reach in History or Search can be deleted, moved and tagged like any other, however
old it is: it leaves or moves the moment you act and stays that way. A long Search keeps only the
pages near what is on screen and asks the rest again as you scroll back.

### History shows every message you own, and Search pages through your whole mailbox
<!-- changes: archive-024-client.md -->

History now lists every message you own, newest first, back to the first one — on the web, the
desktop and the phone. The months and years on the right jump anywhere in it, and any message in
it opens. Search shows one list: what the app already has appears at once and is
replaced by your whole mailbox's answer, scrolling loads more, the line under the box says how many
matched and how long it took, and while older mail is still being indexed it says how far along
that is. In this release, a desktop paired with ohmail Cloud searches the mail it keeps on the computer
rather than your whole mailbox.

### Search on the desktop answers in milliseconds, with the count right behind
<!-- changes: archive-024-desktop-search-budget.md -->

On a desktop that keeps its mailbox in its own store, the first page of search results comes back
in well under a tenth of a second, and the count and the filters beside it follow in a fraction of
a second. A store carried over from an earlier version is brought up to speed the first time it
opens.

### The desktop searches your whole mailbox from its own store, and indexes older mail while idle
<!-- changes: archive-024-desktop-store.md -->

On a desktop that organizes its own mailbox, Search and History now read the app's own store with
the same indexes as the server, so a word inside another word ("axa" in "myAXA") is found there
too and the first page of results is back in about a tenth of a second. Mail stored before this version is indexed in the
background while nobody is using the app and the computer is on power; Settings → Mailboxes shows
how far it has got, and search stays complete meanwhile.

### Search says how many messages match right after the first results
<!-- changes: archive-024-search-estimate-client.md -->

Search shows about how many messages match right after the first page of results, and the exact
count takes its place when it is ready. The filters beside the results arrive with the first count
and keep their order when the exact counts replace it.

### Search reaches every message you own, and History goes back to the first one
<!-- changes: archive-024-server.md -->

Search now finds a message by its body, its subject, its sender, its recipients and its
attachment names — including mail that arrived as HTML only — across your whole mailbox, and the
first page comes back in a fraction of a second however many messages contain the word. Every message you own
can now be listed from the server newest first, back to the first one, with a count for every
month to jump by.

For operators: the new search index is built from what the server already stores — no mailbox is
read again — and fills itself in the background after the upgrade, newest mail first; until it is
complete, search reads the older rows the way it did before. It takes about 7 KB per message,
of which about 5.8 KB comes back once the older body index is retired.

### Removing a mailbox can erase ohmail's copy of its mail
<!-- changes: erase-024-per-mailbox.md -->

Removing a mailbox now offers to erase ohmail's copy of its mail as well as keeping it. You type
the mailbox's address and confirm with your second factor; a large mailbox is erased in the
background while the list counts down, and your mail server keeps every message. The mailbox list
no longer shows the old rows while a change saves.

### On a desktop paired with ohmail Cloud, a change a slow server confirms shows at once
<!-- changes: stale-024-direct-writes-follow-pull.md -->

A change the server is slow to confirm, such as a scheduled send or a removed mailbox, now shows as
soon as this computer's copy has it, instead of at the window's next refresh.

### On a desktop paired with ohmail Cloud, every change shows at once and stays
<!-- changes: stale-024-write-through.md -->

A message you move or read, a tag, a rule, a draft you save or discard and a mailbox setting now
show when you change them in the desktop app paired with ohmail Cloud, and stay. A later change to
the same message, made on this computer or on another device, is no longer missed.

### History on a desktop paired with ohmail Cloud lists your whole mailbox
<!-- changes: fix-024-paired-desktop-timeline-route.md -->

On a desktop paired with ohmail Cloud, History asks your account for its pages, so it lists every
message you own, newest first, as it does on the web.

### Search pages on ohmail Cloud answer faster
<!-- changes: fix-024-search-page-one-round-trip.md -->

A page of search results and everything the list shows about each message are now read from the
database in one statement instead of one per table, and the count and facets share one
transaction with their settings. On ohmail Cloud, where every statement costs a trip to the
database, a whole-mailbox search page comes back in less than half the time it took.

## [0.23.2] — 2026-09-24

### The desktop's Ohbox matches the web's
<!-- changes: fix-0232-desktop-ohbox-news-rows.md -->

On the desktop app paired to ohmail Cloud, the Ohbox could show messages the web filed under
News or Receipts — notification mail from senders you had since decided about — and the counts
disagreed between the two. The desktop now files every sender's mail by the same decision the
web uses, and an installed desktop corrects itself on its next sync.

## [0.23.1] — 2026-09-24

### Drafts on the phone ask where you pressed, and a send we could not confirm says so plainly
<!-- changes: drafts-023-phone-drafts-parity.md -->

On the phone, Discard asks in the place you pressed it, and a message we could not confirm sending
says what is known and offers Send again or It was sent — dismiss.

### Set up a new computer by confirming in your browser — no address to type
<!-- changes: fix-023-first-cloud-door-no-address.md -->

On a fresh install, choose ohmail Cloud and press "Sign in with browser": confirm on ohmail.app and
the app opens your mail, with no address or code to type. The confirmation page shows which account
the computer is being signed in to. Signing in with a code is still there, under "Sign in with a
code instead".

### News no longer jumps while a card opens as you scroll
<!-- changes: fix-023-news-scroll-jump.md -->

Opening a card whose top has scrolled out of view keeps the card where you pressed it; before, it
was pushed up by its own length. Opening another card no longer shifts the one above it: that card
keeps its buttons until it leaves the screen. Receipts behaves the same way.

### Someone you wrote to is never treated as spam
<!-- changes: fix-023-screener-correspondent-unjunk.md -->

A person you have written to since you set up ohmail, or who answers a message you sent since
then, is let through to the Ohbox instead of waiting in the Screener, and "Act on suggestions for
me" never files them, whatever the suggestion says. A message you move out of Junk gets its full
text back with the move, and says it is loading until then rather than that your spam verdict
filed it.

### An Undo stays on screen for its whole window
<!-- changes: fix-023-toast-undo-kept.md -->

- After a Screener decision, a delete or any other act with **Undo**, a notice that arrives
  meanwhile — such as the automatic suggestions' summary — shows beneath the Undo instead of
  replacing it. On the web, the desktop apps and the phone.

### The sign-in card opens at once when ohmail Cloud signs the desktop out
<!-- changes: fix-0231-refused-session-card.md -->

When ohmail Cloud ends the desktop's session — the device was removed from another device, or a
security check signed it out — the app now opens the sign-in card within a second or two, over the
mail it already shows, and its first sentence says why. It no longer shows "Can't refresh.
Retrying." first, and no longer replaces the mail with "ohmail cannot open your mailbox".

## [0.23.0] — 2026-09-23

### Pressing send or retry after a lost answer replays the answer instead of doing the thing twice
<!-- changes: api-023-keyed-effects.md -->

A retried merge replays its answer instead of reporting that the conversations are gone; a workflow
undo refuses a run the automation is still applying rather than half-reversing it; a send whose
attachments are too large to carry inline presents its key before it re-uploads anything, so a
storage hiccup no longer looks like a message that never left; and a staged attachment now says
what its bytes are, which the send checks before the mail goes. Six creates that used to leave two
rows on a retry now replay the first one.

### Every sentence the app says about what you get is either true or gone
<!-- changes: claims-023-false-promises.md -->

The sign-in screen said an invite code was not needed even on a deployment that requires one, while
the page it links to said the opposite. Both now say what the deployment actually asks for.

A confirmed Screener run costs no more than the number you pressed. The price and the purchase are
two steps, and a sender could go back to costing money in between; the run stops at the figure you
confirmed and tells you which senders it did not reach.

The demo reaches the network zero times, including on a page served from cache. Six reads went out
before anything corrected it.

And the product has one name for what it meters: credits, everywhere, including the message you get
when they run out.

### The model you have is the model the settings show
<!-- changes: doors-023-provider-and-standalone.md -->

The desktop's AI settings and the engine now agree about whether a configured model is present: an
Ollama family name matches its installed tag on both sides, so a working configuration no longer
reads as *Choose a model*. When a key cannot reach one of the model ids this app ships as defaults,
the verification names the id and points at the list.

### A Microsoft sign-in that has started takes the form with it
<!-- changes: doors-023-provider-and-standalone.md#2 -->

The connect form goes when the device code appears, so a second press cannot start a second
sign-in. Cancelling or changing provider retires a sign-in that is still starting, and a ceremony
restored after a reload waits for the mailbox list rather than opening under a form in use.

### Screening a sender out unsubscribes on the standalone app
<!-- changes: doors-023-provider-and-standalone.md#3 -->

The standalone desktop app now sends the list's one-click unsubscribe on a screen-out, as the app
has always said it would, with the switch in Settings to turn it off. Nothing is sent for a mailbox
this install has not been allowed to organize.

### Discarding a draft happens where you pressed it, and a send we could not confirm says so plainly
<!-- changes: drafts-023-discard-and-delivery.md -->

Discarding a draft asks and acts in the row you pressed, a discarded draft stays gone, and a
message we could not confirm sending says so plainly — the app looks in your Sent folder itself for
a day and offers to send again.

### Composer: a space typed after a link no longer joins it, typing before a link never joins it, a web address before a full stop or comma is linked without the punctuation, inline code ends on a space and at a line break, arrow keys never type a space, and the toolbar lights exactly the marks the next letter carries.
<!-- changes: editor-023-slack-feel.md -->

A link ends where you stop typing it: the space after it, and everything after the space, is
plain, and a letter typed before a link stays outside it even at the start of a line. Inline code
behaves the same way at a space and at a line break, while bold, italic and strikethrough carry to
the next line. The link button opens the address dialog and lights only while it is open.

### Setup is about one mailbox at a time
<!-- changes: firstrun-023-per-mailbox-truth.md -->

Setting up a second mailbox showed the first one's numbers: the pull counters, the summary rows
and the first decision it offered were counted over everything this device holds. They are this
mailbox's now. Re-running setup for a mailbox that is no longer connected says so instead of
showing the first-time connect form, which would have set the whole install up again. Connecting a
mailbox while something else organizes your mail says at the door that it starts by reading, and
"Start over" in Add mailbox lands on the connect form rather than an intro screen whose one button
did nothing.

### No account is erased while the metering program states no start instant
<!-- changes: fix-023-epoch-belt-fails-closed.md -->

The nightly account pass now erases nothing when the metering program's start instant is missing
or unreadable. Before, a program that stated none was read as an older one and its erasure date
was acted on alone. A self-hosted install has no metering program and never reaches this pass.

### An install no longer stands itself down against its own renewed claim when two renewals land in the same instant or the clock steps back
<!-- changes: fix-023-lapse-arm-race.md -->

When two lease renewals of one install landed inside the same instant, or the computer's clock
was set back between two polls, the install could read its own previous claim as another copy of
itself, delete every claim it held and stop organizing — leaving the mailbox with no organizer
until somebody pressed again. The renewal now recognises the record it is replacing, and an
install that does lose the mailbox at that point leaves the winner's claim standing.

### On Android 12 and older, the phone no longer says notifications are off while it organizes
<!-- changes: fix-023-phone-notifications-below-api-33.md -->

Android 12 and older has no notification permission, and the app read it anyway: Settings said
notifications were off while organizing ran in the background, and starting organizing asked for
a permission those versions do not have. On those versions the app now reads its notification
setting, and it asks only on Android 13 and newer, where the system prompt exists.

### Search finds a word inside another word, and always says whether your whole mailbox was searched
<!-- changes: fix-023-search-verdict-and-substring.md -->

Searching for part of a word now finds it inside a subject or a sender's address — "axa" finds
"myAXA Portal" and mail from an axa address — and a phrase in quotes still matches only that
phrase. The first page of results comes from the server in milliseconds and the line under the
search box shows how long it took. That line always ends on one sentence: how many messages
matched in your whole mailbox, that nothing matched, or that your server did not answer and the
list shows what this device holds.

### A message you act on leaves the list at once and stays gone
<!-- changes: fix-023-stale-after-action.md -->

On the desktop app paired to ohmail Cloud, a message you sent back to a later day, let in or
screened out used to reappear in its old place for a few seconds before leaving for good. It now
leaves when you press and does not come back, unless the action is refused — then it returns and
the app says why.

### A self-hosted server answers a busy sign-in in five seconds
<!-- changes: fix-023-tier-reds.md -->

On a self-hosted server, the sign-in check and the session refresh now answer "retry shortly" after
five seconds when the database is busy, where they used to wait for as long as the work ahead of
them ran.

### Moving a message yourself teaches the rule that filed it, and being copied on a thread nobody answered no longer counts as knowing somebody
<!-- changes: learn-023-what-a-move-teaches.md -->

A message you move inside ohmail now corrects the rule that put it there, exactly as moving it in
another mail client always did — two corrections inside a fortnight switch that rule off, through
the counter that already existed. Three passes that used to leave a message alone because somebody
on its thread had heard from you now ask whether you answered THIS sender, and none of them counts
the away responder's automatic reply. Everyone you write to is added to your contacts at the send,
so their first answer is not held at the Screener. And a message whose own provider says the
sender address is forged can no longer become a correspondent on the strength of having arrived.

### Older messages you load behave like any other, and a press that moves many now reaches a mailbox another install organizes
<!-- changes: lists-023-older-rows-and-bulk.md -->

A message fetched by "Load older" in the Ohbox can be selected, opened, picked and acted on like
any row above it; before, it could only be looked at. A press that moves many messages at once —
undoing a workflow run, or the opt-in re-route of an imported mailbox — now travels to the install
that organizes the mailbox instead of being refused, as one record per message under one key, so
pressing it twice moves nothing twice.

### The mailbox row says what is true now: a stop you changed your mind about from another window stops reading Stopping, and the import card says what not answering costs
<!-- changes: organizer-023-what-the-pane-says.md -->

After you hand a mailbox back and then press "Organize here" on another computer or in another
window, this window's row no longer keeps reading Stopping until Settings is reopened; the note a
press leaves ends the moment the row answers. The confirm well under "Organize here" says that
confirming is what starts the pass. The card that offers settings found on the mailbox says what
happens while you leave it unanswered: the settings you make here stay here and do not travel with
the mailbox.

### A wrong setting is refused, and saved settings import back
<!-- changes: robust-023-config-and-concurrency.md -->

The worker refuses to start on a polling interval it cannot keep, naming the variable and the
range. Database setup stops if it loses the connection holding its migration lock, and builds the
fuzzy-search indexes without blocking writes. Saved settings fit the import on another computer:
past 20 000 screened senders or a rule count of 5 000, they carry the newest, automatic rules left out first.
Two browser tabs keep two separate messages in Compose.

### A Screener row says which of your addresses a stranger wrote to, and Power Through works through the mail the screen shows
<!-- changes: screener-023-the-screen-and-the-act.md -->

On an account with more than one mailbox, every waiting sender now carries the address they wrote
to, on the row and on the sheet where the decision is taken, and the sender's own display name
travels with it. Power Through walks the "New for you" group as the screen shows it: mail you have
put away, scheduled or resurfaced is no longer served or counted there, so the number on the
screen and the mail behind the button are the same set. Stamps on the Screener now read the way
stamps read everywhere else in the app.

### Sending is quicker, and a message scheduled for a date that does not exist is refused instead of sent on another day
<!-- changes: send-023-cold-dial-and-non-instants.md -->

The connection ohmail opens to put a copy of a sent message in your Sent folder is kept for the
next press instead of being opened again from nothing every time; on providers where opening it
was the slowest part of sending, the second and later sends in a row skip that wait. A scheduled
send is refused when its date does not exist (February 30) or names no time zone, rather than
being moved to a date and time you did not choose.

### A busy server is retried, not shown as a dead end
<!-- changes: sessions-023-db-busy-door.md -->

When the server's database is busy, the sign-in check and the session refresh stop waiting after
five seconds instead of fifteen and answer with a "retry shortly"; the browser's session cookies
are left exactly as they were.
Each server instance now holds up to four database connections instead of one, so requests that
arrive together are no longer queued behind a single connection. The page that links the desktop app
retries a busy answer on its own, shows "The server is busy — retrying in N s", and keeps its
button, where it used to stop on the server's message.

### The desktop stays signed in to ohmail Cloud
<!-- changes: sessions-023-desktop-cloud-durable.md -->

A firewall page, a busy server or a dropped connection while the desktop app renews its ohmail Cloud
session no longer signs it out. The app keeps showing the mail it has, says ohmail Cloud could not
be reached, and retries on its own. Only a refusal from ohmail Cloud ends the session, and the
sign-in form then says why. The session renews in the background before it lapses, and a computer
that could not save its sign-in keeps the one it has.

### Sign in on a new computer by confirming in your browser
<!-- changes: sessions-023-device-approval.md -->

"Sign in with browser" in the desktop app now opens ohmail.app on a page that names the computer
asking to be signed in, with the network it asked from, and one Confirm signs it in; the app
notices by itself, with no code to copy. On a desktop that was already set up for ohmail Cloud the
app no longer asks for your address either. If your last second-factor check is more than a few
minutes old, the page asks for one code or a passkey in place. "Not me" declines the request.
Requests last five minutes and work once. A busy server makes the page and the app wait and try
again rather than stop. The code you can type in is still there as the fallback.

### Staying signed in on the web no longer depends on a busy server
<!-- changes: sessions-023-web-durable.md -->

When the server is busy or a connection drops, ohmail.app keeps you signed in and tries again
instead of sending you to the sign-in form. When the form does appear, it says why.

## [0.22.1] — 2026-09-23

### In the admin console, clearing the Microsoft secret asks first and never discards a secret you just typed; a console page that fails to load says so instead of staying blank
<!-- changes: admin-023-console-truth.md -->

"Clear the secret" now arms on the first press and clears on a confirmation that names what it
costs, and it is refused outright while the secret field holds a replacement. Every console page
is served with one line naming the build it is loading and what to do if the line is still there
after a reload; the line goes when the console's first read answers, so a page that never renders
cannot look like a page with nothing to show.

### The desktop's own door
<!-- changes: desktop-023-local-door-truth.md -->

"Test connection" now checks the outgoing server as well as the incoming one and says what each
answered, so a mailbox that is about to be refused for sending says so at the test, by name,
instead of at the connect. A mailbox with no outgoing server set up is still a good answer and is
stated as one.

### Turning off same-network access keeps the port
<!-- changes: desktop-023-stand-down-port-and-build-sha.md -->

Turning off same-network access keeps the port until you turn it back on, so nothing else can be
published on it; the app and its mail engine are checked to be the same build.

### A signed-out tab stops hammering the server
<!-- changes: fix-0221-dead-session-and-attachment-reask.md -->

A tab whose session has ended stops asking the server for anything until it has a session again,
and picks up on its own within five minutes of you signing in. Before, it kept polling several
times a second for as long as it was open.

### Files that failed to load are asked for again
<!-- changes: fix-0221-dead-session-and-attachment-reask.md#2 -->

A message's file list that failed to load is asked for again when you reopen the message. A list
the server answered for good — a message that is not yours, or no longer exists — keeps that
answer instead of being asked for on every open.

### The phone's Servers screen, message bar and mail rows
<!-- changes: fix-0221-phone-rows.md -->

- The **Servers** screen always has a way back. With no server paired it could be left with no
  Back and no tabs, and only restarting the app got you off it. It now returns to your mailbox,
  or to the start screen when nothing is paired.
- The verbs under an open message stand on **one row**. They used to wrap onto a second row that
  covered the message; what does not fit is under **⋯**, one press away.
- A mail row offers **Done, Later and Junk** to VoiceOver and TalkBack, so the verbs behind the
  swipe can be reached without opening the message.

### On the phone, an error on one screen no longer closes the app
<!-- changes: fix-0221-render-error-boundary.md -->

- The screen says so and can be retried.

### A row's actions no longer sit on the row
<!-- changes: fix-0221-resurfaced-done-overlap.md -->

Hovering a Resurfaced row shows a Done action, and it was drawn over the end of the subject and
over the row's attachment mark. It now stands in a slot of its own at the end of the row: the
subject shortens before the slot, hovering moves nothing, and the keyboard reaches the action
exactly as before, and the row's own highlight reaches under the slot so the action stands on the
row rather than beside it. The Screener's accept and file controls moved with it.

### Obvious spam is filed for you the moment it is recognised, when you have asked for that
<!-- changes: fix-0221-screener-auto-act.md -->

With Settings → Screener's "Act on suggestions for me" on, a waiting sender whose suggestion is
confident is filed through the same door the Apply button uses: the sender leaves the Screener,
the rule appears in your rules list to undo, and nothing changes for an account that has not asked
for it. It runs on the hosted service and on an install that organizes its own mailbox.

### On iPhone, the app's diagnostics reach the system log, so a shipped build can be read
<!-- changes: fix-023-ios-engine-log-sink.md -->

The app writes each of its diagnostic lines to the system log under its own subsystem
(`app.ohmail.engine`), so a released build on a device or a simulator can be read with the
platform's own log tools. Until now those lines existed only in a development build's terminal: a
released iPhone build wrote nothing anybody could read, which is why an iPhone problem could only
ever be described rather than shown. On Android the lines carry the tag `ohmail.engine`.

### An account is never erased on a date the metering program worked out before it knew about it
<!-- changes: fix-023-lifecycle-epoch-floor.md -->

The nightly account pass refuses an erasure whose date is not at least a day past the metering
program's own start instant, when the program states one. A program that states none is an older
one and is read exactly as before; a self-hosted install has no metering program at all and never
reaches this door.

### Attaching a photo on the phone
<!-- changes: fix-023-photo-attach-crash.md -->

- Attaching a photo from the library no longer closes the app on the newest iOS. The composer and
  its text stay where they were.

### Your mail server's Inbox can be cleared of older mail from senders you never decided about
<!-- changes: ohbox-023-unscreened-senders.md -->

The Screener says how many messages in the Inbox on your mail server come from senders you never
decided about — mail that arrived before screening existed — and one press moves them to the
Screener, where you decide per sender as usual. Nothing moves until you press it.

### On iPhone, the local copy of your mail stays out of the phone's backup, and Settings says so only where it is true
<!-- changes: phone-023-ios-mirror-backup-exclusion.md -->

The phone marks the folder its mail mirror lives in as excluded from the device's cloud and
computer backups, then reads that mark back — and the About block in Settings states the exclusion
only where the read-back confirmed it, states the opposite where it did not, and claims neither
where nothing could be read. Android already kept the mirror out of its backup; both platforms now
answer the same question through the same code, so the sentence cannot be true on one and written
for the other.

### A certificate authority is trusted for the server you installed it for
<!-- changes: sec-023-door-ca-identity.md -->

A certificate authority you installed for your own mail server is trusted for that server only,
and signing out while switching servers can no longer leave a password behind.

### A saved sign-in survives a crash in the middle of saving
<!-- changes: sidecar-023-credential-store-integrity.md -->

The desktop's saved sign-in survives a crash in the middle of saving, and the account pane tells
you when it could not be saved instead of leaving you to find out at the next restart.

### Backspace and Delete no longer file a message while you are writing
<!-- changes: web-023-shell-keys-and-claims.md -->

With a reply or a new message open and nothing focused, one press of Backspace or Delete moved
the message selected behind it to Trash. Both keys belong to whoever is writing now and come
back when the form closes. Typing is unchanged: Backspace in a field still edits the text, and
in the To field it still takes the last recipient back.

## [0.22.0] — 2026-09-22

### An account whose subscription has ended is told so at every door, and its mailbox is untouched
<!-- changes: api-022-account-wall.md -->

A hosted account whose subscription ends is refused with the reason, the dates and an export path;
it keeps reading its status, its consent state and `GET /account/export`, the organizer stands down
cleanly with the mailbox untouched, and reminder mails precede any erasure. Self-hosted installs
are unaffected — there is no metering program, so nobody is ever parked.

### The phone's new surfaces read as one system
<!-- changes: design-022-phone-polish.md -->

The swipe verb under a dragged row is legible in both themes, the away responder screen aligns
its labels and values and dims Save when a save can't be taken, and Drafts' head counts its rows
in words — with a held, unconfirmed send named in the count.

### The closed-account screen reads the same on every surface
<!-- changes: design-022-wall-polish.md -->

The desktop lock now weighs "Your mailbox is untouched." the way the browser and the phone do, and
sets the erasure date in the same quiet type. The store builds' pointer sentence names manage-or-
delete only. The delete hint stops citing a date in the three states that show none. The phone's
export button says what it is doing while it makes the file, and its delete verb takes the quiet
weight the browser gives it.

### Search stands once on the unfolded phone
<!-- changes: device-022-duo-pass-2.md -->

Unfolded on a foldable phone, search appeared both in the side rail and at the foot of the
message list. It stands in one place per posture now.

### Controls tell a screen reader they can be pressed
<!-- changes: device-022-duo-pass-2.md#2 -->

The side rail's destinations, the Screener's shelves, the appearance and language choosers and
the sender scope switch were read out as plain text. They announce themselves as controls now,
and a verb that is briefly unavailable dims and says so rather than going quiet.

### Every sheet can be closed from the sheet
<!-- changes: device-022-duo-pass-2.md#3 -->

Sheets were dismissed by pressing outside them, which assistive technology is never shown — the
message's ⋯ sheet and the search sheet had no way out at all. Every sheet carries Cancel.

### Forwards stay in their conversation
<!-- changes: feat-022-forward-threading.md -->

A forwarded message now stays in the conversation it came from and carries the threading
headers every mail client reads, so a reply to the forward joins that conversation too. Inside
the conversation, the forward you sent reads "Forwarded to <recipient>" above the original's
text. A new message that merely shares a subject is still its own conversation.

### Search on the phone
<!-- changes: feat-022-phone-parity-a.md -->

The search pill in the dock, the rail, the More screen and the iPad list pane now open a search
screen instead of a note saying it was coming. It answers from the mail the device already holds,
so it works with no signal, and every answer states what that is: subjects, senders and the first
200 characters of each message, not the full text. Close matches appear under "Similar" only when
nothing matched exactly. An address that finds nothing offers the address view — everything from
or to that person.

### A new message on the phone
<!-- changes: feat-022-phone-parity-a.md#2 -->

The phone composes replies and forwards, and now new mail too. New mail stands beside search in
the dock, the rail and the iPad list pane, and opens the composer you already know, with
attachments, your signature and Send later, on the To field. The mailbox it is sent from is named
above the recipients.

### Mark all read on the phone
<!-- changes: feat-022-phone-parity-a.md#3 -->

The Ohbox and stream headers now carry "Mark all read", shown only when something is unread. The
sentence names how many were marked and one undo puts them back.

### Drafts on the phone
<!-- changes: feat-022-phone-parity-b.md -->

Messages you started and have not sent are on the phone, from every device you read your mail on. A
send that could not be confirmed appears there and can be settled — you tell ohmail whether it
arrived — with the text in full, because on that row it is the only copy.

### The away responder on the phone
<!-- changes: feat-022-phone-parity-b.md#2 -->

The switch, the message and an end date, in Settings. Who gets a reply, which mail and how often
are shown as they stand and are still set at a computer.

### Swipe a message to file it
<!-- changes: feat-022-phone-parity-b.md#3 -->

Swipe right to mark read (or Done), left for Answer Later. The row's menu still holds every verb,
and both are available to VoiceOver and TalkBack.

### Move, File and Junk can be taken back too
<!-- changes: feat-022-routing-verbs-undo.md -->

The mail moves the moment you press, and the rule that decides where that sender's mail goes from now on waits while the toast stands. Undo brings the mail back and makes no rule; leave the toast alone and the rule is made exactly as before. `z` presses it from the keyboard, and the phone's pill does the same.

### Send a reply and mark it done in one press
<!-- changes: feat-022-send-and-done.md -->

On a reply or forward of a message sitting in your Ohbox, the composer offers "Send + Done" beside
Send (⌘⇧↩ / Ctrl+⇧↩, and beside Send on the phone). It sends the message and then marks the
conversation done — only once the send has gone through; a refused send marks nothing. The
confirmation carries Undo, which puts the conversation back where it was and unsends nothing.

### Buying Screener suggestions reads one message per sender
<!-- changes: fix-022-backend-remainder.md -->

Asking the model about senders waiting at the gate used to read every message a sender had sent
you in order to ask about one of them. It now reads the one it asks about — the same message the
Screener shows you — so a sender with a long history at the gate costs no more than any other.

### The phone stays up with a receipt from today
<!-- changes: fix-022-duo-conformance.md -->

The phone app could crash a few seconds after opening when the account held a receipt dated
today; the Receipts day heading now takes its word from the app itself.

### The phone on the iPhone Duo
<!-- changes: fix-022-duo-conformance.md#2 -->

The closed face carries its controls in a right-edge rail below the clock; an open message puts
Back, Reply, Reply all, Forward, Done, Park and Junk in that rail; nothing runs under the status
cluster; unfolded, the list keeps the approved width beside the reader.

### Forwards carry the original
<!-- changes: fix-022-forward-arrives-empty.md -->

A forwarded message now carries the original message and its files in both the plain and the
formatted part, and a forward whose original cannot be loaded is refused instead of sent empty.
A message whose body or files were refused by a page in front of ohmail no longer stays
"Couldn't load" for the session.

### The attachment limit says why it is the number it is
<!-- changes: fix-022-frontend-rows.md -->

- The desktop app and a browser tab can offer different attachment limits for the same account,
  because they send the files differently. Where the app's own limit is the smaller one, the
  compose form and the reply editor now say so beside the number instead of stating it bare.

### The confirmation on the phone shows again
<!-- changes: fix-022-ios-toast-pill.md -->

- After Park, Later, Done or Junk on the phone, the short confirmation with **Undo** shows
  again — above the verb bar, and for its whole time. It used to arrive seconds late
  under the bar's second row, and a short one could vanish before it was drawn.

### The iPhone app fills the screen it is given
<!-- changes: fix-022-ios-uiscene-adoption.md -->

The iPhone app adopts the window model current iOS requires, so it builds and launches with the
current iOS SDK and is handed its device's real screen instead of a scaled-up compatibility
window. On a folding iPhone that is the difference between the app's own layout and a smaller one
stretched to fit. Nothing changes for the person on an existing build.

### Replaying the migration journal
<!-- changes: fix-022-migration-replay-census.md -->

- A database replaying its migration journal now applies the mailbox-address, body-cap and
  account-isolation entries instead of stopping on an index or a key that is already there.

### Every phone screen verified on iPhone, iPad and Android
<!-- changes: fix-022-mobile-views.md -->

- Every screen of the phone app was checked as rendered and working on iPhone, iPad and an
  Android foldable against the approved design. Empty states are now a title and a hint without
  an emoji, and the account line at the top of More names the server and your mailbox.

### Pairing opens the mailbox
<!-- changes: fix-022-paired-phone-stuck-on-servers.md -->

After pairing, the phone opens the mailbox instead of stopping on the Servers page. Back and the
edge swipe did nothing there, and the only way out was to restart the app.

### The phone's lists draw only what is on screen
<!-- changes: fix-022-phone-list-virtualization.md -->

- The phone's mail lists draw only the rows on screen and a few screens around them, so a large
  mailbox opens, scrolls and folds without running out of memory. Screen readers hear a list of
  what is visible instead of every message at once.

### Swiping a message
<!-- changes: fix-022-phone-swipe-row-clip.md -->

Swiping a message sideways drew the row outside the list it sits in, so its text ran across the
page and was cut off at the screen edge, and the action revealed underneath was drawn through
the row's own sender and subject. The row now stays inside the list and stays legible.

### Undo on the phone always takes the action back
<!-- changes: fix-022-phone-undo-order.md -->

- **Undo** after Park, Later, Done or Junk on the phone now always takes the action back, even
  when it is pressed the moment the confirmation appears. Pressed that quickly it used to reach
  the mailbox before the action did, and the message stayed where the action had put it.

### The phone answers every press, and every sheet closes
<!-- changes: fix-022-phone-view-findings.md -->

- The ⋯ sheet in the reader now has a Cancel row, like every other sheet. Dragging it down was
  the only way to close it, which a keyboard or a screen reader cannot do.
- When a verb files, parks or moves a message, VoiceOver and TalkBack now speak the confirmation
  and its Undo, where the press used to be silent to them.
- A phone whose pairing ended on the server says so in one sentence wherever you meet it, and
  offers **Pair again** beside it.
- The confirmation always belongs to the press you just made. Several verbs in a row used to
  queue their sentences behind each other, and a fourth could vanish without being shown at all.

### A resurfaced conversation that ends with your own message opens again
<!-- changes: fix-022-resurfaced-row-opens-nothing.md -->

Clicking a resurfaced conversation whose newest message was your own — a reply, or the away
responder's answer — did nothing: the reading pane stayed empty. It now opens on the newest
message you received, and the row shows that message rather than your own. Marking a resurfaced
message Done also tells you the date it is filed under in Earlier.

### Server internals
<!-- changes: fix-022-review-backend-rows.md -->

- The Junk and Trash windows, the two model providers and the three filing passes each share one
  copy of the code they had duplicated. No behaviour changes.

### An account on hold is not asked to subscribe again, and one reactivated before its erasure is kept
<!-- changes: fix-022-suspended-notice.md -->

The nightly pass mailed "Your ohmail subscription has ended … subscribe again" to every closed
account, including one an operator had put on hold — where paying reopens nothing. A held account
now gets no such mail, and is never erased by the pass whatever date it is handed. And the pass
re-reads an account's state immediately before erasing it, so somebody who subscribes again in the
meantime keeps their data.

### The sync strip clears when the sync recovers, and says "Sync failed" only for a mailbox whose sync failed
<!-- changes: fix-022-sync-strip-stays-red.md -->

On a desktop connected to a large mailbox, the strip could read "Sync failed. Retrying." for a whole
session while every sync succeeded, because the window's own first load of the mailbox was failing
after it had already finished — a defect in the window, not in the mailbox. That load now
completes. The strip says "Sync failed" only about a mailbox whose sync failed, names its address,
and clears when that mailbox syncs again; a window that cannot refresh its own view says "Can't
refresh. Retrying." instead. The desktop engine log now records a window's failed pull and any
request it refused.

### Search's empty state offers the address you typed — everything from or to it
<!-- changes: fix-022-ux-rows.md -->

There is no typed search operator; the scopes an address has live on its own list. When an
address-shaped search finds nothing on the device, the empty state now says so and offers that
list — everything the address sent, or anything from or to it — as one press.

### The app says when it is offline
<!-- changes: fix-022-ux-rows.md#2 -->

"Catching up" over a dead network was a wrong claim. When syncing is failing and the browser
itself reports offline, the app now says "Offline — showing what this device holds." — your
mirrored mail stays readable, and the sentence says exactly what you are looking at.

### A view that fails to draw can copy its details
<!-- changes: fix-022-ux-rows.md#3 -->

The in-pane error card now names the build beside the view and a "Copy details" press puts the
error's class, the build and the view on the clipboard — never the message content.

### Every settings tab is reachable from the command palette
<!-- changes: fix-022-ux-rows.md#4 -->

Type "Settings:" into ⌘K and every tab this surface offers opens by name.

### The phone says what happened to a closed account, and keeps every door open
<!-- changes: mobile-022-wall.md -->

A phone paired to a hosted account whose subscription has ended now replaces the mail UI with one
screen naming the closure and its date, stating that the mailbox is untouched, and saying when the
settings ohmail keeps are erased — with the settings export and the account page under it. While an
account is still open and a date is approaching, one strip above the list states the deadline; after
a reopening, one strip says how much arrived meanwhile and lists the mailboxes ohmail handed back,
each leading to the press that starts organizing again. A phone with no hosted account — standalone,
or paired to a self-hosted server — sees none of it.

### The mailbox page loads less before the first paint: the editor arrives when you open the composer
<!-- changes: perf-022-editor-off-first-load.md -->


### The News folder in your mailbox is now called ohmail/News
<!-- changes: rename-022-imap-folder-news.md -->

The folder the News pile files into is `ohmail/News`. A mailbox that still has
`ohmail/Reads` is renamed once, automatically, on the organizer's next pass —
messages, rules and settings all carry over, and if both folders exist their
mail is merged into News. Until that pass runs, everything keeps working
against the old name, and other mail clients simply see the folder change its
name. An ohmail app still on an older version looks for the old folder, so its
News pile reads empty until you update it — no mail is lost.

### Mailboxes on a phone
<!-- changes: rig-022-android-live-mail.md -->

- A mailbox reached by IP address, or on a port that upgrades to encryption mid-conversation, now
  connects on a phone. Both used to fail before the encrypted connection was established and
  reported the mailbox as closed without a reason; an upgrade that cannot be completed is now
  refused with one. What the phone accepts as a valid certificate is unchanged.

### macOS
<!-- changes: store-022-mac-app-store.md -->

- ohmail can now be built for the Mac App Store. It is the same app: the store build simply does
  not update itself — the App Store does that — and carries no link to a subscription page. The
  app you downloaded from the releases page is unchanged and keeps its own updates.

### An account whose subscription has ended sees what happened, when, and three ways out
<!-- changes: web-022-wall.md -->

The shared shell replaces the app with one screen that names the closure and its date, states that
the mailbox is untouched, and says when the settings ohmail keeps are erased — with three actions:
subscribe again, download those settings for a self-hosted install, or erase the account today. A
trial in its last two days, a trial grace and a failed payment each raise one dismissible strip
above the app with the deadline; when an account opens again, a strip says how much arrived while
it was shut and lists the mailboxes ohmail handed back. A self-hosted install has no metering
program and never sees any of it.

## [0.21.0] — 2026-09-21

### The README opens with the features, and wears both faces

The install table follows the features. The README gained a twin, `README.ohmarchy.md` — the same
page wearing the ohmarchy face — and a paper/ohmarchy switch above the first screenshot that links
the two files, in light and dark.

### Attachments in the phone composer

Replies and forwards on the phone can now carry files and photos, picked from the phone's file
picker or photo library, each shown with its size and removable before sending. The stated size
limit is the one the send enforces — the same rule the web and desktop composers read, and the
mail server's own announced maximum can only lower it. A message with only an attachment sends
without text; an empty one is refused with "Write something or attach a file."

### Undo and Trash on the phone

- Every filing verb on the phone shows an Undo in its toast, Delete waits a few seconds before
  it is sent, and a new Trash view under More lists what you deleted and puts it back with one
  press.

### The phone shows the whole message

A message on the phone used to be its text alone: no formatting, no embedded pictures, and
attachment tiles that could not open anything. The reader now renders the html part —
newsletters keep their layout, a signature logo or a pasted screenshot displays in place at its
stored size, bounded to the screen — and every attachment opens through the phone's own share
sheet. The protections are the web reader's, verbatim: remote images are blocked until "Show
images", tracking pixels stay refused even after it, and a link opens only after a confirm that
names the real destination. "Show as text" returns any message to the app's own type.

### Upgrading past the held-release migration

- A database that already ran the held-release migration accepts the corrected version of that
  file instead of stopping the upgrade.

### A replayed mail journal no longer stops on the held-release migration

Self-hosted stores that re-run the mail migration journal failed on the held-release entry, which
added its length constraint without checking whether the database already had it. It now applies
cleanly however many times it runs.

### Server hardening — isolation and admin checks held by tests

Account isolation on every query, one home for the operations console's second-factor read, and
the connection-test guard wired in every server build are now enforced by tests. No behaviour
changes.

### Storage

- The server prunes sync history, audit entries and sign-in events on a stated schedule; a
  client away past the horizon re-syncs cleanly.

### A stop blocked by a restored copy of your computer now says so

A "Stop organizing here" refused because a cloned or restored copy of this computer keeps
renewing its claim used to read as an ordinary "Stopping…" forever. The mailbox settings on the
desktop and in the browser now say it plainly — another copy of this computer keeps organizing
this mailbox until its claim lapses — and the stop completes on its own once that copy stops
renewing.

### A request the local engine never answers ends in a sentence

Presses against the local engine carry a deadline: a wedged-but-alive engine no longer leaves a
press pending forever — after a minute the pane says the engine did not answer and the request
was given up.

### Reading on a foldable and on a phone held sideways

- On a foldable's closed face and a phone held sideways the message list no longer runs under the
  navigation rail, so dates and the Screener pill stay readable.

### Faster first paint

The mailbox paints faster on a full account: the Screener queue derives just after the first
paint instead of before it, and the Settings and Compose panes load when opened.


### Upgrades on large databases

- Schema migrations follow an enforced lock-cost rule, so a future upgrade cannot block writes
  on large tables while a constraint or index is built.

### The tablet reader's toolbar fits its pane

- On a tablet or an unfolded phone, the reader's pinned toolbar now shows every control that
  fits the pane instead of folding them behind More, and re-fits itself when the device
  rotates or unfolds.

### Each mailbox carries its own sync verdict

A mailbox whose server had gone away could keep claiming health in Settings. Each mailbox now
carries its own verdict — a refused sign-in says so at once, a connection dead for more than two
minutes says the server is unreachable.

### Every filing verb can now be taken back

Answer Later, Park, Resurface, Done, tags and the bulk verbs raise one toast: a sentence naming what happened, with Undo beside it. Undo puts the mail back exactly where it was, and `z` presses it from the keyboard while the toast stands.

### The reader moves on after you act

After you act on a message the reader moves to the next one, and the reading pane stays
reachable while it is open.


### The phone sends again when it organizes its own mailbox

Sending and replying from a phone that organizes its own mailbox failed before the message left:
the app refused the name lookup its mail client makes before connecting. The lookup is answered
now, and the connection is made to the server's name as it always was.

### One navigation on every device

- The phone's navigation is one floating glass dock or rail, placed for how the device is
  held — the bottom dock with a search pill on phones, a vertical rail on the edge of a
  folding device — with search one tap away everywhere.

### Mail beside the list on big screens

- On a tablet or an unfolded phone, mail opens beside the list with the same controls the
  desktop has, and nothing moves when the device folds.

### The desktop build refuses a lockfile that drifted from its manifest

Every cargo step in the release workflow now runs `--locked`, so a release cannot ship what a
locked build would refuse — a dependency change that missed the lockfile fails in CI instead of
on a packager's machine.

### The Flathub source check no longer passes over a lockfile it never opened

`flathub-manifest.mjs --check` is how a release finds out whether the generated Flatpak source
lists still cover every dependency an offline build resolves. Run without a published checkout it
read only the two lockfiles in this repository, found nothing wrong with either and reported
success — while the list it could not check was the one a Flathub build installs first. It now
refuses that reading by name and says which lockfiles it did cover.

### The Reads pile is now called News

Newsletters now land in the News pile — the same pile under a new name, on every
surface and in both languages. The folder in your mailbox keeps its name, so
other mail clients see the same folders as before.

### Reopening the web app shows your mail immediately

Reopening the web app on a device that already held your mail could show empty message lists for a
minute or two — the stored mail is now visible the moment it loads, and a list still catching up
says so instead of reading empty.

## [0.20.1] — 2026-09-19

### Removing a mailbox

- Removing a mailbox failed once the away responder had answered somebody, and the window was
  never told it had failed. Fixed.

### Closing the composer saves what you typed, immediately

The compose form writes a draft to your account a couple of seconds after you stop typing, and
leaving it before that — Escape, the close control, the rail, the browser's Back — used to throw
away what was waiting, while the composer said the message was saved. Closing now writes it first.
If your account will not take the draft, the composer stays open and says why instead of closing
over it.

### The Flatpak manifest's generated npm sources cover the published lockfile again — fifteen packages were missing, and an offline build resolves only what it declares

The CI half of this lane is not a changelog item: it is this repository's own check. The sources
are, because the README hands a reader the manifest and tells them to build it.

### Opening a large mailbox

- Message lists and the first sync are quicker on a large mailbox: a page is read in order
  instead of sorting every message in the account first.

### The Ohbox waits before it says it is empty

A mailbox that is still arriving is not an empty one. The Ohbox used to say "Nothing in your
Ohbox." and show a count while the first sync was still running; it now says it is loading until
the mail has arrived, and the count appears once there is a real one to show. The Screener,
History, Reads and Receipts follow the same rule, and the "Syncing your mail" line stops once
your mail is here.

### The phone says who organizes a mailbox, and a Screener decision takes effect at once

Settings names who organizes a mailbox correctly on a paired phone; a Screener decision leaves the
waiting list at once; connection refusals are written for people.

### A phone names what it could not reach, and the account-locked screen is laid out

An address a phone cannot reach is explained instead of being reported as a changed key, so nobody
spends a pairing code over a dead name. The screen shown when an account is not active is laid out
like the rest of the app.

### Self-hosted images report the commit they were built from

A released image answered "dev" when asked which build it was, on `/health` and in
Settings -> About, so two builds of one release looked identical from inside. Each image now
carries the commit it was built from and reports it.

### A mail server address that cannot be reached is explained in a sentence

Connecting a mailbox to a server address that cannot be found, or that points inside your own
network, used to answer with the connection guard's internal wording. It now says which of the two
servers is at fault and what to check, and a port that carries no mail names the ports that do.

### An error in the web app shows a page, not a blank tab

If something goes wrong drawing a screen, the tab used to go blank — no message and no way back.
The web app now shows a page saying it hit an error and that your mail is untouched on your mail
server, with a button to reload, which build you are running, and a reference for the fault.

### A locked build of the desktop app works again

`cargo build --locked` succeeds from a fresh clone again; the lockfile had lost track of one
dependency the manifest names. It is regenerated — one line, no version of anything moved — and a
test now refuses any manifest dependency the lockfile does not carry.

### A newly paired desktop finishes its first sync

- On a fresh desktop signed in to ohmail Cloud, the first sync could stop partway — previews
  arrived, full messages and files never did, and the app looked settled while it silently retried
  the same failing step. Related records are stored in the right order now, so the first sync
  completes; a record that still cannot be stored is set aside and retried instead of blocking
  everything behind it, and the mailbox row says so with Sync now beside it.

### The desktop recovers on its own after a crash or power loss

A hard stop could leave the local mail store's lock file behind, and on some machines the app then
refused every later start. The engine now removes a leftover lock by itself when the process that
took it is provably gone, and the refusal card for anything it cannot judge alone says what
happened in plain words and offers "Unlock and retry" — never a raw log line. Your mail is on your
mail server either way.

### Pictures embedded in a message display in place

A logo in a signature, a pasted screenshot, a picture the sender embedded — these now display
where the sender put them, on the web and desktop reader. They are the message's own bytes:
nothing is fetched for them, and remote images stay blocked exactly as before. Every embedded
picture is also still listed with the message's files, marked "embedded", and "Download all"
includes it.

### The self-hosted server's /health says where its version came from

A released image reports the commit it was built from; `/health` now also says whether that label
was baked into the image or supplied from outside, and reports a label only an environment
variable vouches for. A compose override of `TF_BUILD_VERSION` no longer silently outranks the
identity the image was built with.

### A refused unsubscribe link is explained in a sentence

Pressing Unsubscribe on a message whose sender gave an unusable or unsafe unsubscribe address used
to answer with the connection guard's internal wording. It now says what is wrong with the
sender's link and that nothing was sent.

### Screener

- A sender the suggestion run could not answer for now says so in plain words — why there is no
  suggestion and what to do — instead of showing an empty suggestion with a confidence of 0.00,
  and the header counts only real suggestions, in agreement with the filter chips.
- The offer to release held mail from senders you already decided about now releases it even when
  you replied somewhere in those threads, reads as one plain sentence with one press, and can be
  put away with "Not now" — on every device — until something new is held.

### Send a file with no message text

A message with an attachment sends without any text, on the web and the desktop, in a new message
and in a reply. One with neither text nor a file is refused with a reason on the button and a
sentence on the press: "Write something or attach a file." Pasting a screenshot into the composer
still attaches it.

### Suggestion copy and badges agree on every device

The phone's Screener shows the suggestion badge on every waiting sender of a synced account, a
freshly synced suggestion no longer shows an empty quote before its reasoning arrives, and the
auto-suggest setting says when advice appears: as mail arrives, on every signed-in device,
within seconds.

### A Screener decision covers the sender everywhere

Deciding about a sender now files their held mail in every mailbox of your account at once.
A mailbox organized by another of your installs is asked to file its share, and the Screener
shows that it is on its way. Decided senders no longer reappear from a second mailbox.

### Suggestions appear everywhere the moment they are made

A screening suggestion now syncs to every signed-in device as soon as it is bought — the open
Screener tab, the desktop and the phone show the chip within seconds, instead of on the next
visit. The synced record carries only the verdict and its confidence, never the model's text.

## [0.20.0] — 2026-09-19

### Resurfaced conversations appear once, with a badge when new mail arrived since

Mail you park comes back a message at a time, so a conversation you had put away returned as
several rows — and a reply that had arrived in the meantime stood again under New. Resurfaced now
shows one row per conversation, opening on its newest message. Where new mail arrived after you
asked to see the conversation again, the row says how many; reading it clears the badge and leaves
the conversation where it is until you are done with it. Mail arriving in a conversation whose
return time has not come yet brings it back now rather than at its appointed hour.

### A device organizing one mailbox no longer resurfaces mail in a mailbox it has handed to another organizer

Mail you put away until a set hour came back in every mailbox on an account, including one this
device had stopped organizing. It now comes back only in the mailboxes this device holds; the
copy that organizes the other one brings its mail back, at the hour you chose.

### Change a mailbox's password without removing it

When your mail provider's password changes, Settings → Mailboxes (and Settings → This phone) offer
**Sign in again**: one field, tried against your mail server before anything is stored. The copy on
your computer, your folders and everything ohmail has organized stay where they are.

### The Ohbox keeps arrival order on every device

Every row in the Ohbox now sits by when its mail arrived, newest first — sent mail at the moment
you sent it, in the same one timeline. Mail read in bulk or in another app never moves: the read
state changes how a row looks, not where it sits. Previously the "Earlier" section ordered read
mail by when you read it, which could stack your sent history and your received history as two
separate chronologies; on an existing mailbox, read rows return to chronological order and nothing
else changes.

### A message keeps its place in the Ohbox when you read it

Rows in the Ohbox now sit by when mail arrived in your mailbox. A sender's written date or a
calendar invitation's time is still shown, but it no longer decides where a row sits when it
disagrees with the arrival — so reading a message never files it months away. Mail whose reading
time is not known sits at its own date instead of below everything you have ever read.

### The phone reads out a conversation's badges — thread count, protection, history and new mail

A mail row on the phone read out its sender, subject and time and nothing else, so every badge
beside them — protection, the conversation's length, the folder a History row sits in, a blocked
tracker, an amount, and the chip for mail that arrived since you asked to see a conversation
again — was on screen and unreadable to a screen reader. The row now says all of them, in the
order the web app uses.

### A device that has handed its mailbox to another organizer no longer resurfaces mail on its own

Mail you put away until a set hour came back on every device that still had the mailbox open,
including one you had stopped organizing from. That device now leaves the schedule alone: the
copy that holds the mailbox brings the mail back, once, at the hour you chose.

### Conversations show and read out their message count in every list, on the phone and in the web app

A mail row standing for a conversation of nine showed its length only in the web app's demo — the
number came from a field real mail never carries — and the phone's lists showed none at all, so a
conversation of five was indistinguishable from a single message until you opened it. Every list
on both surfaces now shows it, counted the way the mail server counts it rather than by how much
of the conversation the device is holding, and a screen reader hears it with the rest of the row.

### Screener suggestions arrive while you look

A suggestion bought after you opened the Screener now appears on the row within seconds, instead
of waiting for a reload. A sender you decided about stays decided — newer mail from them no longer
brings the row back while the decision is carried out. On accounts with automatic suggestions
turned on, suggestions are now bought the moment new mail is held for screening, and a row without
an answer says one is coming.

## [0.19.6] — 2026-09-18

### Removing a mailbox works again after the away responder has replied

Removing a mailbox stopped part-way once the away responder had answered anybody: the mail
stayed on disk and nothing on screen said the removal had not happened. Fixed. The record of who
was answered now outlives the message it answered, which is what it is for, and a removed
mailbox takes its own record of that with it.

### A first sync of a big mailbox picks up where it left off

A first sync works through a large mailbox in passes, and each pass carries a memory budget it
spends folder by folder. Where a pass ran out was only ever remembered for as long as the
connection lasted, so a restart began again at the inbox and a mailbox whose first folders hold
large messages could spend every pass on them. That position is now kept, and the progress line
says which folder the sync is continuing at until it has been all the way through.

### A sync that is outstanding but not moving now says so standing still

The sync line's spinner and its travelling bar ran for as long as a sync was outstanding, so a
mailbox that was stuck looked like one that was catching up. They now appear while mail is
actually being fetched and are still between fetches; the line keeps its sentence, its colour and
its track. A window left in the background also stops asking the server questions nobody is
waiting for, and asks again on the way back.

### The app opens in your own theme

The window stamped your theme and look a moment after the first frame, so every launch began with
the app's default light look — about a quarter of a second of the wrong colours on Linux, where
the app picks the Omarchy look for itself. The stamp now runs before anything is drawn. The
landing page's demo follows the page's light or dark too, instead of writing a theme's colours
with no scheme.

### A rule you make no longer moves mail you filed in another mail app or set aside

Choosing where a sender's mail goes moves up to fifty of their messages at once, and the rest
follow in the background. The background pass has always left mail filed in another mail app alone,
along with mail you had set aside, replied to or muted — the fifty did not, so a message filed in
Archive from another mail app, or a receipt you had put aside, could be pulled into the sender's new
place by the same press. Both halves choose the same mail now, on the web, the computer and the phone. On the phone
those fifty are the newest messages — the ones on screen — instead of whichever fifty the mailbox
listed first, and a move the rule makes is recorded, so it can be undone.

### Every time you pick survives the clock change

On the two nights a year the clocks move, an hour can be missing or happen twice. Resurface times
already handled it; the date picker and Send later do too now. Each day in the picker states the
time it would actually book, and a send you schedule for an hour that does not exist tells you
which hour it will go at instead — before you press. The computer and the phone resolve it the
same way.

### The mail engine starts with a smaller allocator

Its memory grew in steps that nothing in it was holding: the C library gives every busy thread its
own pool, and the pools kept what they were lent. It starts with two now, which gives back about
45 MB at rest and costs no measurable time. The same change gives nothing on the window's own
process, so it is asked for where it was measured to help and nowhere else.

### Move organizing to another computer while away replies are going out and the message that stops is still answered later, not written off.

The away responder asked whether it still held the mailbox at the last moment before each reply
left — after the reply had already been written down as answered. A computer that lost the mailbox
mid-run stopped correctly, and the message it stopped on stayed marked answered: if the computer
that took over answered nobody, that person was never replied to. The question is asked before
anything is written down now, and a reply nobody sent is still owed. Deleting a single mailbox also
stops a reply already prepared for it, the way deleting an account does, and a mail server that
accepts a reply and then stops answering no longer holds it open indefinitely.

### An install no longer says it organizes a mailbox before the lease has answered

When ohmail started up it showed the last thing it knew from its own records — "this computer
organizes this mailbox" — before asking the mailbox itself. If the first connection failed, nothing
ever asked: the screen said the mailbox was being organized while no mail was being filed and no
other computer could take over. It says nothing about organizing until the mailbox has answered.
Quitting while ohmail cannot read who organizes a mailbox hands your claim back now, instead of
leaving it there for another computer to wait out. On the phone, ohmail no longer takes over a
mailbox while it is in your pocket with nothing running to organize it.

### A corrected clock no longer keeps refusing until the app is restarted

When a computer's clock is badly wrong, ohmail will not organize a mailbox from it — two machines
cannot agree who has a mailbox if they cannot agree what time it is. Correcting the clock used to
clear that only at the next start, so the message stayed up about a clock you had just fixed. It
clears while ohmail is running now. A clock that is still wrong is still refused.

### A window that is already up to date asks the mailbox one question instead of two

Checking for changes reads how far your account has got and then asked for whatever came after it.
When nothing has, the first read has already said so. The second question is no longer asked and
the answer is unchanged.

### A change waiting for the installation that organizes your mailbox says so on every screen

When another installation organizes a mailbox, this one reads it: a press here is recorded for that
installation to carry out on its next pass. Screening a sender, releasing held mail, changing or
revoking a rule, deleting a message and the piles all reported those presses as done — the rule was
still filing mail, the message was not in the bin, and nothing said what was being waited on. Every
one of them now names the wait, and over a selection the sentence counts what changed and what did
not. Closing a reply you had started sending also cancels that send now, the way Cancel in the
compose window already did; what you wrote is kept.

### Filing a message while your mailbox was being read no longer loses the filing

When ohmail finds a message in a folder it did not put it in, it adopts that placement — the
mailbox is the master, and where you moved the message to is the truth. The reading behind that
observation happens before the write, though, and filing the message somewhere else in between
used to be overwritten by it, with nothing said. Your filing keeps the message now; where the
server holds it is recorded either way.

### Opening Settings in the demo on the site no longer turns off the notifications your signed-in browser is registered for

The demo on the landing page is the real client running on fictional mail. Opening its Settings
could reach past the demo into your own signed-in browser and cancel the registration that lets
ohmail notify you while it is closed, so closed-browser notices stopped arriving with nothing on
screen to say so. The demo no longer touches it.

### A mailbox you erased cannot be filled or unlocked again

Erasing a mailbox leaves the mailbox itself behind as the record that it was removed — and ten
places could still write against that record afterwards: arriving mail, its folders, its drafts
and, on a server configured from its environment, the password used to open it, resealed at the
next restart. All ten now check first, and what they do about it fits where they run: a request is
refused, a background copy skips that mailbox and keeps going.

### A send that could not be saved first is refused rather than sent blind

Every send writes what you wrote before it goes, and a save that failed did not stop it — so the
message that left was the draft as the server held it, which with a second window open could be
that window's words. A send now falls back to the last version of the draft this window saw, and a
press with no version at all retries the save once and then refuses instead of sending blind. Your
words stay in the editor either way. On the phone, a reply sent again after an earlier attempt had
already reached the server now says that the earlier message is the one that went, rather than
reporting the newer words as sent; and a Cancel pressed after the message has already gone says so
rather than closing in silence.

### A self-hosted install's outgoing-size probe checks the address it dials, like every other connection the organizer makes

When you add a mailbox, the address of its outgoing server is resolved and checked. One dial was
still skipping that: the probe that asks a submission server how large a message it will accept
read the stored name and handed it to a new connection. It now resolves and checks at the moment
it connects, like every other dial. A server at an address this install will not connect to is no
longer dialled — the mailbox keeps the conservative size limit instead of learning one, and
nothing else about it changes.

### Setting up a self-hosted database no longer stops on a reworded comment

A migration that has already run is verified against the SQL that ran, proved from the
repository's history, so a reworded comment no longer reads as a changed migration.

### "Not junk" is handed to whichever install organizes your mailbox

Pressing "Not junk" used to make the move from the server, in the same request. It is now recorded
and made by the install that organizes the mailbox, on its next pass — the row stays in the Junk
list and says it is on its way, and it leaves when the message really is out of Junk. "Not junk,
always allow" writes the sender's rule in the same step, so a request that is interrupted can no
longer leave the rule standing with the message unmoved. If your mail server refuses the move, the
row says so and the press can be tried again.

### Account isolation

- Mail, drafts, contacts, folders and sign-in records that belong to one account can no longer
  be stored against another. The separation is now refused by the database rather than kept by
  every part of the program remembering it.
- On a local or phone install, a migration that changes one table's shape no longer removes rows
  in tables that point at it, and refuses rather than finishing if anything is left pointing at
  something that is gone.

### Rebuilding a self-hosted image from a clone says which builder it needs

Each image recipe describes its build context in a file next to it, and only BuildKit reads one of
those. Built with Docker's older builder the context lost the lockfile, and npm then reported a file
this repository does carry as missing. Each recipe now refuses with that sentence and names the
buildx component to install.

### A mailbox you remove takes its in-flight retries with it

A message that failed to sync is re-read by name on a later pass, and that re-read is refused when
the mailbox has been removed in the meantime — nothing is written, the record stays owed, and the
cycle stops there. The check costs one fewer database round trip per write now: the sync cycle
already holds the mailbox's row while it writes, so it reads the answer off that.

### A dropped connection during a background renewal no longer leaves extra sessions behind

Apps renew their session in the background. When the answer to a renewal was lost, a browser was
given a fresh credential for every retry — so one dropped connection could leave several usable
credentials on a session that needed one — while the desktop app and the paired browser were
signed out instead, because their retry was indistinguishable from a stolen token being replayed.
Every retry of one renewal now converges on a single credential, and the desktop app and the
paired browser name their attempts the way the phone already did, so a dropped answer costs a
retry and nothing else.

### An iCloud mailbox's organizer keeps answering your other computer's presses

### A discard that cannot happen now says why, and a held message points at the question that frees it

### A reply you were writing is saved as a draft if the message it answers is moved or deleted in another mail app

### A message another mail app moves or deletes now says so where it was, instead of the pane going blank

### The web Screener can show and release mail held behind rules you already made

### A sender you sent to Spam counts as decided everywhere

### A browser that loses track of your account recovers on the next page load instead of refusing everything

### A meeting invitation with no event says so

### An "Accepted:" your calendar app sent is no longer the face of a conversation

### A first import reports itself on every door

A desktop signed into the hosted service keeps its own copy of the mailbox and pulls into it. While
that first pull runs, the progress sentence was counting the slice the window keeps on screen
rather than the copy being filled, so on a large mailbox the number stopped at the slice's size
while the pull carried on. The copy now answers for itself.

The first-run screen's "Screened so far" and "Listed under History" count the mail on this device.
They sat beside "Still to read", which is about the import, with nothing saying they were different
questions. They now say so.

### A self-hosted server and the mail worker now hold about 47 MB less memory once they have settled

### Move on the phone offers the place a message is shown in, and files the sender there

### Opening a large mailbox puts mail on the list sooner: the first page is a viewport rather than five hundred messages, and the first sync of a launch waits for it instead of holding the database while the list is empty

### Cancelling a security check now cancels what it was for

Cancel and Back end the check on the mailbox pane, on desktop pairing and at the password prompt, not only at the account erase — an answer that lands after you press no longer goes through.

### The desktop window says once when your account cannot be opened

Where it used to refuse one action at a time, it now shows a single screen, and the Screener's notice about AI clears by itself when access comes back.

### A first import keeps its pace, and a computer that loses power while importing leaves nothing missing

A first sync writes a record of its own work to disk as it goes, and the app was folding that
record away while the sync was still running. Each fold makes the sync write that record again
from the beginning for every page it touches afterwards, so a long first sync got slower the
further it went. The fold now happens when the sync finishes a pass instead of during one, and a
computer switched off mid-import still opens in well under a second.

A computer that loses power mid-import re-fetches the mail it did not finish — the mailbox is what
holds your mail, not this copy of it. Until now a phone or a second window that had been reading
from that computer could be left pointing past mail that came back and never ask for it again.
Every sync position now says which run of the store it belongs to, and one from a run that ended
is answered with "start again" instead of a page that quietly skips messages.

### A self-hosted organizer with more mailboxes than it can remember stops re-reading every record

It keeps the mailbox records it is about to need instead of replacing all of them every round. A server whose mailboxes all fit is unaffected.

### The “Another computer” door completes from a fresh install

Open a mailbox another of your computers is serving: paste the pairing link that
computer printed, and this one checks it really is the machine the link came from
before anything is configured. Nothing is written if the check fails.

### Moving into Reads or Receipts on a large mailbox is about a third faster

The window's own timing of a view switch now runs until the new view is on screen, so what it reports is what you waited for.

### A deletion you confirmed completes after a reload, even for a message this device no longer keeps

A message that had scrolled out of what this device holds was read as already gone and the delete was dropped. It is carried out now.

### The pass that finishes unsubscribes no longer re-reads the lists it has left

It remembers which messages it has looked at and where it stopped, so it moves on instead of revisiting the same lists every hour, and the count of what is still owed is work that is actually left.

### The unsubscribe pass runs on a phone

A phone organizing a mailbox on its own said it handled unsubscribes and ran none. It finishes them now, like every other install.

### Upgrading no longer stops halfway over a stale push registration

Push registrations record the device they were made from. The upgrade that starts checking those
records against your devices refused to finish while one named a device that is no longer there,
leaving the database half-migrated. The stale device is now cleared from the record before the
check, and the registration itself keeps working.

### The health check verifies your database's account-isolation keys

The health check certifies that a database carries the schema the server expects, and it could not
see a foreign key at all — so a server started against a database that had never taken the
account-isolation change reported itself complete. It now reads those keys, and by their definition
rather than their name, so one narrowed to fewer columns is caught too. A database missing them
answers `503` and names the migration to run instead of serving.

### A first import is faster again, and a computer switched off during one loses less of it

A first sync writes a record of its own work to disk as it goes, and that record is only written
out efficiently when the app commits something durably. While mail was coming in, nothing did —
so the record was written a page at a time, and every page waited for the disk. The app now
commits one transaction in sixteen durably while importing, which writes the record out in bulk.
The import is faster for it, and a computer switched off in the middle of one has less of that
record to lose.

### Marking mail read

- Marking several messages read in one go now records one time for all of them, rather than
  stamping each message at the moment it was written.

### A release is the latest one once its update feeds are on it

Publishing a release marks it the latest release in the same run that attaches its update feeds, so
the download link and installed clients see it without a manual step. A run that cannot attach the
feeds leaves the previous release as the latest one, which still has a working update path.

### A self-hosted install's health check names the unsubscribe drain's two tables

Until they are there the check reports the database as incomplete, instead of passing and letting the unsubscribe pass fail later.

### A first import no longer re-reads the whole mailbox every cycle

While it builds your mirror, the engine keeps a list of what it already has. It threw that list away
on every message it wrote and on every message it filed, and read the whole thing back on the next
pass — so the work grew with the mailbox and each message got slower as the import ran. It now keeps
the list up to date as it writes.

### A long import tail says what it is doing

A drain ends with passes that run over the whole mailbox the first time — the sender-name repair and
the conversation rejoin. They could take a quarter of an hour without writing a line, which from
outside looks like nothing happening. The log now names the pass it is in.

## [0.19.5] — 2026-09-17

### The Ohbox list no longer slides under the cursor after a jump

After jumping down a long Ohbox — with the scrollbar, End, or a search hit — the rows at the top
of the window could slide away before you scrolled them out, as the list measured rows further
down for the first time. The list now holds its rows still while it measures the ones around you.

## [0.19.3] — 2026-09-17

### Long lists scroll their rows out of view instead of hiding them

A long list draws only the messages around what you are looking at and sets aside space for the
rest. It used to set aside one height for every message it had not drawn, and messages are not all
one height — one showing a line of its text is taller than one that is not — so a long list ran
ahead of the messages in it and stepped over some without ever showing them. The list now measures
every row it draws and sets aside the heights it actually saw, so a list of any length scrolls
without stepping over messages. 0.19.2 fixed this for short lists; this fixes the rest.

## [0.19.2] — 2026-09-17

### Scrolling the Ohbox no longer hides the messages at the top

Scrolling the Ohbox cut messages off the top of the list instead of scrolling them out of view, and
left a blank band under the header. To keep a long list quick the app draws only the messages around
what you are looking at and sets aside a single height for the rest — and Ohbox messages are not all
one height, so the list ran ahead of the messages in it and stepped over some without ever showing
them. A list of up to 500 rows is now drawn whole, which is the size an Ohbox usually is, and scrolling
it moves it by exactly what you scrolled. A longer list still behaves as it did in 0.19.1;
that half is not fixed yet.

## [0.19.1] — 2026-09-16

### Reopening the app no longer holds the text of every reply you have sent

Opening the app fetched every draft your account has ever held, with its full text — and most
drafts are replies you already sent. On a mailbox with thousands of them that is a large amount of
text downloaded and kept in memory for as long as the window is open. Your sent replies are still
listed, and the addresses you write to are still learned from them; their text is no longer carried
along for the ride.

### Mail the app lets go of takes its leftovers with it

The app keeps a window of your mailbox in memory and reaches past it when you ask for older mail.
Letting a message go used to leave its conversation and its side records behind, so the window
bounded the mail and not everything attached to it. Those go with the message now.

### A phone or second computer paired to this one keeps less of the mailbox

A device you pair reads this computer's mailbox over your own network. It kept every message and
every message body it had ever seen for as long as the page stayed open. It now keeps the same
window this app does, and reaches back over the same connection for the rest.

### Re-pairing while the app was renewing its access no longer costs you the new pairing

A browser or phone paired to a computer running ohmail renews its access in the background. The
renewal checked which pairing it belonged to before it asked, and not after the answer came back —
so pairing the device to a different computer while a renewal was in flight let the late answer land
on the new pairing: deleting its credential if the renewal was refused, replacing it with the old
computer's if it succeeded. Either way the pairing you had just made stopped working, with nothing
on screen to say why. A renewal now checks again at the moment it would write, and one that no
longer belongs to the pairing this device holds writes nothing.

### Two sentences about where your password and your key go now say what the app does

"Your password never passes through the app's window" was not true of the window you type it into:
it goes from that field to the mail engine on your own computer. What it never touches is the app's
settings file, and it never reaches us — and a hosted account's session is the thing that is never
typed at all, because the engine establishes that itself. The app's key was described as living in
your computer's keychain; it is kept there and also in a file beside the app's data, which is what
the app reads on later starts. Both sentences say that now.

### The "Another computer" door says it is not available yet

Choosing it asked the mail engine to check the pairing link, on an install that has no mail engine
running yet — and the one setup it could have written would not have started one. The door was
unwalkable from every state, and it said so only at the last step, after a link had been pasted and
spent. It is now listed and marked on the setup screen, with nothing behind it to walk into; a
pairing link pasted into the "Your own server" field gets the same answer. The door is due in a
later version. Pairing a phone or a browser to a computer running ohmail is a different thing and is
untouched.

### A folder you delete no longer takes a message that arrived while it was being emptied

Deleting a folder empties it into Trash first, so that the delete itself has nothing left to take.
Emptiness was read in the one way the mail server is allowed to answer from a state it has already
reported, and a message another client filed into that folder in between went with it — not in
Trash, not on the server, and the mailbox is the master, so nothing brings it back. The folder is
re-read immediately before the delete is issued now, and one that is not provably empty and
unchanged is not deleted.

### A folder your server recreated no longer shows its old contents

If a folder is deleted and made again on the mail server — refiling an archive, a restore, a
migration tool — ohmail could keep showing what used to be in it and never show what is there now.
It reads the folder's numbering along with the counters it compares, so a recreated folder is read
afresh. The same reading covers the small shared folder the computers organizing a mailbox talk
through: a tidy-up no longer removes a request another computer was waiting on, or another
install's settings.

### A message deleted and restored on another device no longer disappears from this one

A page of changes from another device applied every creation and then every deletion, so two
changes to one message could be applied in the wrong order: delete a message elsewhere and restore
it between the same two checks, and the restore was applied first and the delete second. The
message was gone here with nothing left to heal it. A deletion now applies only when nothing later
in the same page names the same message.

### A message restored from Junk elsewhere no longer opens blank

A message whose text the mirror does not keep is marked with the reason, and only one of the three
markers was carried across to other devices. The other two were stored as ordinary empty messages,
which are never asked about again — so a message you rescued from Junk on another device opened
blank here for good. Every marker is carried now, and a message that changes drops the marker so
its text is fetched on the next pass.

### Removing a mailbox stops the writes that were still in flight

An arriving message was already refused into a mailbox you had removed while it was being read.
Three later writers were not: restoring the text of a message a spam verdict had emptied, carrying
your filing and read marks to the server, and the retry of a message that had failed to sync. Each
planned from a reading taken before it wrote, so a removal landing in that gap wrote into a mailbox
that was already gone. All of them ask the same question now, inside the transaction that does the
writing and under the same lock as the removal.

### Erasing an account or a mailbox stops the work already running

Erasing reports success once what it held has been removed. Work that had started before that could
still write afterwards and put some of it back — a draft, a decision about a sender, a cached copy
of your settings, a saved password, an automatic reply that could still be sent. Those checks were
made one writer at a time and several had been missed; they go through a single door now that asks
and writes together, so a writer cannot skip it. Erasing one mailbox is covered too: its record
stays behind on purpose, which is how it is remembered as removed, and a check that asked only about
the account let writes through for a mailbox you had erased.

### A message is sent as you last saw it

With one draft open in two windows, the other window's save could land between your last save and
your press — and the message that left was the other window's, to its recipients, reported as yours.
A send now carries the version of the draft it was composed against: if the draft changed elsewhere,
nothing is sent and you are asked to review it first. The editor keeps your words, and a draft saved
back unchanged still sends.

### Cancelling a queued send on the phone cancels it

Send a reply with no signal and ohmail holds it until the connection is back. Pressing Cancel closed
the composer and left that send on the queue, so writing the reply again and sending it delivered
the message twice. Cancel withdraws the queued send now — on this run and after a restart — and a
message written again for the same reply carries the same send identity, so the server delivers it
once. A message that has already left says so rather than promising otherwise.

### Turning off "Also move the mail already in your mailbox" leaves that mail where it is

On the web and on the phone the switch was read after the move had already been dispatched, so
screening a sender out moved up to fifty of their messages anyway — including mail you had filed by
hand or set aside. With the switch on, the caption says what actually happens: up to fifty messages
move at once, and the rule files the rest.

### A rule you change on a mailbox another computer organizes now takes effect

A rule is identified by what it matches. Finding a rule with the same match, the pass answered that
the change was already applied and wrote nothing — so where it files, how it ranks against other
rules and whether it is on at all were left as they were, and mail carried on going to the old
folder while the app said the change was in force. The state that was asked for is compared against
the state that is there, and the difference is applied. An identical request still writes nothing.

### A change still travelling to your organizer is no longer reported as done

Where the mailboxes on your account are organized by another install — a computer that is off, say —
deleting a rule sends the change there and the rule keeps running until that install applies it. The
first answer said so. The answer to a retry, after a reply went missing, said the rule was gone. A
change waiting for your organizer is reported as waiting, however many times the request is sent.

### Resurfacing a message takes a time, not just a day

Choose the hour as well as the day, on the web and on the phone. The time you choose becomes the
default for the next ones, and it is always shown before you decide, so "Tomorrow" says what it
means. "Now" is unchanged: it is a state, not a date.

### The unsubscribes a screen-out leaves behind now finish

Screening a sender out leaves the lists you said no to. A screen-out that finds more than it can
finish hands the rest to an hourly pass, and that pass could not finish either: it spent its whole
run deciding what it owed and was cut off before it had done much about it. It works to a budget
from the moment it starts now, takes a bounded batch at a time, leaves the rest for the next hour
and reports how many are still waiting. Two things it should never have done went with it: a mailbox
you disconnect is no longer sent for at all, and an unsubscribe that was started and never went
through is no longer reported as already done — pressing again sends it.

### Two computers can no longer both organize a mailbox after a take-over

When you gave a mailbox to another computer, the one losing it compared the mailbox's shared folder
against a reading taken a moment too late — one that already held the new organizer's work. Every
check after that said nothing had changed, so both machines filed into the same mailbox until the
older one's permit ran out. The reading is taken by the step that grants the permit now, and checked
against the claim it belongs to, so a machine that has been taken over stops at its very next write
instead of a minute later.

### A lost answer no longer stops a mailbox being organized

Every renewal writes a new marker and waits to be told it landed. If that answer never arrived — a
dropped connection at the wrong moment — the computer no longer recognised the marker it had just
written, decided another machine had taken the mailbox, and stopped. The marker it left behind then
kept every other machine out too, and pressing stop could not clear it. A computer recognises what
it wrote whether or not the answer came back, and its stop clears it. A marker genuinely written by
another machine still stops it, which is the point of the check.

### A phone that could not start organizing says so instead of showing it

When ohmail on your phone comes back to the foreground it takes the mailbox again. If something went
wrong in the moment after it took it — a busy store, a connection that had not finished coming back
— the phone kept the mailbox, started nothing, and told you it was organizing. Nothing was filed and
no other computer could take over. The phone gives the mailbox back and tries again a couple of
times now, and if it still cannot start it says so on the screen that names this phone.

### A clock you corrected no longer keeps refusing

If a computer wrote its permit while its clock was badly wrong, every later check re-read that old
marker, refused, and told you the clock was wrong — after you had already corrected it, and
restarting did not help. A marker written under a clock that has since been corrected no longer
decides: the install writes a new one under the clock it has now, and that is what later checks
read. A clock that is still wrong is still refused.

### Removing a mailbox on the phone removes its mail

"Stop and remove" closed the mail engine and deleted the phone's copy of the mailbox, and left the
engine's own store behind — the account, the mail, and the mailbox password sealed beside it.
Connecting a different mailbox afterwards found that account and attached both, so the removed
mailbox's mail was in the new mailbox's session. The removal takes all of it now, in one order. A
mailbox you remove on a paired computer leaves the phone with it.

### The phone shows the state of the account you are looking at

After you switched from the mailbox on your phone to another account, ohmail kept organizing the
first one in the background and showed that mailbox's state under the account you were looking at —
so a healthy account could say "Connection lost" about a mailbox you had switched away from. ohmail
on a phone organizes while it is open, and a mailbox you have switched away from is not open: it
hands the mailbox back when you leave it, so your other computer can take it, and takes it again
when you switch back.

### Stop on the phone reaches the mailbox every time you press it

If the mail server would not confirm your stop, Settings went on saying "Organizing" and offered
Stop again — and pressing it did nothing at all, while erasing the one sentence that explained the
first press. The screen says a stop is waiting for the mailbox now, pressing Stop asks again, and
the explanation stays until something changes. On Android, pressing Stop on the notification no
longer takes the notification away while the mailbox is still being organized.

### A server that serves its API under /api works throughout

Mail synced, but consent settings, the mailbox list, the screener and new-mail wakes were sent to
the wrong address on those servers and quietly answered nothing. Every request goes to the address
ohmail measured when you paired.

### Cancelling the account-erase check cancels it

Press "Verify and erase", change your mind, press Cancel, and when the second factor's response
landed the account was erased anyway. Cancel cleared the screen; the check that already held the
challenge went on to erase. A cancelled, failed or finished check is spent now, on all three factor
paths: a response landing late does nothing, and the screen says nothing was erased.

### A recovery code is spent only when it signs you in

Signing in with a recovery code committed the spend on its own and created the session afterwards.
Anything in between — a restart, a dropped connection, a database that refused the write — took the
code and gave back nothing, which for somebody on their last code with the authenticator already
gone is the end of the account. The spend and the session are one act now: either you are signed in
or the sheet is exactly as you found it. A wrong code still costs an attempt.

### A temporary fault is no longer reported as an empty AI budget

When suggestions were briefly unavailable, ohmail said no AI actions remained — and kept saying it
until the next day. It now says AI is briefly unavailable and to try again, in your own language,
and the notice clears by itself once suggestions work. What an account with no budget left is told
has not changed.

### Opening settings no longer requests a subscription-management link each time

The browser tab and the desktop window both asked for a management link the moment settings opened,
whether or not you pressed anything. The link is made when you press Manage.

### Turning hosting off stops it, even when the setting cannot be saved

Turning hosting off stopped at the first thing that went wrong. On a computer where the setting
could not be written — a full disk, a permission — the app gave up there and said hosting was off
while devices you had paired went on reading your mailbox over your network. It now stops serving
whatever happens, and if the setting could not be saved the Devices pane says so in a sentence and
says what it costs: hosting may come back the next time the app starts, until it saves.

### The two buttons on a revoked pairing open what they name

When the computer you are paired to removes this one, the notice offers two ways on: pair again, or
set this computer up on its own. Both buttons left you on the same notice. They now open the pairing
step and the take-over step.

### The window notices when its mail engine stops

The window asked the app what the mail engine was doing while it was starting and stopped asking the
moment it was ready. An engine that then stopped or restarted left the mailbox on screen exactly as
it had been, with nothing behind it, until the app was reopened. The window keeps reading, and says
what happened.

### A crash while ohmail is starting no longer locks you out of your own mail

ohmail keeps one lock file beside its local database so that two copies of the app can never open it
at once. The file was created first and filled in a moment later, so a crash, a forced quit or a
power cut in between left a lock naming nobody — and a lock that names nobody cannot be judged safe
to remove, so every launch after that refused. The lock is written and put in place in one act now,
and one left empty by an older version is taken over once. Separately, a removal that could not
clear this computer's copy of the mail says so and keeps the mailbox in the list, instead of
reporting the mailbox gone with every message still there; pressing Remove again runs the delete
that failed.

### An attachment you open and leave no longer stays in memory

Opening an attachment hands the window a link to its bytes, and that link holds the whole file until
it is handed back. It was handed back by the attachment's own row on screen — so moving on before
the file finished arriving left the row gone by the time it did, with nothing left to hand the link
back with, and the file stayed in memory for the rest of the session. The link is owed by the
message it belongs to now, handed back when you move off that message and immediately when a file
arrives after you have left.

### A long store upgrade says how far along it is

When an update has to rework the copy of your mail on this computer, the app showed one sentence and
no movement — several minutes on a large mailbox, which reads as a hang. It counts the steps as it
goes now, and after a few seconds says out loud that a large mailbox can take several minutes.

### A deletion you confirmed completes after a reload, or says it did not

Press Delete, lose the tab inside the undo window, reload, and the replay ran before this device's
copy of the mailbox had been read off disk: it found no message, took that for the message being
gone, and struck the deletion off. The message was still in the mailbox and the app had already said
it was gone. The replay waits for that read now, and a deletion it cannot complete is retried and
then named on screen rather than quietly dropped.

### A first sync of a mailbox with many folders no longer loads a message from every one of them

ohmail syncs a mailbox with a memory budget, and it would go over that budget once per folder: a
mailbox with a hundred folders each holding one large message could pull about 2.6 GB of mail into
memory before parsing any of it. Each folder checks the budget before it fetches now, so a pass
holds the budget plus at most one message — measured at 200 MB where it used to reach 2.6 GB. A pass
that runs out stops where it is, says the first sync is continuing, and the next one resumes at that
folder.

### A long first import no longer keeps the whole import in the local database's log

The log is folded in after every batch, so an interrupted import loses at most the batch it was on
rather than all of it — and the import itself is about a third faster, because folding the log is
also what lets the database reuse its memory.

### The demo on the site keeps to itself

The demo on the landing page is the real client running on fictional mail, and it ran on the same
browser storage as your own. If you had an unfinished message in ohmail and the demo opened, it
could restore, overwrite or discard it — and after an outage that text is the only copy. The demo
writes to its own space and reads nothing else. The signup form on the site also fixes a mix-up:
submit one address, reopen the form and type another, and a slow answer to the first could report
the second as registered. It confirms only the address you submitted.

## [0.19.0] — 2026-09-14

### Reopening the app no longer grows its cache of mail

Mail bodies restored from the on-disk cache when the app reopens now count toward the memory
window, so the cache no longer grows with every restart. What is kept is unchanged: the newest mail
stays and the oldest gives way.

### A change you make on one computer reaches the one that organizes the mailbox

Moving a message, editing a rule, setting a signature or changing your away reply on a computer that
does not organize the mailbox was stored and shown as waiting for the machine that does — and never
sent to it. Only Screener decisions travelled. All of them travel now, each carrying its own change.

### Search answers while you type

Searching a large mailbox used to freeze the window. Senders, subjects and previews now match as
you type; the text of your mail is searched in the archive, which answers a moment later.

### Attachments land in your Downloads folder

Attachments download to your Downloads folder on the desktop, including Download all. Pressing one wrote the file under the app's own directory and handed it to
the platform viewer, so nothing arrived in Downloads and Download all opened one viewer per file. A
button that says Download downloads: the files go to the folder your system names, a name that
collides is numbered rather than overwritten, and the strip says "Saved to Downloads" once.

### The attachment loader no longer spins

The strip and the preview overlay each drew their own rotating ring. Under the ohmarchy theme that
shape is a square, and a rotating square reads as a spinning box rather than as waiting. Both use
the mark the rest of the app uses now.

### Mail written as one line per block no longer arrives double-spaced

Apple Mail and Gmail write a letter as one `<div>` per line. Every such line was rendered as a
paragraph, so a twelve-line message arrived with a gap between every line while the blank lines the
writer actually typed rendered as nothing. A line gets line spacing now, a paragraph gets paragraph
spacing, and a blank line is one blank line.

### A signature you set on one device now shows up when you write from another

Including a desktop that only reads a mailbox the managed service organizes: that desktop shows the
signature the organizing install published, with its formatting, and says where it was set instead
of offering an editor that changes nothing. Until the organizing install has published one, the
signature set on the reading desktop stays in force and stays editable there.

### Mail from someone you had already written to no longer waits in the Screener

A person you have corresponded with for years could appear in the Screener as a first-time sender,
because mail imported before you confirmed the people you write to never left the screening folder.
Those senders are no longer listed and their held mail is released to where your decision sends it.
Mail from a sender you said no to is unchanged.

### Reads names which of your addresses a message came to

Where you have more than one address, a Reads row, its card and the reading pane say which of your
own addresses the message was delivered to. Below two mailboxes nothing is drawn.

### Applying a new rule to past mail is its own choice

Filing a sender's future mail and moving the mail already in your mailbox were one switch, so the
only way to leave old mail where it was turned the rule off as well. They are two choices now, both
on by default, and the footer says what each one will do.

### Every screen that says another install organizes a mailbox says what to press

The screens that name a holder are the ones somebody is stuck on, and they named no way out. Each
ends with the press that screen actually offers now, and you can tell ohmail you are reading along
here on purpose, so it stops offering to take the mailbox back.

### Organizing a mailbox is recorded the moment it is claimed

Agreeing to organize claimed the mailbox on the mail server a fraction of a second before this
device recorded that it holds it, and a failure to write that record was reported as something
smaller than it was. The record is written when the claim is confirmed now, and a failure to write
it is named and retried at the next check. This is older than it looks: it predates the phone build
that shipped in 0.18.0.

### Choosing another computer to organize a mailbox stops the previous one sooner

The previous install could keep filing for up to a minute after it lost the mailbox, because it was
trusting a dated receipt rather than asking. Every destructive write asks the mailbox first now. One
window remains: a take-over that lands while the previous install is taking its own reading is
admitted until that reading runs out.

### Taking a mailbox back works from the mailbox page

A mailbox another install had taken over could not be taken back: the page reported it as
disconnected and offered to reconnect something that was never disconnected, and the only move left
was connecting the address a second time. Taking it back works from the mailbox page.

### A mailbox whose settings ohmail could not read is no longer stuck

ohmail keeps a mailbox's organizing settings in a message in the mailbox itself. Reading that
message walks back through a folder, and on a mailbox organized for a long time the walk could run
out of room before reaching the bottom — which answered "I could not look", and on a folder holding
no settings message at all that answer was permanent. A folder small enough to search whole is
searched whole now, so "there are none" is an answer, and agreeing to organize such a mailbox
writes the first copy. Where the settings genuinely cannot be read, the mailbox row says so with
the reason instead of reading Up to date.

### A mailbox whose saved password this computer cannot open says so

It read as up to date while nothing was being read at all.

### Signing out holds even when a password was being saved

Signing out deletes the mailbox password stored on this computer, and a save already under way when
you press it — including one sent from a paired phone — is refused rather than written back.
Signing in again afterwards is unchanged.

### A filing whose copy landed and whose delete was refused is no longer recorded as finished

The message stayed in two folders. The delete's answer is read and confirmed now, and the retry
adopts the copy it already made.

### A decision you made while a pass was running is no longer overwritten by it

A pass that put a command on the wire and then wrote what it had decided before the reply came back
could write a value minutes old — including over a destination you had chosen meanwhile. Nothing
errored; the mail simply ended up where the older decision said.

### A page you did not ask for

A zero or negative page size answered with exactly one message and a cursor, which is an
almost-empty mailbox reporting itself healthy. Those are refused by name now, and a blank one means
you did not ask, so it gets the ordinary page.

### Removing a mailbox waits for the mail it is still reading

Removing a mailbox used to tombstone it and delete this machine's copy of its mail before waiting
for the pass that was still reading the mailbox. That pass then wrote what it was carrying into a
mailbox that had just been removed: the messages stayed on the machine, and the window was told
they had arrived after it had been told the mailbox was gone. The removal waits for the pass first
now — bounded, like every other stop — and a write into a removed mailbox is refused rather than
committed behind the removal.

## [0.18.0] — 2026-09-13

### ohmail builds as a Flatpak

The manifest is in the repository at `apps/desktop/flatpak/app.ohmail.Desktop.yml`: every crate,
every npm package and the Node runtime the mail engine runs on are declared there as checksummed
sources. The Flatpak asks for the network, a window, your
login keyring and notifications, and has no access to your files — attachments you open go out
through the desktop portal. It does not check for updates, because a software centre installs
them. It is not on Flathub yet; the README says how to build and install it yourself meanwhile.

### The desktop app reports what it costs and how it feels

The app already wrote the mail engine's memory into its log every five minutes. The window's own
memory is measured too now, on all three systems, each through that system's own reading. On Linux
the first version of this looked for a process name longer than Linux gives, found nothing and
reported it as nothing to report; it identifies the window's processes by the command that started
them now, and a reading it could not take says so instead of reading as a zero. The app also
reports how fast it feels, in the same log: how long the window took to start and to show a usable
list, and the median and 95th percentile of opening a message, switching view and searching.
Counts and durations only — no subject, no address, no folder name — and none of it leaves the
machine.

### Stopping and starting again on a phone is one instruction

Press "Stop organizing here" in Settings, change your mind, press "Start organizing here": the phone
either refused to start again for as long as the app stayed open, or started and went on saying
"Stopping" while it was filing mail. There is one instruction now — Start pressed during a stop
waits for the stop and then starts, Stop pressed during a start cancels it — and Settings shows the
state the mailbox is in rather than the last button you pressed. The stop is written down on the
phone itself, so reopening the app does not undo it. Where nothing organizes a mailbox, the panel no
longer explains how to dismiss a notification that is not showing.

### The Linux build measures start time and memory

The build could prove the packaged app opens a window and nothing about what it costs. The x86_64
Linux job now runs the packaged app against a generated ten-thousand-message mailbox and reads the app's own
numbers back — how long the engine took to be ready, and how much memory the engine and the window
hold — each against a written budget. Over a budget fails the build.

### The Screener works out its list once per change

The Screener's list is derived from the mail itself, and it was derived again from scratch every
time anything in the mailbox moved — hundreds of times while a first sync is running, and whether
or not the Screener was the view you had open. It is worked out once per change now, shared by
everything that asks for it, and a change re-derives only the senders whose mail it touched. On a
large mailbox that is the difference between dropping frames while mail arrives and not.

### A Screener decision that waited too long says so

A decision you take in the Screener is written down the moment you press, so closing the app or a
crash inside the undo window does not lose it. If the app does not open again for a day, that
decision is too old to carry out — and it used to be dropped without a word, leaving the sender
back in your queue with nothing to explain it. ohmail now tells you the decision waited too long to
be sent, says how many if there were several, and asks you to decide again.

### A phone never takes a mailbox your computer is organizing

There is no "take over" button on a phone: it opens a mailbox nobody is organizing and reads one
that somebody is. That was true of the button and not of what the mail server recorded, so a phone
could win a mailbox a computer was actively organizing. The answer is now decided where the claim
is written, by the verb you pressed. A phone asking for a busy mailbox is told which machine has
it and reads the mailbox instead. "Organize here" on a computer still takes the mailbox.

### A rule applies to the mail that arrives after it

A rule that names a subject or body phrase is a decision about the sender too: their mail no
longer waits in the Screener for a decision you had already made, while the phrase still decides
where the mail it names is filed. A rule sending a sender to Screened or Quarantine is carried out
on all of their mail. Mail already waiting when you wrote the rule is unchanged.

### Quitting hands the mailbox back

The organizer claim ohmail keeps in your mailbox is returned when the app closes, whichever way
you quit and on a phone as well, so your other machine can take over at once instead of waiting up
to ten minutes for the claim to go stale. The claim lives in the mailbox, so quitting while your
mail server cannot be reached leaves it to go stale as before. The machine is still the organizer of record: opening it
again takes the mailbox back unless somebody else has taken it first.

### Organizing a mailbox no longer fails while another one is being disconnected

Two such presses on one account at the same moment took the same two locks in opposite orders and
could wait on each other, and the database ended one of them: the press that lost came back as a
server error with nothing wrong with the request. Both take the locks in one order now.

### A draft has a size limit

A draft's text now has the same limit its formatted half already had. Past it the composer stops
saving to your account and says so instead of promising a save; the text stays in the form, and
shortening the message saves all of it. Nothing is ever cut for you.

### A large mailbox's first sync is bounded on the server as well

The first sync's message window now has a ceiling as well as a floor — the last ninety days, at
least five thousand messages and at most ten thousand, the same window the apps keep — so a
mailbox whose mail is dense inside ninety days is no longer sent almost in full. Drafts arrive a
page at a time, newest first, instead of all at once on the first page. Mail you have tagged still
arrives from below the window, and every draft still arrives.

### The desktop is stricter about the server address it stores

A plain http:// address is accepted only for a server on this computer and refused anywhere else,
with a sentence saying why — stored otherwise, it would have sent your password and your
authenticator code over the network unprotected. The app also tells the hosted service from your
own server by the server's name rather than by comparing the address as text, so a certificate
authority you install for your own server is never offered to the hosted door.

### The reading screen's actions fit every phone width, in both languages

Reply, Later, Park and Resurface used to sit on a sideways-scrolling strip: on a 1080 by 2400
phone the fourth action was cut at the row's edge — in German it showed a single letter. The row
now wraps to a second line when the words do not fit, and no action is shortened, cut or hidden.

### The phone asks for the notification it organizes behind

Android does not let an app show notifications until it has asked, and ohmail never did. It asks
now, where you start organizing on this phone, and says what the notification is for: your mailbox
being organized in the background, which stops when you leave the app without it. Say no and the
phone says so, with a link to the setting, and it does not ask again.

### When a phone is organizing a mailbox, the app says so

Four rows named a computer or ohmail Cloud and had no sentence for a phone, so a phone fell into
whichever arm was last. They now say what a phone is: it organizes this mailbox, and only while
the ohmail app is open on it. A phone that has stopped renewing its claim is no longer reported as
still filing.

### How long a first import took

The mail engine writes one line when a mailbox's first import finishes, saying how long it took. The
clock started at the end of the first pass over the mailbox rather than at its beginning, and on a
large mailbox that pass is a quarter of an hour of work — so the figure left out the stretch that was
doing the most. A large first import read as thirty-four minutes where it had taken forty-seven. The figure is one
run's: an import that finishes after a restart is timed from the restart. The
import is unchanged; the line describing it is now the whole of it.

### Links and buttons open your browser again on Linux

On Linux a link or a button that should open your browser could do nothing at all, and nothing
said so. The app now looks for the system opener where distributions keep it, waits to hear
whether it worked, and puts the address on screen when nothing could open it. Attachments open by
the same path.

### A slow credit check no longer reads as "AI unavailable"

The check that confirms your account can run a suggestion was given less time than it sometimes
needs, so a slow moment was reported as AI being unavailable — with the credit already spent. It
waits as long as it actually needs now, and a check that does run out of time is logged and
counted instead of passing silently.

### Asking a phone to organize while your mail server is unreachable says so

The phone recorded your consent and reported that organizing had started even when it could not
reach the mail server, and then showed an organizer notification over a mailbox nothing was
organizing. It now says it could not check: your consent is kept, and the mailbox is taken on the
next round.

### Deleting your account closes every door behind it

A request that was already running when you deleted your account can no longer put a row back
after the sweep. Every write the server makes on your behalf is refused once the deletion has
started.

### Deleting your account clears the address you signed up with

The invitation and sign-up records are kept against your email address, and the sweep did not
reach them. It does now.

### Signing out removes every stored mailbox password

Signing out of a self-hosted mailbox removes every stored password, including one that was still
being saved when you pressed it. A sign-out that cannot account for a save says so instead of
reporting success.

### Removing a two-factor method signs out your other sessions

Removing an authenticator signs out every other session on the account, on every device, and
cancels the tokens that would renew them. The session you remove it from stays signed in.

### A server fault while renewing your session no longer signs you out

Renewing a session had two ways to fail and answered both the same way: a busy database or a fault
on the way told the browser the session was over and cleared its cookies. A fault is answered as a
fault now, with nothing cleared.

### A message is never acted on under an id your mail server cannot vouch for

Moving, flagging, deleting or fetching a message goes ahead only under the folder identity your
mail server vouches for. Where the server names none, ohmail holds the mail and asks again rather
than acting on a guess, and mail still sitting on the server is no longer written off as gone.


## [0.17.0] — 2026-09-12

### A large mailbox no longer costs the desktop window the whole mailbox

Opening a big account could take the app past four gigabytes and hold a CPU core for minutes after
the first sync — on an 8 GB machine the system ran out of memory and began killing other
applications. The window now keeps a window of your mail — the last ninety days, at least five
thousand messages and at most ten thousand — and reaches past it on demand. It keeps that window
while the mail is still arriving, so importing a large mailbox for the first time costs the window
the same as living with it afterwards, rather than the whole mailbox until the import finishes. A
first import no longer redraws everything the window derives from your mailbox for every page of
mail that arrives: mail now lands in groups, pages still arrive as fast as your server sends them,
and the import itself uses substantially less memory.
Nothing about what you can read changes: the whole mailbox is still on the machine, in the engine's
own store, and older mail and search are answered from there. A message's full text is now written
once per batch instead of twice per message, so loading the recent mail after a first sync no longer
pins a core, and the full messages the window holds are bounded too. The window also reports what it
is costing every five minutes beside the engine's own figures, and on Linux it volunteers itself to
the kernel ahead of your other applications. Tagged mail is kept whatever its age, so a tag still
shows all of it; History, which has no list of its own on the server, now says it is showing what
this device kept and points at Search for the rest, instead of printing a count that stops at the
window.

### A first import reports what it has actually pulled

The window holds a recent slice of a mailbox and leaves the rest in the engine's store on your
machine. The "messages so far" line was counting the slice, so on a large mailbox it climbed to
about the slice's size and stopped there while the import carried on underneath — and the
first-run pull screen's remaining count, rate and estimate followed it. Both now count the mail the
engine has actually taken in. The import itself is unchanged; what it reports is now what it has
done.

### A phone asks for a mailbox only when you ask it to

Opening the app used to ask for the mailbox. Only pressing Connect, or "Start organizing here" in
Settings, does now — so a phone reopened beside a computer already organizing that mailbox leaves
it alone, and says which machine has it. Stopping is remembered: dismissing the notification, or
handing the mailbox back from Settings, records the stop on the phone itself, so reopening the app
does not start organizing again and there is a verb to start again. Change your mind twice and the
last press is the one that stands, whichever way round. The phone keeps reading the mailbox and
keeps its mail either way. A phone that stood down because another machine held the mailbox now
takes it back when that machine lets go, instead of waiting to be restarted, and
Settings › This phone follows the mailbox while it is open rather than showing what was true when
the screen was opened. A connect the phone could not record closes the mailbox again rather than
leaving it open behind the message, and only one mailbox opens at a time. Forgetting the mailbox
says whether its claim went back to the mail server, so you are not told it is free while another
machine still cannot have it.

### A phone that loses its network says so

The app organizes your mailbox while it is open, and it loses its network for seconds at a time —
but it waited two minutes before dialling the mail server again, and fifteen seconds more between
attempts, which are a computer's numbers. On a phone it now gives up on a quiet connection after
three cycles, retries after five seconds, and says what is happening: "Connection lost.
Reconnecting…" at the top of the screen and in Settings › This phone, and after five minutes the
time it went instead. A server that answered and refused your password keeps its own sentence.
Computers and ohmail Cloud keep the numbers they had. Stopping is bounded too: on a connection that
stays open and answers nothing, "Stop organizing here" used to wait for a reply that never came.

### A connection that dies without saying so is replaced

A mail server that stops answering while its socket stays open used to leave the app asking the
dead connection to log out — a request that waits behind the command already stuck, so it never
returned. Nothing dialled again and no mail was filed until the app was restarted. A connection
found dead is now ended outright, the next attempt happens, and each attempt is recorded. On a
phone, a command written to a connection that had just closed could also take the app down; those
bytes are refused at the socket and the write is told why.

### The phone names the computer organizing your mailbox

When a computer is organizing your mailbox, the phone says so, names it, and reads along instead
of asking to organize.

### A phone keeps re-claiming its mailbox after the first minutes

"Start organizing here" was refused for the rest of the session once the app had been open more
than five minutes, and so was the phone's own watch for a mailbox another machine had released;
both work now, and a refusal that stands backs off instead of retrying every few seconds. A second
phone asking for a mailbox another phone is actively organizing does not take it and keeps reading
the mailbox.

### The object store images come from Quay

The object store images are pulled from Quay; Docker Hub no longer serves them.

### A self-hosted install's front door reports its version

Dialled by its IP address instead of the name in `OHMAIL_ORIGIN`, the front door answered every
request with an empty 200 — `/version` included, so anything monitoring the install read a healthy
server that was serving nothing. That address now reports the build at `/version` and refuses the
rest with a 421 naming the origin the install answers at.

### Your own address is never a row in your Screener

Mail from one of your own addresses was held out of the Screener queue when it arrived in the
inbox, but not when it was already sitting in the Screener folder — a message you sent to
yourself, or a copy your provider filed there, could appear as a sender waiting for a decision.
The queue now asks who sent a message wherever it sits. Mail already filed in Screened or Spam
keeps its row, and nothing moves on the server either way.

### Settings rows tell screen readers their state

On Linux, a screen reader now reads the sentence under a settings row's label — whether an update
is waiting, which mailbox this computer organizes, what your licence is. Before this only the label
and the value on the right were announced, so an update ready to install was the one thing a reader
could not hear. Windows already read it. Nothing moves on screen.

### The updater says what it checked and what it decided

The auto-updater wrote nothing to the log, so an update that did not happen left nothing to read.
It now records the feed it asked, the version it was offered, and whether the update was installed,
put off or failed. An install that updates through your distribution's packages says it asks no
feed at all. No addresses beyond the configured feed and no library error text go in, so the log
is still safe to attach to a bug report.

### Sign out other web sessions, with an age cutoff

`POST /devices/revoke-web-sessions` takes an optional `olderThanDays`, so a server's own tooling
can clear web sessions last seen more than that many days ago without signing out the ones in use
today. Sent without it, the verb does exactly what it did before. Named devices are never in
scope, and the app's own "sign out everywhere else" press is unchanged.

### Trash also lists what your mail server deleted

The Trash view also lists what sits in your mail server's Trash folder, read-only — mail you
deleted in another mail app, which ohmail does not mirror. Nothing there offers a move, because
that mail records no folder to go back to; your own deletions, in the section above it, still
restore where they came from.

### Building from source is pinned end to end

`apps/desktop` carries a lockfile, so `npm ci` installs the dependency tree this app was built and
tested against rather than whatever its ranges resolve to on the day. The Node runtime the app
bundles can be vendored from archives you already have — point `OHMAIL_NODE_ARCHIVES` at a
directory holding them and nothing is downloaded — and the engine's bundler is a pinned dependency
of the workspace, so the build instructions no longer ask you to install one off to one side.

### The phone shows History

The phone shows History — old mail from senders you never screened — like the desktop does.
It sits under More. Everything in it is read, and nothing in it has moved: each row says which
folder on your mail server the message is still in.

### The phone shows the same waiting senders as the web

Your Screener settings — when screening started, how far back it looks, and whether it looks all
the way back — now reach the phone. Before this the phone applied its own sixty-day window, so a
mailbox with six senders waiting could show two on the phone and six in the browser.

### The door chooser clears the status bar

On a phone with a notch the ohmail wordmark on the first screen sat on top of the clock.

### The doorbell shows four faces and a count

With a lot of senders waiting, the Screener knock drew one circle each and pushed the count — and
the way into the Screener — off the edge of the screen.

### A storage write your browser refuses is reported

The app keeps a few things in the browser's own storage: your appearance choice, the pairing a
phone uses to reach this computer, the local copy of your mailbox. Three of those places dropped a
refused write without a word, so the app went on showing a choice it had not managed to keep. Each
of them answers now, and one line says once per session that this browser is not keeping things
between reloads.

### The phone's chooser counts its own doors

The sentence above the list of places that can organize your mailbox said "One question, three
answers" while the list offers four. It names four now, in both languages.

### Organizing on a phone, when the app is not in front of you

On Android the phone keeps organizing while its notification is shown; on iPhone it hands the
mailbox back when you leave the app and picks it up again when you return. The notification names
the mailbox it is organizing, and it is also how you stop — its "Stop organizing" action, or
swiping it away. If your battery saver is on, ohmail organizes while it is open instead, and says
so once. The notification only stands while the organizing is really happening: if another machine
takes the mailbox, or the phone stops being able to do the work, it comes down.

Coming back asks the mailbox who holds it: free, and the phone takes it again; held by your
computer or by ohmail Cloud, and the phone reads it instead. Nothing is taken from a machine that
has it.
"Stop organizing here" in Settings takes the notification down along with the mailbox. A stop the
mail server will not complete is no longer reported as done: Settings says the mailbox could not be
handed back, the phone goes on watching it, and the request stays recorded — so it survives the app
being closed, and the next round asks the server again. If your phone's battery settings will not
let ohmail work in the background at all, Settings says so beside the line that describes what this
phone does.

### Send later on a phone

A phone can organize a mailbox itself, and it organizes only while ohmail is running on it — so
it cannot hold a message for a time you picked. Send later is not offered there, and the screen
says where to set the time instead: a computer, or ohmail Cloud. A phone paired to either is
unchanged, and a message already waiting for its time can still be cancelled on the phone.

### A .deb or .rpm install no longer offers an update it cannot install

A build installed from the `.deb` or the `.rpm` cannot replace its own files, and the release feed
publishes no package of either kind — but it offered the update anyway, downloaded the AppImage for
your architecture, and then said it could not install it. It now reads how it was installed and
does not ask the feed at all: the menu item says updates come from your package manager, Settings
says the same beside the version you are running, and nothing is downloaded. Install the newer
package over the old one, or use the AppImage, which updates itself.

The same holds for a build from source and for an AppImage you have unpacked and are running from
the extracted files — neither can replace itself, and neither says it can. The AppImage, the
Windows setup and the macOS app are unchanged.

### A draft you open is the draft you wrote

Opening a draft now waits for its text to arrive before the editor appears, so a draft can never
open empty and be saved that way over what you had written. If the text cannot be fetched, the
draft does not open and the row says why.

### The app waits the time the server asks for

When the server is briefly too busy to answer a read and says when to come back, the app waits that
long and asks again instead of reporting that it cannot reach anything.

### A self-hosted server records its own failed requests

When a request fails with a 5xx the server now writes a row for it: the route pattern, the
method, the status, the error's class name and the request id. Never a message, an address or
anything a request carried. Rows are kept seven days.

Two alerts read it. One fires when a single route answers more than ten 5xx in ten minutes; the
other when the database connection pool has refused more than ten requests in that window. Both
are silent on a server that is working — a single pool refusal is the connection ceiling doing
its job, not an incident.

There is also `POST /internal/fault`, which makes the server answer one deliberate 5xx so you
can confirm the record and the alerts work on your own install. It needs the internal shared
secret, and it is absent unless the server has somewhere to record faults.

## [0.16.2] — 2026-09-11

### A phone that organizes its own mailbox keeps it

A phone can be the install that organizes a mailbox. Every install writes a record into the mailbox
saying it holds it, and a phone could write the word for itself that no install could read back —
so a phone read its own record as another organizer's, handed the mailbox back, and did it again
every pass. It keeps it now. A computer or ohmail Cloud still takes a mailbox over from a phone when
you ask, and the row that says so names a phone instead of "another organizer".

### Your piles travel again between your computers

A computer that reads a mailbox another of your computers organizes gets its settings — your rules,
your screener, your away notice — from a document in the mailbox itself. On a mailbox that has been
organized for a while, that document could no longer be found, so a computer that only reads it
showed nothing and a message you parked on one machine did not appear on the other. It is found
again, however long the mailbox has been in use.

### A message you move back into the Ohbox stays there

The pass that clears automated mail out of the Ohbox could file a message you had just moved back
into it, if your move and the pass landed at the same moment. It now checks a second time, right
before it files anything, whether you have moved the message — so your placement wins.
### The Screener asks only about senders still worth a decision

The Screener holds mail from people you have never agreed to hear from. How far back it asks about
is measured from a fixed point — the window in Settings. The count in the sidebar respected that
window; the list itself did not, so it read the folder instead of the question, and on a mailbox
with years of history those are different by an order of magnitude. The queue offered senders whose
newest mail was years old, beside a much smaller count.

The list now asks the same question the count does, through the same code. Nothing moves on your
mail server and nothing is deleted: the mail stays in the folder it is in, and those senders are in
History, where old mail from people you never answered has always been. Set the window to all time
and every one of them is back in the list.

Deciding still works for a sender the queue no longer shows — reach them from History or from
search, press a pile, and all of their held mail follows.

### Connecting a mailbox sets the point the Screener counts from

Connecting a mailbox without choosing a history window left the Screener with no cutoff, so every
message from a sender you had not decided about waited for a decision whatever its date. A mailbox
with years of mail arrived with years of it waiting. Agreeing to let ohmail organize a mailbox is
now itself that point, so only mail that arrives afterwards is a question. Choosing a window still
works the same way, and coming back to setup cannot move the point.

Mail already waiting in the Screener is not moved by this. If yours holds old mail from before
this release, it stays where it is until you decide on it.

### A waiting sender says why no suggestion is coming

When ohmail cannot ask for a suggestion — the AI budget is spent, or AI is switched off for the
account — the senders it did not get to said "No suggestion yet", which reads as a promise. They
say the reason instead.

### The app reports how much memory it is holding

The desktop app's engine now writes its own memory use to its log every five minutes, and the
database it keeps your mail in is a separate number on that line rather than part of one total. If
the app ever feels heavy after a long day, the log says which half grew.

Two things changed behind that. One copy of the mail window's view of the mailbox was being left
alive after the view had moved on, and on a large mailbox it was not small; it is released now.
And the app's store is a fixed cost measured at about 200 MB whatever the size of your mailbox, so
it is now written down as one.

### A long mail-server command is not cut off by the connection check

A large fetch, or a slow server, can hold the connection for longer than the check that watches
it. A connection now counts as gone only while the server has stopped answering as well, so
pressing Sync now during a big fetch leaves the fetch running. And a link that drops after the
check has already passed is picked up by the next check, instead of waiting out the connection's
own timeout.

### A mailbox that changes hands mid-pass stops the old computer within seconds

Exactly one install organizes a mailbox at a time, and which one is recorded in the mailbox itself.
That record was read at the start of a sync pass and then trusted for the whole of it, so moving a
mailbox to another computer mid-pass left the old one filing mail for up to a minute afterwards.
Every move, read-state write and folder operation now asks again, through one check, and the answer
carries a deadline and a write count.

### A computer whose clock is wrong stops claiming mailboxes

A machine whose clock is badly wrong writes timestamps every other install disbelieves, so the
mailbox looks unattended, another computer takes it, and the wrong-clock machine goes on filing —
two installs organizing one mailbox. Each claim now carries the mail server's own timestamp beside
the writing computer's, and an install too far out of step writes no claim until its clock is
corrected.

### A pending stop can be changed your mind about

After pressing "Stop organizing here" the row offered no button at all until the stop landed. The
engine already treats a later "Organize here" as the newer word and cancels the stop, so "Organize
here" now stands in that slot while the stop is being carried out. A takeover also ends the stop's
own "Asked for" note, which used to come back onto the row and stay there.

### A stop that cannot be confirmed no longer says "stopping" for ever

Confirming that a mailbox has been given up needs its record folder read. When that folder is too
full to read, Settings said "Stopping on the next pass" indefinitely. After the window in which a
claim ages out of the folder on its own, the stop is recorded as done — unless another install is
visibly holding the mailbox, in which case the request keeps waiting rather than reporting the
mailbox free.

### A mailbox that sends more than one pass can take is no longer called broken

ohmail sets ceilings on what it reads from a mail server in one go — how many folders it lists,
how long a read may take, how large a message body may turn out to be. A mailbox that crossed one
of them ended up marked with an error in Settings → Mailboxes, next to a mailbox that had
connected and answered perfectly well.

Such a mailbox now stays connected and says what is actually happening: "ohmail read what it
could; this mailbox's server sent more than one pass can take. It will try again." The note
clears by itself as soon as a sync cycle finishes. A real failure — a refused password, a server
that cannot be reached, a broken secure connection — still shows as an error.

### An oversized or slow folder no longer stalls the app

ohmail keeps a little bookkeeping in a hidden folder in your mailbox, and some requests read your
mail server while you wait. Those reads were limited in how many messages they would take and in
nothing else, so one enormous message — or a server answering a byte at a time — could hold the
connection, one of the mailbox's two connection slots and the request itself for as long as the
server liked. A size limit and a time limit now apply as the reply arrives.

Past any of the three limits the answer is "this could not be read", which is what the message
limit already said: your other installs are never shown as stopped, and no organizing decision is
made from half a folder. A request that runs out of time says so and closes its connection at
once, instead of queueing a polite goodbye behind whatever is stuck.

### A sender cannot write their way into your threads, or to the top of your suggestions

The headers on an incoming message are written by whoever sent it, and three places treated them as
facts. A message reusing the Message-ID of one you already have could take its place in a
conversation and in the Ohbox — the mail was still there, and it was no longer shown. A stranger
who put a colleague's address in `Cc` could have their conversation merged into yours. And compose
suggestions were ranked by how much mail an address had sent you, so anyone could become the first
suggestion under a colleague's name.

Now a message groups or ranks on something the sender does not control: mail you sent, mail they
actually sent you, or the folder your mail server filed it in. Compose suggestions put the people
you have written to first, and label someone who has only written to you. Nothing is hidden and
nothing moves: a conversation you have not replied to keeps a new sender's reply in History until
you do.
### Mail filed while a mailbox changes hands

- The handover of moves made just before another machine took over organizing a mailbox now covers
  every one of them rather than the first two hundred, and it happens in the same step as the
  change of organizer: if it cannot be written, nothing is handed over and nothing is recorded,
  and the next check does both.
- A message you had moved once before and moved again during a handover is handed over too. The
  earlier move being finished no longer counts as this one already being on its way.

### Away replies

- When the machine that organizes the mailbox applies an away setting you saved somewhere else,
  the pane says so and shows the settings it applied, instead of leaving the old values under a
  note about a request that has already landed.
- Away replies go only to the piles you chose, and never to a site's own notification mailbox —
  `wordpress@`, `root@` and the rest of a server's mail. Addresses that merely start with one of
  those names are people, and still get a reply.
- A bounce for an away reply no longer lands in your Ohbox. It files to Receipts, and the responder
  stops writing to that address. Bounces for mail you sent yourself still reach you.
- An away setting you saved on another computer is reported as applied only when what came back is
  what you asked for. A change made somewhere else is named as that instead, with the values the
  setting now holds.
- Which piles your away replies answer travels between your computers, with the rest of your away
  settings. A computer taking the mailbox over fell back to the Ohbox and lost your choice; one
  running an older ohmail leaves your choice alone instead of resetting it.

### Sync now says what it did

- A mailbox this app holds but is not running — one it stopped organizing under an older release —
  showed a Sync now button that answered “Sync queued” and did nothing. The press is refused with
  a sentence instead, so nothing tells you a sync started when none did.
- The log now names such a mailbox at start-up, with the reason it is not being run. It named only
  how many mailboxes were running, and the one line that printed an id printed the id of the
  mailbox with no engine, which made the record read backwards.

### When this browser cannot keep your decisions, ohmail says so

In a private window, or on a browser whose storage is full, ohmail cannot write anything down
between reloads. It used to carry on as if it could: a Screener decision or a delete was reported
as done, an Undo was offered for the next few seconds, and closing the tab in that window threw
the decision away with nothing anywhere saying so.

Those few seconds exist only because nothing has been sent yet, and only a record on disk made it
safe to wait. With no record, the decision now goes at once and the toast says there is no undo. A
quiet line at the top of the app says once that this browser is not keeping your decisions between
reloads.

The desktop app and a normal browser window are unaffected.

### A Screener decision is decided in one window, not two

With ohmail open in two browser tabs, a decision made in one of them could be carried out by the
other before its few seconds of undo had run out — the mail filed and the sender unsubscribed while
the first tab still offered to take it back. Pressing that button then reported success over
something that had already happened.

A tab that opens one of those windows now says so, and a tab starting up asks before it finishes
anything it finds waiting. A sender being decided in another tab is not offered in this one, and
comes back the moment the other tab files it or takes it back. A decision left behind by a tab that
is gone is still carried out.

### A send nobody could confirm can always be answered for

A message whose send the server took and never confirmed is held in Drafts: it may already have
arrived, so sending it again could deliver it twice. The two answers you are in a position to give
— it arrived, or it didn't — are now offered everywhere such a message appears, including in a
conversation's own reply editor. That editor used to show nothing about the held row and left Send
live, so a press there started a second reply from a new draft.

Three other ways a second copy could go out are closed with it. A message still on its way stays
held even while an OLDER unconfirmed send is waiting — that older one used to switch the newer
message's hold off. Text typed into a held message, and a file attached to it, are no longer
written over when you reopen it from Drafts. And in a browser that will not let the app keep its
own records, reopening a draft no longer creates a second one beside it.

### Releases are checked more before they reach you

Two things about how a release is built, both of which affect what you download.

The build now starts the packaged Linux app and requires its window to render before the artifact
is kept. A crash that only happens at launch used to reach people who downloaded a release — it
has twice — because every check was a build or a static read. The macOS build also reads the
binary it produced for its content-security policy and for any address it should not contact,
which the Windows and Linux builds already did.

The workflow that signs updates no longer holds the signing keys while it downloads anything, and
both signers are checked against a fixed hash before they run.

### A mailbox an older version paused

A mailbox that stopped syncing here because another computer took over organizing it can be
organized from this computer again: it syncs as a reader on the next launch, and “Organize here
instead” takes effect on the following pass. Versions up to 0.13 recorded that handover by
switching the mailbox off, and it stayed off. A mailbox you removed from this computer is
untouched.

A message you had scheduled from that mailbox before it changed hands is closed with the reason it
could not be sent, instead of sitting in Drafts saying it will send. The mailbox pane says once
that the mailbox changed hands.

### The Android download points at the current release

The Android button on the download page was built from a release tag read when the site was last
built, so it could name an older release than the one the desktop buttons beside it handed out. It
links the APK attached to the current release now, through the same address the desktop downloads
use, and no build has to know a version for it to be right.

### A message you move teaches the rule that filed it

When ohmail has learned to file a sender for you and you move one of those messages somewhere
else, that move now counts against the rule. Move two of them inside a fortnight and the rule
stops filing on its own: it goes back to asking you first, and the rule shows as off in your
rules list. Confirming its suggestions again brings it back.

### A large mailbox's first sync no longer pulls everything at once

The first sync used to ask for one page of mail and, alongside it, every triage state, every held
sender and every pending suggestion in the account — with no limit on any of them. On a mailbox
with years of mail that first response was the largest one the app ever made, and it grew with the
mailbox rather than with the page.

Those now arrive with the mail they belong to, a page at a time. The first screenful comes back
sooner on a big mailbox, and mail the app has not fetched yet no longer arrives with triage state
attached — which is what could put a row titled with an id, and no sender, in Answer Later or
Parked.

### Opening a list of mail no longer costs a round of database work per message

Every list — the Ohbox, one of your own folders, the piles at the bottom — built its page one
message at a time, asking the local database the same set of questions for each. It now asks them
once for the whole page, whatever its length. The desktop's store answers one question at a time,
so a list held it for the whole of that work; it now holds it for a fraction of it, and mail
arriving in the background waits behind it less.

### A self-hosted install listens only where you told it to

The front door published ports 80 and 443 with no address, which binds every interface the machine
has — a rented server's public IP included. `OHMAIL_BIND` in `.env` now decides, and defaults to
`127.0.0.1`.

**If your install serves a public domain, set `OHMAIL_BIND=0.0.0.0` when you take the new compose
file.** Without it the stack comes back up on loopback, your domain stops answering, and
certificate renewal stops with it.

### A desktop signed in to your own server forwards only the requests it should

A desktop install in cloud mode serves reads from its local copy of your mail and forwards
everything else to the server its door names. It refused two paths and forwarded the rest, so
several spellings of the browser sign-in hand-off reached that server with a live sign-in code.

It now forwards only the routes the server's own route table marks as forwardable, and answers 404
to everything else. Signing in through a browser still tells you, on your own server, to use your
password and authenticator code instead.

### A release writes every self-host image's version tag before any latest tag moves

A release wrote each self-host image's version tag and its `latest` tag together, one image at a
time, so a `docker compose pull` during a release could fetch a new server beside an old organizer.
Every version tag is now written first and checked, and `latest` moves only after that.

Three registry tags still cannot move at once. Pin `OHMAIL_IMAGE_TAG` to a version if you would
rather choose when you take a release.

### The self-host boot check can pass a healthy stack again

The boot check sent no `Idempotency-Key` at the attachment-staging step, which the API requires, so
it failed a stack that was working. Fixed. The mail server its mailbox and sync steps use is set by
`SMOKE_MAIL_HOST`, `SMOKE_MAIL_PORT`, `SMOKE_MAIL_DOMAIN` and `SMOKE_MAIL_PASS`, and its compose
defaults are the stack in its own directory.

### A self-hosted install can sit behind a TLS terminator it does not own

Set `OHMAIL_EXTERNAL_TLS=1` in `.env` and the proxy serves plain HTTP on port 80 and holds no
certificate, while `OHMAIL_ORIGIN` keeps naming the https address your terminator presents. Point
the terminator at port 80 on `OHMAIL_BIND`. This makes `tailscale serve`, an existing reverse proxy
and a load balancer workable; the self-host guide's note that they were not is corrected.

`X-Forwarded-For` and `X-Forwarded-Proto` are honoured from `OHMAIL_TLS_TERMINATOR` and nowhere
else. Session cookies are unaffected on either door.

### Two self-hosted stacks on one machine no longer adopt each other

The compose project name was fixed, so a second stack in a second directory was the same project
and its first start took over the first install's containers and volumes. `OHMAIL_PROJECT` now
names each stack, defaulting to the name existing installs already have. Changing it on a running
install orphans that install's volumes, so choose it before first boot.

## [0.16.1] — 2026-09-10

### The message actions use the width they have

On a wide window the actions under a message stopped at Reply, Reply all, Forward and Mark unread
and folded the rest behind the More chevron. The row is no longer held to the width of the text
column: it spans the reading pane, stays centred under the message, and fills that room one action
at a time — Later, Park and Resurface first, then Tag, Screening and Move — in one order, whether
the message is part of a thread or on its own. Anything still folded keeps its place in the menu
and its keyboard shortcut.

### Trash and filing

- Deleting a message again while a restore of it was still travelling to your mail server no
  longer leaves it out of both your mail and Trash.
- Restoring says “Restoring to Ohbox…” until your mail server has actually moved the message,
  instead of reporting it as already back.
- Restoring a message you deleted on a device that is not the one organizing the mailbox puts it
  back in the folder it came from, rather than in your Ohbox.
- A restore whose answer never reached the app is finished on the next launch instead of saying
  it could not be restored.
- A move or delete made from a paired device just as another machine took over organizing the
  mailbox is handed to that machine, instead of being recorded on the old one and never sent.

### Triage piles on the desktop

- Mail you set aside, put in Answer Later or parked until a later time stayed in your Ohbox
  and was missing from its pile. Parked mail now waits under Resurface until its time comes,
  as it does on the web.
- Clearing one of those piles on another device now clears it here too.

### Away replies

- Saving away settings from a device that does not organize the mailbox says the change is
  waiting for the machine that does, instead of “Saved.” over the values it put back.
- Receipts and the Screener can be answered too, if you tick them. Mailing lists, no-reply
  addresses, bounces and anything a sender marked automatic are still never answered, whichever
  piles you choose. The Screener follows “Who gets a reply”, so it can only be answered while
  that is set to everyone who writes.
- You can give the responder a date to switch itself off on. It answers until the end of that day
  and then turns itself off, so the switch says what it is doing.

### A connection that stops answering is noticed in seconds

A network can drop the link to your mail server without telling either end: the connection looks
open and every command sent over it waits for an answer that never comes. ohmail used to wait out
that connection's own timeout — around two minutes — before opening a new one.

It now sends a keep-alive between passes and treats a connection that has not answered within
thirty seconds as gone: it opens a fresh one and re-reads which install is organizing the mailbox
before moving any mail. Pressing Sync now does the same check. Settings → Mailboxes says the
server cannot be reached, and for how long, while this is going on.

And when the check behind that row is itself the thing that stops answering, the row says it
cannot check the mail server rather than reading Up to date.

### Sync now can be pressed again

The button is disabled only until a press you made has been answered. It used to stay greyed out
reading "Sync queued" for the rest of your visit to the screen, and a sync the app started on its
own could take it away too. A mailbox that is syncing says so on its own row.

### Filing is steadier when two decisions land at once

Filing a message takes a round trip to your mail server, and until now a decision made while that
round trip was in flight could be replaced by the older one — so a message you had just re-filed
went back to where you had changed your mind away from. The newer decision now wins, and the app
records where the server actually put the message.

Three fixes on the same path. A reference to a message is trusted only under a folder generation
your server actually named, so a folder your provider deletes and recreates can no longer make a
move, a flag or a read land on a different message. A folder that changed generation while a large
sync was still running no longer repeats that sync forever. And a bulk delete on the server no
longer holds up new mail while the app catches up with it.

Mail that a second machine on the same account filed into one of the ohmail folders is also
repaired once, on first run of this release: it was recorded as if you had filed it by hand, which
is why it sat where it landed even when the sender already had a rule pointing elsewhere. Mail you
moved yourself is left exactly where you put it.

### About names the build this app was made from

Settings → About showed the version and nothing else, so two builds of the same release looked
identical from inside the app. The row now reads the version followed by the first nine characters
of the commit it was built from, which is what a bug report needs to be answerable. A build made
from a checkout shows the version alone.

### Self-hosting: no plans, no metering, no billing surface

The server no longer carries subscription billing or credit accounting. A self-hosted or
standalone install has no plan to choose, no balance to run out of and no billing screen — every
limit is off, and AI features run on the provider keys you configure.

Fresh installs never create the billing tables. An install that already has them drops the empty
ones when it migrates; a table that still holds rows is left in place and named in the migration
log, so nothing is removed without you deciding to.

### The engine's log

- A failure the mail server reported as plain text was written to the app's log with the mailbox
  address still in it. The address is replaced before the line is written, and the message itself
  is kept — it is often the only account of what the server refused.

### A door with no account asks nothing about one

A standalone install, and one paired to another computer, no longer asks where to manage a
subscription each time the window opens. Neither door has an account behind it, so there was
never an answer to that question; nothing on screen changes.

## [0.16.0] — 2026-09-10

### Trash and filing

- Backspace, Delete and `d` move a message to Trash whether or not Use folders is on — Trash is your
  mail server's own folder. On the web already; in the desktop app with this release.
- The line under a message being filed says what is happening — filing, waiting for the organizing machine,
  or held up, and by which machine — and brings the organizer forward rather than waiting for its next pass.
- Trash: see and restore deleted mail from ⌘K (Ctrl+K), or `g` then `t`. Restore puts a message back
  where it was, with Undo, and Shift+Backspace restores the open one. ohmail still never erases mail.

### Reading

- The first press of a key that acts on a message selects the first message and names the key:
  "First message selected. Press again: Move it to Trash". The second press acts.
- The count over Reads and Receipts reads "12 new since you were here", because it counts mail that
  arrived since you last left the stream; an unread figure keeps its own word, "3 unread".
- The row of verbs under a message is centred under the message, so folding a group behind More
  takes room off both ends instead of shifting the capsule left.
- Reads and Receipts hold their place while you scroll: cards reserve their real height, a collapsed
  card no longer resizes when its message arrives, and the wheel no longer scrolls inside a card.
- The tracking notice is a small (i) beside the date — "Tracker blocked", "Images blocked",
  "Stylesheet blocked" — rather than a boxed line above the message.

### Writing and sending

- A send that finishes without a clear answer holds the draft, and the held row now carries **It
  arrived**, which records the send and takes the row out of Drafts, and **It didn't arrive**, which
  turns it back into an ordinary draft. A held draft could not be discarded at all before, nor
  could one whose send definitively failed.
- Your signature uses the same editor as your messages — bold, italic, strike, links, lists, quotes
  and code — and the block under a message shows what ships. Saving plain text clears the formatting.
- Text fields look the same everywhere: a visible edge before you type, one focus ring, and the same
  read-only and disabled states.

### Away replies

- The responder's replies stay in your mail server's Sent folder instead of filling your Ohbox, and
  mail it answered no longer counts as mail you have handled. Fixed on ohmail Cloud on 2026-09-09;
  in the desktop app with this release.
- Which piles get a reply is its own setting now — your Ohbox alone by default, with Reads available;
  Receipts, the Screener and Spam are never answered. **This narrows a responder already switched
  on**: from this release it stops answering Reads and Receipts.
- The Away pane and the Ohbox banner name those piles, the banner scrolls with the list on a phone, and
  what is never answered is an (i) beside the setting. A bounce stops the automatic replies to that sender.
- A message the responder answered carries one line under the recipients — "Answered by the away
  responder", with the time — and never counts as mail you have dealt with. On the web already.

### Settings, rules and mail on a mailbox another machine organizes

Your out-of-office, screening posture, screening reach and sign-off are applied by the install that
organizes a mailbox, and an edit made on a device that only reads it never arrived there: you could
set an out-of-office and no out-of-office would ever be sent.

- All four travel now, as a request the organizing install carries out. Only the setting you changed
  travels, and one save covers an account whose mailboxes are organized in different places.
- Moving a message, deleting one, approving a sender out of the Screener and editing a rule travel the same
  way: the answer names the install being waited on, or which mailboxes took the rule and which run a
  version too old. Changing a message's folder used to be recorded only on this device; it travels too now.
- Changing what a rule MATCHES cannot travel and is refused with that reason; deleting one keeps it
  visible until it is gone there. Undoing a workflow run, and the re-route for rules brought over
  from Hey, refuse and name the mailbox and the install holding it.
- An install that only reads a mailbox keeps a copy of the settings in force on it, refreshed every
  few minutes, with the mailbox's signature and the requests the organizer can carry out. Settings →
  Mailboxes gives each mailbox one chip instead of a boxed paragraph under every row.

### Search

- Every result carries the sender's name and the address under it, and the address is a link that
  opens one correspondent: what that address sent and what was sent to it, either direction or both.
- That view says what it can see — this device answers all three directions, the archive by sender
  only — and mail you have sent is listed for the first time, marked "Sent".
- A hyphenated or dotted run is searched as itself and its parts — so `D-U-N-S` and `d-u-n-s`
  reach a message neither found before.
- A search of the whole archive that never comes back now ends: "The archive did not answer."

### Doors: a laptop through your desktop, and a server you run

- The setup chooser has a fourth door, **Another computer**, meant to take the pairing link the
  first machine hands out under Settings → Devices. It does not work, and did not in this version:
  it is marked unavailable from 0.19.1 and is due in a later version. Pairing a **phone** or a
  computer running ohmail, which is the other half of Settings → Devices, works and is unaffected.
- A pairing link works once and is checked before it is used, so a link that is not one, a plain
  unencrypted address, a changed key and something that is not ohmail are refused before the setup
  is touched. A link already used is refused when it is redeemed, a moment later.
- When that computer is not answering, the app says so and keeps saying so: the mail on screen is
  real and readable, nothing can be changed until it is back, and the line cannot be dismissed.
- An install with no mailbox connected can finish the "Your own server" door: it points itself at
  the address, asks that server whether it is there, and puts itself back if the answer is no.
- The address you type is dialled by a connection made for it, so a server you run that was
  answering is no longer reported unreachable because another computer of yours was off.
- When a mail server's certificate is for a different name than the one you typed, ohmail stops
  before sending your password, says which name the certificate covers, and offers it as a press:
  `Use <host> as the IMAP server`, or SMTP where the outgoing server did not match.

### Screen readers and small controls

A settings banner and every settings row's value — including whether a mailbox's mail server can be
reached — were on screen and out of reach; both are read now. The compose body and the inline reply
editor report themselves as text boxes, and four small controls take a full press band under 640px.

### RPM packages for Fedora and openSUSE

Every release attaches an `.rpm` per architecture, beside the two `.deb` packages and the two
AppImages. Like the `.deb`, it updates by installing the next one, not through the app's own updater.

    sudo dnf install ./ohmail-linux-x86_64.rpm      # Fedora, RHEL, CentOS Stream
    sudo zypper install ./ohmail-linux-x86_64.rpm   # openSUSE

### Sentences that say what the product does

Eight sentences described software that does not exist, and each is the plain fact now. Settings →
About no longer says the publisher signs this app, because the builds are not signed, and the privacy
notice names all three platforms as the real mail clients they have been since 0.7.0. The composer's
footnote no longer says a message is kept in this browser until you send it: it is not a browser in
the desktop app, and drafts are saved to your account after a moment.

## [0.15.0] — 2026-09-09

### The phone chooser says what a phone can be

The chooser offers three answers — ohmail Cloud, a server you run, or your own computer — and left
the obvious next question unanswered: what if you have none of those? A phone does not organize a
mailbox on its own, and the chooser now says so in one sentence, in English and German, under the
three doors. It appears at first run and on the "Add a server" panel, which is where somebody who
has already connected one server goes looking.

### Small fixes on phones

**Keyboard shortcuts are no longer printed on devices that have no keyboard.** The action row
labelled its verbs with the keys that trigger them — `r` for reply, `⇧f` for forward — and those
labels rendered on phones, naming keys the device cannot type. They are hidden where the primary
pointer is a finger. The shortcuts themselves are unchanged, and still shown, on anything with a
keyboard.

**The notification strip clears the home indicator.** The strip that appears after an action, with
its Undo, was placed a fixed distance from the bottom of the window. On a phone whose screen
extends under a home indicator that distance was measured from the glass rather than from the
usable area, which could put the strip and the action row it was spaced away from in the same
place. Both now allow for it.

**The Screener's full-screen read reserved space for nothing.** Reading a sender's mail full-screen
on a phone left 60 pixels empty under the last line for a control that is not there — that screen's
decision buttons are at the top. It reserves what every other scrolling list in the app reserves
instead, and allows for the home indicator, which the old number did not.

### On the phone, message bodies read at the reader's size and long button labels wrap

**On the phone a message body reads at the reader's size.** Opening a message on a phone opens the
reader, and the reader sets its body a point larger than the pane the wide layout reads in, with
more air between the lines. The phone app was setting the pane's size; it now sets the reader's,
which is what the browser has always done at that width.

**A button label that does not fit wraps instead of crossing the panel.** Labelled buttons in the
Screener strip and in settings kept their text on one line at any width, so a label longer than the
space — German runs longer than the English these were laid out against — pushed past the edge of
the panel around it. Below 640px they wrap onto a second line, and the button grows taller to hold it.

### The same message cannot be sent twice, even from a client that has lost its place

Sending has always been protected two ways: by a key the app mints and reuses when it retries, and
by a rule that a message already on its way cannot be sent again from the same draft. Both depend on
something the app is still holding. An app that has lost both — a fresh install, a second device, a
browser whose storage was cleared, an older build — and that writes a new draft holding the same
words gets past both, and the person receives the message twice. There is no taking that back.

So the account now claims the message itself. When a send is reserved, the server records a digest
of what a recipient would perceive: the recipients, the subject, the text that goes out, the reply
or forward it belongs to, the scheduled time, and the contents of any files attached in the
composer. For an hour, a second send of exactly that message from the same address is refused —
whatever key it arrives under, and whatever draft it names. Nothing is submitted, the draft is left
untouched and ready to send, and the composer says what became of the first attempt: whether it is
known to have been sent, could not be confirmed, or is going out right now. Those are three
different facts and they get three different sentences. For a message known to have been sent, the
time named is the time that send was recorded as sent — the one to look for in the Sent folder —
rather than the time the first attempt was reserved, which can be up to an hour earlier when an
attempt's outcome was unknown at the time and only confirmed later.

**A message carrying an UPLOADED attachment is not covered by this.** Large files are uploaded before
the message goes, and their contents are not readable at the moment a send is reserved — only the
name, type and size are, and those do not identify a file: a corrected version of the same size
would have been mistaken for the original and refused. Rather than claim a protection it does not
have, such a message is left out of this check. It keeps the two defences it always had: the key the
app holds for that send, which does account for attached file contents, and the rule that a message
already on its way cannot be sent again from the same draft.

Anything a recipient would notice makes it a different message and it sends: one character of the
text, one more person on the copy line, a different file attached in the composer, a different
message forwarded. So does sending it again once the hour has passed, and so does sending it again
after an attempt that definitely failed — the ordinary "the mail server was unreachable, try again"
retry, which must keep working.

### The verbs stay with you while you read a long message

Opening a message in Reads or Receipts expanded the card in place and put its verbs — reply,
forward, park, resurface, move, delete — at the very bottom of it. On a long message that is a
screen or more below where you are reading: on a phone the row sat 2 700 pixels down an 844-pixel
window, so answering the mail you had just read meant scrolling past all of it first.

The row now rests against the bottom of the reading area while the message is taller than the
window, and settles into place at the end of the message when you reach it. It stays inside the
card it belongs to — it never rides over the message above or below — and it does not hide itself
when you scroll down, which is the direction you read in. There is no scrim over the text: the row
is an opaque capsule, the same one the reading column and the reading overlay use, and the text
passes under it as it does there.

Its More menu opens upward, and stays inside the window at every width in both languages.

### Reading views say who else got the message

A message in Reads showed who sent it and when, and nothing about who it was addressed to — so
mail written to you alone and mail sent to a list of eleven looked exactly the same until you
opened it.

The reading views now carry the same recipients line the message header has always had: the
people a message went to, named, under the subject. It is the same block in both places rather
than a second one written to look like it, so a name is drawn the same way and does the same
thing wherever you meet it — pressing one still offers to copy the address, write to that person,
or open their screener settings.

A card has one head's worth of room, so it names the first two and folds the rest into a count
you can press; pressing it names everyone, along with the exact date and the folder the message
sits in on your server. A message addressed to one person draws no line at all — "To: you" under
every subject in the stream is not worth the space.

### Selecting messages uses the same bar as reading one

Picking several messages in the Ohbox used to raise a strip of its own above the list: its own
colour, its own shape, its own idea of which verbs fit. It was a third kind of control for verbs
that already exist elsewhere, it pushed the mail down by up to 142 pixels on a phone, and in
German its own last button was cut off at the edge of the strip.

A selection now uses the message action bar — the same rounded bar, the same grouping, the same
More menu — standing at the foot of the list where the reading column's bar stands at the foot of
a message. On a wide window the two sit on one line. The verbs are the ones a single message
offers, minus the ones that mean nothing over a set: there is no Reply over eleven messages.

The count is the bar's first button: "× 7 selected", in the same colour as the selected rows, and
pressing it clears the selection. Where the bar runs out of room it drops that button's word and
keeps the number, exactly as the message bar drops the read control's words — measured in the font
your system is really drawing, so it behaves the same in German and on either face.

Selecting is easier to do and easier to undo. Cmd-click (Ctrl-click) picks a single row without
moving the cursor. Shift with the arrow keys, or Shift-J and Shift-K, extends the selection from
where it started; extending only ever adds, so walking back over a row never quietly unpicks it.
Escape clears; clicking elsewhere does not.

While a selection is up, the verb keys act on it — a parks the selection, m moves it, and so on —
and the shortcut sheet says so in those words. With nothing selected the same keys mean what they
always did, on the message under the cursor.

Delete works over a selection too, through the same undo window a single delete uses: the whole
set goes in one press, the toast carries one Undo for all of it, and nothing is sent until the
toast goes. The menu item and d ask first and state how many; Backspace and Delete go straight to
the undo window.

On a mailbox another ohmail install is organizing, Move, Screening and Delete are refused when you
press them rather than after the mail has moved and come back, in the sentence the rest of the app
uses — and the selection stays, so you do not have to build it again.

That question is asked of every mailbox the selection actually spans, not of the account. A
selection can hold mail from a mailbox this install organizes and mail from one it does not, and
in that case the whole press is refused rather than the part of it that would have worked —
moving four of seven and saying nothing about the other three is a result nobody asked for and no
message could describe honestly. On a machine with no mailbox list of its own, nothing changes:
the server remains the authority there, as it always was.

Moving a single message is refused the same way, and it used to be the case that showed the
problem most plainly: the message left the list, the server declined the request, and it
reappeared a moment later with nothing on screen saying why.

Keyboard hints no longer draw on touch screens, or in windows too narrow to hold both the hint and
the verb it belongs to.

Backspace and Delete no longer reach a selection through something opened over it. With rows
selected and the shortcut sheet, a menu or a popover standing on top, pressing either key filed
the selection anyway. The keys now ask what is actually on screen before they act, so anything
standing over the list holds them off — and they work again the moment it closes. The reading
sheet is deliberately not one of those things: deleting the message you are reading is exactly
what the key means there.

Holding Shift no longer runs a shortcut that did not ask for it. Shift-Backspace and
Shift-Delete were reaching the ordinary delete — on Windows that combination means "delete
permanently", and in several editors it kills a line, so anyone pressing it meant something
other than this app's undoable delete. Any named key — Backspace, Delete, Enter, Escape, the
arrows — now needs its shortcut to ask for Shift before a shifted press counts. Punctuation is
unchanged, because Shift is how those characters are typed: ? still opens the shortcut sheet.

On a phone, hold a row for about half a second to start a selection. Until now there was no way
in at all on a touch screen — picking a row needed a key or a modifier — so the whole selection
bar was desktop-only. While a selection is up, tapping a row adds it or takes it out instead of
opening it, and the count button ends the mode. A hold that moves is a scroll, and a hold with a
mouse does nothing: the desktop already has x and Cmd-click.

### Backspace and Delete move a message to Trash

Press either key on the message you are looking at and it goes to the Trash folder on your own
mail server. It is a move, never a permanent erase — ohmail does not expunge mail, and what
happens after the move is your mail server's Trash policy. Both keys work, with Use folders on,
on every list that shows a message with a cursor on it, and both are listed in the
shortcut sheet (`?`).

The press is undoable, and the undo is real rather than cosmetic. There is no un-delete on the
wire, so instead of sending the request and offering to take it back, the press hides the message
and holds the request for the length of the toast. Undo inside that window cancels a delete that
was never sent; let the toast go and it is filed. The keys share one dispatch path with the
action bar's own confirm button, so that button now carries the same window.

The request is written to this browser's storage before the window opens, so closing the tab
inside it does not lose the delete: what can still be sent on the way out is sent, and anything
left is finished the next time you open ohmail. Undo removes the record along with the request.

The keys stay out of the way where a delete is not what you meant. They do nothing while you are
typing in any text field — where Backspace is the most-pressed key on the keyboard — and nothing
while a dialog, menu or popover stands over the app, including the first-run screens and menus
opened on a message. That is decided by looking at what is actually on screen rather than by a
list the app keeps of its own panels, so a panel added later is covered without anyone
remembering to add it. The reading view is not treated as something in the way: deleting the
message you are reading is exactly what the key is for.

On a mailbox another ohmail install is organizing, the press is refused before it does anything
and says so, in the same sentence the app already uses for a move made where mail is not filed
from. The question is asked about that message's own mailbox, so an account that organizes one
mailbox and only reads another gets the right answer for each. If the app does not yet know who
organizes a mailbox — during startup, or while it cannot reach the server — the press is refused
rather than guessed at. Nothing is hidden and nothing is sent in either case.

One press is one undo, whatever it covers. The same window serves a press over a whole selection:
one toast, one Undo that takes all of it back, and one record on disk — so a tab closed inside the
window commits the selection whole rather than an arbitrary part of it. A selection spanning a
mailbox this install organizes and one it only reads is refused entirely, never the permitted half.

### A window left open no longer holds every render's work, and a parked card can be unparked

**A desktop window left open no longer holds every render's work.** The shell keeps a
memoized callback for every action, so the same function can be handed back on renders where
nothing it depends on has moved. One reference like that kept the entire render it was created in
alive — including everything that render had derived over the whole mailbox — and the window
gained one such retained render per update, releasing none of them. Better dependency lists cannot
fix that, because the problem is not which render's function survives but that any surviving
function holds a whole render with it. Every callback in the shell's main view now keeps a stable
identity and reads current values through a reference, so a callback that outlives its render keeps
nothing else alive.

**A message parked from the reading pane can be unparked from the same card.** Opening a message in
Reads or Receipts and pressing Park moved it, but the button did not change: the card was still
holding the copy of the message it had been drawn with. Pressing Park again let that stale copy
decide, and it still looked unparked, so the message was parked a second time instead of being put
back. Cards are skipped when nothing they draw has changed, and messages were compared by id alone
— right for a subject or a sender, wrong for the three fields the action bar draws and the message
can change. Those three are now compared at the values the bar reads.

### Four small fixes in the reading pane

**The More menu closes when you press More again.** A pointer press begins before the click lands,
and the menu was dismissing itself on the first half of the press and reopening on the second — so
the first thing anybody tries in order to put a menu away did nothing at all.

**A delete question that stops applying is put away properly.** The confirmation stands only while
folders are in use and the message is held on this machine. When one of those changed while the
question was on screen, the question disappeared but something invisible stayed open behind it, and
the next Escape was spent on that instead of closing the message. Escape now leaves the message —
and if the setting comes back, the question is not restored behind your back: you press Delete
again.

**Resurface, Move and Delete keep the keyboard.** Opening the Resurface chooser left the keyboard on
a control that had just gone, so the chooser could not be answered without tabbing in from the top
of the page; it starts on its first choice now, as Move and Delete already did. And cancelling any
of the three — with the button or with Escape — puts the keyboard back on the control that opened
it, instead of dropping it at the top of the page.

**Widening the window no longer loses the open menu.** As the reading area gets wider the bar takes
verbs back out of the More menu and into the row. If the keyboard was on one of those verbs the menu
lost it: the arrow keys stopped working, and the next letter typed acted on the mail behind the menu
instead. The keyboard now moves to the nearest verb still in the menu, or back to the button if the
menu has emptied — and while a menu is open, a letter belongs to the menu.

### Compose opens ready to type

Pressing Compose puts the cursor in the To field. When the recipients are already answered — a
reopened draft, a forward — the cursor lands where the writing resumes: the subject, or the
message body.

Letters typed while the compose form is open no longer act as keyboard shortcuts on the mailbox
behind it. Before this, if nothing on the form had focus — after a click on empty space, say —
each typed letter still ran its one-key mailbox verb, so writing a message could file, park or
navigate away from mail behind the form while the form itself stayed empty. Escape, Tab, Enter
and the modifier shortcuts (such as ⌘K) still work over the form, and so do the shortcut sheet
(`?`) and the send-later number keys.

### Clearing a search, a keyboard hint on the demo, and one name for the Ohbox

**Escape in Search leaves the caret in the box.** Pressing Escape clears the question, and after
arrowing down to a result it used to leave the keyboard focused on nothing: the highlighted row went
away with the rest of the results, and the next letter typed was read as a shortcut instead of as
the start of a new question. Escape now clears the search and puts the caret back where you type.

**The keyboard hint on the front page says Ctrl where there is no ⌘.** The app's keycaps were
corrected in an earlier release; the hint under the demo on ohmail.app was typed by hand and kept
saying "⌘K" to everyone. It reads the visitor's own keyboard now, like the caps inside the app.

**One name for the Ohbox, in both lists that name it.** The command palette said "Go to Ohbox"
and the shortcut list said "Go to the Ohbox" — the same instruction, one word apart, in the two
places you go looking for it. Both read the same sentence now, and so do Reads and Receipts.

### A computer that stopped organizing no longer holds the mailbox for ever

Organizing a mailbox means keeping a record inside the mailbox itself saying which install is doing
it, so that a second computer can see the mailbox is taken. A record nobody has renewed for ten
minutes has lapsed, and from then on you can press Organize here on another computer and take the
mailbox over.

That was not true of a record this version cannot read — one written in a newer format, or naming a
kind of organizer this release does not know about. The app refuses to take a mailbox from an
organizer it cannot place, which is right for as long as that organizer is still there, and the
refusal was meant to end when the record lapsed. It never ended. The age of a record was measured
against the newest record in the same mailbox, so a mailbox holding only one record measured that
record against itself and read it as current whatever its date said. A computer that stopped
organizing months ago and left its record behind refused every takeover, from every other computer,
with no way out short of deleting the message by hand.

The newest record in a mailbox is now measured against the clock of the computer reading it, and
every older record is still measured against that newest one -- which is what keeps two computers
with two clocks from disagreeing about who holds the mailbox.

A second way to hold a mailbox for ever came out of closing the first. A date far enough in the
future is ahead of any reader's clock, so it reads as current at every real moment, and a machine
with a dead clock battery could hold a mailbox on nothing but a wrong date. A date beyond the
tolerance for ordinary differences between two machines' clocks is now taken to say nothing at all
about when the record was last renewed: such a record holds the mailbox only while something
believable in the same mailbox is still being renewed. Inside the tolerance a clock that runs ahead
is still believed, which is the case that matters -- treating a machine that is slightly ahead as
gone is how two computers both decide they are the organizer.

And a wrong date could push a working organizer out. Because the age of a record was judged against
the newest date in the mailbox, a date in the future dragged that comparison forward, and a record
written seconds ago could read as expired beside it -- so a computer that was organizing the mailbox
and checking in normally could be taken over by another, on the strength of a wrong date in a third
record. It did not take an absurd date: a few minutes ahead was enough. Dates are no longer used to
judge how old OTHER records are once they run ahead of the reading computer's own clock, and a date
beyond what a clock difference could explain is not used for anything. A machine whose clock runs a
little fast is still believed to be alive, which is the case that has to keep working; it simply no
longer ages its neighbours.

Two more ways a mailbox could get stuck, both of which needed a second record to appear.

**A mailbox with two abandoned records stayed stuck when either one alone would have recovered.**
The age of a record was measured against the newest record present, and with two old records the
newest was itself old -- so each looked recent beside the other and the mailbox refused every
takeover for ever. Whether a mailbox has been abandoned is now decided for the mailbox as a whole,
against the clock of the computer reading it, before any record is compared with any other. If
nothing has checked in for ten minutes, nothing in that mailbox is holding it.

**And a computer that was organizing could be reported as stopped, letting a second one start.**
When one computer left two records behind -- the ordinary result of a renewal that was interrupted
-- the screen described it by the newer record alone, which could be the leftover rather than the
live one. It was then shown as stopped, and the record of who was organizing could be cleared while
that computer was still working. Both the screen and the clearing now look at every record a
computer has left, not just the newest.

Three smaller corrections in the same area.

**A mailbox set to wait longer than the default before treating an organizer as gone was not
waiting that long everywhere.** The setting reached the part that decides whether this computer may
organize, and not the part that reports who is organizing -- so on a mailbox configured to wait a
day, the report could say nobody was organizing while the decision still said somebody was, and the
record of who held the mailbox could be cleared while another computer was well inside its own
time. Both now use the mailbox's own setting.

**The screen could name the wrong computer.** When two computers had each left an extra record
behind with an unusable date, the name shown was chosen by whichever unusable date happened to be
later -- which could be the computer that had just stood down rather than the one organizing. A date
nobody can believe no longer decides that name.

**And a mailbox told to wait no time at all now waits no time at all.** A record dated slightly in
the future was still counted as current under a zero wait. That setting is unusual, and it now
means what it says.

Two things deliberately did not change. A record that is genuinely still being renewed refuses a
takeover exactly as before, and a record with an unusable date sitting beside one that is being
renewed refuses too, because then something is organizing the mailbox even if we cannot tell what.
And a computer that finds only its own record in a mailbox still resumes organizing without asking
anybody, however long it has been asleep.

The screen that tells you who is organizing a mailbox reads the same rule as the button beside it.
It no longer names a live organizer for a record the app had already stopped defending, and no
longer offers to stop a computer that has already stopped.

### The mailbox row says when it cannot check, instead of "Up to date"

0.14.2 taught this row the difference between an answer and a bad answer. There was a fourth case
underneath: the question never ARRIVING. Settings → Mailboxes asks the mail engine on your own
computer, every fifteen seconds, which of your mailboxes it can currently reach; when that question
could not be put to the engine at all, the pane treated it exactly as it treats an engine too old
to be asked — silence, keep the state you had — and the row went on saying "Up to date".

On Windows that was reproducible through a nine-minute outage. The engine had noticed the dropped
connection, was retrying it, and had recorded how long it had been down; the row said the mailbox
was fine. Its "Last checked" stamp, which comes from a different read, was right the whole time —
the two halves of one row disagreed for nine minutes.

The two silences are told apart now. A question that could not be delivered says so — "Can't check
the mail server right now" — and so does a mailbox this computer organizes that the engine's answer
does not mention at all, because the engine answers that question from every mailbox it holds. An
engine too old to be asked keeps the row exactly as it was: that silence is ordinary, it happens
while an update lands, and it says nothing about anybody's mail server.

### Re-filing mail on a mailbox another install organizes

Exactly one install organizes a mailbox at a time; the others read it. A message can be re-filed
either by asking to move it or by amending it and naming a folder, and underneath the two do the
same thing — they record where the message should be, and the regular sync pass performs the move on
the server. Only the first checked whether this install is the one organizing that mailbox.

So on a mailbox you read rather than organize, amending a message's folder wrote the change down and
reported success. The message appeared in its new place and the mail server was never told. What you
were shown was not true, and the change stayed on file to be carried out if this install ever became
the one organizing that mailbox — moving mail on a decision made when it had no business making it.

Both ways of re-filing now answer the same way, and the refusal names the machine that holds the
mailbox. Marking mail read is untouched: that is something an install reading a mailbox is genuinely
allowed to do, and it still happens immediately.

### Setup credits on ohmail Cloud: whether one was granted, and why not

An ohmail Cloud account on a paid plan receives a one-time pool of screening credits when it
connects its first mailbox — a month of that plan's own allowance, held separately from the monthly
balance and written in the same step as the mailbox itself, so a connection that fails grants
nothing. That much is not new. What is new is that the service now records what happened each time
it tried.

Connecting a mailbox succeeds whether or not a pool was written, so an account holding no pool
looked exactly like an account whose pool was never attempted, and the several reasons one is
withheld looked like each other. The service now records which of five things happened — the pool
was granted, the account already held one, another connection granted one first, it has no
subscription to size one from, or its plan sells no credits — beside the account and the mailbox
concerned. That record goes to the server's own log, where somebody answering a question about an
account can read it. None of it is shown to you, and nothing about connecting a mailbox looks
different. A failure to write that line can never become the reason a mailbox failed to connect,
while a failure to write the pool itself still stops the connection, exactly as before.

Signing in to a provider grants the pool exactly as connecting with a password does. Whichever way
a mailbox is connected, a first connection grants the pool, reconnecting a mailbox that already
exists grants nothing, and connecting one mailbox each way grants one pool between them.

### The trial note counts credits, not actions

The number in "500 AI actions to try" was never a count of actions — it is a credit balance, and an
action costs between one and twenty credits depending on what it is. Screening a sender costs one; a
drafted reply costs fifteen. So the sentence promised as much as twenty times what the trial holds,
to somebody it was inviting to try the drafts.

Every place that puts a figure against the unit now says credits: the trial notes on the pricing
page and in signup, the plan line in signup, the answer about the trial, and the notice in the app
that tells you how much of a trial balance is left. The answer that states the price of each action
was already correct and is unchanged; the plan cards now link to it.

### A fault inside the local mail engine is written down

When the window asks the mail engine on your own computer for something and the engine hits a
failure it does not recognise, it answers "internal error" and the window tells you something went
wrong. That answer used to be everything there was: the engine wrote no line about it, so
`engine.log` — the file the app keeps for exactly this, and the one thing worth sending with a
report — held nothing at all about the request that failed.

It now records one line per such failure, naming the request it was answering and what kind of
failure it was. As with every other line in that file, it does not carry the failure's own message,
your address, or anything from the request. Nothing about what the window shows you changes; the
difference is that afterwards there is something to read.

### The local engine's answers carry a request id

Every answer from the mail engine on your own computer now includes an `X-Request-Id`
header — one value naming that single request. The hosted services have always sent it.
The engine minted the id internally and never returned it, so a report about an action
that failed carried nothing identifying which action it was.

Nothing else about a response changes, and the hosted services send the same value they
sent before.

## [0.14.2] — 2026-09-08

### Settings → Mailboxes says what it knows, and stops naming what it does not

Five sentences on the mailbox rows described a state the install was not in.

**A question the app could not get answered read as a working mailbox.** Settings asks the mail
engine on your own computer, every fifteen seconds, which of your mailboxes it can currently
reach. If that came back refused, or failed, or arrived as something that is not a list of
mailboxes, the pane treated it as no answer at all: every row went on saying "Up to date" while
nothing could be said about whether any mail was moving.

The row now says the mail server cannot be *checked* right now — not that it cannot be reached.
Those are different facts and only one of them had happened: what refused was the engine on this
machine, asked about its own connections, and your mail server may be working perfectly. That also
means a single bad answer costs you one interval of "cannot check" instead of a false outage, and
the next good answer replaces it.

An engine too old to be asked the question at all is a third thing again — silence, not a bad
answer — and there the rows keep the state they had: a desktop updates on its own schedule, and a
window newer than its engine must not announce anything.

**"Stop organizing here" left no trace on some mailboxes.** The row that says what this computer
does with a mailbox — and carries the stop — was withheld entirely on installs that took the
mailbox over through the organizing hand-off rather than through the setup flow, and on mailboxes
connected before that record existed. Pressing stop from anywhere else then showed nowhere: the row
read as an ordinary organized mailbox with nothing pending. The row now says "Stopping on the next
pass" whenever a stop is standing on a mailbox this computer organizes. A mailbox organized
somewhere else does not carry that sentence even if a stop was once asked for here — the request
records that somebody asked, not who is organizing, and only the second decides what the row says.

**A takeover you had since undone came back on screen.** After "Organize here", the note saying the
change was asked for ended when this computer became the organizer — and only then. Pressing "Stop
organizing here" afterwards moved the row out of organizer again, and the old note reappeared,
promising a takeover "within a minute" over a mailbox you had just given up. The same record hid the
button that would ask for it again, so the row offered no way back. A press is the newest word only
until another press is made. The same lag remains in the other direction: after a stop, pressing
"Organize here" again leaves the stop's "Asked for" note on the row until Settings is closed and
reopened, although the takeover is what stands.

**A row could say "Organized by" and then name nobody.** When the install holding a mailbox reports
no name for itself, the sentence was left to end where the name belongs. It now reads "another
install", which is what the row means.

**On a mailbox nothing organizes, the button offered an alternative to nobody.** It read "Organize
here instead" while the sentence beside it names the press as "Organize here", and the confirmation
one press deeper described what the takeover costs "another install". Both now say what is true of a
mailbox with no organizer.

### First run stops asking about an install that is not there

"Already organized elsewhere" asks one question — let the other install keep the mailbox, or take it
from here — and every sentence on that screen is about that install. If the mailbox was released
while you were reading it, the screen stayed, offering a choice between two installs when there was
one. Setup now moves on to the next thing it needs as soon as nothing holds the mailbox.

It moves on only when it has actually been TOLD that nothing holds it. A read that said nothing —
because the mailbox list was stale, or failing, or the mailbox had been removed on another
computer — used to count as "nothing holds it", and the next screen after this one is where you
agree to let this computer organize the mailbox. Not being told is not an answer, and the question
stays on screen until one arrives.

Neither is being told something out of date. Two checks of the same account can be under way at
once and come back in either order, so an answer prepared before the other install appeared can
arrive after the one that showed it — and it says exactly what a current answer would say. Setup
now compares when each answer was last true of the mailbox and ignores the older one, so the
question is not taken away by news that has been overtaken.

### Sync now reconnects at once after a detected outage

When the connection to your mail server drops, ohmail re-dials by itself on a widening interval —
fifteen seconds, then longer, up to about five minutes (each wait carries a small random spread, so
the longest gap can approach six) — so that a server which is genuinely down is not knocked on every
few seconds. That is right when nobody is watching and wrong when somebody is: if
your network came back thirty seconds into a five-minute wait, the mailbox sat there saying it was
unreachable until the wait ran out, and pressing "Sync now" did nothing about it.

Pressing "Sync now" now reconnects immediately once the app has NOTICED the link is down,
instead of waiting out the interval. Noticing is its own step: a link that ends is reported at
once, but one that goes half-open — the socket still there, answering nothing — is only concluded
dead after about two minutes without a completed round trip, and until then a press finds nothing
to reconnect and the row can still read as up to date. Shortening that is separate work.

What a press deliberately does not do: it does not retry a sign-in the server has already
rejected, because that is a password to fix and not a connection to retry, and repeating those
attempts is what some providers answer by locking an account. It does not open a second
connection if one is already being opened. And a press that fails is not repeatable on demand —
it is worth one attempt every fifteen seconds, so pressing again straight away is accepted and
changes nothing, and holding the button down cannot turn into the rapid knocking the interval
exists to prevent. On the desktop the button itself stays greyed out after a press until Settings is
closed and reopened; that is a separate defect, still open.

### A long quiet stretch no longer drops the connection

Syncing a large mailbox for the first time could stop partway with a lost-connection error, and
the bigger the mailbox the more likely it was. The app was dialling with a set of network
deadlines meant for a server that has to finish a request inside a minute — twenty-five seconds
of silence on the socket and the connection is considered gone. But ohmail stays open, and while
it is working through a big first sync there are legitimate stretches with nothing on the wire
that grow with the amount of mail. Past a certain size, every run hit one.

It now dials with the deadlines of a program that stays running: two minutes of silence before a
connection is considered lost. Testing a connection from the settings form is unchanged and still
gives up quickly, because someone is waiting at that form.

If your first sync has been stopping short, this is why.

### One draft per message

A message you are writing has exactly one draft on your account, from the first thing you type
until it is sent. Four ways it could end up with two are closed. One case is not, and because it
is the same case for both promises it is stated once, under **A message still on its way is held**.

Opening a compose with somebody already in the To line — from a contact, or from a mail link
outside the app — no longer saves a draft by itself. Nothing is written to your account until the
message has a subject or a body, typed by you or carried in by the link, so Drafts stops filling
with rows that hold nothing but an address.

Pressing Send in the couple of seconds before the first save no longer leaves a second draft
behind. The send makes its own, and that is the one the app keeps.

Coming back, in the composer, to a message whose send could not be confirmed no longer starts a
fresh copy of it, whatever state the server left the original in. A reply is not covered yet:
opened from Drafts it goes back into its message's own editor, which knows nothing of the held
row and sends from a new one.

A send that finishes while the app is still starting up now clears the message it was for. Before,
that message stayed in the composer with nothing on screen to say it had gone, and the next thing
you typed in it was saved as a second draft.

### A message still on its way is held while it goes

Come back to the app while a message you sent is still going out and it is there in the composer,
where you left it. Editing it and pressing Send there sent a second copy: the change made it a
different message, so nothing on the server could recognise it as the one already on its way.

That message is now held until it has gone — the fields are read-only, Send waits, and a line says
why. It clears itself the moment the send completes. A different message you start in the meantime
is not affected; only the one being sent is held — unless an older unconfirmed send from this app
is still waiting; then the newer message is not held, and editing and sending it could deliver it a
second time and leave a second draft.

The opposite case, and it lasts as long as the send does: if you updated the app while a message
was already waiting to go out, there is no record of which message that send is for — the app that
wrote it did not keep one. Until it has gone, the composer waits whatever you put in it. That is
the only case where starting something else waits too.

### A send nobody could confirm is held

It stays in Drafts, it says so when you open it, and the app will not send it again — sending
again could deliver the same mail twice, and this release has no way to tell which it would be.
Checking your Sent folder is what settles it, and it is yours to do: a send the server itself
recorded as unconfirmed is never checked again, so its warning stays. If the server instead
reports the message as sent, the warning comes down and the composer clears.

Discarding such a message from the Drafts list says why it stays instead of reporting that
something went wrong. From the composer, Discard closes the message and leaves it in Drafts
without saying so, and the confirmation before it still speaks of deleting.
Reopening it while a different message is part-written in the composer is refused, so that
message is not replaced without asking. The held message's own composer is not protected the
same way: text typed into it after the send is not saved, and reopening its row from Drafts
restores the row's text over it.

A browser that will not let the app keep its own records can still send and still save. What it
cannot do is decide, on evidence it does not have, to delete a draft or take over a message it may
already have sent. It cannot recognise a draft it reopens either: edits made there are saved as a
new draft beside the original.

The wording no longer tells you to send it again, because sending it again is refused; it still
points you to your Sent folder, which is where the answer is, and says the message is held here.

## [0.14.1] — 2026-09-04

**The phone's 0.14.1 build went out first; this desktop and web release completes 0.14.1.**
The Android APK attached to this release is that build. iOS is not attached — there is still no
sideload path on that platform and no Apple Developer Program membership behind a store build.

### The download carries only what runs on your computer

The mail engine inside the desktop app is built from this repository, and it had come to include
code that exists to run the hosted service — the parts that bill accounts, that talk to the hosted
database, and the machinery behind the assistant features an account pays for. None of it ran on a
standalone install, which has no hosted account to bill and no such database to reach.

It should not have been in the download all the same. A standalone install is meant to be
standalone, and that is a statement about what is in the file you downloaded, not only about what
it does once it starts. Shipping a service's internals to people who are not using that service
also puts more of it in front of anyone reading the artifact than they have any reason to see.

It arrived through two imports that named a package's front door instead of the one file they
wanted, and a front door re-exports everything behind it. Both now name the file. The check that
looks for this had a way of being skipped, which is why the growth went unnoticed for a month; it
now runs wherever the engine is built, so the next import like it fails the build instead of
shipping.

### Recent mail says what time it arrived

A message from today shows the time it arrived — `09:12`. A message from the last six days shows
the weekday with it — `Mon 09:12`. Beyond that a weekday would repeat and stop telling two messages
apart, so the stamp becomes the date — `2 Aug`, and `30 Dec 2025` for a message from another year.

The time used to disappear at midnight: a mail stamped `09:12` became a bare `Mon` the moment the
day turned, and a mail from March showed `Tue` sitting directly above yesterday's, which also
showed `Tue`.

Weekday and month names are in the app's language, and every clock is read in your own machine's
time zone — the same one the account dates beside it already used, so no two stamps on a screen
disagree about what time it is. The list rows, the open message and the earlier messages in a
thread all read the same way, in the browser, on the desktop and on the phone.

### A mailbox that cannot send says so

A mailbox that cannot send no longer reports a send in progress; the refusal is shown as what it is.

### The action pill is as wide as its verbs

The row of actions under a message is as wide as the buttons standing in it. Where the column is
too narrow for all of them the rest still move into the ⌄ menu at its end, but the row no longer
keeps its full width with an empty gap where they were.

### Signing in, signing out, and a browser that two people share

A browser holds one set of cookies for everything open in it. Sign into a second account in another
tab and every tab now belongs to that account — including the ones still showing the first one's
mail. Several things in the app kept acting for the account they were opened for, and this release
is that class of fault, found and fixed together.

**A tab left open no longer renews somebody else's session.** When the short-lived part of a session
expires, the app quietly renews it. A tab that had been idle since before another account signed in
would renew THAT account's session — spending a one-time token in the process, so the other person's
own tab could afterwards be treated as suspicious. The renewal now checks which account the browser
holds at the moment the request leaves, not when it was decided.

**The "welcome back" screen no longer spends whichever session the browser happens to hold.** That
screen is chosen when the page is requested and does its work after the page has loaded and waited
its turn. If somebody signed in during either gap, it renewed their session and then opened their
mailbox in a window that was never theirs. It now records which account it was chosen for, on the
server, and does nothing if that has changed.

**Mail, settings and sign-up steps stop when the browser changes hands.** A window whose account has
been replaced no longer merges new mail, loads pictures, keeps its live connection for new-mail
notices, or acts on the settings screens — security, devices, billing, mailboxes. The sign-up wizard
asks which account it is signed in as before every step that acts on one, and refuses when it cannot
tell rather than continuing.

**Signing out says so even when the server cannot be reached.** A sign-out the server did not confirm
used to leave the browser looking signed out while the session was still live. It now records that
state and refuses everything except signing in again or retrying the sign-out.

**And the screen no longer says you are signed out when the app simply could not ask.** A failed
check — a slow server, a dropped connection — was reported as a verdict about your session. Those
are now told apart: a session that was refused signs you out, and a question that could not be asked
is retried.

### Removing a mailbox releases its organizer claim, and says so plainly when it cannot

Organizing a mailbox means keeping a record inside the mailbox itself saying which install is doing
it, so that a second device can see the mailbox is taken and does not organize it twice. Removing
the mailbox from a computer takes that record back out.

Taking it out can fail on its own. The mail server has to be asked which records in that folder
belong to this install, and it can refuse, or answer with less than the whole set. The release
refuses in that case rather than removing only what it happened to see, because a half-finished
release is worse than none.

What was missing is that the refusal went to a log and nowhere else. The mailbox was reported
removed, the record stayed in the folder, and the next device to try that mailbox waited for the
record to lapse while saying only that something else was organizing it — naming a machine that had
already let the mailbox go, with no way to find out why the wait was happening.

The removal itself still goes through; it is not something this step may block. It now reports
whether the record was actually taken out, and Settings → Mailboxes says so when it was not.
Nothing is ever deleted from the mailbox itself.

### Stopping organizing waits until the record is out of the mailbox

"Stop organizing here, keep the mail" takes out the same record inside the mailbox as removing it
does, and the same ask of the mail server can be refused, answered short, or cover less than the
folder holds. On this path the app went ahead regardless: the mailbox was marked as no longer
organized here and the day was recorded, while the record stayed in the folder. So the computer you
were handing the mailbox to went on refusing it, and the one you pressed the button on told you the
handover was complete.

It now records the change only when the record is confirmed out — because this install took it out,
or because a complete read of the folder found nothing of this install's left in it. Where the
server would not answer, the mailbox stays organized here with the request still standing; the app
goes on reading the mailbox, and files and sends nothing while the request is outstanding, and the
next check asks the server again. Pressing "Organize here" cancels the request, as before.

Finding the record does not depend on the server being willing to search for it. One real provider
refuses that kind of search — every time, not transiently — which would have left the button unable
to finish, ever. The app reads the folder itself, picks out its own records from what came back,
takes them out, and reads again to confirm they are gone; a folder too full to read whole is
refused with a named reason rather than half-answered.

And the wait has an end. The record expires on its own once the app stops renewing it — and an app
with a standing stop request renews nothing — after which every install treats it as expired and
can take the mailbox past it. If the server still has not confirmed the removal by then, the
mailbox is recorded as no longer organized here, rather than promising for ever a confirmation the
server will not give.

While the request is waiting, the row in Settings → Mailboxes says so — "Stopping on the next
pass — waiting for the server to confirm" — instead of reading as an ordinary organized mailbox
with no trace of the press. The "Asked for" note a press leaves also ends when the row answers,
instead of promising "within a minute" for ever beside a mailbox that finished long ago.

### Every control on a phone is a 44-pixel target

Controls drawn smaller than a fingertip were smaller than a fingertip to press, too. Segmented
controls, filter chips, ghost verbs, the settings navigation, the add-tag chip, the topbar button
and the read switch now all answer to a 44×44 press area on phones, without any of them being
drawn larger: the extra area is invisible and sits around the control, so the layout looks exactly
as it did and nothing crowds anything else. The switch keeps its 40×23 track inside it.

Four icon-only controls are still smaller than that and are named as such rather than quietly
skipped — the per-message disclosure among them. They need a different treatment and it is coming.

### Handing a mailbox back checks which install is holding it

Exactly one install organizes a mailbox at a time, and the claim that says so lives in the mailbox
itself. Asking the hosted server to stop used to be decided from what SORT of install held it —
hosted, local, unknown — which is the same question only when there is one install of each sort.
There is not: a hosted deployment's identity includes the environment it runs in, so two of them
over one mailbox is ordinary.

The decision is made on the holder's identity now, and the report waits until the mailbox itself
says it is free. Three things it used to get wrong: a claim removed by count rather than by
checking the mailbox afterwards, so a mailbox could be reported free while another install still
held it; a claim written by this same deployment moments earlier, which did not count as anybody
holding it; and a request to stop that could still be honoured after you had taken it back with
"Organize here", clearing the newer press. Where the mailbox cannot be read, or something is still
holding it, the request stays pending and is tried again rather than reported done.

### Text is a step larger on phones

Every reading role in the app sat one to three pixels under what the phone platforms set beside it,
and the meta band — timestamps, addresses, preview lines, settings descriptions — sat furthest
under. At phone width every text role between 10.5px and 15.5px is now exactly one pixel larger.
Nothing at 16px or above moves, no information-bearing text is left under 12px, and a window wider
than 640px is unchanged to the pixel.

Text fields are the exception, and they are floored rather than stepped: a focused field under 16px
makes iOS zoom the whole page, so those land on 16 whatever they were.

### An idle window no longer rebuilds the whole view

With a large mailbox the desktop rebuilt its whole view on every sync and every mailbox poll, even
when nothing had changed; an idle window grew by about a gigabyte an hour. It no longer rebuilds on
a poll that changed nothing. Memory still grows slowly over a long session; that is a separate fix.

### Every answer belongs to one account

Two changes from opposite ends of the same idea: a request that mixes two accounts is refused, and
an answer says whose it is.

**A pairing code can no longer be redeemed by a browser signed in as somebody else.** Pairing a
phone or a second machine works by redeeming a short-lived code. That redeem read the code on its
own and never looked at who the browser doing the redeeming was already signed in as — so a browser
signed in to one account could redeem a code belonging to another, spend it, and be handed that
account's device session. It is refused now, and refused *before* the code is spent: the person the
code was meant for can still use it, and signing out and trying again works. The same refusal
already applied when signing in, rotating a session, claiming a desktop link or exchanging a token;
this was the one door where it could not take effect, because that door never worked out who was
asking.

**Responses say which account they were answered for.** A response to a signed-in request now names
the account it belongs to, and on the sign-in and pairing routes that is the account whose
credential was presented rather than whoever the browser happened to already be signed in as. An
app that keeps mail on the device can check that before it stores anything.

It matters for a case a browser cannot see on its own: if a sign-in happens in another tab, and
finishes, between a request leaving and its answer coming back, everything the asking tab can
observe reads exactly as it did before — and the answer it applies belongs to somebody else. Only
the server knows whose question it answered, so now it says so.

A server states whether it sends this, so pointing an app at an older self-hosted install does not
make every ordinary response look suspect.

### Controls fit the width they are given

Four things in the app decided their own width from something other than the room they had, and
each of them broke out of it somewhere. They are fixed together, because they were one fault.

**The message action bar keeps every verb reachable, and uses its row.** Which verbs stand in the
bar and which move into the More menu is now decided one way: the bar measures the row it actually
has, in the font your system is actually drawing, and seats what fits. Before, that measurement ran
alongside a set of fixed widths worked out from one reference font, and where the two disagreed a
verb could be hidden by one and hidden by the other — Answer later, Park and Resurface were, on some
messages, in neither the bar nor the menu. Every verb is now in exactly one of the two places at
every width. The bar also fills the row it stands in rather than shrinking to its contents, so the
space beside a folded verb is space the next verb can use. Where even the essentials do not fit — a
narrow reading column in German — the read control keeps its dot and its shortcut and drops its
words, rather than anything being pushed out of sight.

**The date picker is the app's own, and stays on screen.** Choosing "Pick a date" for a resurface
used to hand you the operating system's calendar: drawn in its look, opened downward from a control
that sits at the foot of the reading column, and often running off the bottom of the display. It is
now a month grid in the app's own shapes, on both faces, with month and weekday names in your
language. It opens below the button when there is room and above it when there is not, and is never
placed outside the window. It works from the keyboard — arrows by day and week, Page Up and Page
Down by month, Enter to choose, Escape to close — and days before tomorrow cannot be chosen.

**Settings controls fit their cards.** A row of choices — the away responder's reply rate, with the
longest labels in the app — used to run out of the card holding it, and at narrow widths the choices
wrapped inside their own capsule. A row of choices now becomes a short list when the row would not
fit, and goes back to a row when the width returns. It measures its own labels, so it behaves the
same in German, where the words are longer, and on the ohmarchy face, where they are drawn wider.

**Mailbox rows no longer cut their buttons.** In the mailboxes list, a button under an address —
"Organize here instead", and its neighbours — was stretched to a fixed-width column and its label cut
off mid-word. It was worst in German, where up to half the label was missing. The column now makes
room for whatever stands in it, the button is as wide as its own label, and the status text beside it
wraps instead.

### The away responder's notice reads as a notice

The line in your Ohbox that says the away responder is on now stands in a quiet box of its own
rather than as another line of small grey text above the pile descriptions. Nothing is wrong when it
appears — it is a standing fact about your mail, and it stays until you turn the responder off — so
it is tinted rather than alarming. Its sentence also reads correctly in English for every
combination of audience and rate; one of them did not agree with its subject.
### Changes that could not be saved now say so

A change you make offline is written to this device's storage and retried until it lands. Until
now that retrying had no end: a change the server would refuse every time was retried for ever,
across restarts, holding the optimistic result on screen and never mentioning it.

The queue now stops after a bounded number of failures the server actually answered, and both the
desktop app and the phone show what it gave up on — what was being done, the server's own reason
where there is a usable one, and a choice between trying again and discarding it. Trying again
reuses the original request key, so an attempt that succeeded and only lost its reply is not sent a
second time. The outcome of that attempt is written onto the entry itself, so a refusal is still
there tomorrow and after a restart — not only in the moment it arrived, on the screen that
happened to be open.

If this device's storage refuses the write, a message is not sent and the composer says so: the
request key that stops a retry from delivering twice lives in the record that just failed to be
written, and sending without one risks a second copy nobody can take back. Any other change is
still sent at once, but would not survive a restart until storage recovers — repeating it costs
nothing, so refusing it would cost you the action to protect you from nothing.

Every route to the network now shares one lane, in the order the requests were made: a change you
make right now, the batch replayed when the app wakes, a retry you press, and a flush after the
connection returns. Two of the four used to run outside it. That mattered most for marking things
read: nothing else orders those, so a newer "unread" could reach the server before an older
"read" and leave it at the older value, with both requests reporting success.

Two failures deliberately do not count toward that limit. A dropped connection or a timed-out
request never does, so a machine that is simply offline keeps retrying for as long as it takes;
neither does a server that refuses and says when to come back. Without those exceptions a long
outage would have discarded every pending change at once, which is worse than the problem being
fixed.

The drafted-reply button also stops repeating the server's message when that message is the generic
one an unhandled fault produces. Real refusals — no actions left on the account, a message that
cannot be drafted against, no drafter configured — are still shown word for word.


### A malformed address in a request is answered, not swallowed

Every address in this app's API — the identifier in `/drafts/<id>`, `/messages/<id>`, and about
seventy-five more — is now checked for shape before anything else happens. One that could not name
anything, because it was truncated, or carried a stray space or newline picked up from a copy and
paste, used to reach the database and come back as `internal error` with a 500. That answer was
wrong twice over: it reported a fault in the server for what was a bad request, and it told the
caller nothing it could act on.

Such a request now gets `400` and a plain sentence naming the field. The check runs in the one place
every request passes through, so it covers the file-download and administrative paths that sit
outside the normal request chain as well.

Requests carrying a well-formed identifier are unchanged, including one naming something that does
not exist or is not yours — that is still an ordinary "not found", and the shape check makes no
judgement about who may see what.

### Organizing keeps going after the connection drops

If the connection to your mail server ended while ohmail stayed open — the lid closed for long
enough that your provider hung up, a Wi-Fi change, a VPN reconnecting, the server closing an idle
session — the app stopped organizing and did not start again. Mail kept arriving in your mailbox
and the window kept working, but nothing was being filed, and Settings still said this machine was
organizing. Quitting and reopening was the only thing that fixed it.

ohmail now notices and opens a new connection by itself. It notices two ways, because one is not
enough: the mail library reports some connection deaths and not others, so the app also watches its
own work — a run of cycles that cannot read the mailbox is treated as a dead connection after about
two minutes, whether or not anything reported it.

When it reconnects it re-reads who is organizing the mailbox **before** it moves a single message.
That matters more than the reconnect itself: coming back from a closed lid is exactly when a
mailbox has most likely been picked up somewhere else — you opened your mail on another machine
while this one was asleep. An app that simply resumed filing would spend a cycle organizing a
mailbox that is no longer its to organize, and two copies of ohmail filing the same mail is the one
thing the whole design exists to prevent. So it asks first, and if the mailbox has moved it stands
down and says so.

Nothing is signed out, nothing is deleted, and no password is needed: the app re-dials on its own.

### Two smaller fixes underneath it

A crash or a lost battery could leave ohmail unable to open your mail at all. The file that stops
two copies of the app from using one database recorded a process number, and after a reboot the
system hands those numbers out again — so if an unrelated program happened to be given the old one,
ohmail concluded another copy of itself was still running and refused to start, permanently. It now
records enough to tell one process from another and takes the lock back when the process that wrote
it is genuinely gone.

On macOS and Windows that identity is not available to us, and ohmail does not guess: it will not
release a lock held by a process id that is currently alive, because guessing wrong would let two
copies use one database and corrupt it. After a reboot that reused the number you may still have to
delete the file the error message names. On Linux the identity is exact and no such step is needed.

And the settings ohmail copies between your installs are compared by content, using a fingerprint
of that content. Sorting for that fingerprint used the machine's own alphabet ordering, which can
differ between builds — so two machines holding identical settings could disagree about whether
they were identical, and each would treat the other's copy as a stranger's. The ordering no longer
depends on the machine.

### Deciding on a mailbox another install is organizing

Exactly one install organizes a mailbox at a time — that is what keeps two copies of ohmail from
filing the same message to two different places. Every other install reads it. Pressing a Screener
decision on a mailbox you read rather than organize used to fail, and the message did not say much:
it was answered for the whole account, so an account with one organized mailbox and one read-only
mailbox got the same sentence for both.

Now the decision travels. Press it on an install that reads the mailbox, and the install that
organizes the mailbox carries it out on its next pass — the sender leaves your queue immediately,
and the rule and the filing appear where they always would have.

The decision is carried in the mailbox itself, which is the only thing two installs on different
machines share. That folder is ordinary mail, so anything with access to the mailbox can write to
it: an organizer that acted on whatever it found there would file a stranger's mail on their say-so,
and a single forged message would be enough to whitelist a sender permanently. So every decision is
signed, and the organizing install checks the signature **before** it reads the decision at all. A
record it cannot verify is refused and never acted on.

The organizing install also answers, which it could not before. A decision it carried out comes back
as applied; one it declined comes back as declined, with the reason. Previously the only signal was
the record disappearing from the mailbox — and it disappears either way, so a decision that had been
thrown away was reported as done. A decision that gets no answer at all is now reported as waiting
until it times out, rather than quietly counted as a success — which is also what happens to a
decision written before your password changed, since changing it replaces the key and the older
decision can no longer be checked.

The key is not sent anywhere, and that is what lets this work in both directions. It is computed
from your mailbox password, which every install that can open the mailbox already has — and which
the thing being guarded against does not: somebody who can drop a message into your folder through
a shared-folder permission or a server-side rule has no password. So an install that organizes your
mail on your own machine takes part on exactly the same terms as ohmail Cloud, without ever
contacting our service. That separation is what makes a local install local, and nothing here
weakens it.

Changing your mailbox password changes the key. Decisions written before the change stop verifying
and time out, and everything after it works normally — which is the behaviour you would want from a
password change anyway.

**One case has no shared secret, and it says so.** If you signed the mailbox in with Google or
Microsoft rather than a password, each install holds its own token and there is nothing for the two
to compute the same key from. For those mailboxes decisions can only be made on the install that
organizes the mailbox; pressing from another one is refused, naming the install to go to.

The folder the decisions travel in is ordinary mail, so it can fill up with ordinary mail — and a
full folder used to hide the newest things in it, silently: enough messages and a decision, an
answer, or the record of which install is organizing the mailbox could sit there unread for good.
Now the newest records are the ones that are read, and a folder too full to read in one go is
treated as a folder nobody could look at rather than as an empty one, so no decision is reported as
taken, refused or dropped on the strength of a look that did not finish.

### A rule you apply to existing mail reaches what another install filed

Mail that arrived while this install was only reading the mailbox — because another install was
organizing it — is no longer recorded as a placement you made by hand, so a rule you later ask to
apply to existing mail can reach it. And a request to apply a rule to existing mail, made while the
install was not organizing, is now kept until it is, instead of being marked done with nothing
moved.

A request like that covers every mailbox on the account. Where the account has more than one and
this install organizes only some of them, the request is no longer finished once the mail on those
is done — it stays open until every mailbox has been gone through, so a mailbox you start
organizing later still has its existing mail considered.

### A message you move back yourself stays where you put it

Drag a message out of one of ohmail's folders and back into your inbox in another mail client, and
that is where it stays. While this install was only reading the mailbox, a move like that was
recorded as another install's filing rather than yours — and a rule you then applied to existing
mail could move the message straight back out.

A move you make in your own client is recorded as yours, and no rule undoes it. The same case seen
from the other side is the trade: a message another install re-files while this one is reading is
also kept where it now is, rather than counted as a placement a later rule may revisit.

### Screener decisions from a reader no longer buy advice nobody can use

Asking for an AI suggestion on a mailbox you only read used to spend credits whatever the state of
the mailbox. If no install is organizing it, or the one that is cannot take decisions from
elsewhere, the suggestion could never be applied — so it is refused now, before the model is
called and before anything is charged, with the same sentence the decision itself would give.

### Any machine can take a mailbox over, and give it back

Which install organizes a mailbox used to depend on what kind of install it was: one running on
your own computer could not take a mailbox over from a hosted one while that one was still checking
in, whatever you pressed. If the machine you ran ohmail on became unreachable, the mailbox stayed
where it was and there was nothing you could do about it from the machine in front of you.

An explicit press now outranks a claim that carries none, whichever machine wrote it. Pressing
"Organize here" takes the mailbox on the next pass — within a minute — and the install that had it
becomes a reader: it keeps its copy of your mail and moves nothing. Your rules, the screening
window and the away responder travel with the mailbox. No mail is moved and nothing is screened
again.

Every sentence that described the old rule is gone with it. The screens that told you to go and
stop the other organizer first, and the ones that warned a running install would keep the mailbox
whatever you asked for here, were true while a press could be refused; they would now send you to
stop a machine you no longer have to touch.

### Stop organizing here, and keep your mail

The other direction had no control at all. To make an install let go of a mailbox you had to remove
the mailbox, which deletes the password stored for it and stops the mail — so "leave whenever you
like" was a promise with nothing behind it on the very screen that made it.

Settings → Mailboxes now offers "Stop organizing here, keep the mail" on any mailbox this install
organizes, on the desktop and in the browser. Your folders and everything in them stay exactly
where they are, the password is kept, and any install can take the mailbox afterwards — including
the one that just let it go. Like the takeover, it records a request: the claim lives in your own
mailbox, so the install that holds it is the only thing that can give it up, and it does so on its
next pass.

### One line when a mailbox changes hands, and a permanent record of where it stands

Reading a mailbox another machine organizes is a normal state, and often the one you chose — a
phone and a laptop on one mailbox is the ordinary shape of this. So a banner that says so on every
visit is a warning about a decision you already made.

Instead, a change is announced once: a quiet line above the Ohbox saying who organizes the mailbox
now, with "Mark read" that ends it for good. It is derived from the mailbox itself rather than
remembered per app, so acknowledging it on your phone takes it off your laptop too, and a mailbox
that changed hands twice while nobody was looking produces one line describing where it ended up.

What does not disappear is the record. Settings → Mailboxes keeps a line under every mailbox saying
whether this install organizes it, which one does and since when, or that nothing does — with the
one button that changes it, and the sentence saying what that press costs the other machine before
you make it.

### A mailbox you only read says so, and says who to ask

A mailbox this install reads rather than organizes shows the install that organizes it. Where the
organizing install can take your decisions — a mailbox signed in with a password — the Screener
keeps its decision bar and a press travels as described above. Where it cannot — a mailbox signed
in with Google or Microsoft, or an organizer on an older build — the Screener withholds its
decision bar and its keyboard verbs rather than offering controls that answer with a refusal, and
says so before the press, with who organizes and the one press in Settings → Mailboxes that
organizes it here instead. The panes that release mail from Screened out or rescue it from
Quarantine say that moving mail happens where the organizer runs. On a phone, a decision made on a
mailbox the phone does not organize no longer reports itself as filed.

A mailbox you stopped organizing yourself is no longer described as one another install claimed:
Settings → Mailboxes says you released it and on what day, and offers a single press to organize it
here again, instead of the check-then-confirm handover written for taking a mailbox back from an
install that is still running.

### German where the app used to speak half English

With the language set to Deutsch, the one control that stayed in English was the one that
matters most: the Screener's decision bar. The five destinations, the "this sender / whole
domain" choice and the line saying that a press becomes a rule were all English, beside a
sidebar and a message list that were German. Four of those five names already had a German
translation. Nothing connected it to the bar.

That is fixed, and so is everything that shared its cause — a component holding its own
words instead of taking them from the language files. Twelve more parts of the interface
did: the "protected" badge on a held message and the "held" chip beside it, the ⌘K
palette's foot, the reading pane's return hint, the Reply Run's screens, the "open reading
mode" button, and the rule-by-subject sheet, which was English from top to bottom inside a
German window. Where a sentence names a destination it now uses the word the sidebar shows,
so a message filed to Belege is described as going to Belege.

Nine German sentences also stopped bending a folder name into a shape it does not take.
German has a preposition for going somewhere — *nach Berlin*, *nach Hause* — and it wants a
bare place-noun; a mail folder is not one, it is *der Ordner Belege*. Sentences like "Nach
Belege verschoben" and "nach Belege einsortieren" therefore read as though you were being
sent somewhere. They name the folder after a colon or a dash now, which asks nothing of the
name and is right for every folder including the ones with articles in them. The rename
notice reads *in* rather than *zu*, which is how German renames.

The first-run consent screen was not untranslated but wrong, which is worse. It said ohmail
would create folders called "Belege", "Aussortiert" and "Quarantäne". The folders it
actually creates are `ohmail/Receipts`, `ohmail/Screened` and `ohmail/Quarantine` — English
in every language, because they are names on your own mail server and they are what every
other mail app will show you. The sentence now gives both, so what you agree to is what you
will find.

The two parts that were still English in a German window are fixed now too: the door
chooser you meet before a mailbox is connected — all three ways of signing in — and the
Desktop and About panes in Settings, including the sentences behind "Sign out", "Switch
mailbox" and the mail engine's own status line. The search box's placeholder and its
accessible label are translated as well; they had been missed by the earlier pass.

### Search puts matches first, and keeps the near-misses out of the way

Search has always tolerated typos: ask for "invoce" and it finds the invoice. It did that
by mixing the near-misses in with the real matches and ranking the whole lot together —
and because a word in a subject line counts for more than a word in a body, a guess in a
subject could outrank the word you actually typed. Searching for "graphite" put a message
titled "Fotos vom Grat" above the one whose text says graphite. Asking for a common word
returned a page of messages that merely resembled it: "invoce" gave twenty results, and
nineteen of them had reached the list through the two-letter word "in".

Matches now come first, on their own. Near-misses appear only when nothing matched — under
a "Similar" heading that says so, so a guess is never mistaken for an answer. Typo
tolerance is unchanged in the case it exists for: a misspelt word matches nothing exactly,
so the guesses are exactly what you get.

Three other things changed with it:

- **Multi-word searches prefer the phrase.** "glaze evening" ranks a message that says
  those words together above one that happens to contain both somewhere.
- **Recency breaks ties; it does not decide them.** Two equally good matches come back
  newest first. A better match still beats a newer one — that is what "Newest first" is
  for, and it is a choice you make.
- **The result count counts what is on screen.** It used to include the near-misses even
  where they were not the answer.

The same rule applies wherever your mail is searched — the index on your own machine and
the one behind a hosted account — and both are held to it by the same code.

### The Screener's controls, in one shape

The row above the waiting list — Apply, Suggest…, Mark all spam — is now one row of
capsules of one size. Asking for suggestions opens a single block under it: how many senders
to ask about (a segmented choice), the server's price, and the one button that spends,
with the server's own sentence at the foot when there is one. While a purchase runs, the
button says so and carries the run along its foot, the way Send does; the Apply button does
the same while it files, and refuses a second press until it is done. The filter capsules
under the row show which one is chosen — before, the chosen one was drawn in a colour no
stylesheet defined, so it looked like the rest.

### The sender panel is never cut off

The panel that decides where a sender's mail goes — from any list, any card, or the `s`
key — used to be cut to the space beside the row it opened from: opened mid-screen in a
900-pixel-tall window, it showed about half of itself with a scrollbar, while the rest of the
window stood empty. It now stands whole wherever the window holds it, sliding up over its row
by exactly the pixels it lacks, and scrolls inside only when it is taller than the window
itself. It is wider, and laid out as a settings pane: whose mail, where it goes, the rule as a
switch with its note, the ways onward, and the reason — at the sizes settings use.

### The waiting mark holds still

The small mark that says something is running — beside the sync line, on a folder that is
still loading, on a connection check — no longer spins as a box. It is a frame whose corners
follow the theme (a ring on the paper face, a square on the ohmarchy face) with a segment
travelling around its edge, one lap a second. On the ohmarchy face the square stays put and
the segment runs its four sides.

### The Screener doorbell's initials, on the ohmarchy face

The initials in the "N waiting" line overlapped as square tiles with crossing rings. On the
ohmarchy face they now stand in a row with a small gap, and the "+N" tile is gone there —
the count is already in the sentence beside them. The paper face is unchanged.

### Keycaps say Ctrl where there is no ⌘

Every keycap that named the modifier said ⌘, on every platform. On Linux and Windows the
caps — the sidebar's Command row, the top bar's pill, Send, and the shortcut list — now say
Ctrl, which is the key that works there.

### The shortcut list

Each place is listed once, with both of its chords on one row ("1 · g o"). The "Go to
Triage" row is gone — the sidebar has no such place; "Go to Answer Later" (`g l`) reaches the
same view. Every row starts with a capital, and the list is wide enough for three columns.

### A wide sidebar no longer starves the reading column

A sidebar dragged to its widest kept that width when the window shrank, leaving the reading
column a sliver. Its ceiling now follows the window, so narrowing the window narrows the
sidebar first.

### ohmail looks for its own update at least once a day

The app checked for a new release when it started, and whenever you asked it to. If you
never quit it — and most people do not quit a mail client — it never asked again. It now
re-checks daily while it is running, measured on the clock rather than on how long the
machine has been awake, so closing the lid every evening does not postpone it.

Nothing installs itself. When a release is found it is fetched, checked against the
signing key and offered, exactly as before, and one press installs it. What is new is
what happens if you answer "Later": the update used to wait in silence until you next
restarted the app. A quiet line above your mail now says it is ready — at most once a
day, never twice about the same release, and never while you are writing a message. You
can put it away.

On Linux, an install that ohmail cannot carry out itself used to fail and tell you to
try again — advice that cannot work when the files belong to your distribution's
packages. It now says that it could not replace its own files, and points at the package
manager for the case where that is why. It also stops re-downloading the release every
day on an install that can never take it.

Settings → About still shows the version you are on, when it last checked, and a "Check
now" button. It is where the daily answer shows up.

**In the browser**, a tab left open for days had no way to know that a newer ohmail was
being served. It notices now, and offers a reload — at most once a day, and never over a
message you are writing.

### Fixed — the settings a connected install shows

An install signed in to a hosted account was missing six Settings sections and three
Screener controls, and the Desktop section told you that you were signed out while your
mail was arriving.

The app asked the mail engine about your session once, when the engine started, and then
kept that answer for as long as the app was open. Signing in happens against the running
engine, so an app that started signed out went on describing itself that way for the rest
of the session — and the sections that belong to an account went with it: the away
responder, signatures, folders, subscription, security and your account, along with the
Screener's dormancy window, its automatic suggestions and its unsubscribe switch. Quitting
and reopening was the only way back, and nothing on screen suggested it.

The app already asks the engine about your session every minute, and already uses that
answer to decide whether to show your mail at all. That is now the answer the settings
follow too, so what a section can reach is what decides whether it is drawn.

### Added — Devices, on an install connected to an account

Settings gains a Devices section on an install connected to a hosted account: the devices
signed in to it, adding one, and signing one out. Those all ask for a second factor from
the last few minutes, which this app has no way to give, so the section opens the page in
your browser where you are already signed in — the same shape Security and Your account
already use. A standalone install keeps its own Devices section, which is a different
thing: serving the mailbox on this computer to your own devices.

### Changed — Folders on a standalone install

A standalone install no longer offers the "Use folders" section. The mail engine on this
computer does not create, rename or delete folders, so the switch stored nothing and moved
back to off on its own. It returns when there is something behind it.

### A message to yourself keeps the address you were writing from

When you address a message to somebody on a domain one of your own addresses stands on,
ohmail sends it from that address and says on the From line that it switched. The rule is
there for an account holding two businesses' addresses, where the default would otherwise
be the wrong company about half the time.

Your own addresses were caught by it too, and they should not have been. Every address you
hold stands on one of your own domains, so a note to your own second mailbox — the
commonest reason to type your own address into a compose form — moved the sender onto the
mailbox you were writing *to*, and announced the switch as though a correspondent had asked
for it.

Your own addresses no longer count as evidence of which identity is writing. A message
addressed only to yourself leaves from the address the form opened on, or the one you
picked, and says nothing. Addressed to yourself *and* a correspondent, the correspondent
decides, exactly as they would have on their own. An address on a mailbox that can no
longer send still counts as yours; so does your own address typed in a different case, and
so does one filed under a tag — `you+receipts@…` is you.

Nothing changes for a reply or a forward: both answer from the mailbox the original arrived
in, whoever they are addressed to.

### The phone

### Messages open with the whole message again

Opening a message could leave it showing nothing but the preview line, under *"Only the preview
could be loaded. Reopen to try again."* — and reopening did not help. Every message on the phone
was affected.

The mail was never missing and the server was never refusing; the phone had already been handed
the full text and lost it on the way into its own copy. Writing that copy went through a second
connection to the same database file, so two writes that overlapped were two writers competing for
one file — and the loser aborted. Opening an unread message is exactly that case, because the open
fetches the body while marking the message read at the same moment. The failure then stuck: the
aborted write left the message recorded as unfetchable, which is what the notice was reporting on
every later open.

Writes now go through one lane per database file, so they queue instead of colliding.

### The About block says which build you are looking at

Settings → About now ends with a line like **Version 0.14.1 (2)** — the marketing version and the
build number. Nothing in the app used to state a version anywhere, so anyone holding an APK sent
to them had no way to tell, from inside ohmail, which build it was. The numbers come from the
config embedded in the artifact, and a test holds them equal to the generated Android project's
own version fields, so the line cannot drift from the thing it describes.

### The app has its final name, and an existing install will not update into it

The application identifier is **`app.ohmail`** on both platforms, the reverse-DNS form of the
product's domain, replacing the earlier `app.ohmail.preview`.

**If you are holding one of those preview builds, uninstall it before installing this one.**
Android and iOS both treat the identifier as the app's identity, so a package with a different
identifier is a different app, and this one will not update over the old one. Nothing is
migrated across that boundary and nothing needs to be: a phone holds only a copy of what is on
the server, so the new install pairs again — one scan, or one pairing token — and syncs the
same mail back down. The old app's copy goes with it when it is removed, which is what an
uninstall has always done here.

### Type sized for a phone rather than inherited from a desktop

The reading band steps up one point. Sender lines are 14, subjects 14.5, previews and other
secondary text 13 — a notch larger than the desktop scale the phone had been using, which was
set for a screen you sit further away from. Nothing that was already at 16 points or more moves,
and no information-bearing text is left below 12. The wordmark does not step, because a mark is
artwork at a fixed size rather than something you read.

Small controls got the other half. The minimum touch target has always been documented as 48
points, but the padding that was supposed to deliver it was a flat 6 on everything, so a 34-point
segmented control reached 46 and a 29-point chip reached 41. Each control now measures its own
height and takes exactly the padding that closes the gap. Nothing moves on screen — the press
area grows, not the layout.

### The launch screen is the product's own, in both faces

Opening the app used to show a white screen with the framework's grey placeholder on it, in
light and dark alike — the configuration for it had moved and the app had not followed. The
first frame is now `#fbfaf9` with the product mark in light, and `#0e0b08` with the light-ink
mark in dark, at every screen density.

### What the app asks the system for

The iOS build no longer asks for a **microphone** or **Face ID**. Neither is used by anything
in the app — the strings came from defaults in two libraries, and a purpose string for a
capability an app does not use is a claim about that app that is false. Android had already
kept `RECORD_AUDIO` out of the manifest; iOS was the half still missing.

The iOS app icon is also flattened for Apple's pipeline rather than left to acquire four white
corners where the transparent rounding met the platform's own mask.

### The phone speaks German too

The phone client is bilingual. It follows the language your phone is set to, and Settings carries a
control — System, English, Deutsch — for the times the two should differ; the choice is remembered
on the device and applies to ohmail alone.

Every string the app can say is translated: the three doors and the pairing flow, the Ohbox, Reads,
Belege and the Screener, the folder verbs, the message actions and their toasts, the reply and
forward composer, send later and the scheduled list, tags, Settings and the About block, and each
refusal the app can give you — a certificate it will not accept, an address it cannot reach, a
pairing it could not store. The day and month names on your mail come from the platform in the
language the app is in, so a message listed under "Thursday" or "2 Aug" in English is listed under
"Donnerstag" or "2. Aug" in German, and the day rows in the send-later and resurface pickers follow
the same rule.

Where the phone says the same thing as the web client, it says it in the same words, and the two
are held to that by a test rather than by care.

Two more tests stand behind the translation, and it is worth being exact about what they do and do
not cover, because "everything is translated" is the kind of claim that quietly stops being true.
One compares the two decks: it fails if the German one loses a key, drops a number or an
interpolation, collapses a plural or a two-way choice, or simply repeats the English sentence. The
other reads the app's own source and fails if a sentence is written into a screen instead of into
the deck — including text between tags, text returned from a callback, a one-word label, and a
sentence joined onto a value. It also fails on a translated string read once when a file is first
loaded, which freezes it in whatever language happened to be active at the time.

What that second test cannot see is a string that reaches the screen through a variable filled in
somewhere else; for those, the rule that a sentence belongs in the deck is what applies. Text that
is not the app's own — an error message from the phone or from your server — is shown as it
arrived, on purpose: a translated paraphrase of it is worse for anyone trying to search for it or
send it on.

Failures the app raises itself are translated too. They used to travel as English sentences and
end up inside an otherwise German refusal; they now travel as codes and become words at the moment
they are shown, so a refusal already on screen follows a language change instead of staying in the
language it was raised in.

Two things are not translated yet, and both are named here rather than left to be found.

The Piles screen is still English: both the three pile names and the sentence under each. The
names are translated everywhere else they appear — the More menu shows them in German — which is
what made this easy to miss.

And one date format is still English everywhere it appears: the short weekday-and-time label, which
reads "Fri 09:00" or "12 Sep, 18:00" in both languages. It is used in more places than a single
screen, so the full list is: the toast confirming when a message will resurface; the "Sends …" line
on the Scheduled screen; the "as of" note on mail that has not caught up; the three send-later
presets (so "Heute Abend (Sat 18:00)"); the hour rows inside the send-later picker; and the
confirmation after a message is scheduled. Every other date on your mail — the row stamps, the day
headings in Belege, the Screener's stamps, and the day rows in both the send-later and resurface
pickers — is in the language the app is in.

### Corrections inside this release

The changes below were made during this release and were wrong in ways that never reached 0.14.0.
They are fixed here rather than carried into it.

Undoing a move before the first one had been confirmed could let the first one win. A change sent
to the server is kept until it is answered, and the app stops waiting for an answer that takes too
long — the request is still running and still owns that change. Expressing a newer change for the
same message retires the older one, and that only looked at changes still waiting to be sent, so
moving a message and moving it straight back could end with the first move sent a second time
after the second one, leaving the message in the folder you had already taken it out of. A newer
change now retires an older one whether it is waiting or already on its way — and if the app
cannot record the newer change at all, the older one is left standing and sent, rather than being
dropped on behalf of a change that never happened.

A send whose outcome the server could not confirm blocked every other new message. When a send
comes back unconfirmed the app keeps the record of it and stops you sending again, because sending
again could deliver the same mail twice and nothing can take that back. That block was written
against the compose surface rather than against the message on it, and the record is deliberately
kept indefinitely — so one unconfirmed send disabled Send and Send Later for every new message
after it.

The block now applies to the message the unconfirmed send was OF: the mail you were answering, the
draft you were writing, or the new message still open in the composer. That message stays blocked
until the send is resolved — after a reload, and after you edit it, because an edit does not make
it a different message. Editing it used to release the block, which is how the same mail could go
out twice. Other conversations, other drafts and other new messages send normally, and more than
one unconfirmed send can be waiting at a time. To write something else in place of an unconfirmed
new message, discard it first; that is what tells the app you are done with it.

The same block then lifted a moment later on its own, because the app had saved the message as a
draft. A new message you are writing has no draft saved to your account until the app writes one,
which it does a couple of seconds after you stop typing — and the block identified the message by
that draft, so a message blocked before the draft existed stopped being recognised the instant it
appeared. Send lit up again with nothing typed, and pressing it sent the mail a second time: the
recipient held two copies, while your own Sent folder held one, so neither side showed it.

A message you are writing is now identified by the composing session it belongs to, for as long as
you are writing it — whether or not a draft has been saved yet, and whether the draft it is saved
to changes underneath it. A reload no longer loses which draft the composer is holding: it takes
that draft back up rather than writing a second one, which is what used to make one message look
like two. For a message whose send is unconfirmed it takes up no draft and writes none — see
below.

Nothing about the message itself lifts the block: not a saved draft appearing, not the draft
changing, and not an edit. What does is replacing the message — opening another draft, writing to
a contact from their card, or following a mail link from outside the app. Each of those starts a
new composing session, so the message that replaces the unconfirmed one sends normally.

A message the server could not confirm stays held wherever you come back to it — from Drafts,
after another message, after a reload. In each of those the app puts the message's own identity
back, rather than treating what is on screen as a new message: the composing session it was
written under, and the draft it is saved to. It stays held until the send is resolved or you
discard it, and nothing is written to your account for it in the meantime: the drafts it already
has are left exactly as they are, and no new one is made.

Two of those returns used to end in a second copy, and both are closed here. Coming back after
writing something else in between poured the held message into the draft the app had made for that
other message, and worked on it from there — a draft the record could not recognise, so the block
lifted. And a message sent before its first draft had been saved ends up with TWO drafts on the
account: the send makes one of its own, the composer's pending save makes another moments later.
Opening either of them is now recognised as the same held message. A draft the server itself marks
as unconfirmed is held on that alone, whatever this browser remembers — which also covers the copy
the send made, whose existence this browser never learned of.

One case is not covered and is stated rather than left to be found: if the app cannot read its own
storage at all — a browser configured to refuse it — it cannot see its own record of the send. A
draft the server marks as unconfirmed is still held; one it does not is not.

Reopening or reloading an unconfirmed message keeps it parked. A message whose send could not be
confirmed stays in Drafts — that row is the only copy of it — and opening it from there used to be
treated as starting again from its text: a fresh draft was saved and a fresh composing session
begun, which is what the app does for a message stranded by some other device. For a message this
browser is still waiting on, that threw away both of the names the block was holding it by, so
Send came back on and one press sent a second copy. Opening it now reopens the message, not a copy
of it: no new draft, the same composing session, the warning still there and Send still held. Only
a stranded message this browser knows nothing about takes the start-again path, and that one sends
once, as before.

Reloading the tab did the same thing without your reopening anything. The composer takes the draft
it was holding back up after a reload, and for an unconfirmed message it found that draft moved on
by the server and let go of it — so the next pause saved a second draft, Drafts listed the one
message twice before you had touched it, and the copy on screen was no longer the one being held
back. The composer now keeps hold of an unconfirmed message across a reload without saving anything
for it at all: the draft already in Drafts stays the only copy, the composing session is the same
one, and the warning and the held Send come back with it. A message with no unconfirmed send behind
it is unaffected — its draft is taken back up and saved as it always was.

A send left unconfirmed by 0.14.0 is still recognised after the update, and it is never sent again
without you asking. The record of such a send is stored in your browser, and 0.14.1 changed how a
message is recognised from it — so a record written by 0.14.0 would not have been matched to the
message it belongs to at all, and the next press would have started a second send of mail that may
already have gone. The web app updates every open browser at once, so this affects anyone whose
send was unresolved at that moment.

Such a record is now read on the first look after the update and rewritten in the current form,
once. What it does not do is hand that send's identity to the message on your screen. The way
0.14.0 recognised a message could not tell certain changes apart — a replacement attachment of the
same size, a corrected name beside an address, a change to the plain-text half of a formatted
message — so treating a match as certain could have sent the earlier message's identity out for
the new one. The server never sends twice under an identity it already holds, so it would have
answered that the mail was sent while the message in front of you was quietly dropped, which is
worse than the duplicate this is all here to prevent. Instead the message that record belongs to
shows the unconfirmed warning and Send stays blocked for it: check your Sent folder, and any
change you make to the message makes it a message of its own, which sends once.

One limit worth stating: a 0.14.0 record names neither a saved draft nor a composing session, so
the only thing it can be matched against is the message as it stood when the record was written. A
message that has changed since is not matched by it and shows no warning.

Records carry the form they were written in from now on, and a record in a form this version does
not know is left alone rather than read or removed — including by the clean-up that clears records
nobody will ever resolve, which used to delete such a record after a week and take the only
evidence of that send with it. Installing an older version and updating again therefore keeps it.
While the older version is running it shows no warning for that one message, because it cannot
read what the record says.

A rule applied to existing mail could stop early if a mailbox changed hands at the wrong moment.
The request stays open while any mailbox on the account is one this install is not organizing, and
the place the walk had reached is cleared at the same time — but those were two separate writes,
and a mailbox becoming this install's to organize in between left the old place standing. The next
pass then looked only at the mail sorting after it, took that for the end of the backlog and marked
the request done, so older mail on the mailbox that had just changed hands was never filed. The two
are one write now, decided once.

Changing your mind about stopping organizing did not work, and stopping could undo it. "Stop
organizing here, keep the mail" is carried out on the next check rather than at the press, so there
is a minute in which you can change your mind — and pressing "Organize here" in that minute was
answered as though the mailbox were already being organized, with nothing written, and the mailbox
was let go a moment later anyway. The press now cancels the request, on the desktop and on a
standalone install as it already did on an account.

The other half is the order the two can arrive in. If the press lands while the app is in the
middle of taking the record out of the mailbox, the check that started before the press no longer
writes over it: it records nothing at all and leaves your later instruction standing, and the next
check organizes the mailbox here again.

Replacing an attached file with a different one of the same size could report a message as sent
without it. Every send carries an identity, so that pressing Send twice — or pressing it again
after a reload, when the app never learned what became of the first attempt — delivers one mail
and not two. That identity was built from each attached file's name, type and size rather than
from what is in the file. Swapping a file for a different one of the same size under the same
name, which is what happens when the image-quality setting re-encodes a photo in place, left the
new message looking identical to the first: it went out under the first message's identity, and
where that first attempt had already reached the server, the server recognised the identity as one
it had already handled and answered with the earlier result — so the app reported the message as
sent although the file just attached never left. The identity is now read from the contents of each
file. It also now takes in the names written beside the addresses a message is going to, which are
sent with the message and were not being read either. An unchanged message keeps the identity it
had, so pressing Send again after an answer went missing still delivers exactly once.

A mailbox nobody organizes said it was organized by another install. Connect a mailbox on this
computer and give nothing permission to organize it, and no install holds it — but the row about it
named one anyway, over a date line reading "Since —". The words for "somebody else organizes this
and we have no name for them" were being used for "nothing organizes this at all", because both
were decided by the holder's name being missing. Whether a holder exists is now read from whether
one was recorded, and the state where none was gets its own sentence: nothing organizes this
mailbox, this computer reads it and moves and screens nothing, and pressing Organize here changes
that. The setup summary, the "already organized elsewhere" screen and Settings → Mailboxes take
that sentence from one place, so they cannot describe one state three ways.

The same rule now covers a mailbox that IS organized elsewhere. No date line is shown where there
is no date: an organizer whose start date was never recorded says what this computer does with the
mailbox and stops there, instead of opening on a date printed as a dash or as nothing at all. And
an organizer recorded without a kind or a name is an organizer — the desktop read that record as
nobody and offered to take a mailbox it said nothing was organizing, while the same record in the
browser was named. Both now read it the same way. An organizer that is known, with a date, reads
exactly as it did.

## [0.14.0] — 2026-09-03

A desktop install can hold more than one mailbox. Each one gets its own connection,
its own organizing claim, its own poll timer and its own saved password and servers;
adding, removing and re-adding one touches only that mailbox, and an existing install
upgrades in place with nothing moved. Alongside it the away responder was reworked: it
replies in the thread instead of sending a message with a subject of its own, it answers
each person at a rate you choose, and a standalone install can send those replies at all
for the first time. A send left stalled on a standalone install is settled on the next
pass.

### More than one mailbox

A desktop install can hold several mailboxes. Until now it served exactly one, and
nearly everything about it was written in that shape: one connection, one
organizing claim, one poll timer, one outgoing server taken from the settings the
app was started with.

Each mailbox now gets its own — its own connection, its own claim in its own
mailbox, its own poll timer, and its own saved password and servers. What stays
shared is what belongs to the install rather than to a mailbox: the local
database, the encryption key, the AI settings and the screening window.

Every mailbox reaches the server its own saved password names. The settings the
app starts with describe the FIRST mailbox, and only until that mailbox's password
records the server a connection actually proved.

Adding one: connect, and the password is checked against that mailbox's own server
before anything is saved. It is refused if the login opens a mailbox this machine
already has, even under a different address or an alias — what decides whether two
entries are the same mailbox is the server and username that answered, not the
name typed into the form.

Removing one takes only its own. Its claim is released from its own mailbox rather
than left to go stale, its mail comes off this machine, its connection closes, and
the mailboxes beside it keep running untouched. Leaving is still per mailbox and
still immediate.

Changing a mailbox's password takes effect straight away rather than at the next
launch. Signing out of the local door now forgets every mailbox's password, not
just the first one's.

Existing installs upgrade in place. The database, the account, the mailbox entry,
the saved password and the claim already in your mailbox are all exactly as they
were. Two small repairs run once: the saved password gains a record of which
server it was proved against, if it did not have one, and a matching entry for the
outgoing server. Which outgoing server that names comes from what the password was
saved for, never from the current settings — and when the two disagree, nothing is
written and sending waits until you enter the password again, because the record
names a server and not a port.

Adding one: Settings → Mailboxes has an **Add mailbox** button. It walks the same
guided setup a first run does, minus the parts that belong to the computer rather
than to a mailbox — no welcome, no AI question, no phone pairing, because those
were answered when this copy of ohmail was set up. What it does ask is the server
and password, with a real connection test; who organizes the mailbox already, if
somebody does; and how far back to screen.

Every mailbox in the list says what this computer does with it — organizes it, or
only reads it and who organizes it instead — and each row carries its own controls:
sync it now, run its setup again, remove it. Taking a mailbox back from another
install is offered on every mailbox that is only being read, not just the first one
in the list.

Removing the mailbox this computer was started with no longer stops the one that
stays: each mailbox reaches the server its own saved password names, so no mailbox
inherits a removed one's server.

Testing a connection while adding a mailbox works however long the app has been
open. It used to be checked against a stamp made when the app started, which was
fine on the setup screen and not fine anywhere else — after a few minutes it
refused with a message about two-factor authentication, on an app that has no
second factor.

A mailbox now connects when its incoming server works, even if sending is not set
up yet. A refused outgoing server used to refuse the whole thing, so a mailbox that
could receive perfectly well could not be connected at all because the outgoing
server was blocked, wanted a different login, or was guessed wrong by a provider
preset. The mailbox connects and syncs; the list says that sending is not set up
and why; a send from it is refused with the same reason rather than quietly trying
a server that has already said no; and correcting the outgoing server in Settings
checks it again and clears the notice. A refused incoming server still stops the
connection, because that is the password you are being asked for.

Two things a connect will not do any more. It will not save a password onto a
different mailbox than the one you typed — it checks which mailbox it is actually
opening first and refuses if they disagree, whether you are connecting for the
first time or changing a password later. And the password it saves records both
servers, incoming and outgoing, so a mailbox added later sends through its own
server rather than the first mailbox's.

### The away responder replies in the thread, at a rate you choose — and works offline of Cloud

The away responder had a subject line of its own, so a reply arrived as a new message
about a subject its recipient had never seen. It is a reply now: "Re:" plus what they
wrote, threaded onto their message, so it lands in the conversation they started.

How often one person may be answered is a setting — every message, once until you change
the text, at most once a day, or at most once a week. Existing responders keep answering
at most once a day, which is the new default.

"Once until you change the text" means the text. Turning the responder off and on again,
or opening settings and pressing Save without editing anything, used to start a fresh
round in which everybody was answered again; it no longer does. The other half of the
same problem is fixed too: correcting a typo in the middle of a trip used to permanently
silence everyone who had written before the correction — they received neither the old
message nor the new one. They are answered now, with what you actually wrote.

**A standalone install answers its own mail for the first time.** The setting was hidden
there because nothing in the app could send the reply. That is no longer true, and the
pane says what the app can honestly promise: replies are sent while ohmail is open on
this computer. Mail that arrives overnight is answered when you next open it. An install
that reads a mailbox without organizing it answers nobody, so two installs can never both
reply to the same person.

The list of senders who never get an automatic reply gained the ones you have turned
away, and separated them from the strangers still waiting in the Screener — those are
answered only if you have chosen to answer everyone. A message from a mailing list, from
an address that accepts no reply, from a security-related sender, or from one of your own
addresses is still never answered, and every reply carries the header that stops somebody
else's responder answering it back. A message whose text has not been downloaded yet is
left alone until it has been, rather than treated as carrying no markers at all.

### A send that stalled on this computer is settled on the next pass

If a send was interrupted between your mail server accepting it and the app writing that
down, the draft could sit at "Sending…" indefinitely on a standalone install. It is
settled on the next pass now — usually without opening a connection, because the copy in
your own mailbox is enough to confirm it went. This already worked on ohmail Cloud and on
a self-hosted server.

## [0.13.8] — 2026-09-02

An install that only reads a mailbox now says so, and stops offering decisions it
cannot carry out. The desktop notification switch reflects what the app is actually
doing. Around those: removing your last mailbox clears the door it came in by,
servers that keep their folders under a prefix are recognised, and notification
registration survives signing out and signing back in. Most of this release is the
same shape of correction — a screen that stated something the code did not do.

### Notifications come back when you sign back in

Signing out correctly took this browser's notification registration down. Nothing
put it back. Signing in again left every switch in Settings showing ON over a
registration that no longer existed, so new-mail notices with the browser closed
were silently off until you happened to open Settings — the one screen that
re-established them.

They are re-established when the app starts instead.

One consequence worth stating plainly, because it is a deliberate choice rather
than an oversight: the app now confirms with the server that the registration is
this browser's before it allows notices to be drawn. On a poor connection that
confirmation can time out, and when it does, closed-browser notices stay off
until the next time you open the app. Being quiet for one session is the better
failure. The alternative is the one below.

### A shared computer no longer announces the previous person's mail

If a sign-out could not reach the server — a captive portal, a dropped
connection, a window closed mid-way — the notification registration survived on
the server, and the only thing keeping it silent was a local flag saying "do not
draw". The next person to sign in on that computer set that flag back to "draw",
because the app decided from the switches on screen rather than from whose
registration was actually live. The next new-mail notice for the previous
account then appeared on their screen.

Both places that could do this — starting the app, and opening Settings — now
turn drawing back on only for a registration the server has confirmed belongs to
the current session. Turning notifications OFF is unchanged and still takes
effect immediately, without waiting for the network.

### Mailboxes that keep folders under a prefix

Some servers file everything under a prefix such as `INBOX.`. On those, the app
did not recognise its own folders and asked the server to create all five again
on every single connection. The server refused each one as already existing, so
nothing broke and nothing showed — it was five wasted round trips every time the
app connected. It recognises them now.

The same blind spot had a sharper form: when another installation was actively
organizing the mailbox, the check that asks "is anyone organizing this?" could
answer "nobody" on those servers. Two installations could then both believe they
were in charge of the same mailbox.

### An install that reads a mailbox stops acting as though it organizes it

Two installs never organize one mailbox at once: one holds the lease, the other
reads it. On the reader, reading, searching, marking read and sending all work.
Filing does not — and until now the app let you try, told you it had worked, and
took it back about a minute later without saying why.

The Screener no longer offers a decision it cannot make. Where this install does not
organize the mailbox, the decision bar is replaced by a sentence naming who does and
what still works here; the per-row quick-file menu, "Apply all" and "Mark all spam"
are not drawn; and the five destination keys answer with that sentence instead of
filing. Asking a model about a sender is still offered — advice writes nothing to
the mailbox.

A reader's settings read as a reader's, too. Settings → Desktop and About said "The
mailbox this copy of ohmail organizes" on an install that only reads it, and the
Remove confirmation's first bullet said organizing would stop. Both say what the
install actually does now. Settings → Screener keeps its controls — they are stored
on this computer and take effect if you take the mailbox over — and gains a line
saying so.

### Removing the last mailbox clears the door it came in by

Removing a mailbox cleared the entry, the stored password, the organizer claim and
this computer's copy of the mail, and left the file the app builds its connection
from. The next launch created a fresh entry for the same address and opened saying
"Connected. The first sync has not finished yet." with no password stored anywhere.

The removal itself is unchanged and still happens first. The sign-out that clears
the door follows it, and only when the mailbox you removed was the last one.

### The setup flow's reader ending, and one ask at a time

Choosing "Just read it here" used to close setup outright, so the summary written
for that ending — who organizes the mailbox, since when, and what this computer does
and does not do — was never shown. It is shown now.

On the same screen the pre-selected choice is the one that can succeed: where taking
the mailbox over would be refused, "Just read it here" starts selected and the
refusal is stated before any press instead of only after choosing the other option.

And a first run puts one thing in front of you at a time. The "open email links with
ohmail?" prompt used to stack over setup's own buttons and hide them, with the theme
offer behind both. Both wait until setup is closed.

### The desktop notification switch works, and says what it governs

The app window holds no notification permission and cannot ask for one — the shell
around it asks your system on first use. Reading the browser's permission there
reported a refusal that had never happened, so the master switch could not be turned
on. Meanwhile notices were being posted, because the stored default is on: the
switch showed the opposite of what the app was doing, and there was no way to stop
it.

The switch now reflects and controls what the app does, and the pane says plainly
that your computer has the last word on whether a notice appears.

### Settings → Screener is translated

Its heading, the Ohbox posture, the automatic-suggestion consent, the Ohbox sentence
editor and the two lines shown when no model is set up were written directly into the
source, so a German install read that pane half in English. All of them are proper
catalogue entries now, in both languages.

### When another install has claimed the mailbox, the notice says what to do

"Not organized here — ohmail on your own machine has claimed this mailbox." stated a
fact and stopped, leaving no way forward for somebody who then tried to pull new mail
and was refused. It now says that mail still arrives and is readable and searchable
here, that nothing is filed from here, and where the control is that moves organizing
to this install — after which the other one reads the mailbox. The mailbox row adds
what this install does, and the line under it names the button directly beneath it.

## [0.13.7] — 2026-09-02

Mail at scale, a setup that describes what it actually did, and a Send button
that says what is happening. Beside those: an install that keeps your mail on
this computer can now let a mailbox go, the three columns can be resized and
remember their widths, the notification switches offer only what something can
deliver, and the ohmarchy face stopped clipping the top edge off boxed surfaces.

### Reads opens straight away, however much mail is behind it

Opening Reads built a row for every message in the pile before it could paint
anything, so a large mailbox left the view blank for a long time and the whole
window stopped answering while it worked. On mailboxes of tens of thousands of
messages that was the difference between a client you can use and one you wait
for.

Reads now draws only the rows that fit on screen and asks the local mirror for
the next page as you scroll, and the work that decides what goes where happens
off the thread that draws. First paint is bounded by the size of the window
rather than by the size of the mailbox.

### The action pill folds only when it really runs out of room

The row's action pill collapsed to its short form on a guess about the width
rather than on the width it was given, so it folded on rows with room to spare
and stayed wide on rows without it. It now folds on measurement.

### Setting up reports what this install did, not what some install did

Three ways the guided setup could describe work that had not happened here:

- Connecting a mailbox that another install is already organizing skipped the
  screen that says so, and the summary at the end then claimed senders screened
  and folders created — work the other install had done. The "already organized
  elsewhere" screen now appears whenever the check before consent finds another
  install holding the mailbox, agreeing is the choice to take the mailbox over
  rather than a silent demotion, and the summary describes this install's own
  role: one that only reads says that it reads.
- "How far back should the Screener look?" started on 90 days while calling one
  year the usual answer. It starts on one year.
- The Screener's "all time" setting saved and did nothing. The code that decides
  which senders the Screener asks about never read it, so the pane said the
  Screener would ask about everyone and the queue did not change. It now widens
  the queue as it says.

### A mailbox can be let go from an install on this computer

An install that keeps your mail on this computer can now remove a mailbox from
Settings → Mailboxes. Removing one releases the organizer claim, deletes this
computer's copy of the mail, and closes any scheduled sends; connecting the same
address again shows each message once. In 0.13.6 the removal itself was already
correct — there was no control that reached it, and the note for that release
described a flow you could not get to.

One rough edge is still there, and it is better said than found: removing a
mailbox does not yet clear the address from this install's own door settings, so
the next launch lists that address again as a mailbox waiting for a password.
Nothing is connected and nothing is fetched — there is no stored password, so
no server is contacted and no mail is copied or organized — but the entry
reappears, and clearing it properly is the next release's work.

### Connecting a mailbox something else already organizes now says so

Exactly one thing organizes a mailbox at a time. Before ohmail takes that on it
asks whether something already is — another computer of yours, or the hosted
service — and if so it tells you who, and asks, instead of offering the plain
"organize this mailbox" statement. That question came back "nobody" on a whole
class of mail servers, whatever the true answer was.

ohmail keeps a small housekeeping folder in the mailbox and looked for it by name
at the top of the folder tree. Servers that keep everything beneath a top-level
INBOX file it one level in and list it there, so the name never matched. On a
mailbox another machine was actively organizing, the warning did not appear and
you could take it over without being told anything was there.

The folder is now found where the server actually keeps it — under the personal
folder prefix the server declares, or at the top of the tree when there is no
prefix — and the side that reads it and the side that writes it now resolve it
the same way, so they cannot end up pointed at different folders. Where two
folders could both be it, ohmail says it cannot tell rather than guessing.

### Send says what it is doing, and cannot hang

Pressing Send could sit for several seconds with nothing on screen to say the
message was on its way, and a send that stalled had nothing to stop it.

A send opens a fresh connection to the mail server for every press, and how long
that takes depends on the provider — invisible on some, several seconds on
others. Each individual network step already had a deadline; the sequence of them
did not, so every step could sit just under its own limit while the press had
nothing to wait on.

The request now answers as soon as the message is reserved, and an attempt has a
ceiling of its own. What a breach means depends on where it lands: before
anything has been offered to a server the message provably did not go, so it is
recorded as not sent and Send is the retry; after, the outcome is genuinely
unknown, the request answers "queued", and the recovery that has always existed
resolves it — a later attempt under the same key reports the live one and
searches the Sent folder before deciding anything. Nothing is ever sent twice.

The button carries that state. It keeps its accent fill while locked, and while
sending a thin band of light passes along its foot — motion inside the control's
own shape, not a spinner. A confirmed send completes the band once and settles on
"Sent"; a queued submission rests with a sentence under the row. Reduced motion
keeps the labels and drops the movement.

### The three columns can be resized, and stay where you put them

The sidebar, the message list and the reading pane had fixed widths. The two
gaps between them are now the handles: the gap itself takes a resize cursor, and
a line down its centre appears as you approach it and turns to the focus colour
while you drag. There is no grip and there are no dots — the line is drawn at the
same width the focused tile's border is drawn at, so it is a hairline in the
light interface and matches the border weight in the tiling one.

The sidebar clamps between 200 and 360 pixels and the list between 320 and 720,
and the reading pane always keeps at least 480. Those limits are enforced by the
layout rather than by the drag, so narrowing the window gives way on its own and
widening it again brings your width back — the number you chose is not
overwritten by a window you made smaller for a minute.

Your widths are stored on this machine, not on your account: a laptop and a large
display are allowed to disagree about how wide a sidebar should be. They are read
back before the first frame is drawn, so the window opens at the size you left it
rather than resizing itself a moment later, and the loading silhouette stands in
the same three columns the mail will.

The separators are real controls, not just drag targets. Tab reaches them; the
arrow keys move a seam by 16 pixels, or 64 with Shift; Home and End go to the
limits; Backspace, Delete or a double-click puts one seam back to its default and
leaves the other where it is. Those keys apply only while a separator has focus,
so the arrow keys mean what they have always meant everywhere else. Below the
width where the three columns collapse into one there are no seams, so there are
no handles and no extra stops on the keyboard walk.

One smaller correction rides along: the gap between the list and the reading pane
was fixed at 16 pixels and now follows the layout's own spacing, which leaves it
unchanged in the light interface and brings it into line with the tighter spacing
the tiling one uses everywhere else.

### Settings offers only the notifications something can deliver

The notifications pane offered four switches. One of them reached anything: new
mail in the Ohbox. A new sender waiting, a scheduled message's outcome and a
device pairing were described but drawn by nothing, on any platform — three
controls that could not act, sitting above an assurance about what notifications
contain. The pane now offers a switch only for events something actually draws;
the others reappear as switches when something draws them.

### Signing out takes this browser's notification registration with it

Signing out of ohmail in a browser left behind the registration that lets the
server wake it. The clean-up that removes those registrations is scoped to a
device, and a browser signing in does not create a device record — so the
clean-up never matched a browser's registration, and because the browser was
still subscribed the registration never looked dead either. It stayed, and the
server went on using it.

On a shared computer that is the case that matters: someone signs out, the next
person signs in, and the browser can still be woken for the first person's mail.

Signing out now deletes that registration, unsubscribes the browser, and clears
the stored copy of it — each of the three independently, so that one of them
failing still leaves the other two to close the gap. Whether ohmail may show
notifications at all is a permission belonging to the computer, so that setting
stays, as the appearance settings do.

### Ring surfaces keep their top edge on the ohmarchy face

A tile's edge on the ohmarchy face is an outer ring painted in the pixels beside
the box, and a scroll container clips at its padding edge — so a ringed surface
standing flush at a scroller's top lost the rows its top edge lives in while the
other three edges stood in room the layout already reserved. The compose card,
the settings pane and a selected first row all showed three edges out of four.
Every scroller now reserves the ring's width at its top: nothing under paper,
where no ring is painted, and the ring's exact width under ohmarchy.

## [0.13.6] — 2026-09-02

A fix release for the guided setup that 0.13.5 introduced. On the "on this
computer" door that setup could not be reached at all, which is the whole of the
release.

### Connecting a mailbox on this computer opens the setup, instead of skipping it

Connecting a mailbox on the standalone door dropped you straight into the mail
client. Nothing opened the guided setup — no welcome, no statement of what would
be moved where, no question about a model, no progress screen. The flow existed
and had no way in on that door; it was reachable only from Settings, after the
fact.

Connecting opens it now, and which screen it opens on is derived from the state
of the mailbox rather than from a step counter, so quitting and coming back
resumes where you were.

**A change in behaviour worth knowing before you upgrade:** a mailbox you connect
on that door is now a *reader* until you agree to the re-arrangement — ohmail
reads and mirrors it and creates nothing, moves nothing, until you press Agree on
the consent screen. An install that is already organizing a mailbox keeps
organizing it; nothing about existing setups changes.

### Removing a mailbox and adding it back no longer doubles every message

After removing a mailbox from a standalone install and connecting the same
address again, every message was served twice and every conversation became a
thread holding its own duplicates. The local copy of the removed mailbox was not
being cleared, so the second connection added a second copy of everything beside
the first.

### A self-hosted server names itself on the reader banner

A server you run wrote "ohmail Cloud" into its own users' mailboxes. That name
travels in the organizer claim inside the mailbox, so it showed up on the "organized
by" banner and to anyone opening that folder in another mail client — naming a
hosted service they are not a customer of as the thing that had taken their mail.
A self-hosted deployment now names its own origin.

## [0.13.5] — 2026-09-02

Setting ohmail up is a guided flow now. Beside that: an install that has handed
the organizing role to another one keeps reading the mailbox instead of
freezing, the window frame is handed to tiling Wayland compositors, a mailbox
can be removed, Test connection answers, and the settings panes are one system.

### Setting up is a guided flow, not a settings pane

A first run now walks from "I installed ohmail" to a mailbox that is being
organized, one screen at a time: connect a mailbox and test it, agree to the
re-arrangement in the words of what actually happens, choose how far back to
screen, answer the AI question, watch the first pull with a real count of what
is left, and take a first Screener decision.

It is cancellable and restartable at any point, it resumes where you left off
across restarts — by looking at the state of your mailbox rather than by
counting screens — and it can be run again later from Settings.

The consent screen names the folders your mail will be arranged into and says
plainly that they are ordinary IMAP folders every other mail client can still
see, that History is a view rather than a place things are moved to, and that
nothing moves until you agree.

### An install that no longer organizes a mailbox keeps reading it

Exactly one install organizes a mailbox at a time — that is what keeps two copies
of ohmail from filing the same mail twice. When another install takes that role,
this one stands down.

Standing down used to mean stopping. The mailbox froze at the moment of the
handover: no new mail, and — because the read-state write-back runs in the same
loop — mail you marked as read here never became read in the mailbox itself.

Now standing down means becoming a reader. The mailbox stays connected, the
mirror keeps growing, you can still search it, still mark mail read, still send.
What a reader does not do is re-arrange your mail; that belongs to whichever
install holds the role.

**Organize here instead** takes the role back, and it now takes effect while the
app is open rather than at the next launch. The button says what it is doing —
asking, since the mailbox itself grants the role — and it is not offered at all
when the mailbox would refuse it.

### The window frame belongs to the compositor on tiling Wayland desktops

On Hyprland and its relatives the app drew its own title bar and menu bar inside
a window the compositor was already framing, so every window had two borders and
a menu bar nothing else on the desktop has. On those compositors ohmail now hands
the frame over and draws neither.

Ordinary stacking desktops — GNOME, KDE, Windows, macOS — are unchanged and keep
both. If the detection is wrong for your setup, `OHMAIL_DECORATIONS=1` restores
the title bar and the menu bar.

Because the menu bar is where **Check for updates** lived, it has moved into
Settings → About, where it is reachable on every desktop.

### A mailbox can be removed

Settings → Mailboxes has a remove action, with a confirmation that says what
removal actually does: ohmail stops syncing and forgets the credentials; the mail
itself stays in your mailbox, in the folders it is already in. Nothing is deleted
from the server.

### Test connection answers where you pressed it

The mailbox form's connection test reported nothing at all. It now gives a verdict
next to the button for every outcome — connected, with the server it reached and
how many folders it found, or the specific reason it could not: the password, the
host or port, the encryption, or a server that never answered.

Three things the test learned after that, each of which had let a verdict describe
a form you were no longer looking at: editing a field cancels a test that is still
running, a sign-in option that appears mid-form clears the result belonging to the
old one, and permission to reach one server without encryption does not follow you
to another.

### One settings system

Every settings pane now uses the same form grammar — one column, labelled rows,
the same spacing and the same controls — instead of each pane having grown its
own. The model settings became a form of their own rather than a panel of
scattered controls, and they read the mail engine once per pane rather than on
every keystroke.

On the ohmarchy face the focused tile now carries a ring, so arrow navigation says
where you are.

### Also

- Keyboard shortcuts work in the Folder, Tag and History views, where they used to
  do nothing.
- A screening suggestion run asks how many senders to cover, and buys them in
  bounded batches instead of one at a time.
- When an install stands down, the scheduled sends it can no longer deliver are
  closed rather than left to expire silently.
- The first load of a cloud-connected window stops showing empty message bodies
  while its local copy is still filling.
- The update pane registers one listener for the app, survives a stale read, and a
  refused check no longer leaves its button stuck.

## [0.13.4] — 2026-09-01

Four fixes to the Linux packaging, one of them the difference between an app that
draws and an app that does not. Nothing else changed; macOS and Windows are the
0.13.3 build with a new version number.

### The AppImage renders on distributions whose graphics stack is newer than Ubuntu's

On some machines the AppImage started, mapped its window, and never drew
anything. The log said

```
Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
```

and the web process aborted. It was not the machine: the same computer ran its
own distribution's WebKitGTK fine.

An AppImage carries its own copy of most libraries, but deliberately not the
graphics drivers — those have to be the host's, because they are the ones that
match the hardware and the kernel. The trouble is that the host's driver does not
arrive alone: Mesa's EGL library links `libwayland-client`, and an AppImage puts
its own libraries ahead of the system's for every process it starts. So the
host's driver was being loaded against the AppImage's copy of that library
instead of the one it was built against, and on a host whose Mesa is newer than
the system this was built on, it could not load at all. Nothing said so; the only
symptom was the EGL line above.

`libwayland-client` is no longer bundled, so the host's driver gets the copy it
expects. The AppImage project's own exclude list has recommended exactly this
since 2024; the packaging tool in use here was built before that entry existed
and did not know about it.

If you hit anything like this again, `OHMAIL_SYSTEM_WEBKIT=1` now runs the app
against your distribution's GTK and WebKitGTK instead of the bundled ones:

```
OHMAIL_SYSTEM_WEBKIT=1 ./ohmail-linux-x86_64.AppImage
```

### The window is no longer forced through XWayland

The AppImage's launcher set `GDK_BACKEND=x11` unconditionally, which put every
Wayland session on XWayland — where the window is scaled 1x and looks blurry on a
HiDPI display — and did it even when you had asked for something else. It was a
workaround for a crash reported against a much older build than this one. The
launcher now leaves the choice alone: on a Wayland desktop the app is a Wayland
app, and `GDK_BACKEND=x11` still works if you want it.

### Clicking a mailto: link opens a message

ohmail's desktop entry has always declared itself a handler for `mailto:`, which
is what lets you pick it as your system mail app. It was missing the one field
that passes the address along, so the app opened with nothing — the address you
clicked went nowhere. The entry now hands it over, and the app opens a message to
that person. This affects the `.deb` as well as the AppImage.

### The arm64 build no longer looks for x86 directories

The arm64 AppImage's launcher pointed its GTK module search path at
`/usr/lib/x86_64-linux-gnu/gtk-3.0`, a directory no arm64 machine has. It now
names the architecture it was actually built for. The build checks this on both
architectures, out of the finished AppImage, so it cannot come back quietly.

## [0.13.3] — 2026-09-01

ohmail now has an arm64 Linux build, connecting your own mail server tells you
which host its certificate is for, and the mail engine stops using a stored
password with a server it was never proved against.

### Connecting your own mail server says which host the certificate is for

When you connect a mailbox, ohmail dials the server and checks its certificate
before it sends your password anywhere. A common way for that check to fail is a
name that looks right and is not: you type `mail.your-domain`, the server
answering there presents a certificate for `your-domain`, and the connection is
refused. That refusal is correct and nothing of yours is sent — but until now the
desktop app only told you to "check the IMAP host with your provider", while it
already had the right host in hand.

It now says it: which name the certificate is for, which name you typed, and —
where the certificate makes it unambiguous — the name to use instead. This is the
wording the web app has been showing for a while, so the same refusal reads the
same way wherever you meet it.

Nothing about what is trusted changes. The suggested host is only ever shown to
you; nothing connects to it until you enter it, and the next attempt verifies the
certificate against that name as strictly as before. A refusal this does not fully
recognise still shows the server's own sentence rather than a guess.

### Checksums

Every release now carries a `SHA256SUMS` listing every file on it, so you can
check a download against what was published:

```bash
shasum -a 256 --check SHA256SUMS   # sha256sum --check on Linux
```

The download page has offered "notes and checksums" for a long time and the
releases published none. The builds are unsigned, so this is one of the two checks
actually available — the other being the signature on an update, which has always
been verified before anything is installed.

### arm64 Linux

Until now the Linux download was x86_64 only, so a Raspberry Pi desktop, a Mac
running Linux under Asahi, or an arm64 workstation or server had no ohmail build
at all — the x86_64 AppImage does not run on those machines and there is nothing
in the way to translate it. There are now two Linux builds:

| architecture | files |
|---|---|
| x86_64 | `ohmail-linux-x86_64.AppImage` · `ohmail-linux-amd64.deb` |
| arm64 | `ohmail-linux-aarch64.AppImage` · `ohmail-linux-arm64.deb` |

`uname -m` tells you which one to take: `x86_64` or `aarch64`. They are the same
application, compiled twice. There is no single file that runs on both, the way
the macOS DMG does — ELF has no equivalent of a universal binary — so the two are
built on separate machines and each carries a Node runtime for its own
architecture.

**The update feed knows about both.** An arm64 install asks for an arm64 payload
and is offered the arm64 AppImage; it can never be handed the x86_64 one. Nothing
changes for existing x86_64 installs: they ask for the same key they always have
and get the same file.

**What is verified, and what is not.** The arm64 build is compiled, tested and
packaged on arm64 hardware, and it passes every check the x86_64 build passes:
both Rust test configurations, the window-bundle render, the artifact inspection,
and — new for this architecture — starting its own mail engine from inside the
packaged AppImage with nothing installed on the machine. What has not happened is
a person opening the window on real arm64 hardware, because this project has
none. If you run it, please [say how it
went](https://github.com/trafficflowhq/ohmail/issues).

**Windows stays x86_64.** There is no arm64 Windows build and this release does
not add one. macOS was already universal and is unchanged.

The `.deb` still cannot update itself, on either architecture, for the reason the
[README](README.md#linux) gives: a package install updates through the package
manager it came from.

### A stored password is only ever used with the server it was set up for

This closes the thing 0.13.2's notes said it did not close.

0.13.2 fixed the order the connect screen uses, so changing a connected mailbox's
server no longer offers the new server your old password. But that fix lives in
the screen. The mail engine itself still trusted whatever password was stored
without checking which server it had been stored for — so anything that changed
the settings by another route, or an app that was interrupted midway through
changing them, could still start up pointing at one server holding a password
proved against another.

The engine now checks. When a stored password was set up for a different server
than the one it is now configured for, it is not used — not to fetch mail, and not
to send it either. Nothing is deleted — the stored password is still where it was.
To get going again, open the mailbox settings, confirm the server you want and
enter its password; the app asks for it because entering it is what proves it
against whichever server you have chosen.

This matters most in the moment the 0.13.2 fix cannot reach. Storing the new
password and writing the new settings are two steps, and an app that is closed or
crashes between them is left with the two disagreeing. When there is someone to
tell, 0.13.2 tells them. When there is not — the app simply stopped — the next
launch is the only thing left, and it now declines to sign in rather than guessing
which of the two is right. A scheduled send firing in that same moment is declined
for the same reason, instead of offering one server's password to another.

**And it says so in words that are true.** Settings shows "Server changed", and
explains that the password was set up for a different mail server and has not been
sent to the server this computer is set to. It deliberately does not show the
"needs re-entering" message that means your keychain will not open the password:
this check runs first, before the app tries to open anything, so the changed server
is what you are told about. It is careful in the other direction too — getting into
this state usually means the password was already proved against the server it was
stored for, so the only honest claim is about the server it was withheld from.

One limit worth stating: this check compares the incoming mail server. A change that
moves only the outgoing server is not covered by it yet.

## [0.13.2] — 2026-09-01

A fix release for Windows. On Windows 11, ohmail 0.13.0 and 0.13.1 could not start
their mail engine at all — so no mailbox could be connected, on any of the three
ways in. This release fixes that. macOS and Linux were never affected.

### The Windows app can open a mailbox

**The engine would not start.** ohmail carries its own copy of Node and runs the
mail engine with it, which means it has to work out where its own files are. On
Windows the answer comes back in an extended form — `\\?\C:\Users\…` rather than
`C:\Users\…`. Windows accepts both, and so does every check ohmail makes, so the
app had no reason to think anything was wrong: it found the engine, found the
runtime, and launched. Node does not accept the extended form for the file it is
asked to run. It reads the front of such a path as a bare drive letter, fails on
that, and exits before loading anything. Four attempts, four identical failures,
and then the app stopped trying. Paths are now converted to their ordinary form
before anything is handed to Node.

**And the message you got named a cause that was not the cause.** After the fourth
failed start the app said the engine had stopped restarting, and that another
running copy of ohmail was the reason. It was not, and nothing on screen could tell
you otherwise: the engine had written the real error out four times, into ohmail's
own log file, while the app offered a different explanation. That sentence now
quotes what the engine actually said. It suggests a second copy only when the
engine stopped without saying anything at all, and then as one possibility rather
than as the answer.

### Changing a connected mailbox's server, which 0.13.1 said was still broken

0.13.1's notes named two problems on this path and said they were not fixed. They
are fixed here, together, and both were the same wrong order.

Choosing where your mail lives writes the server settings and restarts the mail
engine behind them, and the password was offered afterwards. That order is right
the first time a mailbox is connected: there is no mailbox to attach a password
to, and no stored password that could be misused. It was wrong when the server of
an already-connected mailbox changed, and it went wrong in both directions.

**When the change succeeded, the new server was offered the old password.** The
restarted engine came up pointing at the new server while still holding the
password stored for the old one, and it signed in with it — before you had been
asked for the new one. Correcting a mistyped hostname cost nothing; moving a
mailbox to a server you do not control handed that server your previous password.

**When the password was refused, a working mailbox was left offline.** The
settings already named the new server while the stored password still belonged to
the old one, and nothing put them back. The next launch tried the new server with
the old password, and a mailbox that had been working that morning stopped
connecting.

The password is now proved and stored first, and the settings are committed only
once it has been accepted. A refusal writes nothing at all: the mailbox is left on
the configuration that was working, and the app tells you what the mail server
said. Changing the address as well as the server keeps the original order, because
that is a different mailbox rather than a reconfiguration of this one — it starts
with no stored password, so there is nothing to misuse there either. First
connects are unchanged.

One thing this does not close, said plainly: the fix is in the screen that changes
the setting. An engine started some other way still trusts whatever password is
stored without checking which server it was stored for. Saying so on screen needs
wording that is not a lie — the existing message for an unusable password tells
you your keychain will not open it, which would be false here — so it is left for
its own release rather than half-done.

## [0.13.1] — 2026-09-01

A fix release for the connect screen. Connecting your own mail server on a fresh
install could not succeed: it refused every attempt with "imap host is required",
however carefully you filled the form in. Three separate faults sat on that one
screen — reported by [issue #5](https://github.com/trafficflowhq/ohmail/issues/5),
which is the only reason any of them was found.

### Connecting your own mail server

**"imap host is required", on a form where you had typed the host.** Connecting on
the desktop app is two requests: the server settings go to the app, which writes
them to a file, and the password goes separately to the local mail engine, because
the password deliberately never travels with the settings. The engine creates the
mailbox when it starts, and at that moment it has no password, so it stores no
server configuration. The password arriving a moment later was merged over a stored
configuration that did not exist — which left no host, and that is the message you
saw. The password request now carries the server settings with it.

This was never specific to a custom server. A preset provider's host was equally
absent from that request. It only ever *looked* like a custom-server problem
because "any other IMAP mailbox" is the one option where you type the host
yourself and can see it sitting in the field you are being told is empty.

**The provider picker reported a choice that had not changed.** Clicking the
provider tile you had already chosen, or pressing Space on it, counted as picking
it again. Every connect screen answers a choice by filling in that provider's
servers, and "any other IMAP mailbox" has none to fill in — so doing that quietly
emptied the incoming and outgoing server fields further down the form. The error
appears directly above the provider grid, which makes confirming your provider the
natural next thing to do, so this could loop.

**Mail did not start arriving until the app was restarted.** After a successful
first connect the app sat empty, with no error and no explanation. The engine reads
the password once, when it starts, and on a first connect it starts before there is
one. The app now restarts it after storing the password, and waits for it to come
back before reporting success.

**A provider's server no longer carries into an attempt on a different one.**
Choosing a provider fills in its servers; choosing "any other IMAP mailbox"
afterwards used to keep them, so the manual fields could open already containing,
say, Gmail's server, and the password you then entered for your own server would
be tried against Gmail. Only servers you typed yourself are kept.

### The settings file is replaced, not overwritten

ohmail keeps one small file recording how you connected, and reads it at every
launch. It was written by truncating the old file and writing over it, so a crash,
a power cut or a full disk during that write left the file unreadable — and an
unreadable file is treated as "never configured", so the app came back asking how
you want to connect with your mailbox and saved password both still there. The new
contents are now written beside it and renamed into place, so the file on disk is
always either the whole old configuration or the whole new one. The same applies to
the file recording whether this install publishes your mail to your own network.

### What this release does not fix

**Changing an already-connected mailbox to a different server still sends the
password you had stored to the new server, before you are asked for a new one.**
Everything above is about a *first* connect, where there is no stored password and
nothing to send. Re-pointing a mailbox is a different path and it has the wrong
order: the engine is restarted with the new server and the old password, and it
tries to log in before you have supplied anything. If you are correcting a typo in
your own server's name this costs nothing; if you are moving a mailbox to a server
somebody else runs, that server is offered your previous password. Only the person
at the machine can reach it, and only for their own mailbox. Fixing it means
changing the one path that logs in to a real mail server, which is not something to
do in the same release as the fixes above — so it is stated here rather than
quietly carried. Until it is fixed, change the password on the old server if you
move a mailbox to a server you do not control.

**And an attempt that fails partway can leave a mailbox that was working offline.**
Same two steps, on the failing side: the server settings are written before the
password is checked, so if the password is refused the app is left holding the new
server and the old password. The attempt reports the failure and you back out, but
the settings are not put back — and the mailbox that worked this morning does not
connect at the next launch. Re-entering the correct server and password fixes it.
Both of these are the same shape and will be fixed together, in a change to the
step that stores the settings rather than to the screen.

## [0.13.0] — 2026-09-01

A feature release. ohmail has a second look — **ohmarchy**, a tiling, keyboard-first
appearance you can turn on per device or across your account — a second window arrangement
to go with it, and a keyboard grammar that reaches every screen in the app. On an Omarchy
desktop the window follows the theme you set in the system.

### A second look

Settings → General → **Look** now offers two appearances: **paper**, which is what ohmail
has always looked like, and **ohmarchy**, a denser, tiling, keyboard-first look.

- **Off by default on macOS, Windows and in the browser** — nothing about your install
  changes there until you pick a look. **Linux is the exception**, below. A choice you have
  already made, on this device or on your account, always wins over any default.
- **You choose the scope.** Picking a look applies to the device you are on and nothing else.
  *Apply on all devices* stores the choice on your account, and every other device you use
  picks it up.
- **On Linux, ohmail starts in the ohmarchy look** — including an install you already have
  that has never chosen one, which will therefore look different after this update. **If you
  are signed in to an account**, ohmail says so, with one press to make the choice account-wide
  and one to dismiss; dismiss it and it stays dismissed. A standalone install with no account
  gets the Linux default with no notice, because there is nothing for *apply on all devices* to
  write to — switch looks in Settings whenever you like.
- Both looks answer light, dark and system exactly as before, including where a message or a
  panel sets its own scheme inside the page.

### The Zero layout

A second arrangement of the same app: no window header, panes as tiles, one band per zone.
Press **`w`** to switch between it and the classic layout, or find *Switch layout* in the
command palette. It is a per-device choice — it is never stored on your account and never
follows you to another machine — and the classic layout stays the default in both looks.

Zero works with either look, because the arrangement is written in the same design tokens
both looks fill in. The reading pane behaves differently by design: under Zero at a wide
enough window the reader is a tile beside a live list rather than a sheet over it, so `h` and
← put the list back instead of closing a modal.

### The whole app on the keyboard

The keyboard map is one table now, and it covers the app rather than the parts that happened
to have shortcuts.

- **Go anywhere with `g`.** `g l` / `g p` / `g b` for the triage horizons, `g d` drafts,
  `g h` history, `g ,` settings, and the stream jumps you already had.
- **`h` and `l`** move between zones, the lateral twins of the arrows.
- **`p`** pulls new mail now. **`m`** moves a message and puts the cursor on the first
  destination. **`d d`** deletes: the first press asks, the second confirms.
- **`[` and `]`** walk the Screener's sections.
- **In compose,** `1`–`4` pick a send-later slot, and ⌘↵ sends — or schedules, when the
  picker is open. Reply-Run takes ⌘↵ too.
- **The focused zone is drawn, not guessed.** A quiet border in paper, a loud one in
  ohmarchy, on whichever pane the keyboard is actually in.
- **Buttons wear their keys.** Where an action has a shortcut, the button shows it, read from
  the same table the keys come from — so a button and its key cannot drift apart.
- **`?`** lists everything, and the movement hints at the foot of a section are generated from
  the live map rather than typed by hand.

Nothing is bound to Super, to Alt, or to a function key, and a test refuses a binding that
breaks that.

### On an Omarchy desktop, ohmail follows your theme

Run `omarchy theme set` and the ohmail window re-skins itself to match, without a restart and
without you telling ohmail anything. It reads the theme the desktop is actually using and
maps its palette onto the ohmarchy look.

It is deliberately conservative about what it will apply: a palette that cannot meet the
contrast floors ohmail holds itself to is refused, and the theme you had stays. So a theme
ohmail cannot render legibly leaves the window as it was rather than making text you cannot
read. This applies to the ohmarchy look only — in paper, ohmail keeps its own colours.

### Under the hood

- **Mail stylesheets are read the way CSS is written.** An `@import` now ends where the CSS
  grammar says it ends rather than at the first semicolon, and a font family the policy
  cannot pass is dropped on its own instead of taking the whole stack with it.
- **A remote image that redirects is followed through the proxy** rather than refused, so
  images from senders whose CDN redirects now appear when you ask for images.
- **Pairing a desktop is one identity.** The storage partition, the window and the mail
  engine move together when you switch which account the app is paired to, instead of one of
  the three keeping the previous account's state.
- **A second window opening no longer ends the first one's session.** The guard that keeps two
  windows from fighting over one mailbox now stands down instead of deleting the session the
  newer window just created.
- **Sizes a caller or a sender chooses are bounded where they enter the app's own server
  half**, with a census that fails if a new door is added without one.

### Known limits, named

- **The Linux `.deb` cannot update itself, and this is not new in 0.13.0.** A build installed
  from the `.deb` asks the release feed for a Debian package first; the feed publishes only
  the AppImage; so the app downloads the 130 MB AppImage and then reports *"ohmail could not
  install the update. Try again in a moment."* Nothing on disk is touched and nothing is
  damaged — but the in-app updater does not work for a `.deb` install, and it did not work in
  0.12.x either. **If you want in-app updates on Linux, install the AppImage.** From a `.deb`,
  update by downloading the new `.deb` and installing it over the old one. The same applies to
  any distribution package built from the `.deb`.
- **The phone wears the look, but is not held to the same contract, and its device choice
  does not survive a relaunch.** The Android app at 0.13.0 offers paper and ohmarchy in
  Settings, built from the same palette set as the desktop so the two cannot drift apart, and
  *apply on all devices* stores the choice on your account and does persist. **A device-only
  choice on the phone lasts for that run of the app** — reopen it and you are back on your
  account's look, or on the default. On the desktop, and in a browser that lets ohmail keep
  local storage, a device choice is remembered; a browser that refuses storage loses it the
  same way, which is the limit named at the foot of this note. The phone also has no Zero layout — that is the desktop and the browser — and its
  theming is its own machinery rather than the shared stylesheet the other surfaces are checked
  against.
- **A fifth review pass on the mail-stylesheet reader is owed, not finished.** Four passes
  returned eight, seven, six and three findings, and each one landed on the previous pass's
  fix. The reading frame also still allows a consented image to be requested from any path on
  ohmail's own origin, not just the image proxy's — narrower than it was, not closed.
- **Bounding a size is not the same as parsing it.** On several list endpoints a non-numeric
  page size or a date without a timezone is still accepted and can fail as a server error
  rather than a refusal.
- **Signing out while switching doors can still leave a credential behind.** Changing which
  door the desktop is on inside the same second as a sign-out can leave the other door's
  saved mailbox password sealed on disk under a sign-out that reported success. Two
  deliberate gestures in one second, and it is the strongest credential this app stores.
- **The limits 0.12.2 named are unchanged**: a restarted compose can still mint a second send
  key rather than resuming the first; a browser that refuses local storage leaves a decision
  as durable as the tab; sent mail is recognised by a folder's NAME; and a mailbox that
  reports a folder identity of zero is still read as "not yet learned".

## [0.12.2] — 2026-08-31

A correctness patch. The Ohbox stopped calling other people's mail your own,
so your real correspondence is back at the top where it belongs; a resurfaced
message now reads unread on every screen at once; decisions are written to disk
the moment you make them rather than seconds later; and signing out takes
everything with it and tells you if something was left behind.

### Your Ohbox shows your correspondence again

The Ohbox groups mail you sent yourself separately from mail you received, and
it decided which was which by asking "is this message outside the six views
ohmail organises?" That was true when the app only ever saw those six folders.
Once it began mirroring your mailbox's whole folder tree, every message in every
other folder — Promotions, archives, anything your provider or an old client
made — was counted as mail you had written. On a large mailbox that is most of
the "Me → …" rows in Earlier, each one sorted by its own date instead of by when
you read it, which pushes real conversations below the fold. Sent mail is now
recognised by the Sent folder itself rather than by "not one of ours". One
residual, and it is bounded where the old rule was not: a Sent folder named in a
language the two name lists do not carry is not recognised, and that account's
sent mail is missing from Earlier until the folder the server advertises is
recorded per mailbox.

### One answer per screen

Open on a desktop and in a browser at the same time and the two could disagree.

- **A resurfaced message reads unread everywhere.** A message you asked to see
  again now presents as unread on the rows, in the reading pane, in tag and
  folder views, and on the phone, and it does so by derivation — nothing writes a
  read mark to your mail server to make it look that way, so no background pass
  can argue with it and no `\Seen` flag is changed behind your back. Glancing at
  it lands your read without clearing the pin, so the row does not change under
  you while you are looking at it; replying, marking it done, or otherwise
  dealing with the row clears it, and your genuine read state applies from that
  instant.
- **The new-mail badge counts the mailbox, not the scroll position.** The number
  beside a stream used to count everything above your device's last-visited
  line, so a pile the mail server considered entirely read could still show a
  count — a different one per device. It now counts what is both new to you and
  actually unread. Where your last visit ended is still per-device and still
  does not move under you while you read.
- The phone was computing its own third answer for the same badge and now reads
  the same one.

### What you decide is on disk before it is done

The mirror and its decision journals were writing after the fact, which left
narrow windows where a crash or a closed lid could lose work the app had already
told you was applied. Each item below is about where the record is written and
when. One limit applies to all of them: where the browser refuses local storage
outright — a private window, storage switched off, a full quota — the record is
still only as durable as the tab, and the app does not yet tell you that.

- A screening decision is recorded from the press, not up to eight seconds later.
- The key that makes a send at-most-once is written to disk at the moment it is
  minted, before the send is dispatched, instead of being held only in memory. A
  further press on the same compose resumes that key rather than minting a second
  one, and the server refuses to deliver one key twice.
- The mirror's cursor advances only once the page it covers is actually stored, so
  an interrupted sync resumes where the data ends instead of past it.
- Clearing data in one window fences the others rather than letting an abandoned
  bootstrap leave a half-built mirror behind. The fence is kept inside the local
  database it guards, so a second tab whose write was already in flight when you
  cleared can still recreate it; closing your other tabs first is still the
  reliable way.
- A re-screen keeps its place on disk, says which of three ways it stopped, and
  claims completion only when it holds it; a mailbox that has been deleted is
  treated as gone rather than as finished.
- An attachment upload is keyed by the request that asked for it, so a retry after
  a lost response finds the ticket it already made instead of minting a second
  one — the file is stored once and counted against your storage once.

### Signing out takes everything, and says so honestly

Signing out cleared the mail mirror but left the local decision journals in
place. It now clears those too, releases that device's wake registration along
with the credential, and reports what it could not remove instead of always
claiming success — a refused credential deletion is no longer reported as a
completed sign-out. On installs without a browser cookie, stored data is scoped
per account, so signing in as someone else cannot read what the previous account
left.

### The permanent warning at the rail is gone

The rail carried an amber warning whenever this device held fewer messages than
the account has, in every view, for as long as the two numbers differed. It could
not tell a mirror resting between syncs from one that had stopped, and it pointed
at a settings page where every mailbox read "Up to date". The device's holdings
are now a plain line in Settings → Mailboxes. The warning mark is reserved for
actual faults — stopped, failing, blocked, a mailbox error.

### Message styling cannot reach the network

A stylesheet in a received message may name only schemes that fetch nothing. The
check now runs after character escapes are unescaped and after CSS variables are
substituted, so a URL assembled out of either cannot slip past it.

### Smaller things

- The composer's unsent scratch text belongs to the account you wrote it in, not
  to the browser profile, so it cannot surface under a different account.
- Every IMAP command that acts on a stored message reference now checks the
  folder's validity marker first, instead of only some of them doing so — a
  folder your server rebuilds no longer redirects a filing or a read onto a
  different message. One case is still open: a server that reports a validity
  marker of zero cannot yet be told apart from one that reports none, and that
  is the value the check reads as "unknown".
- A search whose date bound cannot be read at all answers "bad request" instead
  of failing; a bound that is merely impossible — the 31st of February, a time
  with no timezone — is still normalised rather than refused. A page limit that
  is not a number is a page, not the whole table.
- The standalone organizer's mirror and the hosted one now share one drain
  policy instead of two implementations that had drifted.

### The phone is a separate release

The Android app is released on its own schedule and is **not** part of this
build. Its next release carries the phone half of the work above — one read
state and one badge across your screens — along with Send later on the phone, a
pairing screen that takes the server address from inside the app rather than
from a link, and a "forget this server" that deletes the mail and checks that it
did.

## [0.12.1] — 2026-08-30

Everything the desktop apps accumulated since 0.12.0, in one patch: the window
paints its own shape from the first frame, block formats in the composer take
lines instead of the whole message, attached pictures preview again, your
actions survive a closed window, a device opened after days away is current in
seconds and says so while it catches up, Send later delivers on the standalone
door, and the app stops calling every computer a Mac.

### The first paint is the app's own shape

On a cold start of the Cloud door, the boot screen could draw bare placeholder
rows — no rail, no panels, no sentence — for the whole time the built-in engine
took to come up. One of the three boot branches rendered a rows-only skeleton;
all three now draw the same three-column silhouette with the engine's own boot
sentence at the rail's foot, and the short no-flicker grace runs once across
them instead of restarting at each hop.

### Block formats take the line, not the message

A message typed line by line is a single paragraph with line breaks, and the
composer's list, quote and code buttons used to format all of it. They now take
exactly the lines you meant: the caret's line when nothing is selected, the
touched lines of a selection expanded to their boundaries — lists one item per
line, a quote as one block with its inner breaks kept, code expanded to whole
lines. Inline formatting survives, and one press is one undo step.

### Attached pictures preview again

Opening an attached image showed the file card — name, type, size, Download —
over an empty stage. The desktop window's content-security policy did not admit
the local `blob:` URLs previews are served from; it now does, for images alone
and nothing else. The web client was never affected.

### Send later delivers on the standalone door

Scheduling a send is part of the composer on both doors. The Cloud door's
appointments were already kept by the hosted service; with this build the
standalone door's own engine drains due appointments too, so a scheduled draft
delivers on time from a mailbox organized entirely on your machine — and a
draft whose appointment passed while the app was closed goes out on the next
healthy cycle rather than being lost.

### What you do sticks, even through a restart

Every action — reading, replying, screening decisions, sends — is recorded in
the app's local mirror before it travels. A closed window, a crash or a restart
no longer loses an action in flight: it is restored with the mirror, shown as
already applied, and replayed under its original idempotency key so nothing is
performed twice. Closing the window also flushes the read-state the reading
pane was still holding, so a message you read stays read everywhere.

### Days away, current in seconds

Reopening the app after days used to mean watching the backlog replay
oldest-first before the newest mail appeared. The mirror now fetches the newest
window first — current mail lands in seconds — and the Cloud door labels the
interim honestly: "As of <time> · catching up" until the mirror converges. The
catch-up itself got several times faster: a stale resume is served the latest
state of each conversation instead of every intermediate step.

### Check for new mail yourself

Both doors gain a pull control at the rail's foot: press it and the app asks
the mail server for new mail now, tells you what happened in a sentence
("Checked — nothing new." / new mail arrives in place), and caps the wait
honestly instead of spinning. The dead band the old rail left at its foot is
gone.

### Sessions survive sleep and wake

The signed-in Cloud door rides the same session fix the web client shipped:
closing the lid mid-refresh recovers instead of signing you out, and several
windows waking at once rotate the session once between them instead of racing
each other out of it.

### A mailbox that receives nothing says so

Settings → Mailboxes now notes when a healthy, syncing mailbox has not
received mail in a long stretch — usually a forwarding rule at the provider
diverting mail before it reaches the mailbox — and says so quietly, with a
dismissal that stays dismissed until mail actually flows and stops again.

### The app speaks your platform

Setup and settings said "On this Mac" on every platform — the 0.12.0 Linux
build greeted its user as a Mac. The wording now comes from the build itself:
"On this Mac", "On this PC", or "On this computer".

### The standalone organizer catches up

- **Unsubscribe works.** The reading pane's unsubscribe on the standalone door
  performs the request — the same at-most-once record per list as the Cloud
  door — instead of answering "unavailable". Automatic unsubscribe on
  screen-out remains a Cloud-door feature; the standalone door files the
  message and touches nothing without you.
- **A takeover respects open questions.** Taking over a mailbox that another
  organizer ran no longer re-screens mail it finds in place while your
  decision about the previous organizer's settings is open: placement on the
  server is treated as the intent it records.
- **A Sent folder's first scan converges.** Duplicate copies of one sent
  message no longer ping-pong the scan forever, and one oversized message no
  longer starves everything behind it — the scan records what it saw, skips
  what does not fit this pass, and finishes.

### Fixes

- Screening a sender out marks the message read in the same act, and that
  read-mark sticks instead of flickering back on the next sync.
- The desktop manifest declares `@tiptap/pm` directly instead of reaching
  through another package for it.

## [0.12.0] — 2026-08-28

Folders you can manage from the app, a Junk window you can search and teach,
per-mailbox signatures, and new mail that shows up in seconds instead of
minutes. The version names a feature wave, so the minor moves. The Android
app is at 0.11.2 as this ships and joins the 0.12 line with its own next
release — each platform's version moves when its release does.

### Manage your mail server's folders

With **Use folders** on, the folder list is no longer read-only: **+ New
folder** creates one on your mail server, and each folder's **…** menu offers
Rename, New subfolder and Delete. Every verb is a real IMAP operation your
server performs — the app records the command, shows the folder wearing its
pending state ("Being renamed to … on your mail server…"), and settles when
the server has actually done it, usually within seconds. A failed command says
why and can be dismissed. Delete asks first, states what it moves, and sweeps
the folder's messages to your server's own Trash — never an expunge — before
removing the folder itself. In the hosted web client the confirmation counts
the messages it is about to move; the desktop app asks with the same sentence,
uncounted.

Folder delivery got its three missing pieces in the same wave:

- The desktop app's folder lists load their contents now. They used to answer
  "older mail could not be loaded" for every folder, because the ask was
  served from the local mirror, which does not hold that mail; it now travels
  to the account, which does.
- A message beyond what the local window kept opens when you click it —
  including from a folder list — instead of offering a Retry that could never
  succeed. A message that is genuinely gone from the server says so, without
  the dead Retry.
- Settings changes land live. Turning folders on or off (or per mailbox) in
  one client reaches every other open client through the sync feed — the
  desktop app no longer needs a restart to notice.

### The Junk window reaches the desktop, and learns three things

0.11.1 gave the hosted web client a live window into the mailbox's own Junk
folder and said the desktop app keeps its verdict-based Spam pile "for now".
Now is over: the desktop app's Cloud door carries the same Junk segment, served
by the account itself. And the window learned:

- **Search.** Typing filters the loaded window instantly; when that finds
  nothing, the app asks your mail server itself (one bounded search per
  mailbox, newest first) and appends the hits — so a message your server filed
  weeks ago is findable without scrolling the whole pile.
- **Not junk, always allow.** Beside "Not junk" — which rescues one message —
  a second action also disables the spam rules standing against that sender
  and mints an allow, so their next message lands in your inbox instead of
  re-filing. Sender-scoped on purpose: a domain-wide spam rule is left
  standing.
- **A one-time sweep.** Accounts with messages that earlier spam rules filed
  into ohmail's own quarantine folder get a counted, two-press offer to move
  them to the mailbox's native Junk folder, where the window (and every other
  mail client) can see them. The number offered is the number moved; the offer
  can be dismissed and does not return for the same pile.

Messages a rule filed to Junk also keep their text now: moving one back out
restores the withheld body instead of leaving a husk.

### Writing mail: signatures, Cc/Bcc, and the subject

- **Per-mailbox signatures** (Settings → Signatures): a sign-off stored per
  mailbox, offered automatically under every message you write from it,
  editable or removable per message. Switching the From swaps the signature;
  a signature you edited stays yours. What you see is what ships — including
  indentation, which survives mail's own whitespace rules.
- **"Change recipients" opens Cc and Bcc at once** — no second click.
- **A reply's subject is editable in place.** It renders as calm text; click
  it and the full subject — `Re:` included — is yours to change. Threading is
  anchored in mail headers, so an edited subject never splits the
  conversation.

### New mail shows up in seconds

Inbound latency on hosted accounts was measured in minutes (median around
three) and is now measured in seconds (single digits on live probes). The
watch on the inbox had been going quiet after the first cycle; it now stays
armed, wakes on real arrivals only — not on the organizer's own bookkeeping —
and catches up anything that arrived while it was switching folders. A
**sync-now** control in the rail and top bar asks the account to pull
immediately and settles when the account has actually scanned, for the moments
you know something was just sent to you.

### Designed mail renders as its sender designed it

The reading pane sets ordinary letters in the app's own type, and that class was
too greedy: a designed message whose template declares its width the responsive
way (`max-width` on a full-width table) or builds its layout from nested tables
was treated as a letter, and the app's table styling drew a border around every
layout cell — a box around each nesting level of a design that draws none. Such
messages now keep their frame: the sender's own presentation, laid out at the
column's width, with sanitization unchanged. Plain letters keep the app's
typography exactly as before, and "Show original" still flips any letter to the
sender's rendering.

### A first sync fills from the top

A fresh install of the Cloud door used to mirror the account oldest-first: the
replay of the account's change history runs in the order it happened, so the
mail at the top of the Ohbox — this week's — was the last to arrive, hours in on
a large account. The first sync now opens with the newest window of mail (the
same recent window the web client boots from — ninety days, and never fewer
than five thousand messages — rules first, then the newest messages), and only
then replays the rest of the history behind it.
The first screenful is current within seconds; the archive fills in underneath.
Interrupting the app in either phase resumes where it left off — the window at
its last committed page, the replay at its committed cursor — with nothing
re-fetched from the start.

The text of the mail now fills from the top too. The one-time body fill walks
the account in storage order — an order that has nothing to do with the list —
so the newest message could open blank until the walk happened to reach it.
Each pass now fetches the first screenful's message text ahead of that walk,
and a catch-up after time offline starts with the newest missing messages
instead of arbitrary ones. The walk itself is unchanged: same pages, same
resume, same finish line.

### One conversation instead of two

A reply that re-enters your mailbox as a forward — say, an answer sent to an
old address of yours and passed along — opens a fresh header chain, and header
chains are how mail is threaded, so the one conversation rendered as two. The
organizer now joins such a chain back onto its conversation when the evidence
is unambiguous: the same subject under a clear continuation prefix (Re:, AW:,
Fwd: and their stackings), a shared correspondent on both chains, close in
time. Mail that merely shares a subject is never merged, and a correspondent
who appears across hundreds of unrelated threads does not count as evidence. A
one-time pass healed the splits already sitting in hosted accounts.

### The keyboard walks the whole window

Arrow keys move between the three zones — ← toward the folder rail, → toward
the open message — and ↓/↑ walk whatever list you are in, including folder,
tag and settings views that previously had no cursor at all. Entering a zone
is a real focus move, so screen readers announce it and the focus ring shows
it. Glancing down a list with the arrows marks nothing read; dwelling on a
message does, exactly as opening it would. The `?` sheet prints the new keys.

### Fixes

- A sent reply's attachments are visible inside its own conversation — the
  thread view used to show them only on the message's standalone page.
- A message returning from Parked, Answer Later or a scheduled resurface keeps
  its real read state instead of flipping back to bold, and reading it in
  place marks it read without cancelling the return.
- While the desktop app boots it draws the real window's shape — rail, list,
  reading pane — instead of a few placeholder text lines.
- The desktop app tells the account what platform it runs on when it signs in
  to the Cloud door, so the account's devices list can name your computer
  instead of guessing.
- The Reads and Receipts stream cards and the Screener's previews follow the
  same image setting as the reading pane; they used to withhold pictures the
  reading pane showed.

## [0.11.1] — 2026-08-25

Deleting mail is safe for synced devices now, the Cloud mirror survives its own
first sync, and the folders you keep on your own mail server can join the menu —
off unless you turn them on.

### Deleting mail no longer stalls a synced device

Deleting a message that other messages replied to could wedge the app's local
mirror of a Cloud account: the sync page carrying the delete aborted on a
reply's reference to the deleted message, the same page was retried forever,
and new mail stopped arriving with no error on screen. Deletes now detach the
surviving replies instead of aborting — on the single-message path and the
whole-thread path alike — and every detachment is announced through the same
sync feed. An install that had already hit this starts moving again on its
first sync after the update: the page that used to abort now applies.

### The Cloud mirror survives its own first sync

- An interrupted first sync resumes where it stopped instead of starting over.
- Every sync request carries a deadline, so a hung connection fails and
  retries instead of freezing the mirror behind it.
- Being signed out shows as signed out, with the door to sign back in —
  not as a false "offline" banner over a network that is fine. An expired
  session is detected and named instead of masquerading as an outage.
- The wake channel backs off when the server asks it to, instead of retrying
  into the same refusal.

### The hosted door re-earns its answer

The gate that decides whether the desktop's hosted client is signed in
re-checks whenever the engine changes, and cancelling the sign-in overlay
re-asks the engine before any mail is shown — a stale "signed in" cannot
survive a cancelled sign-in any more.

### Rules before mail

A first sync loads the account's screening decisions before its mail, so
senders you have already let in never flash as unscreened while the backlog
downloads.

### Your mail server's own folders (opt-in)

Settings → **Use folders** shows the folders you keep on your mail server in
the menu, each opening as its own list with unread counts. It only shows what
already exists — nothing is moved — and turning it off hides them again
without touching your mail. With it on, the reading pane gains **Delete**: the
message goes to your server's own Trash, behind a confirmation that says
exactly that. In the hosted web client the Screener's Spam view also gains a
**Junk** segment — a live window into the mailbox's own Junk folder, with
"Not junk" moving a message back to your inbox on your own server; the desktop
app keeps its verdict-based Spam pile for now.

### Sending and attachments

- A just-sent message shows its attachments immediately, and a forwarded
  message's sent copy lists the files it inherited.
- The picture-quality dial re-encodes pictures that are already attached, and
  its refusals name the limit that actually fired: an unreadable file gets its
  own sentence, a mixed batch states both failures, and a removed file stays
  removed.

### Parked mail returns where it belongs

Mail taken back out of Parked, Answer Later or a scheduled resurface returns
at its own chronological position instead of wherever an old reading stamp put
it, and answering a resurfaced message completes the resurface — the pin no
longer stays up over mail you just replied to.

### Fixes

- On mail servers that advertise no Sent folder, the organizer now follows the
  Sent folder it actually watches by name, so completing a delete there no
  longer leaves a retrying stale row.
- The organizer's first-import stamp reads inbound mail alone, so a long
  outbound filing pass cannot withhold it.

## [0.11.0] — 2026-08-21

ohmail can be your computer's mail app now — and the app carries no demo mail
any more: it opens empty, and you connect a mailbox.

### Your default mail app

**Click an email address anywhere and a new message opens here, prefilled.**
ohmail registers as a mail-app candidate on all three platforms (macOS
`CFBundleURLTypes`, the Linux desktop entry's scheme handler, and on Windows the
installer's capability keys, which put ohmail on Settings → Default apps →
Email). Becoming the default stays your choice, made the way each platform
sanctions: you press the app's own "Make default", then macOS confirms with
its own dialog or applies the change directly, Windows opens the Default-apps
page for you to pick, Linux goes through `xdg-settings`. Nothing writes the
choice behind the platform's back — on Windows in particular, the app never
writes `UserChoice` (it reads it, to show you which app currently has the
job).

**The app asks once.** After a mailbox is connected, one card offers to make
ohmail the default; either answer is remembered and the question never
reappears. Settings → General keeps the row — the live-detected state and the
same action — for whoever changes their mind later.

**mailto links become the compose form, safely.** The link is parsed by one
parser (RFC 6068 — recipients, cc, bcc, subject, body), read defensively: every
field is plain bounded text, control characters cannot ride into single-line
fields, and any other header a link author invents is dropped rather than
honored. A click that *starts* the app still lands: the shell holds the link
until the window is ready to claim it, exactly once. Clicked before a mailbox
is connected, the draft waits until one is. Who you write to is never logged.

### No demo mail in the app

The app used to carry a small fictional mailbox for the case where its bundle
ran with no native shell, and a separate fixtures-only "interface preview"
artifact was built and smoked (never shipped). Both are retired: the app has
two states — not connected, and your own mail — and the one demo lives at
[ohmail.app/demo](https://ohmail.app/demo). The sample-mail corpus is aliased
out of both built bundles and the artifact scan proves its absence from the
emitted bytes, in both directions. The render check's offline audit —
fetch/XHR/WebSocket/EventSource/sendBeacon all sealed — moved onto the bundle
the installers actually carry, which is a strictly stronger claim than the
preview could make.

### Version alignment

Desktop, web and mobile share one main version from this release: the web
app's Settings → About reports the same `0.11` this desktop release carries,
from one source the release bumps.

## [0.10.0] — 2026-08-20

Two additions with one idea between them: what's yours stays with you. Your other
devices can now read your mailbox through your own computer instead of through
anyone's cloud, and the decisions you make — who gets in, where mail files — now
live in the mailbox itself and travel with it.

### Host mode: your computer serves your other devices

**Settings → Devices turns a desktop install into the host for your other
devices.** Your phone's browser opens the same ohmail client through your own
computer — the Ohbox, the Screener, reading and filing real mail — while that
computer is awake. It works over [Tailscale](https://tailscale.com), a private
tunnel between your own devices: the mail engine listens on this computer only,
never on a network interface, and Tailscale carries the connection under a real
HTTPS address. Nothing is opened to the internet, and the pane refuses the
public-funnel variant structurally. The pane detects what is missing — Tailscale
not installed, not running, signed out, unnamed — and says what to do in plain
words instead of an error code.

**Adding a device is a QR code.** Scan it with the device's camera and it opens
your mail and pairs in one step. Every code works once and expires in five
minutes; unused codes and paired devices are listed and revocable at any moment,
and a removed device is cut off with its next request. Relaunching or updating
the desktop app does not unpair anything — paired sessions survive on purpose,
and a test holds that promise.

**While hosting, the app stays out of the way.** Closing the window hides the
app (the tray brings it back; on macOS the Dock icon does too), quitting from the
tray really quits, and the enable step offers start-at-login as a visible,
pre-checked choice rather than a hidden default. With host mode off, none of this
machinery exists — no listener, no tray, the exact lifecycle earlier releases
had.

**A same-network door, for apps rather than browsers.** Devices on your own
network can opt into a plain-HTTP address for API clients. It binds one address
you choose — never all interfaces — and the pane says plainly why a phone
browser still needs the Tailscale address: browsers require HTTPS for a network
address.

### Your settings live in the mailbox

**The senders you've screened in, your rules, notification rules, away reply and
tag names are stored in the mailbox itself** — a few kilobytes of versioned JSON
in the hidden `ohmail/_meta` folder, beside the marker that already coordinates
which ohmail organizes the mailbox. Connect the same mailbox from another ohmail
— a fresh desktop install, the hosted service, a server you run — and it finds
them and asks before importing. Your local decisions are never overwritten
silently: the found settings win only for the entries they actually name, and
you can decline durably.

The format is public and documented in
[docs/organizer-profile.md](docs/organizer-profile.md): natural keys only
(sender addresses, folder names, tag names — never database ids), unknown fields
tolerated so builds of different ages can read each other's documents, and never
any credential or key. Deleting the message only resets ohmail's settings, never
your mail. If you stop using ohmail, the document is still yours, in your own
mailbox, readable by anything that parses JSON.

### The Screener

**"Not spam" now releases the sender, not just the message.** When mail sat in
spam because a rule you once made held the sender there, the release buttons
moved the messages but left the rule standing — so the same sender's mail kept
re-presenting as spam, and mail physically in the inbox appeared to do nothing
at all. Releasing a sender now retargets or deletes the rule that holds them,
moves only the mail that is physically present, and re-files the sender's
backlog. The confirmation names the rule it rewrote, so what happened is what
the screen says happened.

### Fixes

- **A failed permission-tightening on the configuration file is an error, not a
  silent success.** The config and host-mode files are set to owner-only after
  every write — they name your mail server and username — but a failed chmod
  used to be discarded. It now surfaces the way the key file's always has.
- **The public tree compiles on Windows and Linux again.** A macOS-only window
  event reached a match arm without a platform guard, which broke `cargo test`
  for anyone building this repository on the other two platforms. The served
  host client's entry document also joins the repository — it was missing, so
  the engine-bearing app could not be built from a clone.

### The licence

This repository is **AGPL-3.0** now (0.9.x shipped under GPL-3.0), and it grew:
the server source behind ohmail.app — the sync API, the background organizer,
the web client and the self-host deployment — lives here beside the desktop app.
Anyone can run it; anyone who redistributes a changed version or hosts it as a
service for others must publish their changes under the same terms.
Contributions need no CLA — a DCO sign-off (`git commit -s`) is enough.

## [0.9.8] — 2026-08-15

**0.9.7 quits a few seconds after you open it, on every platform, every launch. This
release fixes that — and if you are on 0.9.7 you have to install it by hand.** The crash
happens before the app reaches its own update check, so a copy of 0.9.7 can never fetch
this release for itself; there is no version of waiting that works. Download the installer
for your platform from [the release page](https://github.com/trafficflowhq/ohmail/releases/tag/v0.9.8)
and install it over what you have. Your mail, your account and your settings are in your
data directory, not in the app, and are untouched by reinstalling.

**On 0.9.6 or earlier, nothing is required of you.** Those builds reach their update check
normally and will offer this release the way they always have. Only 0.9.7 is stranded, and
only because it cannot stay running long enough to ask.

### The launch crash

**The app no longer quits at launch over the window's link and attachment permissions.**
0.9.7 granted the window two commands — "open this link in your browser" and "open this
attachment" — without declaring either of them in the build's own manifest of what the app
is allowed to do. The framework resolves a window's permissions against that manifest while
the window is being created, and a permission it cannot find there is a failure it does not
return from: these builds abort the process instead. So the failure was total and immediate
rather than partial and quiet, the same on macOS, Windows and Linux, and unaffected by
anything in your mailbox or your settings.

Both commands are now declared. The build keeps its whole command list in one place and
bakes that list into the binary, and the window's permissions are checked against it before
the framework is asked for anything: a permission the compiled manifest cannot resolve is
dropped and named in the engine log, rather than handed over to be aborted on. A failed
grant is also no longer treated as fatal — a window short one command still draws, still
has its menus, and still reaches the update feed. That last property is the one that
decides whether a release like this one can be delivered at all, which is why it is now a
behaviour with a test on it rather than a hope. Two tests hold the halves together: a
command that is granted but not declared is red before it is built, and a permission that
cannot be resolved is required to be dropped and logged rather than passed through.

### Mail on your own server

**A folder is no longer reported as fully downloaded when the server quietly held a message
back.** A mail server is allowed to answer a request for a batch of messages with fewer
messages than were asked for, with no error and nothing to mark which ones are missing. The
download pass did not check. It asked for a page of unknown messages, compared what came
back against its own size limits, found neither limit reached, and concluded the folder had
drained. Any message the server had declined to return produced nothing at all — no
message, no record that one was owed, and a folder marker moved past it as though it had
arrived. A folder in that state looks finished to everything downstream, including the mark
that says a mailbox's first import is done.

What triggers it is a header the sender chose. A message identifier may legally be written
as a quoted string, and at least one large provider cannot assemble its summary reply for
such a message, so it leaves the row out instead of failing the command. Checked against a
live account one command at a time: search lists the message, flags return it, size returns
it, date returns it, and the full body returns it. Only the summary does not.

Because the body is available, the message is recoverable rather than lost. Both download
paths now compare what came back against what they asked for and re-issue the shortfall
without the summary, reading the message identifier out of the raw headers instead — the
summary was only ever wanted for that one value. A message still unanswered after the second
attempt gets a durable record written before any folder marker moves, and the folder's
marker is held where it is if that record cannot be written. The retry pass re-reads owed
messages on a schedule and on every new build, so anything stuck behind a server limitation
is picked up when either side changes. The targeted retry path had the same defect with a
worse ending — it treated a message the body fetch skipped as deleted from the server, and
discarded the outstanding record for a message still sitting there.

Guards for both paths, each watched failing: a server that withholds exactly these rows, and
a database check that the record is committed before the marker crosses and that the marker
is held when it is not. The raw-header reader is pinned to the message's own header block,
so an identifier quoted inside a forwarded message is never mistaken for the message's own.

## [0.9.7] — 2026-08-14

Mostly about what a message carries. A meeting invitation is an event you can read rather
than a file with a made-up name; an attachment opens in whatever your computer uses for
that kind of file; a link goes to your browser. A message you asked to see again has a word
for finishing with it. The Screener's automatic suggestions arrive on a standalone install,
bounded, and they leave mail that looks like it holds a passcode alone.

### Reading a message

**Meeting invitations show as events you can read.** Calendar programs send the invite as a
calendar part with no filename, so the attachment strip listed it under a generated name —
downloadable, unreadable, and named in a way that hid the one thing it is. A nameless
calendar part is now called `invite.ics` wherever a name is minted: the tile, a single
download and a download-all archive all agree. And the invitation is readable in place —
when a message's attachments load, its calendar parts are decoded and the strip draws the
event instead of a tile: what it is, when, where, who. The message's own meaning is said
plainly — an invitation, a proposed new time (the replaced time struck through under the
new one, when the sender carried it), a cancellation, or an answer.

Times are shown on your own clock and in your language. An all-day date stays a calendar
day; a time in a zone this app cannot resolve is shown as written, with its zone label,
claiming nothing more. Recurrence is put into words only where one line can be true
("Weekly on Tuesday"); anything richer shows the first occurrence and stops. Every field of
an invitation is a stranger's text, so the card renders text only — names and addresses are
never links, and a summary carrying markup lands on screen as characters. A part that does
not parse, or is too large, or is not calendar data at all, keeps its plain attachment row:
the card is a promotion, never a claim. English and German.

**Attachments open in your computer's own viewer.** Pressing an attachment did nothing at
all — no file, no error, nothing anywhere. A PDF was worse: the reader got a panel saying to
download it instead, above a Download button that could not deliver a file either. Two dead
ends in one press, and neither of them said so. A page delivers a file by handing the
webview a download to perform, and the webview forwards that to whatever the host program
registered to perform one; this program registered nothing, so the press was answered
correctly by a component whose correct answer is "no download".

The app now takes the bytes it already fetched and the display name the message gave them,
writes that file into a directory of its own, and opens it with the same platform opener a
link goes to. On macOS that is the call the Finder makes, so a PDF lands in Preview with
Quick Look's own gestures on it, a picture in the picture viewer, a spreadsheet in the
spreadsheet program. Nothing is rendered inside the mail window, which is also the safest
answer for bytes a stranger sent. The name is sanitised before it is joined to anything, and
each attachment is written into its own randomly named holder, so two files called the same
thing do not collide and neither is renamed. The files are created private, and opened files
are swept a day later — on the way in rather than on a timer, so nothing is deleted out from
under a viewer you are reading.

A PDF is no longer offered the in-app viewer on the desktop, because this build cannot draw
one: the in-page PDF renderer needs a worker, this window's policy forbids workers, and the
library is left out of both desktop bundles. The tile's own press is the whole gesture here.
On the web app, and for every other file type, the viewer and the press are exactly what
they were.

**Links in your mail open in your browser.** Clicking a link did nothing at all — no page,
no error. Every outbound link the app renders asks for a new window, which in a browser tab
means a tab; in this window it is a request the webview forwards to the host program, and
this program answered none. Nothing was refused and nothing was blocked, which is why it was
silent everywhere.

An `http` or `https` click is now intercepted, cancelled so the window can never navigate
away from the app, and handed to the platform's own opener — your browser then makes the
request, as itself, with its own cookies. One handler covers both documents that exist: the
app's own, and the separate document a designed HTML mail renders in. The app's own links
still open in the window. `mailto:`, `tel:` and `cid:` are refused; `cid:` names a part of
the message you are reading and must never leave the machine.

On Windows the address is handed to the system opener directly rather than through the
command interpreter. That was safe while the only addresses it could receive were the
handful of pages Settings links to; an address out of a message is a different thing, and
the interpreter re-parses its own command line — a URL with a query in it would have been
split at the `&`.

The interface preview is unchanged: both handoffs are armed only in the build that carries a
mail engine, and the bundler removes them from the other one entirely.

### The Ohbox

**A message you asked to see again has a way out, and it is called Done.** A resurfaced
message stays pinned to the top of the Ohbox until you answer it or deliberately mark it
read — deliberately, so a glance never dismisses it. That rule is unchanged; what was
missing was a name for the way out, and "Mark as read" does not read as an answer to "show
me this again".

One word, everywhere the state is visible: the pinned row carries a small **Done** control,
shown when the row is hovered, focused or selected, and always where hover does not exist;
the open message's action bar says Done where the read control would stand, with a check
instead of the read dot, because what it completes is the resurface rather than the read
mark; and a message scheduled to come back carries the same Done on its row in the Resurface
pile, where it also cancels the scheduled return. Pressing it is the deliberate release that
has existed all along — the message is marked read, the pin comes down, and the row files at
the top of Earlier by when you finished with it. Nothing new is stored. German: "Erledigt",
and the pinned group's own heading is translated with it instead of standing in English
under a German interface.

### The Screener

**Automatic suggestions work on a standalone install too.** 0.9.4 announced this option
without saying that it only ever ran for a mailbox organised by the hosted service. An install that organises its own mailbox has no process running all the
time to notice mail arriving, so the setting had nowhere to run and was not offered there.
It is now, and the moment it runs is the end of a sync — the only point at which this
program can have senders it has not seen before and is also running. There is no separate
catch-up at launch, because no mail arrives while the app is closed.

It is the same pass the hosted service runs rather than a second copy of it, so which
message stands for a sender, and in what order, agrees with what the Screener shows you.
Three things bound it: it never reaches back past the moment you turned it on, so switching
it on does not work through a mailbox you have already synced; it asks about at most ten
senders per sync and the rest wait for the next one; and it stops on the first failure
rather than trying the rest, which with a key of your own is the difference between one
wasted call and one per sender, every sync, for as long as the model is down.

The setting is in Settings → Screener and is off until you turn it on. It says whether this
install has a model set up at all, because without one there is nothing for the pass to ask.
Nothing it does is irreversible — it writes no rules and files nothing, exactly like pressing
Suggest yourself, and only the sender, the subject and a short extract go to the model.

**Mail that looks like it holds a passcode is left out of the automatic pass.** Every message
is screened on arrival for things that look like credentials — a one-time code, a sign-in
link, a passcode — and the flag that puts on a message is what keeps it away from a model.
Pressing Suggest is a request you made about the senders you picked. The automatic version is
a timer, so it now excludes flagged mail when it chooses which senders to ask about, and the
exclusion is part of the query rather than a check inside the loop. It applies after each
sender's most recent waiting message has been picked, not before: picking first and then
excluding leaves a sender whose newest mail is a passcode alone, where excluding first would
have quietly promoted an older message and made the suggestion about mail that is not the one
on screen. Such a sender keeps their place in the Screener and every decision you can make
about them, and can still be asked about with the button.

**A sender is asked about once, not once per message they send.** The advice is about the
sender — the row is a sender, and the verdict applies to their whole waiting bag — but
everything deciding whether to ask for one was keyed on a message. The queue represents a
sender by their newest waiting message, so a second message replaced the first, carried no
answer of its own, and the automatic pass asked again. And again. A mailing list that sends
daily produces that by sending. The pass now asks the question its answers are about — does
this account already hold advice about this sender — and a sender who has been advised about
is not a candidate however much mail arrives afterwards. The Screener page moved with it: it
reports a sender's most recent answer whichever of their messages it came from, so one more
message from a sender no longer hides an answer that already exists. Pressing Suggest still
asks the model afresh, which is the point of pressing it.

### What reaches a model

**Short one-time codes are masked before a message reaches a model.** When you ask for a
suggestion about a sender, the subject and the first part of the message go to the model.
Before they do they are screened, and if they carry authentication material the value is
taken out and only the words around it are sent. That a message is about signing in is not a
secret; the code in it is.

The removal had a gap, and it was in the length rather than in the idea. Two things were
being taken out: a code written plainly as digits, and an encoded run of sixteen characters
or more. A short code does not occupy sixteen characters in any encoding mail actually uses
— six digits as base64 is eight — so the encoded form of the most common code shape fell
under the threshold. Percent escapes and HTML entities were not covered at any length, and a
code in mixed or lower case did not match the plain pattern, which recognised upper case
only. In each of those the message was reported as redacted and left with the code still in
it.

Lowering the threshold would not have fixed it: at six characters an encoded run is any
six-letter word. So short runs are decoded and looked at instead of measured, and replaced
only when what they decode to is a code rather than a word — `NDgyOTEz` decodes to `482913`
and goes, `Q29uZmlybQ` decodes to `Confirm` and stays. Percent escapes and both HTML entity
forms go through the same test. For codes written in the clear there are three narrow
additions: a token holding both letters and digits, a value directly after the word that
names it, and a value after a colon with that word nearby — using the same list of
credential words the screening step already uses, in every language it already covers.

All of it runs only on a message the screen has already flagged, and only where a code is
the kind of thing that would be there. A "new sign-in from Chrome on macOS in Zurich" notice
is left alone: the browser, the system and the city are the whole of what it says, and each
of them wears the shape of a code.

### Signed in to a hosted account

**Signing in as a different account starts from that account's own mail.** This mode keeps a
local mirror of one account's mail, and it belongs to exactly one account. The app already
discarded a mirror whose owner had changed — but it only asked the question while starting
up. Signing out leaves the mirror where it is, deliberately: nothing can be read out of it
without a session, and throwing it away would cost a full re-download the next time the same
person signs back in. That meant the next sign-in arrived while the previous account's
database was still open, and it was not checked against it, so signing in as somebody else
put the new session on top of the previous account's mail.

The app now resolves who a new session actually belongs to by asking the account, using the
credentials just given, rather than by reading the address out of the sign-in form — the
address on the form is typed by whoever is signing in, and the browser sign-in sends no
address at all. If the answer is not the account this mirror was built for, the sign-in is
refused before anything is stored or opened, and an answer that cannot be obtained refuses
too rather than assuming a match. Switching accounts on a computer you own is an ordinary
thing to do, so the app offers the way through: press Sign in again and it re-points the
door, which starts a new engine, which discards the previous account's mail before opening
anything. Signing back into the same account changes nothing at all — the mirror is
untouched, and there is no re-download.

### Mail stored by an earlier version

**Sender names are filled in on an install that organises its own mailbox.** A message
stored by an early version of this app shows the sender as a bare address where their name
should be, and no "To" line at all. The information was never lost — the column to keep the
name in arrived after those messages did — so a mailbox reads correctly at the top and
plainly wrong further down, which is the confusing version of a defect. The material is on
disk: every stored message keeps the header block it arrived with.

A mailbox organised by the hosted service had this repaired centrally and picked the values
up as ordinary sync updates. An install that organises its own mailbox has no such centre —
the database under your home directory is the only copy — so the app now does the repair
itself, at the end of a sync, two hundred messages a visit. A large mailbox is repaired over
many syncs and quite possibly several sessions; bringing back a display name is worth
nothing next to the mail arriving. It never replaces a value that is already there, and it
never invents a name from an address: a sender who wrote no name keeps none, because a name
made up from the address would afterwards be indistinguishable from one they chose. Repaired
rows redraw in the window while you are looking at it.

## [0.9.6] — 2026-08-13

One change, and it is for installs signed in to a hosted account: the app is told the
moment something happens, instead of only ever asking on a timer.

### Signed in to a hosted account

**Mail turns up when it arrives, not when the app next asks.** The engine that keeps this
app's copy of a hosted mailbox current asked the service for changes every twenty seconds,
so mail that had already landed — or a message you sent, or a decision you made, in the
browser — could sit unseen for that long. The engine now holds one open
connection to the service, the service sends a signal the moment anything on the account
changes, and the engine answers each signal by fetching once. New mail is in the window a
few seconds after the service records it instead of up to half a minute.

The signal carries nothing and decides nothing. It says only "there is something to
fetch": what gets fetched, how it is applied, and what happens when a fetch fails are all
exactly as they were, and the twenty-second check keeps running underneath as the floor. So
the app is never worse off when the connection is not there. If the service refuses it or
does not offer it, the run costs one refused request and is never retried — an app that
expected the channel cannot turn a service without it into a reconnect storm — and the door
behaves as it did before the channel existed. However many signals arrive while a fetch is
running, exactly one more is queued; a fetch that fails is left to the retry it already had
rather than being repeated per signal.

**A standalone install is not affected.** It talks to your own mail server on its own
schedule, with no hosted service in between, and nothing about that changed.

## [0.9.5] — 2026-08-13

Mostly about mail being where you left it — starting with the folders you made yourself,
which the app reads for the first time and will not reorganise. A message you send is in the
Ohbox the moment it goes; a message you put away is in exactly one place; a decision made in
the Screener holds while you move around the app, and says so when it does not land; and
clicking a search result opens the message you clicked. An install signed in to a hosted
account also stops hiding settings that account has.

### Your own folders

**Mail in the folders you made is part of your mailbox.** Until now the app read a fixed set:
your inbox, the five `ohmail/` folders and your Sent folder. Anything you had filed yourself
was invisible — an Archive, a folder per client, years of nesting made in another mail app.
None of it was in your history, none of it was in a conversation, and none of it came back
from a search. All of it is read now, stored, threaded into its conversations, and findable.

**And nothing moves it.** Your filing is yours: no rule runs on mail in your own folders, it
is never held for screening, never filed as a newsletter or a receipt, and no AI is spent on
it. That is three separate things in the code rather than a setting or a promise in a
comment, any one of which would be enough on its own — those folders are not in the set
anything may file into, the routing step returns before the rules are even loaded, and the
message is recorded as placed by *you*, which every part of the app that moves mail refuses
to touch. A test moves each of the three out of the way in turn and watches the mail get
moved, so the guarantee is measured rather than asserted.

Drafts, Junk and Trash stay out, and so do Gmail's All Mail and Starred. None of the first
three holds mail you filed — one is unfinished writing, one is your provider's opinion, one
is what you threw away — so reading them would be inventing a decision rather than following
one; the other two already contain every message in the account, so reading them would
duplicate the whole mailbox. An Archive is filing, and it is read.

A mailbox with a hundred folders costs almost nothing per check: where the server supports
it, one command asks after every folder at once and only the ones that actually changed are
opened. The first pass through a large archive is spread over several rounds behind your
incoming mail, so nothing you are waiting for is held up by years of history arriving.

**Two reasons a mailbox could say "still importing" for ever are fixed**, both found on
accounts that had been connected for days and were doing no work. Some servers ignore the
question "what changed since I last looked" and answer with the whole folder, so read-state
updates were re-read from scratch on every check — thousands of them, capped per round — and
the end was never reached; the app now compares what the server says against what it already
recorded and treats agreement as nothing to do. And a mailbox holding two copies of the same
message in one folder — an import run twice, a client that filed twice — could only remember
one of them, so the other looked new on every check, was downloaded again, and displaced the
first. Both copies are remembered now, and if the one a message points at is deleted the
record follows the copy that is still there.

### Sending

**A sent message is in the Ohbox the moment you send it, with its conversation.** Three
separate things stood between pressing Send and seeing the message, and none of them was
the mail server — it holds the message before the app goes looking for it.

The provisional local copy — built so a sent message can be read minutes before the Sent
folder is read back from the mail server — was queued behind a full reconciliation pass
that could never carry one, and on a mailbox still filling for the first time there is no
bound on how long such a pass takes. It is built the instant the send is confirmed now, and
the reconciliation runs behind it rather than in front of it.

"Earlier" is ordered by when you finished with each message, and nothing stamps a reading
time on mail you wrote — there was never a moment you opened it — so every message an
account had ever sent sat under everything it had ever read. A sent message is ranked by
when it was sent, because writing a message is finishing with it; a recorded reading time
still wins, so re-reading your own sent mail still moves it.

And the compose form did not leave when the message did. It emptied itself and stayed on
screen, so the only thing saying the mail had gone was a passing notice over a blank form.
A confirmed send returns to the Ohbox with nothing selected and the message as the first
row — on the confirmation rather than on the press, so the list it lands on already holds
the message, and a send that fails leaves you on the form where your text is.

Three corrections found on the way. Mail sent before the account finished screening its
backlog goes to History, on the same line as everything else from before it, rather than
presenting years of Sent mail as recent. A sent reply on a conversation that is in the
Ohbox follows that conversation rather than splitting away from it. And the list collapses
the two copies of a just-sent message — the local one and the one read back from the
server, which share a Message-ID — the way the reading pane already did.

**The message is recorded when it is sent, not when the Sent folder is next read.** A send
delivers over SMTP and then appends the finished message to your own Sent folder, and the
server answers with the identifier of the copy it just filed. Both of those facts were
discarded, so nothing knew the message existed until the next pass over that folder read it
back — a whole poll interval between pressing Send and the message existing anywhere the
reader can see it. The send path records it immediately now, from the exact bytes that were
filed.

This is not a second place your mail lives. The message was already written to the mailbox
on your server, which is the only master there is; this records what was written, the
folder is still watched exactly as before, and anything this misses is picked up on the
next pass regardless. Nothing here writes to your mailbox.

It uses the ordinary reading path rather than a shortcut: the message is handed to the same
code that reads any message out of your mailbox — same parse, same identity, same threading
— because that is the only way the record can be guaranteed to match what the folder pass
would have produced. If the two disagreed, reading the folder later would file the same
message a second time, and nothing removes a duplicate once it is on every device. That is
also why the record is built from the bytes that were filed rather than from the message
that was composed: the sent date is stamped when the mail is built and exists nowhere else,
and identity reads the date.

The mail has already gone by then, so a failure to record it is never allowed to fail the
send — it is logged, the send succeeds, and the folder pass writes the message shortly
afterwards. Both ways of sending are covered: through the hosted service, and an install
talking to your own mail server. A provider that files its own version of the message
beside ours resolves to the one message rather than two, including when the two copies are
not byte-identical.

### The Ohbox and the Screener

**A message is in exactly one pile.** Mail you put away — Answer Later, Set aside,
Resurface — was listed in its pile and still sitting in the Ohbox at the same time. Nothing
moves a parked message on the mail server, and the Ohbox grouped mail by folder, so it
never knew the message had been filed anywhere. The sharpest form of it: asking a
resurfaced message to come back again put it straight back at the top of the Ohbox as
unread, as though it had just arrived, while the Resurface pile listed it too.

Which pile a triage state belongs to is now one function that the pile lister and the Ohbox
both read, so the two cannot disagree, and the Ohbox holds every parked message out of all
three of its groups. Parked mail therefore leaves "Earlier" as well as "New for you", which
is the rule working rather than a side effect, and returns to the top of the Ohbox when its
time comes, as it always did. Reads and Receipts are skim streams rather than piles and
still list an issue you have queued.

**Screening decisions hold, and the ones that do not land are reported.** Screening one
sender in and another out, moving to another view and coming back could show both of them
waiting again as though nothing had been decided. The decision was sent and the server's
answer thrown away, so when the server declined it — which it does when the mail is no
longer waiting at the gate, reachable whenever this device is a moment behind another one —
the sender came back with nothing said about why, and the only message on screen was the
one raised optimistically at the press. The answer is read now: a refused decision says so,
names the sender, and marks the row that came back, so the record outlives the notice that
fades. A decision merely waiting to retry is not treated as a refusal, because the intent
still stands.

The three controls that take a sender back **out** of Spam or Screened out — "Allow", "Not
spam → Ohbox" and "Not spam → Screener" — did the same thing, and had less to fall back on:
they have no undo window and no second notice, so the toast raised at the press was the
only account of them a reader ever got. They report in the same words now. The note is
keyed on the sender's whole bag of mail rather than on the message that was pressed,
because a row in these piles stands for the newest message in it: release five, have one
refused, and the row that comes back is a different message.

### Finding

**Clicking a search result opens the message you clicked.** A result for an older message
in one of the reading streams took you to that stream and stopped somewhere with nothing in
it. Cards in a reading stream are cheap while they are off screen — the browser is told to
skip their layout and to stand a rough height in for each — so a jump computed the position
of a card that had never been laid out, from a stack of rough heights, and scrolled to that
fixed number while every card it passed replaced its guess with its real height. Measured
over a pile eight hundred cards deep, jumping to the four-hundredth: the stream came to rest
18,301 px short of the card that was asked for. On a mailbox whose cards run shorter than
the guess the same arithmetic overshoots, into the blank space held open for the part of the
pile that is not mounted yet — which is the "there is nothing here" this started as.

The landing measures instead of predicting. It reads where the card actually is, corrects,
and keeps doing that until the card is at the top of the reading area, or until the scroller
is as far as it goes with the card in view. It has to hold for a few frames rather than
merely happen once, because a card keeps moving after the scroller stops while the cards
above it are still being laid out. Arriving also opens the card now, the same way clicking
it does; the jump used to leave it collapsed, so the message you had just asked for was a
two-line preview among two hundred identical ones. A card already laid out near the fold
keeps the smooth single scroll it always had.

A result can also name a message that is in no pile at all: search asks the whole archive,
while a device keeps a window over it. Those were routed to the pile their folder named,
where no row for them exists, and the reader refused to open a message it had no local copy
of, so clicking did nothing whatever. Routing now asks whether the destination actually
holds the message and falls back to the reader when it does not, and the reader opens with
what search returned — the sender, the subject, the date and the preview. The full text
cannot be fetched for a message there is no local record of, and the reader says as much
rather than showing an empty sheet. Mail that is deliberately in no pile, filed under
Answer Later or held back by the history cut-off, opens the same way.

### Settings

**An install signed in to a hosted account gets that account's settings.** In that mode the
app showed a shorter settings surface than the same account showed in a browser, and nothing
on screen said why. The shared settings screen asks "is there a server to reach?" by looking
for the browser API client, which is not part of this build at all — the desktop talks to a
mail engine on this machine over a pipe — so the answer was no on both doors. That is right
for an install opening your own mail server: there is no account, nothing to store a
preference on, nothing to bill. It was wrong for an install mirroring a hosted account,
whose engine forwards these routes to that account.

Four controls come back on the hosted door, and the account's own row is what they read and
write: automatic suggestions for new senders, the dormancy window, whether screening a
sender out also unsubscribes, and the account's choice of interface language. Only the wire
is injected — the controls, the consent rules and the pricing are the shared ones,
unchanged. That matters most for automatic suggestions, the one setting that authorises
spending without a press: it is priced by the same endpoint against the same ledger, and the
switch renders what the account stored rather than what was clicked.

Three panes existed on the web and were absent here. **Subscription** shows the plan, the
renewal date, the remaining AI budget and the managed-AI switch, all read through the
engine. Everything else on **Security** and **Account** asks for a second factor asserted
within the last few minutes, which this app has no way to give — it holds no password, no
authenticator secret, and a passkey ceremony needs a real browser origin. So each of those
panes is present with a button that opens the page in your own browser, where you are
already signed in, rather than being missing: an absent entry reads as "this product does
not have that", which for deleting an account would be untrue. The button passes a key and
the app's own table decides what it means, so nothing that could get a string into the page
can open an arbitrary address in your browser.

Two settings stay deliberately absent on the desktop, both because their machinery calls the
browser API client directly. The sent-mail review is a browser ceremony end to end. Remote
images load through a proxy on the page's own origin, which is what keeps your address away
from the sender, and a window that may not open a connection has no such origin — so the
setting would govern nothing. An install opening your own mail server is unchanged in every
respect: it supplies no wire and no pane, so none of the above reaches it.

Settings → Account also had roughly a menu's height of blank space above "Delete your
account". The sheet is a two-column grid and every direct child was a grid item, so the
second of that pane's two cards started a second row as tall as the menu beside it. A pane
stacks its own cards now.

## [0.9.4] — 2026-08-13

Mostly about sending and finding. An install signed in to a hosted account can pick the
address its mail leaves from and actually send from it; files and recipient chips can be
dragged where the interface implies they can; search answers in the order you ask for; and
mail you asked to see again stays in front of you until you deal with it.

### Sending

**Sending works again when the app is signed in to a hosted account.** That mode keeps a
local database the window reads everything out of, and it was inventing a single
placeholder mailbox to file all of it under. Three things followed from that: every send
was refused, because a send names the mailbox it leaves from and an invented one is not one
of the account's; the From selector offered that placeholder instead of the addresses mail
can actually leave from, so an account with two addresses could not choose between them;
and every reply announced that its sender had been substituted, whether or not anything had
been. The app now mirrors the account's own mailboxes before it drains a single change, so
each message is filed under the mailbox it really belongs to. An install that already holds
a local database repairs itself once, in the background, on the next sync — nothing is
re-downloaded and no message bodies are touched. Mail for a mailbox the account does not
list is skipped rather than filed under the wrong address.

**Drag a file onto an open compose to attach it, and drag a recipient between To and Cc.**
Neither gesture did anything in the desktop app. Both are ordinary drag and drop, and
neither ever reached the page: the window had the framework's own native drag handler on
it, which answers the whole drag session itself and never lets the page see it. The window
now switches that handler off, which is what a webview implementing its own drag and drop
needs. Dragging a message row onto a pile or a tag in the rail was never affected — that
gesture is built on pointer events for exactly this reason.

**Large attachments can travel separately from the send on the hosted service.**
Attachment bytes have always ridden inside the send request, which puts the hosted API's
request-body ceiling in front of the feature: somebody whose own provider accepts
twenty-five megabytes was told three. A client can now be told it may stage those files
first and send references instead, and the server pulls them back and hands them to the
transport exactly as before. **This app does not use it, on either door**, and a guard reads
the app's own source and fails if it ever appears there — in local mode compose, the send
handler and the connection to your mail server are one process with no request body in
between, and in Cloud mode the send is forwarded unchanged. The standalone desktop's cap
already follows what your own submission server announces, which 0.9.3 shipped.

### Finding

**Search results can be ordered — newest first, oldest first, by mailbox, by sender, or by
best match**, which stays the default. The choice is remembered per account on that device.

The ordering is not a sort over the page you were already going to be shown, and that
distinction is invisible on a small mailbox: relevance ranking keeps only its best few
hundred candidates before it trims to a page, so sorting *that* by date answers "of the most
relevant few, which is newest" and quietly drops a message that matched weakly and arrived
this morning. A chosen order therefore runs its own query across every message that matches,
with the sort key deciding which rows come back. It reuses the same filters the count above
the list is computed from, so the count and the list keep describing the same mail. The
local index on the device and the full archive are merged in the chosen order too, rather
than leaving the device's own hits in relevance order at the top of a list claiming to be
sorted by date.

### The Ohbox and the Screener

**Mail you asked to see again stays until you answer it or mark it read.** A resurfaced
message is pinned to the top of the Ohbox, and that pin was being spent by a glance —
looking at the message, or just leaving the list it was in, filed it away again. Two of the
ways the app marks mail read are not things anyone asks for: the reliability sweep the
newsletter and receipt streams run as you scroll, and the Ohbox's own rest-for-two-seconds
timer. Both now say what they are, and pinned mail is held back from them. Everything that
is an actual answer still releases the pin — the read button, the shortcut, marking a
selection or everything read, filing it, and replying to it. A pinned message you have
looked at but not answered stays bold, deliberately: that is the whole point of having
asked to see it again.

**With automatic suggestions on, the Screener can suggest for senders as their mail
arrives**, so opening the Screener finds the advice already there instead of fetching it
while you wait. The option is still off by default, still decides nothing, and still leaves
nothing behind but advice — no rule, no contact, no folder change, no mail moved. It is
bounded three ways: only senders whose held mail arrived after you switched the option on,
at most ten at a time, and the allowance is checked before every request, so an empty
balance sends nothing anywhere.

**The sentence that asks what belongs in your Ohbox prefills in the app's language.** It
was English text in a German session, in the one control that asks you to write in your own
words. Save stays inert for either language's default, so a German reader opening Settings
is not one press away from storing a sentence they never typed; editing it still stores
your own words exactly as before.

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

[Unreleased]: https://github.com/trafficflowhq/ohmail/compare/v0.30.17...HEAD
[0.30.17]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.17
[0.30.16]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.16
[0.30.15]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.15
[0.30.14]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.14
[0.30.13]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.13
[0.30.12]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.12
[0.30.11]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.11
[0.30.10]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.10
[0.30.9]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.9
[0.30.8]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.8
[0.30.7]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.7
[0.30.6]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.6
[0.30.5]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.5
[0.30.4]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.4
[0.30.3]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.3
[0.30.2]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.2
[0.30.1]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.1
[0.30.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.30.0
[0.29.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.29.0
[0.28.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.28.0
[0.27.5]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.27.5
[0.27.4]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.27.4
[0.27.3]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.27.3
[0.27.2]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.27.2
[0.27.1]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.27.1
[0.27.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.27.0
[0.26.1]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.26.1
[0.26.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.26.0
[0.25.24]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.24
[0.25.23]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.23
[0.25.22]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.22
[0.25.21]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.21
[0.25.20]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.20
[0.25.19]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.19
[0.25.18]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.18
[0.25.17]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.17
[0.25.16]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.16
[0.25.15]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.15
[0.25.14]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.14
[0.25.13]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.13
[0.25.12]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.12
[0.25.11]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.11
[0.25.10]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.10
[0.25.9]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.9
[0.25.8]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.8
[0.25.7]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.7
[0.25.6]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.6
[0.25.5]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.5
[0.25.4]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.4
[0.25.3]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.3
[0.25.2]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.2
[0.25.1]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.1
[0.25.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.25.0
[0.24.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.24.0
[0.23.2]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.23.2
[0.23.1]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.23.1
[0.23.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.23.0
[0.22.1]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.22.1
[0.22.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.22.0
[0.21.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.21.0
[0.20.1]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.20.1
[0.20.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.20.0
[0.19.6]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.19.6
[0.19.5]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.19.5
[0.19.3]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.19.3
[0.19.2]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.19.2
[0.19.1]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.19.1
[0.19.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.19.0
[0.18.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.18.0
[0.17.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.17.0
[0.16.2]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.16.2
[0.16.1]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.16.1
[0.16.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.16.0
[0.15.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.15.0
[0.14.2]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.14.2
[0.14.1]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.14.1
[0.14.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.14.0
[0.13.8]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.13.8
[0.13.7]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.13.7
[0.13.6]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.13.6
[0.13.5]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.13.5
[0.13.4]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.13.4
[0.13.3]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.13.3
[0.13.2]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.13.2
[0.13.1]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.13.1
[0.13.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.13.0
[0.12.2]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.12.2
[0.12.1]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.12.1
[0.12.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.12.0
[0.11.1]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.11.1
[0.11.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.11.0
[0.10.0]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.10.0
[0.9.8]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.9.8
[0.9.7]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.9.7
[0.9.6]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.9.6
[0.9.5]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.9.5
[0.9.4]: https://github.com/trafficflowhq/ohmail/releases/tag/v0.9.4
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
