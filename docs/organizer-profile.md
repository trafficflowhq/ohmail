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
- A plain-text body: a short human preamble (for whoever finds the message in
  an ordinary mail client), then the JSON document. A reader takes the
  substring from the body's first `{` to its last `}` — the preamble is
  guaranteed not to contain `{`.

## The JSON document, version 1

```jsonc
{
  "v": 1,                          // format version. REQUIRED. See versioning below.
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
      "provenance": "manual" | "migrated" | "promoted",
      "subjectContains": "<optional narrowing term>",
      "bodyContains": "<optional narrowing term>"
    }
  ],
  "notifyRules": [                 // senders/threads opted back INTO notifications
    { "kind": "sender" | …, "target": "<spec>" }
  ],
  "awayResponder": {               // the single per-mailbox autoresponder, or null
    "enabled": false,
    "subject": "<string or null>",
    "body": "<string or null>",
    "startsAt": "<ISO 8601 or null>",
    "endsAt": "<ISO 8601 or null>",
    "audience": "screened_in" | "everyone"
  },
  "tagNames": ["<tag name>", …]    // the names of this mailbox's tags
}
```

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
adaptive state (learning signals, graduations) — v1 is the human-made
configuration and nothing inferred.

## Update = append new + expunge old

IMAP has no in-place update. The new copy is appended first and the old copies
expunged after, so a crash between the two steps leaves two documents rather
than none; readers coalesce by `updatedAt` (newest wins) and the writer's next
update cleans up the extras. Exactly one current profile message is the steady
state.

Only the active organizer writes — the organizer lease already serializes
writers, so last-incumbent-wins and no merge algorithm exists.

## What a reader in another mail client sees

`ohmail/_meta` is unsubscribed, so ordinary mail clients hide it. Someone who
browses into it anyway finds a short message that explains itself and is safe
to delete. It never touches the Inbox and triggers no notifications. A note on
exposure: your mail provider already sees every sender as messages; this
document adds no information the mailbox does not already hold. It is a few
kilobytes and irrelevant to quota.
