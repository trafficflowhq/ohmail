/**
 * HOW LONG THE DRAWN DOCUMENT WILL BE, READ BEFORE ITS PICTURES ARE WRITTEN INTO IT. The sanitizer writes
 * a picture's `data:` URI once per reference, so one picture named two hundred times is two hundred
 * copies, and a document of tens of millions of characters ran the app out of memory when the WebView
 * was handed it on a test phone. This reads that length without writing a picture: the sanitizer runs
 * once with a short stand-in for each picture, the stand-ins it wrote are counted (less any the
 * sender's own text already carried), and each one adds its picture's real length.
 */
import { INLINE_IMAGE_SRC } from "@ohmail/client-engine";
import { buildPhoneMailDocument, type MailDocumentTheme } from "./mail-document";
import { sanitizeMailHtmlPhone, type PhoneSanitizedMail, type PhoneSanitizeOptions } from "./sanitize";

/** The `i`th picture's stand-in: a `data:` URI the mint's gate admits, told apart by its fixed-width index. */
export function lengthStandIn(i: number): string {
  return "data:image/gif;base64,Q" + i.toString(36).padStart(6, "0") + "9";
}

function occurrences(text: string, needle: string): number {
  let n = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) n += 1;
  return n;
}

/**
 * The length of `buildPhoneMailDocument(sanitizeMailHtmlPhone(html, opts).html, theme)`, with no
 * picture written; `bare` is `html` sanitized with no picture at all. A picture the gate refuses is
 * left out, as the sanitizer leaves it out.
 */
export function drawnLength(
  html: string,
  opts: PhoneSanitizeOptions,
  bare: PhoneSanitizedMail,
  theme: MailDocumentTheme,
): number {
  const shell = buildPhoneMailDocument("", theme).length;
  const real: string[] = [];
  const standIns = (map: ReadonlyMap<string, string> | undefined): Map<string, string> | undefined => {
    if (map === undefined) return undefined;
    const out = new Map<string, string>();
    for (const [key, uri] of map) {
      if (!INLINE_IMAGE_SRC.test(uri)) continue;
      out.set(key, lengthStandIn(real.length));
      real.push(uri);
    }
    return out;
  };
  const inlineImages = standIns(opts.inlineImages);
  const resolvedRemote = standIns(opts.resolvedRemote);
  if (real.length === 0) return shell + bare.html.length;
  const dry = sanitizeMailHtmlPhone(html, { ...opts, inlineImages, resolvedRemote });
  let length = shell + dry.html.length;
  real.forEach((uri, i) => {
    const standIn = lengthStandIn(i);
    const written = occurrences(dry.html, standIn) - occurrences(bare.html, standIn);
    length += written * (uri.length - standIn.length);
  });
  return length;
}
