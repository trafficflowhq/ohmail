# Quoted-history corpus

131 synthetic `.eml` fixtures, one per real-world shape of quoted reply/forward history, each with an
`<file>.expected.json` sidecar that says where the new message ends and the history begins. Built for the
0.30.x thread reader, where thread members show their whole quoted history unfolded (report,
2026-10-23: an Outlook-style `Von:/Datum:/An:/Cc:/Betreff: WG:` block in the body's own colour, never folded).

Everything is invented: people, companies, addresses (example.com / example.org / example.net), message ids,
dates (October 2026, CEST). Nothing comes from a real mailbox or from the reported screenshot. The bodies
reproduce each client's markup, plain-text quoting, header labels, date formats, charsets and transfer
encodings, except that text parts a client sends quoted-printable or base64 are kept here as 8bit (the same
decoded bytes), and encoded headers as base64 words.

Each fixture is the `.eml`, its sidecar, and the parts storage keeps (`NN-shape.body.txt` from `normalizeMime`,
`NN-shape.body.html` from `prepareHtmlForStorage`, absent when there is no html part).
`packages/core/test/quoted-history-parts.test.ts` recomputes both from the `.eml`, so they cannot drift.
Fixtures 66-75 are the negative and single-guard cases (a ticket, an invoice, a designed newsletter card,
prose that says someone wrote, pasted header blocks, a bare `>` question, 55 without its announcement, an
Outlook chain in Outlook blue, a list footer under a Gmail quote).
Fixtures 76-87 are tester A's round-42 letters (Outlook on the web, Outlook desktop with and
without a signature table, Outlook for iOS, '-----Original Message-----', Apple Mail, Proton, Yahoo's prefixed
ids, a signature above a quoted chain, bottom-posting, a forward with a note, a wrapped plain-text attribution).
Fixtures 88-105 are the shapes of PR #205's second review: coloured or nested-table signatures in a quoted
Outlook hop, a div canvas card, coloured answers inside a quote, a bare header block under a sentence (pasted
mail, a portal notice, an invoice head), phone forwards with nothing typed but the client's signature line, the
writer's own quoted passage, a registration line under interleaved answers, a newsletter's pull quote, a
forward note ending in ':' (its text folds under its html's verdict only), and bold answers announced as bold.
Fixtures 106-116 are the shapes of its third review: a coloured line inside a quote run that is no answer (a
brand-coloured company name over a nested Outlook hop, a red 'URGENT' line), GMX, WEB.DE and mail.com replies (a
date-first header block), a markerless Samsung history under a nested-table signature, and leads that name no
answers.
A forward keeps the message it forwards open: it is the content the forward delivers. Its history opens with
the forward's own introducer ('Forwarded message', 'Weitergeleitete Nachricht', 'Begin forwarded message:';
19, 26, 32, 86), or its subject opens with a forward's prefix (Fwd, FW, WG, TR, I, RV, Doorst): an Outlook,
OWA or Samsung forward reads like a reply in its body (02, 11, 104, 125-127). Only the hops below the
forwarded message fold, so a forward of one message folds nothing (104). A forwarded message that is itself
a forward (its own header's subject, or a nested introducer) delivers the message below it too (128-130). The readers hand the detector each
`.eml`'s Subject, as the tests do. Fixture 123 is tester A's round-43 reply that quotes such a forward: it folds
at its attribution.
Fixture 124 is an Outlook reply whose answers sit inside the history in the body's own black ink, marked only
by the writer's initials ('[AE] '); a mark two lines of one hop repeat ('[Ana Example] ') counts the same, a single
'[EXTERNAL]' banner does not.
Fixture 131 is a Thunderbird reply (ISO attribution) quoting an Outlook reply to a group: every quoted `An:`
line runs past 400 characters, and its Von/Datum/An/Cc/Betreff blocks still count as header blocks.

## Sidecar schema (`*.expected.json`)

```jsonc
{
  "id": "03", "file": "03-....eml", "shape": "...", "description": "...",
  "client": "outlook_mac_new",            // the client that wrote the TOP message
  "ui_language": "de",                    // that client's UI language (labels, attribution)
  "parts": ["text/plain", "text/html"],   // + text/calendar / image/png where present
  "charset": "utf-8", "transfer_encoding": {"text/plain": "quoted-printable", "text/html": "quoted-printable"},
  "historyKind": "reply" | "forward" | "inline",
  "levels": 2,                            // quoted messages in the body (depth of the chain)
  "authorsInHistory": ["Ben Sample", "Ana Example"],   // newest first
  "expect": {
    "fold": "trailing" | "leading" | "none" | "trailing-tail-only",
    "mustNotFold": false,                 // true: interleaved answers; folding hides them
    "onlyHistory": false,                 // true: nothing typed (bare forward); folding empties the pane
    "text": {                             // null when there is no text/plain part
      "visibleFirstLine": "...",          // first line of the new part
      "visibleLastLine": "...",           // last line of the new part (signature / disclaimer included)
      "historyStartLine": "...",          // the exact first history line as it appears in text/plain
      "historyStartLineNormalized": "...", // same without leading '>'/whitespace, whitespace collapsed
      "signatureAfterHistory": ["..."]    // only where the signature follows the quote (mutt)
    },
    "html": {                             // null when there is no text/html part (or no html marker)
      "historyStartSelector": "div.gmail_quote",  // FIRST match in document order = where history begins;
                                                  // history = that element and everything after it
      "attributionBefore": null,          // text just before that element that also belongs to the history
                                          // (Fastmail, Roundcube put the attribution outside the quote)
      "historyStartText": "...",          // normalized text the history begins with (from the element on)
      "visibleFirstText": "...", "visibleLastText": "..."
    },
    "inlineAnswers": [],                  // answer lines that MUST stay visible (interleaved fixtures)
    "trailingTail": null                  // {startLine, foldable}: the unanswered tail below inline answers
  },
  "notes": "..."
}
```

Text comparisons are on normalized text: U+00A0 as a space, runs of whitespace collapsed, trimmed; for
text/plain lines, leading `>` markers and indentation stripped where the field says "Normalized".

`fold` meanings: `trailing` = the history is the trailing part and should fold; `leading` = bottom-posted,
the history comes first and the new text follows (never hide the reply); `none` = must stay open
(interleaved answers, or the history is the only content); `trailing-tail-only` = interleaved answers stay,
only the unanswered tail below them may fold.
`trailing-before-signature` = the attribution + quote sit between the new text and a signature placed below
the quote (mutt and other bottom-signature editors); `expect.text.signatureAfterHistory` lists those lines,
which belong to the new message and stay visible.

## Shapes

| # | File | Client | UI | Kind | Levels | Fold | Shape |
|---|---|---|---|---|---|---|---|
| 01 | `01-outlook-win-de-reply.eml` | outlook_win | de | reply | 1 | trailing | Outlook for Windows, German: MsoNormal paragraphs, border-top div with Von/Gesendet/An/Cc/Betreff, earlier message flat below (no blockquote, no '>') |
| 02 | `02-outlook-win-de-chain-5-wg.eml` | outlook_win | de | forward | 5 | trailing (from level 2) | Outlook for Windows, German: a WG: forward on top of a 5-level flat AW: chain; five border-top Von: blocks one after another, all at the same depth; the first stays open |
| 03 | `03-outlook-mac-de-datum-wg.eml` | outlook_mac_new | de | reply | 2 | trailing | Outlook for Mac (new), German: body-colour header block (Von:/Datum: '... um HH:MM'/An:/Betreff: WG: ...) with no border and no quote bar, the forwarded message below it, and a further Outlook Von: block below that |
| 04 | `04-outlook-mac-classic-en-reply.eml` | outlook_mac | en | reply | 1 | trailing | Outlook for Mac (classic), English: border-top #B5C4DF div with From/Date/To/Subject, the Gmail original (with its own gmail_quote-free body) below |
| 05 | `05-outlook-win-en-mailto-chain.eml` | outlook_win | en | reply | 2 | trailing | Outlook 2010-2013 style, English: 'From: Name [mailto:address]', Sent: '... 9:14 AM', two levels, windows-1252 |
| 06 | `06-outlook-win-fr-reply.eml` | outlook_win | fr | reply | 1 | trailing | Outlook for Windows, French: 'De :'/'Envoyé :'/'À :'/'Objet :' with a no-break space before the colon (&nbsp; in HTML) |
| 07 | `07-outlook-win-it-reply.eml` | outlook_win | it | reply | 2 | trailing | Outlook for Windows, Italian: Da:/Inviato:/A:/Oggetto:, subject prefix 'R:', two levels |
| 08 | `08-outlook-win-es-reply.eml` | outlook_win | es | reply | 1 | trailing | Outlook for Windows, Spanish: De:/Enviado el:/Para:/Asunto:, 'jueves, 22 de octubre de 2026 9:14', HTML base64 |
| 09 | `09-outlook-win-nl-reply.eml` | outlook_win | nl | reply | 1 | trailing | Outlook for Windows, Dutch: Van:/Verzonden:/Aan:/Onderwerp:, iso-8859-1 |
| 10 | `10-owa-en-reply-to-gmail.eml` | owa | en | reply | 2 | trailing | Outlook on the web, English: div#appendonsend + hr + div#divRplyFwdMsg header; the quoted Gmail thread has every class/id rewritten with an x_ prefix (x_gmail_quote, x_gmail_attr) |
| 11 | `11-owa-de-forward-wg-note.eml` | owa | de | forward | 2 | trailing (from level 2) | Outlook on the web, German: WG: forward with a two-line note; underscore rule in text/plain, divRplyFwdMsg in HTML, an older Outlook Von: block inside; the first stays open |
| 12 | `12-outlook-ios-de-reply.eml` | outlook_ios | de | reply | 1 | trailing | Outlook for iOS, German: 'Outlook für iOS beziehen' line, #mail-editor-reference-message-container with a border-top reference header, underscore rule in text/plain |
| 13 | `13-gmail-en-reply-nested.eml` | gmail | en | reply | 2 | trailing | Gmail web, English: div.gmail_quote > div.gmail_attr 'On ... wrote:' + blockquote.gmail_quote, nested twice; text/plain '> ' and '> > ' |
| 14 | `14-gmail-de-reply-to-apple.eml` | gmail | de | reply | 1 | trailing | Gmail web, German: 'Am Do., 22. Okt. 2026 um 09:14 Uhr schrieb Name <address>:' over an Apple Mail original |
| 15 | `15-gmail-fr-reply-to-outlook.eml` | gmail | fr | reply | 1 | trailing | Gmail web, French: 'Le jeu. 22 oct. 2026 à 09:14, Name <address> a écrit :' over an Outlook original (MsoNormal inside blockquote.gmail_quote) |
| 16 | `16-gmail-it-reply.eml` | gmail | it | reply | 1 | trailing | Gmail web, Italian: 'Il giorno gio 22 ott 2026 alle ore 09:14 Name <address> ha scritto:' |
| 17 | `17-gmail-es-reply.eml` | gmail | es | reply | 1 | trailing | Gmail web, Spanish: 'El jue, 22 oct 2026 a las 9:14, Name (<address>) escribió:' |
| 18 | `18-gmail-nl-reply.eml` | gmail | nl | reply | 1 | trailing | Gmail web, Dutch: 'Op do 22 okt 2026 om 09:14 schreef Name <address>:' |
| 19 | `19-gmail-en-forward-with-note.eml` | gmail | en | forward | 1 | none (forward: shown whole) | Gmail web, English: '---------- Forwarded message ---------' block (From/Date/Subject/To) inside div.gmail_quote, NO blockquote and NO '>' in text/plain, a note above |
| 20 | `20-gmail-de-forward-only.eml` | gmail | de | forward | 1 | none (only history) | Gmail web, German: a bare forward, nothing typed: '---------- Weitergeleitete Nachricht ---------' with Von:/Date:/Subject:/To: (Gmail mixes German and English labels) |
| 21 | `21-gmail-android-de-reply.eml` | gmail_android | de | reply | 1 | trailing | Gmail for Android, German: 'Name <address> schrieb am Do., 22. Okt. 2026, 09:14:' (name first), dir=auto |
| 22 | `22-gmail-android-en-reply.eml` | gmail_android | en | reply | 1 | trailing | Gmail for Android, English: 'On Thu, 22 Oct 2026, 09:14 Name, <address> wrote:' over an Outlook original |
| 23 | `23-apple-mail-en-reply-nested.eml` | apple | en | reply | 2 | trailing | Apple Mail (macOS), English: blockquote type=cite with the attribution INSIDE the quote, nested twice; text/plain quotes the attribution too ('> On ... wrote:') |
| 24 | `24-apple-mail-de-reply.eml` | apple | de | reply | 1 | trailing | Apple Mail, German: 'Am 22.10.2026 um 09:14 schrieb Name <address>:' over an Outlook original |
| 25 | `25-apple-mail-nl-reply.eml` | apple | nl | reply | 1 | trailing | Apple Mail, Dutch: 'Op 22 okt 2026 om 09:14 heeft Name <address> het volgende geschreven:' (no 'schreef') |
| 26 | `26-apple-mail-de-forward-note.eml` | apple | de | forward | 1 | none (forward: shown whole) | Apple Mail, German: 'Anfang der weitergeleiteten Nachricht:' with Von/Betreff/Datum/An rows inside blockquote type=cite, a note above |
| 27 | `27-apple-mail-en-forward-only.eml` | apple | en | forward | 1 | none (only history) | Apple Mail, English: 'Begin forwarded message:' and nothing typed |
| 28 | `28-ios-mail-en-reply.eml` | ios | en | reply | 1 | trailing | iOS Mail, English: 'Sent from my iPhone', the attribution in its OWN blockquote type=cite, the quoted message in a SIBLING blockquote |
| 29 | `29-ios-mail-de-reply.eml` | ios | de | reply | 2 | trailing | iOS Mail, German: 'Von meinem iPhone gesendet' over a two-level Outlook chain (the Outlook Von: block sits inside the iOS quote) |
| 30 | `30-thunderbird-en-top-reply.eml` | thunderbird | en | reply | 1 | trailing | Thunderbird, English, top-posted: div.moz-cite-prefix + blockquote type=cite cite=mid:..., format=flowed text with '-- ' signature above the quote |
| 31 | `31-thunderbird-de-bottom-post.eml` | thunderbird_bottom | de | reply | 1 | leading | Thunderbird, German, BOTTOM-posted: 'Am 22.10.26 um 09:14 schrieb Name:' + quote first, the new text and signature below it |
| 32 | `32-thunderbird-de-forward-inline.eml` | thunderbird | de | forward | 1 | none (forward: shown whole) | Thunderbird, German, inline forward: div.moz-forward-container with '-------- Weitergeleitete Nachricht --------' and a moz-email-headers-table (Betreff/Datum/Von/An) |
| 62 | `62-thunderbird-es-reply.eml` | thunderbird | es | reply | 1 | trailing | Thunderbird, Spanish: 'El 22/10/26 a las 9:14, Name escribió:' |
| 33 | `33-proton-en-reply.eml` | proton | en | reply | 1 | trailing | Proton Mail, English: div.protonmail_quote with 'On Thursday, October 22nd, 2026 at 09:14, ... wrote:' + blockquote.protonmail_quote, 'Sent with Proton Mail secure email.' |
| 34 | `34-yahoo-en-reply.eml` | yahoo | en | reply | 1 | trailing | Yahoo Mail, English: div.yahoo_quoted; text/plain history is NOT '>'-quoted, only indented by spaces under an indented attribution |
| 35 | `35-yahoo-de-reply.eml` | yahoo | de | reply | 1 | trailing | Yahoo Mail, German: 'Am Donnerstag, 22. Oktober 2026 um 09:14:05 MESZ hat Name <address> Folgendes geschrieben:' |
| 36 | `36-zimbra-de-reply-nested.eml` | zimbra | de | reply | 2 | trailing | Zimbra, German: hr#zwchr data-marker=__DIVIDER__, __HEADERS__ (Von/An/Gesendet/Betreff), __QUOTED_TEXT__; text '----- Ursprüngliche Mail -----' then '> ' lines; two levels |
| 37 | `37-exchange-plain-en-original-message.eml` | exchange_plain | en | reply | 1 | trailing | Plain text only, English: '-----Original Message-----' then From: Name [mailto:...] / Sent / To / Subject, history unquoted |
| 38 | `38-exchange-plain-de-urspruengliche-nachricht.eml` | exchange_plain | de | reply | 2 | trailing | Plain text only, German: '-----Ursprüngliche Nachricht-----' / Von / Gesendet / An / Betreff, two levels, iso-8859-1 |
| 39 | `39-exchange-plain-fr-message-dorigine.eml` | exchange_plain | fr | reply | 1 | trailing | Plain text only, French: "-----Message d'origine-----" / De : / Envoyé : / À : / Objet :, windows-1252 |
| 40 | `40-exchange-plain-it-messaggio-originale.eml` | exchange_plain | it | reply | 1 | trailing | Plain text only, Italian: '-----Messaggio originale-----' / Da: / Inviato: / A: / Oggetto: |
| 41 | `41-exchange-plain-es-mensaje-original.eml` | exchange_plain | es | reply | 1 | trailing | Plain text only, Spanish: '-----Mensaje original-----' / De: / Enviado el: / Para: / Asunto:, base64 |
| 42 | `42-exchange-plain-nl-oorspronkelijk-bericht.eml` | exchange_plain | nl | reply | 1 | trailing | Plain text only, Dutch: '-----Oorspronkelijk bericht-----' / Van: / Verzonden: / Aan: / Onderwerp: |
| 43 | `43-lotus-notes-de-reply.eml` | lotus | de | reply | 1 | trailing | HCL (Lotus) Notes, German: grey <font size=1 color=#5f5f5f> label column Von/An/Datum/Betreff, <hr noshade>, subject prefix 'Antwort:' |
| 44 | `44-samsung-email-en-reply.eml` | samsung | en | reply | 1 | trailing | Samsung Email (Android), English: 'Sent from my Galaxy', <!-- originalMessage --> div with '-------- Original message --------' and From/Date/To/Subject |
| 45 | `45-fastmail-en-reply.eml` | fastmail | en | reply | 1 | trailing | Fastmail, English: plain <div> attribution BEFORE blockquote#qt type=cite (the attribution is outside the quote element) |
| 46 | `46-roundcube-de-reply.eml` | roundcube | de | reply | 1 | trailing | Roundcube, German: p#reply-intro 'Am 22.10.2026 09:14, schrieb Name:' before a blue-bordered blockquote type=cite, format=flowed text |
| 47 | `47-mutt-en-bottom-quote-chain.eml` | mutt | en | reply | 2 | trailing-before-signature | mutt, English, plain text only: 'On Thu, Oct 22, 2026 at 09:14:05AM +0200, Name wrote:' + '>' / '>>' quotes, '-- ' signature after the quote |
| 48 | `48-deep-gmail-nested-6.eml` | gmail | en | reply | 6 | trailing | Gmail web, English: six levels of nested div.gmail_quote/blockquote in one body; text/plain down to '> > > > > >' |
| 49 | `49-deep-mixed-clients-6.eml` | gmail | en | reply | 6 | trailing | Six levels, seven clients: Gmail (English UI) over Zimbra over Outlook Windows over Apple Mail over OWA (English UI, German content) over Outlook for Mac over Thunderbird; quote styles nest inside each other |
| 50 | `50-deep-plain-gt-6.eml` | mutt | en | reply | 6 | trailing-before-signature | Plain text only, six levels of '>' nesting ('>>>>>>'), mutt attributions at each level, signatures interleaved |
| 51 | `51-signature-disclaimer-before-history.eml` | outlook_win | de | reply | 2 | trailing | Outlook, German: every message ends with a signature AND a two-language legal disclaimer before the history; the disclaimer repeats at every level |
| 52 | `52-top-posting-plain-wrapped-attribution.eml` | gmail_wrapped | en | reply | 1 | trailing | Gmail plain text only, top-posted: the attribution line is hard-wrapped across two lines ('... David Placeholder <' / 'address> wrote:') before the '>' quote |
| 53 | `53-inline-interleaved-plain.eml` | mutt | en | inline | 1 | none (MUST NOT FOLD) | mutt, plain text only: answers typed BETWEEN quoted lines (quote, answer, quote, answer, quote, answer, signature) |
| 54 | `54-inline-interleaved-plain-with-tail.eml` | mutt | en | inline | 2 | trailing-tail-only (MUST NOT FOLD) | mutt, plain text only: interleaved answers, a short sign-off, then the UNANSWERED rest of the quote (incl. a deeper '>>' level) trailing below |
| 55 | `55-inline-interleaved-outlook-html.eml` | outlook_win | de | inline | 1 | none (MUST NOT FOLD) | Outlook for Windows, German: 'meine Antworten finden Sie unten in Blau' - the answers are bold blue paragraphs INSIDE the quoted message, below its Von: header; no '>' anywhere |
| 56 | `56-inline-interleaved-gmail-html.eml` | gmail | en | inline | 1 | none (MUST NOT FOLD) | Gmail web, English: inside one div.gmail_quote, blockquote / bold answer / blockquote / answer / blockquote / answer; text/plain '> ' lines with *answers* between |
| 57 | `57-calendar-reply-outlook-de.eml` | outlook_win | de | reply | 1 | trailing | Outlook, German: 'Angenommen:' meeting reply with a typed comment; multipart/alternative text/plain + text/html + text/calendar METHOD:REPLY; the quoted invitation header has Wann:/Wo: lines |
| 58 | `58-html-images-tables-history.eml` | outlook_win | en | reply | 2 | trailing | Outlook, English, multipart/related: the quoted message holds a bordered MsoNormalTable, an inline cid: logo (image/png part) and a remote image; text/plain has '[cid:...]' and tab-separated rows |
| 59 | `59-html-only-outlook-de-reply.eml` | outlook_win | de | reply | 2 | trailing | HTML only (no text/plain part), Outlook German, two levels, base64 |
| 60 | `60-outlook-plain-only-de-von-block.eml` | outlook_win | de | reply | 1 | trailing | Plain text only, Outlook German: the history is a bare 'Von:/Gesendet:/An:/Cc:/Betreff:' block after a blank line, no separator line, no '>' |
| 61 | `61-gmail-reply-to-owa-forward-chain.eml` | gmail | en | reply | 3 | trailing | Gmail reply quoting an OWA forward (x_-prefixed markers) of a two-level Outlook thread: gmail_quote > divRplyFwdMsg > border-top Von blocks |
| 63 | `63-apple-mail-it-reply.eml` | apple | it | reply | 1 | trailing | Apple Mail, Italian: 'Il giorno 22 ott 2026, alle ore 09:14, Name <address> ha scritto:' |
| 64 | `64-apple-mail-fr-reply.eml` | apple | fr | reply | 1 | trailing | Apple Mail, French: 'Le 22 oct. 2026 à 09:14, Name <address> a écrit :' |
| 65 | `65-apple-mail-es-reply.eml` | apple | es | reply | 1 | trailing | Apple Mail, Spanish: 'El 22 oct 2026, a las 9:14, Name <address> escribió:' |
| 76 | `76-r42-owa-en-reply-chain.eml` | owa | en | reply | 3 | trailing | Outlook on the web, English: three divRplyFwdMsg hops, each under an hr, the originals unindented |
| 77 | `77-r42-outlook-win-en-word-chain.eml` | outlook_win | en | reply | 2 | trailing | Outlook desktop (Word HTML), English: two border-top From blocks, no quote markup |
| 78 | `78-r42-outlook-win-en-signature-table-chain.eml` | outlook_win | en | reply | 2 | trailing | Outlook desktop, English: a logo-and-name signature table (the name bold in brand blue) in every hop, two border-top From blocks |
| 79 | `79-r42-outlook-ios-en-reply-chain.eml` | outlook_ios | en | reply | 2 | trailing | Outlook for iOS, English: ms-outlook-mobile-reference-message hops with a border-top From/Date block, 'Get Outlook for iOS' under each note |
| 80 | `80-r42-outlook-plain-en-original-message.eml` | outlook_win | en | reply | 2 | trailing | Outlook plain text, English: '-----Original Message-----' hops, unquoted |
| 81 | `81-r42-apple-mail-en-wrapped-quote.eml` | apple | en | reply | 2 | trailing | Apple Mail, English: <div><br><blockquote type=cite> with the attribution inside the quote, nested twice |
| 82 | `82-r42-proton-en-reply-chain.eml` | proton | en | reply | 2 | trailing | Proton Mail, English: div.protonmail_quote around blockquote.protonmail_quote, nested twice, the Proton signature above |
| 83 | `83-r42-yahoo-ydp-en-reply-chain.eml` | yahoo | en | reply | 2 | trailing | Yahoo Mail, English: div#ydp…yahoo_quoted_1.ydp…yahoo_quoted (the generated id prefix), no blockquote, nested twice |
| 84 | `84-r42-plain-signature-above-quote-chain.eml` | plain | en | reply | 2 | trailing | Plain text: a '-- ' signature, then the attribution and a '>' chain whose own signature is quoted |
| 85 | `85-r42-plain-bottom-posted.eml` | plain | en | reply | 2 | leading | Plain text, bottom-posted: the attribution and '>' quote first, the new words last |
| 86 | `86-r42-gmail-en-forward-note.eml` | gmail | en | forward | 1 | none (forward: shown whole) | Gmail, English: a forward with a note, '---------- Forwarded message ---------' inside div.gmail_quote, no blockquote |
| 87 | `87-r42-gmail-plain-wrapped-attribution-chain.eml` | gmail_wrapped | en | reply | 2 | trailing | Gmail text/plain: the attribution wrapped at '<' over two lines at every level, a blank line before each quote |
| 88 | `88-outlook-quoted-brand-coloured-signature.eml` | outlook_win | de | reply | 1 | trailing | Outlook for Windows, German: the quoted signature names the company in bold brand blue over a grey address line |
| 89 | `89-outlook-quoted-green-print-notice.eml` | outlook_win | de | reply | 1 | trailing | Outlook for Windows, German: the quoted signature carries a green print notice over a grey 8pt disclaimer |
| 90 | `90-outlook-nested-table-signature-new-part.eml` | outlook_win | de | reply | 1 | trailing | Outlook for Windows, German: the new message's signature is a nested table (logo cell, text cell with its own table) |
| 91 | `91-outlook-nested-table-signature-quoted-hop.eml` | outlook_win | de | reply | 1 | trailing | Outlook for Windows, German: the quoted message's signature is a nested table |
| 92 | `92-negative-div-canvas-border-card.eml` | synthetic | en | inline | 0 | none | A max-width 600px newsletter whose reply card is an Outlook-style border-top div: designed, never history |
| 93 | `93-gmail-coloured-answers-inside-quote-announced.eml` | gmail | en | inline | 1 | none (MUST NOT FOLD) | Gmail, English: the lead says the answers are below in red, and they are typed in red inside the quote |
| 94 | `94-apple-coloured-answers-inside-quote.eml` | apple | de | inline | 1 | none (MUST NOT FOLD) | Apple Mail, German: answers typed in blue inside the quote, nothing in the lead says so |
| 95 | `95-negative-pasted-mail-comments-below.eml` | synthetic | en | inline | 0 | none (MUST NOT FOLD) | Plain text: a pasted header block under a lead that ends in a sentence, the writer's request below it |
| 96 | `96-negative-portal-notification.eml` | synthetic | en | inline | 0 | none (MUST NOT FOLD) | Plain text: a portal notification quoting the customer's message under a From/Subject/Date block |
| 97 | `97-negative-invoice-letterhead-de.eml` | synthetic | de | inline | 0 | none (MUST NOT FOLD) | Plain text, German: an invoice whose letter head is a Von/An/Datum/Betreff block under a sentence |
| 98 | `98-ios-mail-en-bare-forward-signature.eml` | ios | en | forward | 1 | none (only history) | iOS Mail, English: a forward with nothing typed but 'Sent from my iPhone' |
| 99 | `99-outlook-ios-en-bare-forward-signature.eml` | outlook_ios | en | forward | 1 | none (only history) | Outlook for iOS, English: a forward with nothing typed but 'Get Outlook for iOS' |
| 100 | `100-samsung-email-en-bare-forward-signature.eml` | samsung | en | forward | 1 | none (only history) | Samsung Email, English: a forward with nothing typed but 'Sent from my Galaxy' |
| 101 | `101-negative-gmail-quoted-passage-over-signature.eml` | gmail | en | inline | 0 | none (MUST NOT FOLD) | Gmail, English: the writer quotes a contract paragraph with the quote button, a signature below; no attribution |
| 102 | `102-inline-interleaved-plain-registered-signature.eml` | mutt | en | inline | 1 | none (MUST NOT FOLD) | Fixture 53 (mutt, answers between quoted lines) with a company registration line in the signature |
| 103 | `103-negative-newsletter-pull-quote.eml` | synthetic | en | inline | 0 | none (MUST NOT FOLD) | A max-width 600px newsletter whose post ends on a pull quote above a grey footer |
| 104 | `104-outlook-win-de-forward-colon-note.eml` | outlook_win | de | forward | 1 | none (forward: shown whole) | Outlook for Windows, German: a WG: forward whose note ends with ':' over a border-top Von block; without its subject it folds, and the text part alone reads as a paste |
| 105 | `105-inline-interleaved-outlook-bold-announced.eml` | synthetic | de | inline | 1 | none (MUST NOT FOLD) | Fixture 73 with the answers bold in the body's ink, the lead 'meine Antworten sind fett gedruckt.' |
| 106 | `106-gmail-reply-to-owa-chain-brand-signature.eml` | gmail | en | reply | 3 | trailing | Fixture 61 with the quoted hop's company name in bold brand blue; the next hop is an Outlook header block inside the quote |
| 107 | `107-gmail-fr-reply-red-urgent-line.eml` | gmail | fr | reply | 1 | trailing | Fixture 15 with a red 'URGENT' line between the quoted greeting and its prose |
| 108 | `108-gmx-de-reply.eml` | gmx | de | reply | 1 | trailing | GMX, German: 'Gesendet:/Von:/An:/Betreff:' (the date first) over the original in an unclassed div name=quote |
| 109 | `109-webde-de-reply-nested-table-signature.eml` | webde | de | reply | 1 | trailing | WEB.DE, German: GMX's date-first header block, the quoted signature a nested table (logo cell beside a name cell) |
| 110 | `110-mailcom-en-reply.eml` | mailcom | en | reply | 1 | trailing | mail.com, English: 'Sent:/From:/To:/Subject:' (the date first) over the original in an unclassed div name=quote |
| 111 | `111-samsung-email-en-reply-nested-table-signature.eml` | samsung | en | reply | 1 | trailing | Fixture 44 (Samsung, '-------- Original message --------') with a nested-table signature under the quoted message |
| 112 | `112-gmail-en-reply-lead-photo-inline.eml` | gmail | en | reply | 2 | trailing | Fixture 13 with the lead 'The photo is inline.': no announcement of answers |
| 113 | `113-gmail-en-reply-lead-chart-inline.eml` | gmail | en | reply | 2 | trailing | Fixture 13 with the lead 'I put the chart inline so you can see it.': no announcement of answers |
| 114 | `114-gmail-en-reply-lead-comments-question.eml` | gmail | en | reply | 2 | trailing | Fixture 13 with the lead 'Any comments? The full draft is attached below.': no announcement of answers |
| 115 | `115-gmail-de-reply-lead-antworten-verb.eml` | gmail | en | reply | 2 | trailing | Fixture 13 with the lead 'Bitte antworten Sie bis Freitag, Details unten.': no announcement of answers |
| 116 | `116-gmail-en-reply-lead-notes-red-team.eml` | gmail | en | reply | 2 | trailing | Fixture 13 with the lead 'Thanks for the notes on the red team report.': no announcement of answers |
| 117 | `117-gmail-caps-answers-inside-quote.eml` | gmail | en | inline | 1 | none (MUST NOT FOLD) | Gmail, English: lead 'see below.', the answers YES, CHF 5'000, 14:00 in red under the quoted questions |
| 118 | `118-gmail-ok-done-answers-inside-quote.eml` | gmail | en | inline | 1 | none (MUST NOT FOLD) | Gmail, English: lead 'see below.', the answers OK, OK, DONE in red under the quoted questions |
| 119 | `119-owa-caps-answers-inside-quote.eml` | owa | de | inline | 1 | none (MUST NOT FOLD) | Outlook on the web, German: lead 'siehe unten.', the answers JA, 5000 CHF, 14:00 in red below the divRplyFwdMsg block |
| 120 | `120-owa-colon-answers-inside-quote.eml` | owa | de | inline | 1 | none (MUST NOT FOLD) | Outlook on the web, German: lead 'siehe unten.', red answers ending in ':' below the divRplyFwdMsg block |
| 121 | `121-gmail-de-ink-first-lead-caps-answers.eml` | gmail | de | inline | 1 | none (MUST NOT FOLD) | Gmail, German: lead 'In Rot meine Antworten.', the answers JA, 5000 CHF, 14:00 in red inside the quote |
| 122 | `122-gmail-en-split-lead-caps-answers.eml` | gmail | en | inline | 1 | none (MUST NOT FOLD) | Gmail, English: lead 'My answers are, as usual, in red.', the answers YES, CHF 5'000, 14:00 in red inside the quote |
| 123 | `123-r43-gmail-en-reply-quoting-forward.eml` | gmail | en | reply | 2 | trailing | Gmail, English: a reply whose quote holds a forward with a note; folds at 'On ... wrote:' |
| 124 | `124-outlook-en-black-initials-answers.eml` | outlook_win | en | inline | 1 | none (MUST NOT FOLD) | Outlook for Windows, English: lead 'thanks, done.', black answers inside the history marked '[AE] ' in bold italic |
| 125 | `125-outlook-win-en-forward-thread.eml` | outlook_win | en | forward | 2 | trailing (from level 2) | Outlook for Windows, English: FW: of a two-message thread with a note; border-top From/Sent blocks, no forward wording in the body |
| 126 | `126-owa-fr-forward-thread.eml` | owa | fr | forward | 2 | trailing (from level 2) | Outlook on the web, French: TR: of a two-message thread with a note; 'De :' blocks under underscore rules and divRplyFwdMsg |
| 127 | `127-samsung-email-en-forward-thread.eml` | samsung | en | forward | 2 | trailing (from level 2) | Samsung Email, English: Fwd: of a Gmail reply with a note; '-------- Original message --------' over the forwarded reply, its 'On ... wrote:' quote below |
| 128 | `128-apple-mail-de-forward-of-forward.eml` | apple | de | forward | 2 | none (forward: shown whole) | Apple Mail, German: Fwd: Fwd: with a note; the inner forward's 'zur Info', then a nested 'Anfang der weitergeleiteten Nachricht:' over the offer it delivers |
| 129 | `129-gmail-en-forward-of-forward-thread.eml` | gmail | en | forward | 3 | trailing (from level 3) | Gmail, English: Fwd: Fwd: with a note; two nested 'Forwarded message' blocks, the inner one a reply whose 'On ... wrote:' quote folds |
| 130 | `130-outlook-win-de-forward-of-forward-chain.eml` | outlook_win | de | forward | 3 | trailing (from level 3) | Outlook for Windows, German: WG: WG: with a note; the middle Von block's Betreff is WG: over 'z.K.', the supplier's AW: with the invoice stays open, the request it answers folds |
| 131 | `131-thunderbird-en-iso-reply-to-outlook-mac-group.eml` | thunderbird | en | reply | 4 | trailing | Thunderbird, English: 'On 2026-10-20 07:44, ... wrote:' over an Outlook for Mac reply to twelve people; a two-line answer, then Von/Datum/An/Cc/Betreff blocks whose An: line is past 400 characters |
