# How ohmail organizes inside your mailbox

The short version is in the [README](../README.md#how-ohmail-organizes-inside-your-mailbox).
This is the mechanism. Everything below is ordinary IMAP, inspectable from any
other mail client, which is the point: the mailbox is the source of truth, and
everything ohmail adds to it is plain IMAP a stranger's client can read.

## The folders

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

There is no folder called "Spam". Your own spam verdicts ride to the provider's
native Junk folder; what ohmail's automatic patterns set aside on their own
lands in `ohmail/Quarantine`, held for review. "Spam" is only ever a friendly
label the app shows.

## Real moves, crash-safe

Filing a message is a real IMAP move into one of those folders. ohmail first
records where the message should be, then the one active organizer performs the
move on the server and confirms what it observed. A crash mid-move leaves a
pending intention, never a half-moved mailbox, and nothing else races it.

## One organizer per mailbox, agreed inside the mailbox

Beside the settings message, `ohmail/_meta` holds the organizer **lease**: which
single install or server currently organizes this mailbox, renewed as it works.
A desktop install and a server, which can never query each other, still cannot
fight over one mailbox.

## Your settings live in the mailbox

`_meta` also holds your ohmail settings for this mailbox as a small
versioned-JSON message: the senders you screened, your rules, your notification
rules, the away responder, the mailbox's signature, your tag names and the
screening window. These are the settings you made, never credentials and never
keys. They live in your mailbox rather than in any ohmail database and move with
it. The format is specified in [organizer-profile.md](organizer-profile.md) and
implemented in `packages/core/src/adapters/organizer-profile.ts`; deleting the
message only resets ohmail's settings, never your mail.

Connect the same mailbox from another desktop install, from a server you run or
from ohmail.app, and ohmail finds the settings and asks first: *"We found your
ohmail settings on this mailbox."* There is no export step and no transfer flow.
If you stop using ohmail, those decisions are still yours, in your own mailbox,
in a published format anything can parse.

## Your own folders, if you want them

Off by default, and per mailbox: switch "Use folders" on and the folders you
already keep appear in the menu, each as its own list: the real folders on your
server, never a copy. Create, rename and delete them from ohmail and the same
IMAP operations happen in your mailbox; deleting a folder files its mail to your
provider's Trash first, never an expunge. (Not yet in the standalone desktop
app.)

## Spam and deletion use your provider's own folders

A spam verdict files the message into the mailbox's native Junk folder, where
its filter and your other clients expect spam, and "Not junk" moves it back out;
the sender rule, stored with your settings, is the durable memory either way. A
message you move back out of Junk has its text again with the move. Delete moves
to native Trash, never expunges. Beyond those acts you command, and the Spam
filing "Act on confident suggestions for me" does once you switch it on (the
same move your press would make), ohmail never acts in Junk or Trash on its own:
no rule, no other automatic pass and no AI proposal may name them.

Your provider's Junk, Trash and Drafts folders are also the ones ohmail does not
read: the local mirror, History and search leave them out.

## What travels, and what stays

ohmail's desktop app, a server you run and ohmail.app never share a database.
The only medium they all read is the mailbox itself, so that is where everything
durable lives:

- **Your mail and its organization** are real IMAP folders on your own server:
  the `ohmail/*` tree plus any folders of your own, moved by ordinary IMAP
  commands, readable by any client, kept when you leave.
- **Your settings, rules and screening structure** are one small versioned-JSON
  message in the hidden `ohmail/_meta` folder, the portable organizer profile.
- **Which ohmail organizes the mailbox** is decided in the mailbox too: a lease
  message in the same `_meta` folder names the one active organizer, so a desktop
  install, a self-hosted server and ohmail.app can hand a mailbox to one another
  without ever talking to one another.

So switching how you run ohmail is reconnecting a mailbox. What an install keeps
to itself is the working copy (the local mirror, cached bodies, device
pairings), reconstructible from the mailbox or irrelevant to it, plus the honest
edge: decisions with no IMAP representation yet. Triage piles, Resurface timers,
learned patterns, which tag is on which message, notes, snippets and the app's
own preference switches all stay with the install they were made on.

## Removing a mailbox

Removing a mailbox from your ohmail account can also erase ohmail's copy of its
mail: you type its address and confirm with a second factor. The mail on your own mail server is never touched.
