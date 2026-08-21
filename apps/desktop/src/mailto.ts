/**
 * A `mailto:` link, read into a compose prefill — RFC 6068, read defensively.
 *
 * The operating system hands this app whatever string the registered handler was invoked with,
 * and that string is the one input in this window that a WEBSITE composes: any page can write
 * `<a href="mailto:...">` and a click delivers it here. So this parser's contract is stated as
 * what its OUTPUT can never contain, not as what its input should look like:
 *
 *  · PLAIN STRINGS ONLY. The five fields are text for text inputs. Nothing here is HTML, nothing
 *    is a URL to follow, and no header a link author invents is honored — `attach`, `content-type`
 *    and every other name RFC 6068 lets a URI carry are DROPPED, because each one is an
 *    instruction, and instructions from a web page do not run in a mail client.
 *  · NO CONTROL CHARACTERS where one line is expected. Addresses and the subject are single-line
 *    fields; a CR or LF smuggled into one is the classic header-injection shape, so controls are
 *    collapsed to a space there. The body keeps `\n` and `\t` — it is the one multi-line field —
 *    and nothing else below 0x20.
 *  · BOUNDED. A link is a click; a compose prefill the size of a mailbox is not a compose
 *    prefill. Recipients, subject and body are capped, and the caps are stated here rather than
 *    discovered in a hang.
 *
 * Two RFC 6068 readings that are easy to get wrong, pinned by test:
 *
 *  · `+` IS A PLUS. mailto is percent-encoding only — form encoding's `+`-for-space does not
 *    apply, and `tom+filter@example.org` is a real address.
 *  · SPLIT FIRST, DECODE SECOND. `&` and `=` are separators only while still encoded; a `%26`
 *    inside a subject is an ampersand in the text, never a new header.
 */

export interface MailtoDraft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

/* The caps. Generous against every real link, and small against every hostile one. */
const MAX_RECIPIENTS = 64;
/** RFC 5321's forward-path limit; anything longer is not an address a server would take. */
const MAX_ADDRESS = 320;
const MAX_SUBJECT = 2_000;
const MAX_BODY = 100_000;

/**
 * The prefill a mailto string asks for, or null when the string is not a mailto at all.
 *
 * A bare `mailto:` returns an EMPTY draft rather than null: the click still means "compose",
 * and an empty compose is what that click has always opened.
 */
export function parseMailto(raw: unknown): MailtoDraft | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const scheme = /^mailto:/i.exec(trimmed);
  if (!scheme) return null;
  let rest = trimmed.slice(scheme[0].length);
  /* Not RFC 6068 — the RFC has no authority part — but `mailto://addr` is what some launchers
     and older apps produce, and refusing it would drop the address on exactly the clicks this
     handler exists for. Two literal slashes and nothing else is tolerated. */
  if (rest.startsWith("//")) rest = rest.slice(2);

  const draft: MailtoDraft = { to: [], cc: [], bcc: [], subject: "", body: "" };

  const q = rest.indexOf("?");
  addAddresses(draft.to, decodeLoose(q === -1 ? rest : rest.slice(0, q)));

  /* First occurrence wins for the single-valued fields, and that is a decision, not an accident:
     with "last wins", a link could bury the subject a person will see under one they skimmed past
     in the URL preview. Recipient headers APPEND, which is the RFC's own reading of repeated
     `to=`. */
  let subjectSeen = false;
  let bodySeen = false;
  const query = q === -1 ? "" : rest.slice(q + 1);
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = decodeLoose(eq === -1 ? pair : pair.slice(0, eq)).trim().toLowerCase();
    const value = eq === -1 ? "" : decodeLoose(pair.slice(eq + 1));
    switch (key) {
      case "to":
        addAddresses(draft.to, value);
        break;
      case "cc":
        addAddresses(draft.cc, value);
        break;
      case "bcc":
        addAddresses(draft.bcc, value);
        break;
      case "subject":
        if (!subjectSeen) {
          subjectSeen = true;
          draft.subject = oneLine(value).slice(0, MAX_SUBJECT);
        }
        break;
      case "body":
        if (!bodySeen) {
          bodySeen = true;
          draft.body = bodyText(value).slice(0, MAX_BODY);
        }
        break;
      default:
        /* DROPPED, deliberately, whatever it is. See the header: every other name is an
           instruction from the link's author, and instructions do not ride a click. */
        break;
    }
  }
  return draft;
}

/** True when the draft asks for nothing — the caller opens a plain empty compose. */
export function emptyDraft(d: MailtoDraft): boolean {
  return d.to.length === 0 && d.cc.length === 0 && d.bcc.length === 0 && !d.subject && !d.body;
}

/**
 * Percent-decoding that survives a malformed link.
 *
 * `decodeURIComponent` over the whole string throws on the first bad escape, and a thrown parse
 * is a dropped click. So decoding happens per RUN of escapes — a run is the unit UTF-8 needs,
 * since one character can be several `%XX` in a row — and a run that does not decode stays as it
 * was typed, visible in the field rather than vanished.
 */
function decodeLoose(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** One line of text: every control character — below 0x20, DEL, 0x80–0x9F — collapses to a space. */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

/**
 * Multi-line text: `%0D%0A` (the RFC's line break) and bare CR both become `\n`; `\n` and `\t`
 * survive; every other control character is removed.
 */
function bodyText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
  );
}

/**
 * Separator-delimited addr-specs into `into`, filtered rather than trusted.
 *
 * Split on COMMA AND SEMICOLON, and the semicolon is load-bearing: the compose send path
 * (`parseRecipients`) splits its To text on `/[,;]/`, so an entry this parser admitted whole —
 * `a@x;b@y`, reachable as `%3B` in a link — would count as ONE recipient here and mail TWO
 * there, hiding the second from `MAX_RECIPIENTS` and from every per-entry check. The same
 * separators on both sides keep "what was counted" and "what is mailed" the same list. (RFC 6068
 * delimits with commas; a semicolon inside an addr-spec is legal only in a quoted local part,
 * a shape the send path's validator refuses anyway — dropping it costs no deliverable address.)
 *
 * An entry must contain `@` and fit an address's length to join; everything else — empty
 * segments, decorative text, an entry that is only a display name — is dropped. What joins is
 * still only TEXT in an editable To field; the send path's own validation is the authority on
 * whether it is a deliverable address.
 */
function addAddresses(into: string[], list: string): void {
  for (const part of list.split(/[,;]/)) {
    const entry = oneLine(part);
    if (!entry || !entry.includes("@") || entry.length > MAX_ADDRESS) continue;
    if (into.length >= MAX_RECIPIENTS) return;
    into.push(entry);
  }
}
