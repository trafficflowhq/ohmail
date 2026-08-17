// ─────────────────────────────────────────────────────────────────────────────
// The spy-pixel / tracker blocker (core, PURE, no network).
//
// Two responsibilities, both pure string→data functions so they are trivially
// unit-testable and safe to run on any host:
//   • detectTrackers(html)       — find remote images that look like tracking
//                                  beacons (1×1 pixels, known tracker hosts,
//                                  beacon-shaped urls) and return the hits.
//   • rewriteRemoteImages(html)  — point the remote image references it covers
//                                  at OUR image proxy so the reader's browser
//                                  does not connect to the sender directly (the
//                                  proxy fetches server-side, hiding the
//                                  reader's IP). data: and cid: URIs are
//                                  inline/embedded — left as-is.
//
// The network fetch that actually hides the IP lives in PrivacyService
// (packages/services); this file only decides WHAT to block and rewrites the html.
//
// ── WHAT rewriteRemoteImages COVERS, STATED EXACTLY, BECAUSE IT IS NOT "EVERY
//    REMOTE REFERENCE" AND THIS HEADER USED TO SAY IT WAS ────────────────────
//
// It rewrites two shapes and only two: an `<img>` tag's `src`, and a CSS
// `background-image: url(…)` declaration. Everything else that can name a
// network resource is untouched — `srcset`, the legacy `background` attribute,
// `image-set()`, the `background:` shorthand, `@import`, `<link href>`,
// `<video poster>`, `<object data>`, `<embed src>`, `<iframe src>`, SVG
// `<image href>`/`xlink:href`, `<base>` and `<meta http-equiv=refresh>`. Both
// matchers are also regular expressions over raw markup, so they disagree with
// a real parser on quoted urls containing `)` or `>`, on character references,
// and on CSS escapes.
//
// ── THIS IS NOT THE READER'S PRIVACY GATE. DO NOT WIRE IT IN AS ONE. ─────────
//
// Nothing on the reader's render path calls this module. What protects a reader
// opening a message is `MessageBody`, and it is a different and much stronger
// mechanism: a tag/attribute ALLOW-LIST (so an unlisted element is gone rather
// than rewritten), an explicit strip of every `src`, `srcset`, `background`,
// CSS `url()`, `image-set()` and `@import` before the document is built, and a
// frame CSP of `default-src 'none'` that refuses whatever shape of remote
// reference the code has not thought of. The gaps listed above are survivable
// only because that is what actually runs.
//
// So this module is a SERVER-SIDE analysis helper — "what did this message try
// to fetch, and what would a proxied rewrite look like". Routing reader-facing
// html through it INSTEAD of the allow-list would silently trade a default-deny
// gate for a default-allow one. If it ever does go on a render path, the list
// above is the work that has to be done first.
// ─────────────────────────────────────────────────────────────────────────────

/** The stored/surfaced tracker kind. `pixel` = a 1×1/0×0 beacon; `remote_image`
 *  = a remote image from a known tracker host / beacon url that is not a bare
 *  pixel; `read_receipt` is reserved for provider read-receipt beacons. */
export type TrackerKind = "pixel" | "remote_image" | "read_receipt";

export interface TrackerHit {
  url: string;          // the original remote url
  host: string;         // its host (lowercased), "" if unparseable
  kind: TrackerKind;    // pixel vs remote_image
  isPixel: boolean;     // true when 1×1/0×0 dimensions were detected
}

// A small built-in list of hosts/domains overwhelmingly used for open-tracking
// and email beacons. Matched as a substring of the url host, so subdomains
// (e.g. `ct.sendgrid.net`, `email.mailchimp.com`) are covered. Not exhaustive by
// design — dimension + beacon heuristics catch the long tail.
const TRACKER_HOSTS: string[] = [
  "list-manage.com",       // Mailchimp campaign links / opens
  "mailchimp.com",
  "mailchi.mp",
  "sendgrid.net",          // SendGrid open-tracking (ct.sendgrid.net, wtrack…)
  "sendgrid.com",
  "hubspot.com",
  "hubspotemail.net",
  "hs-sites.com",
  "mailgun.org",
  "mailgun.net",
  "mandrillapp.com",
  "sparkpostmail.com",
  "sendibm1.com",          // Sendinblue / Brevo
  "sendinblue.com",
  "doubleclick.net",
  "google-analytics.com",
  "awstrack.me",           // Amazon SES open-tracking
  "constantcontact.com",
  "rs6.net",               // Constant Contact
  "exct.net",              // Salesforce Marketing Cloud (ExactTarget)
  "mixpanel.com",
  "klaviyomail.com",
  "braze.com",
];

const REMOTE = /^https?:\/\//i;

/** The host of a url, lowercased, or "" if it cannot be parsed. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    const m = /^https?:\/\/([^/?#]+)/i.exec(url);
    return m ? m[1]!.toLowerCase() : "";
  }
}

/** True when `host` matches (as a substring) any known email-tracker host. */
export function isKnownTracker(host: string): boolean {
  if (!host) return false;
  return TRACKER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`) || host.includes(h));
}

// A "beacon"-shaped url: an image request whose path/query screams open-tracking
// (an `/open`, `/track`, `/pixel`, `/beacon` segment, a `.gif?…`/`.png?…` with a
// query string, or a query carrying a message/recipient identifier). Heuristic,
// deliberately conservative — the dimension + host checks are the primary signal.
const BEACON_RE = /(?:\/(?:open|track|tracking|beacon|pixel|spy|wf\/open)\b|\.(?:gif|png)\?|[?&](?:mid|eid|uid|rid|recipient|subscriber|campaign|utm_medium=email)\b)/i;

export function isBeaconUrl(url: string): boolean {
  return BEACON_RE.test(url);
}

/** Read `name="…"` / `name='…'` / `name=bare` from a single HTML tag. */
function attrValue(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return null;
  return (m[2] ?? m[3] ?? m[4] ?? "").trim();
}

/** Read a single CSS declaration value (e.g. `width`) from a style string. */
function styleProp(style: string, prop: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i");
  const m = re.exec(style);
  return m ? m[1]!.trim() : null;
}

/** Parse a pixel dimension (`"1"`, `"1px"`, `"0"`), or null if not numeric. */
function dim(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v.replace(/px$/i, "").trim());
  return Number.isFinite(n) ? n : null;
}

/** True when an <img> tag declares 1×1/0×0 dimensions (attrs or inline style). */
function isPixelTag(tag: string): boolean {
  const w = dim(attrValue(tag, "width"));
  const h = dim(attrValue(tag, "height"));
  if (w !== null && h !== null && w <= 1 && h <= 1) return true;
  const style = attrValue(tag, "style");
  if (style) {
    const sw = dim(styleProp(style, "width"));
    const sh = dim(styleProp(style, "height"));
    if (sw !== null && sh !== null && sw <= 1 && sh <= 1) return true;
  }
  return false;
}

function pushHit(hits: TrackerHit[], seen: Set<string>, url: string, isPixel: boolean): void {
  if (seen.has(url)) return;
  seen.add(url);
  hits.push({ url, host: hostOf(url), kind: isPixel ? "pixel" : "remote_image", isPixel });
}

/**
 * Scan an HTML body and return the remote resources that LOOK like tracking
 * beacons. A plain remote image (real host, real dimensions, no beacon shape) is
 * NOT returned — only suspected trackers are. Covers `<img>` (with dimension
 * heuristics), CSS `background-image: url(…)`, and remote `<link href>`.
 */
export function detectTrackers(html: string): TrackerHit[] {
  const hits: TrackerHit[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = attrValue(tag, "src");
    if (!src || !REMOTE.test(src)) continue;             // data:/cid:/relative → not a remote tracker
    const pixel = isPixelTag(tag);
    if (!pixel && !isKnownTracker(hostOf(src)) && !isBeaconUrl(src)) continue;  // ordinary remote image
    pushHit(hits, seen, src, pixel);
  }

  for (const m of html.matchAll(/background-image\s*:\s*url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
    const url = m[2]!.trim();
    if (!REMOTE.test(url)) continue;
    if (!isKnownTracker(hostOf(url)) && !isBeaconUrl(url)) continue;
    pushHit(hits, seen, url, false);
  }

  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const href = attrValue(m[0], "href");
    if (!href || !REMOTE.test(href)) continue;
    if (!isKnownTracker(hostOf(href)) && !isBeaconUrl(href)) continue;
    pushHit(hits, seen, href, false);
  }

  return hits;
}

/** Build the proxy url for one original remote image url (§5.15). */
export function proxyUrlFor(proxyBase: string, messageId: string, url: string): string {
  return `${proxyBase}?mid=${encodeURIComponent(messageId)}&u=${encodeURIComponent(url)}`;
}

/**
 * Rewrite every REMOTE image reference in `html` to the image proxy, so the
 * reader's browser fetches image bytes THROUGH our server (which fetches them
 * server-side, hiding the reader's IP from the sender) instead of connecting to
 * the sender directly. `<img src>` and CSS `background-image: url(…)` are
 * rewritten; `data:` (inline) and `cid:` (embedded attachment) URIs are left
 * untouched. Returns the rewritten html plus the detected trackers (from the
 * ORIGINAL html) so the caller can surface "who tried to spy on you".
 */
export function rewriteRemoteImages(
  html: string,
  proxyBase: string,
  messageId: string,
): { html: string; trackers: TrackerHit[] } {
  const trackers = detectTrackers(html);

  // Rewrite <img src="…"> when the src is remote.
  let out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = attrValue(tag, "src");
    if (!src || !REMOTE.test(src)) return tag;           // data:/cid:/relative left as-is
    const proxied = proxyUrlFor(proxyBase, messageId, src);
    return tag.replace(
      /(\bsrc\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))/i,
      (_full, pre: string) => `${pre}"${proxied}"`,
    );
  });

  // Rewrite CSS background-image: url(remote).
  out = out.replace(
    /background-image\s*:\s*url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (full, _q: string, url: string) => {
      if (!REMOTE.test(url.trim())) return full;
      return `background-image:url("${proxyUrlFor(proxyBase, messageId, url.trim())}")`;
    },
  );

  return { html: out, trackers };
}
