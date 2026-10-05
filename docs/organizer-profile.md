# The portable organizer profile

How a mailbox carries its own ohmail configuration, and the exact format it is
written in. This page is the specification; the implementation and the same
text as a module comment live in
[`packages/core/src/adapters/organizer-profile.ts`](../packages/core/src/adapters/organizer-profile.ts).

ohmail keeps two kinds of record in the unsubscribed `ohmail/_meta` folder of
the mailbox it organizes. The organizer lease answers *who* organizes this
mailbox; the profile document answers *how this mailbox wants to be
organized*. Both live in the mailbox because the mailbox is the only medium
every deployment shares: a desktop install, the hosted service and a
self-hosted server can never query each other's databases, but they all read
the same folder. Connect the same mailbox from any of them and the
configuration is waiting — no export step, no transfer flow, no account
linkage.

The format is deliberately public. The point of storing configuration in your
own mailbox is that it stays **yours**: move between ohmail deployments and it
travels; stop using ohmail entirely and it is still there, in the mailbox, as
JSON anything can parse.

## The message

One RFC822 message in `ohmail/_meta`:

- Header `X-Ohmail-Profile: 1` — the discriminator. A message without it is
  not a profile and is invisible to the profile reader (the organizer lease's
  claim messages live in the same folder and carry `X-Ohmail-Lease: 1`
  instead; each reader ignores the other's records).
- Header `X-Ohmail-Install-Id` — which organizer wrote this copy. Transport
  bookkeeping, not configuration: it lets an organizer recognise its own
  previous write. It is a header rather than a JSON field so the document
  itself stays free of anything install-specific.
- Header `X-Ohmail-Profile-Version` — the document's `v`, repeated where a
  header read can see it, so a later format is recognised without reading the
  body. A writer of any version above 2 MUST write it; its absence means 1 or 2.
- Header `Date` — the document's `updatedAt`, cut to the second.
- Header `Subject: ohmail settings for this mailbox`, exactly.
- A plain-text body: a short human preamble (for whoever finds the message in
  an ordinary mail client), then the JSON document. A reader takes the
  substring from the body's first `{` to its last `}` — the preamble is
  guaranteed not to contain `{`. Every string value except the format fields
  (`updatedAt`, `producer`, rule and notification kinds, a rule's provenance
  and decision date, the away reply's audience, rate, dates and piles) is written as JSON
  `\uXXXX` escapes; any JSON parser reads the same values. The body is 7-bit ASCII
  (`Content-Transfer-Encoding: 7bit`).

## The JSON document, version 2

```jsonc
{
  "v": 2,                          // format version. REQUIRED. See versioning below.
  "updatedAt": "<ISO 8601>",       // when this copy was written, by the writer's clock
  "producer": {                    // which kind of organizer wrote it — provenance, not identity
    "kind": "local" | "cloud" | …, // an open set; readers must tolerate unknown kinds
    "version": "<build label>"
  },
  "screener": [                    // senders this mailbox has SCREENED IN (admitted)
    { "address": "<sender email, lowercased>", "name": "<display name, optional>" }
  ],
  "rules": [                       // where mail from matched senders is filed
    {
      "kind": "sender" | "domain" | "header",
      "match": "<address | domain | header spec>",
      "destination": "<canonical folder NAME, e.g. ohmail/Reads>",
      "priority": 0,
      "enabled": true,
      "provenance": "manual" | "migrated" | "promoted" | "seeded-from-sent",
      "subjectContains": "<optional narrowing term>",
      "bodyContains": "<optional narrowing term>",
      "personDecidedAt": "<optional ISO 8601 instant>"
    }
  ],
  "notifyRules": [                 // senders/threads opted back INTO notifications
    { "kind": "sender" | …, "target": "<spec>" }
  ],
  "awayResponder": {               // the single per-mailbox autoresponder, or null
    "enabled": false,
    "body": "<string or null>",
    "startsAt": "<ISO 8601 or null>",
    "endsAt": "<ISO 8601 or null>",
    "audience": "screened_in" | "everyone",
    "throttle": "always" | "per_message" | "per_day" | "per_week",
    "piles": ["INBOX" | "ohmail/Reads" | "ohmail/Receipts" | "ohmail/Screener", …]
  },
  "tagNames": ["<tag name>", …],   // the names of this mailbox's tags
  "signature": "<string or null>",     // the sign-off on mail sent from this address
  "signatureHtml": "<string>"          // optional — that sign-off's formatting, when it has any
}
```

## Field by field

The envelope:

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | integer ≥ 1 | Format version. Required. This page documents version 2; ohmail reads version 1 as well, and always will. The number names the field set **and** the canonical ordering the document is written in — see versioning. |
| `updatedAt` | ISO 8601 string | When this copy was written, by the writer's clock. Readers coalesce duplicate messages by it — newest wins. |
| `producer` | object | Provenance, never identity: `kind` is an open set (`"local"`, `"cloud"`, a future value — readers must tolerate unknown kinds), `version` is the writer's build label. |

**`screener`** — an array of senders this mailbox has screened **in**:

| Field | Type | Meaning |
| --- | --- | --- |
| `address` | string | The sender's email address, lowercased. The natural key. |
| `name` | string, optional | The display name, when one was kept. Omitted rather than null. |

**`rules`** — an array of filing rules, where mail from matched senders goes:

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `"sender"` \| `"domain"` \| `"header"` | What `match` is matched against. |
| `match` | string | The address, the domain, or the header spec. |
| `destination` | string | The canonical folder **name** (`ohmail/Reads`, `ohmail/Screened`, …) — never an internal id. |
| `priority` | number | Higher wins between overlapping rules; `0` is the default. Read as a whole number from 0 to 1000; a value outside that range is read as the nearest end. |
| `enabled` | boolean | A disabled rule is kept, not deleted — re-enabling restores it exactly. |
| `provenance` | string | How the rule came to be. Today's writers emit `"manual"` (written by hand), `"migrated"` (imported from another tool), `"promoted"` (a screening decision — a screen-out and a spam verdict both leave one), or `"seeded-from-sent"` (the onboarding pass over your own Sent mail). The field is open: a reader must carry an unknown value through unchanged, never reject the profile over it. |
| `subjectContains` | string, optional | Narrows the rule to subjects containing this term. |
| `bodyContains` | string, optional | Narrows the rule to bodies containing this term. |
| `personDecidedAt` | string, optional | When you decided this rule yourself (pressed it in the Screener, allowed a sender from Junk, or paused a rule ohmail learned), as an ISO 8601 instant. Absent on a rule nobody decided. A reader keeps a date it already holds; ohmail never lets what it learns change a rule you decided. |

**`notifyRules`** — an array of senders or threads opted back **into** notifications:

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | string | The target's kind; `"sender"` today, an open set. |
| `target` | string | The spec the kind interprets. |

**`awayResponder`** — the single per-mailbox autoresponder, or `null`:

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | boolean | Whether it answers at all — a drafted-but-off responder travels too. |
| `body` | string or null | The reply's text. |
| `startsAt` | ISO 8601 or null | When it starts answering. |
| `endsAt` | ISO 8601 or null | When it stops. |
| `audience` | `"screened_in"` \| `"everyone"` | Who gets an answer. |
| `throttle` | `"always"` \| `"per_message"` \| `"per_day"` \| `"per_week"` | How often one person may be answered. `"per_message"` means once until the text changes. Absent in a document written by an older ohmail, which reads as `"per_day"`. |
| `piles` | array of `"INBOX"` \| `"ohmail/Reads"` \| `"ohmail/Receipts"` \| `"ohmail/Screener"` | Which piles the responder answers. A SET: duplicates are collapsed and order carries no meaning. An empty array means it answers nobody. **Absent means unstated, not the default** — a document written by an older ohmail says nothing about scope, and a reader applying one leaves its own stored value alone rather than narrowing it. Members a reader does not recognise are dropped. |

The responder is reply-only: it answers in the correspondent's own thread under `Re: ` plus their
subject, so there is no subject to carry. A document written by an older ohmail may contain a
`subject` field; readers ignore it.

**`tagNames`** — an array of this mailbox's tag names, as plain strings.

**`signature`** — the text appended to mail sent from this address, or `null` for none. It is the
one field in this document that belongs to the MAILBOX rather than to the account: somebody with
two addresses has two signatures, so a document is written per mailbox and carries that mailbox's
own. Absent in a document written by an older ohmail, which reads as `null` — the same as an
explicit `null`, because there is no third state a signature can be in. The envelope's `v` does
not move for this: an older reader ignores the field and applies the rest correctly, and a newer
one supplies the default, so a document remains readable in both directions.

Whether an outgoing message actually carries it is the compose window's decision — the signature
is visible and removable there. This document records what the sign-off IS, not that it is used.

**`signatureHtml`** — the same sign-off's formatting, when it has any. Optional, and ABSENT rather
than `null` when there is none: a document that never carried this key must keep the fingerprint it
was written with, so writers omit it and readers treat absent, `null` and blank markup as the one
answer, "this signature is plain text". It never appears without `signature` beside it — the plain
text is what a recipient reading in plain text gets, and markup alone would describe a message that
cannot be sent. The envelope's `v` does not move for this, on `signature`'s own argument.

## A complete example

One profile message exactly as ohmail writes it — regenerated from the writer
by the test suite, so it cannot drift from the code. Every address in it is
invented. Line endings on the wire are CRLF, as in any RFC822 message.

```text
X-Ohmail-Profile: 1
X-Ohmail-Install-Id: 0f4c7d1e-2b6a-4a51-9c3e-7d8f1a2b3c4d
X-Ohmail-Profile-Version: 2
Subject: ohmail settings for this mailbox
Date: Thu, 27 Aug 2026 09:30:00 GMT
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: 7bit

This message stores your ohmail settings for this mailbox: which senders
you have screened in, your filing rules, notification choices, away reply
and tag names. Keeping them here means they live in YOUR mailbox: they
travel with it to any computer or service you connect it from, and they
remain yours even if you stop using ohmail.

Names and addresses below are written as JSON escapes; any JSON tool
shows them as text.

Deleting this message is safe. It only resets ohmail's settings for this
mailbox; your mail is not touched. ohmail writes a fresh copy when its
settings next change.

The format: versioned JSON, documented in ohmail's published source
(packages/core/src/adapters/organizer-profile.ts).

{
  "v": 2,
  "updatedAt": "2026-08-27T09:30:00.000Z",
  "producer": {
    "kind": "local",
    "version": "0.11.1"
  },
  "screener": [
    {
      "address": "\u0069\u006e\u0065\u0073\u002e\u0061\u0065\u0062\u0065\u0072\u0073\u006f\u006c\u0064\u0040\u0065\u0078\u0061\u006d\u0070\u006c\u0065\u002e\u0063\u0068",
      "name": "\u0049\u006e\u0065\u0073\u0020\u0041\u0065\u0062\u0065\u0072\u0073\u006f\u006c\u0064"
    },
    {
      "address": "\u006f\u0072\u0064\u0065\u0072\u0073\u0040\u006e\u0069\u006e\u0065\u0066\u006f\u006c\u0064\u002d\u0070\u0072\u0065\u0073\u0073\u002e\u0065\u0078\u0061\u006d\u0070\u006c\u0065"
    }
  ],
  "rules": [
    {
      "kind": "domain",
      "match": "\u0062\u0069\u006c\u006c\u0069\u006e\u0067\u002e\u0065\u0078\u0061\u006d\u0070\u006c\u0065",
      "destination": "\u006f\u0068\u006d\u0061\u0069\u006c\u002f\u0052\u0065\u0063\u0065\u0069\u0070\u0074\u0073",
      "priority": 0,
      "enabled": true,
      "provenance": "manual",
      "subjectContains": "\u0069\u006e\u0076\u006f\u0069\u0063\u0065"
    },
    {
      "kind": "sender",
      "match": "\u0064\u0065\u0061\u006c\u0073\u0040\u006c\u006f\u0075\u0064\u006d\u0061\u0069\u006c\u002e\u0065\u0078\u0061\u006d\u0070\u006c\u0065",
      "destination": "\u006f\u0068\u006d\u0061\u0069\u006c\u002f\u0051\u0075\u0061\u0072\u0061\u006e\u0074\u0069\u006e\u0065",
      "priority": 0,
      "enabled": true,
      "provenance": "promoted"
    },
    {
      "kind": "sender",
      "match": "\u006e\u0065\u0077\u0073\u006c\u0065\u0074\u0074\u0065\u0072\u0040\u006e\u0069\u006e\u0065\u0066\u006f\u006c\u0064\u002d\u0070\u0072\u0065\u0073\u0073\u002e\u0065\u0078\u0061\u006d\u0070\u006c\u0065",
      "destination": "\u006f\u0068\u006d\u0061\u0069\u006c\u002f\u0052\u0065\u0061\u0064\u0073",
      "priority": 0,
      "enabled": true,
      "provenance": "promoted"
    },
    {
      "kind": "sender",
      "match": "\u006e\u006f\u0072\u0065\u0070\u006c\u0079\u0040\u0072\u006f\u0075\u006e\u0064\u0061\u0062\u006f\u0075\u0074\u002e\u0065\u0078\u0061\u006d\u0070\u006c\u0065",
      "destination": "\u006f\u0068\u006d\u0061\u0069\u006c\u002f\u0053\u0063\u0072\u0065\u0065\u006e\u0065\u0064",
      "priority": 0,
      "enabled": false,
      "provenance": "manual"
    }
  ],
  "notifyRules": [
    {
      "kind": "sender",
      "target": "\u0069\u006e\u0065\u0073\u002e\u0061\u0065\u0062\u0065\u0072\u0073\u006f\u006c\u0064\u0040\u0065\u0078\u0061\u006d\u0070\u006c\u0065\u002e\u0063\u0068"
    }
  ],
  "awayResponder": {
    "enabled": false,
    "body": "\u0054\u0068\u0061\u006e\u006b\u0073\u0020\u0066\u006f\u0072\u0020\u0077\u0072\u0069\u0074\u0069\u006e\u0067\u0020\u2014\u0020\u0049\u0020\u0072\u0065\u0061\u0064\u0020\u006d\u0061\u0069\u006c\u0020\u0061\u0067\u0061\u0069\u006e\u0020\u006f\u006e\u0020\u0032\u0020\u0053\u0065\u0070\u0074\u0065\u006d\u0062\u0065\u0072\u002e",
    "startsAt": "2026-08-24T00:00:00.000Z",
    "endsAt": "2026-09-02T00:00:00.000Z",
    "audience": "screened_in",
    "throttle": "per_day",
    "piles": [
      "INBOX",
      "ohmail/Reads"
    ]
  },
  "tagNames": [
    "\u006b\u0069\u006c\u006e",
    "\u0070\u006f\u0074\u0074\u0065\u0072\u0079\u002d\u0066\u0061\u0069\u0072"
  ],
  "signature": "\u002d\u002d\u0020\u000a\u004a\u0075\u006e\u006f\u0020\u004d\u0061\u0072\u0063\u0068\u0065\u0074\u0074\u0069\u000a\u006b\u0069\u006c\u006e\u0020\u002b\u0020\u0077\u0068\u0065\u0065\u006c\u002c\u0020\u0042\u0061\u0073\u0065\u006c"
}
```

Things to notice: every list is sorted by its natural key (the payload is
canonicalized before writing, so identical configuration produces an
identical payload — compare the JSON below the three metadata fields, or a
hash of it; the envelope's `updatedAt` and `producer` and the message's own
`Date` header are write metadata with no stability guarantee in either
direction, so whole documents are not byte-comparable); the second rule is a spam verdict (a promoted rule to
`ohmail/Quarantine`), the last a screen-out (`ohmail/Screened`) that was later
disabled and kept; and the JSON sits after the human preamble, so the substring
from the body's first `{` to its last `}` is the document.

## Natural keys only — a rule, not a style

Every entry is keyed by what it *means* — a sender address, a folder name, a
tag name — never by an internal row id. A row id names a row in one
deployment's database; this document has to be readable by a deployment that
has never seen that database, and by software that is not ohmail at all.
Screened-**out** senders are not a separate section: a screen-out is recorded
as a rule whose destination is `ohmail/Screened`, because that is what the
decision durably is.

## Versioning: tolerant forward, honest about newer

- A reader **ignores unknown fields** at every level. A v1 reader handed a v1
  document that a later build decorated with extra fields reads the fields it
  knows and drops the rest — that is what lets an older desktop and a newer
  server read each other's documents.
- **`v` also names the canonical order.** ohmail identifies a document by a
  hash of its canonical form, and compares that hash across installs, so the
  ordering rule is part of the format rather than a detail of one writer.
  Version 1 sorts each array by its natural keys; entries agreeing on those
  keep the order they were written in. Version 2 sorts by the natural keys and
  then by the entry's own serialization, which orders every pair of entries
  that differ at all, and serializes object keys in code-unit order. Two
  installs holding the same configuration therefore write byte-identical v2
  documents whatever order their storage returned it in.
- **Version 1 is read for ever, exactly as it was written.** A v1 document is
  never re-ordered on being read — its identity is the one its writer gave it,
  so an install still recognises a document it wrote last year. It is rewritten
  as v2 the next time its settings change, and not before.
- **An older ohmail asks you to update.** A build that implements v1 only will
  read a v2 document as newer than it understands: it leaves the document
  alone, keeps its own settings, and says so. Updating that install clears it.
- A reader **refuses only** a document whose `v` is greater than the version
  it implements, and the refusal is a typed "newer" result, never an error:
  the caller says "written by a newer ohmail" and leaves the document alone.
  The writer enforces the leaving-alone too — an organizer that finds a newer
  document will not overwrite it, because it cannot represent fields it does
  not know and a rewrite would silently drop them.
- **Absence of the document means defaults.** A missing profile is a mailbox
  that has not stored one, never an error, and deleting the message only
  resets ohmail's settings for the mailbox — never your mail.

## Never secrets

No credential, token or key of any kind is ever part of this document — not
the mailbox password (the organizer holds it, the document does not), not API
keys, not encryption material. The serializers read only the configuration
named above, and the test suite pins the document's exact key census so a new
field is a reviewed decision, not a drive-by. The document also carries no
adaptive state (learning signals, graduations) — it is the human-made
configuration and nothing inferred.

## What does not travel

The document carries the human-made configuration and nothing inferred or
device-bound. Deliberately absent, so nobody discovers it at a switch:

- triage piles and Resurface timers — decisions about individual messages,
  with no IMAP representation yet;
- learned patterns and their graduation state — inferred, and re-learnable;
- notes, snippets and contact annotations;
- device pairings, sessions, billing — deployment-specific by nature;
- credentials of any kind (see above).

The mail itself needs no line here: it never left the mailbox.

## Update = append new + expunge old

IMAP has no in-place update. The new copy is appended first, read back, and
the copy it replaces expunged after, so a crash between the steps leaves two
documents rather than none; readers coalesce by `updatedAt` (newest wins).
Exactly one current profile message is the steady state. While the organizer
asks the person about settings another install left in the folder, that
install's message stays beside the organizer's own until the question is
answered, so the folder holds at most the organizer's current copy, that held
message and one older copy of the organizer's own that a server would not let
it remove yet: while such an older copy is still there, the next write removes
it instead of appending.

Settings messages are found by reading every message's headers in
`ohmail/_meta`, checked against the folder's message count — never by a header
SEARCH, which some servers answer with nothing. The organizer removes
superseded copies: its own at once (while the current document is another
install's, only once it has read that one), another install's once the current
document is ten minutes newer and that install holds no fresh claim, and the
message it held for a found-settings question once that question is answered
by an import or by saving this install's settings. It never
removes the current document, the message it holds for an unanswered
found-settings question, a claim, or a message that is not an ohmail settings
message.

Only the active organizer writes — the organizer lease already serializes
writers, so last-incumbent-wins and no merge algorithm exists.

An install that only reads the mailbox keeps a copy of the current document,
read again every few minutes, and shows the mail where the organizer's rules
place it. It applies none of them itself: nothing is moved or screened by a
reading install.

## A found document stays — and holds the screening

An organizer that takes over a mailbox and finds a foreign document it cannot
call its own does two things with the one question the document poses, and
refuses to answer it itself:

- **The found document stays.** It is surfaced for the user's import decision
  and is never overwritten or removed while that decision is open; the
  organizer writes its own settings beside it. An applied import, or saving
  this install's settings to the mailbox from Settings, answers the question,
  and the organizer then removes the found document. "Not now" answers the
  question for screening and leaves the found document in the mailbox.
- **The consent gate holds, for the senders the document lets
  through.** While the decision is open, mail from a sender the found
  document screened in (or admits by a rule) keeps the folder the mailbox
  already has it in, instead of being re-screened by a store that has not yet
  imported the decisions travelling with the mailbox. The mailbox is the
  master: its standing placement was made under the previous organizer and is
  not undone by the act of switching; so is mail already where the document's
  own rule files it, such as a screened-out sender's mail in Screened out. A
  new letter from a sender the document does not know, or from one a document
  rule screens out, is screened as usual — no answer would let that mail
  through — and importing the document files the mail ohmail held in the
  Screener for the senders it screens out. A rule in the incoming store still applies, a message
  that fails authentication is still held, and a document written by a newer
  ohmail holds every "unknown sender" verdict until it is dismissed. Ordinary
  screening resumes once the import question is answered: before the next sync
  pass for the document the answer names, and within the organizer's next
  profile pass when the document changed under an open question. Mail kept in
  place while the question was open is not re-filed afterwards.

## What a reader in another mail client sees

`ohmail/_meta` is unsubscribed; some mail apps, Apple Mail among them, still
list and search it. Someone who browses into it finds a short message that
explains itself and is safe to delete. It never touches the Inbox and triggers no notifications. A note on
exposure: your mail provider already sees every sender as messages; this
document adds no information the mailbox does not already hold. Its size grows
with the number of senders you have screened in.
