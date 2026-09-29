// The spy-pixel / tracker blocker (core, PURE, no network). Two pure string→data
// responsibilities: `detectTrackers(html)` finds remote images that look like beacons;
// `rewriteRemoteImages(html)` points the references it covers at OUR image proxy so the reader's
// browser never connects to the sender (`data:`/`cid:` are inline, left alone). The network fetch
// lives in PrivacyService. The rewrite covers exactly two shapes — an `<img>` `src` and a CSS
// `background-image: url(…)` — everything else is untouched, and both matchers are regexes over
// raw markup. THIS IS NOT THE READER'S PRIVACY GATE: nothing on the render path calls this — what
// protects a reader is `MessageBody`: a tag/attribute ALLOW-LIST, an explicit strip of every
// remote-reference shape, and a frame CSP of `default-src 'none'`. Routing reader html through
// this instead would trade a default-deny gate for a default-allow one.

import { decodeUnreservedEscapes } from "../url-escapes.js";

/** The stored/surfaced tracker kind. `pixel` = a beacon by the readers' rule (a declared
 *  1×1/0×0 or a beacon url); `remote_image` = an image from a known tracker host that is
 *  neither; `read_receipt` is reserved for provider read-receipt beacons. */
export type TrackerKind = "pixel" | "remote_image" | "read_receipt";

export interface TrackerHit {
  url: string;          // the original remote url
  host: string;         // its host (lowercased), "" if unparseable
  kind: TrackerKind;    // pixel vs remote_image
  isPixel: boolean;     // a declared 1×1/0×0 or a beacon url — the label the readers show
}

/**
 * HOSTS THAT SERVE NOTHING BUT OPEN AND CLICK TRACKING — the image proxy refuses their FETCH while
 * the pixel switch stands, so a host here must never serve a sender's real picture. An ESP's
 * umbrella domain that also hosts pictures does not belong: Mailchimp's pictures live on
 * `gallery.mailchimp.com`, Constant Contact's on `files.constantcontact.com`, SendGrid's on
 * `cdn.mcauto-images-production.sendgrid.net` (so only `ct.sendgrid.net`, its tracking host).
 * Matched as the host or a subdomain of it; `tracker-hosts-census.test.ts` holds one tracker
 * url and one picture url per entry.
 */
export const TRACKER_HOSTS: readonly string[] = [
  "list-manage.com",       // Mailchimp opens and clicks (pictures: gallery.mailchimp.com)
  "mandrillapp.com",       // Mailchimp Transactional opens and clicks
  "ct.sendgrid.net",       // SendGrid opens and clicks (pictures: *.mcauto-images-production.sendgrid.net)
  "hubspotemail.net",      // HubSpot opens and clicks (pictures: *.hubspotusercontent*.net)
  "mailgun.org",
  "mailgun.net",
  "sparkpostmail.com",
  "sendibm1.com",          // Brevo opens and clicks (pictures: img.mailinblue.com)
  "doubleclick.net",
  "google-analytics.com",
  "awstrack.me",           // Amazon SES opens and clicks
  "rs6.net",               // Constant Contact opens and clicks (pictures: files.constantcontact.com)
  "api.mixpanel.com",      // Mixpanel's event endpoint (its own pictures sit on mixpanel.com)
  "klaviyomail.com",       // Klaviyo opens and clicks
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

/** True when `host` is a listed tracking host or a subdomain of one — never a substring match. */
export function isKnownTracker(host: string): boolean {
  if (!host) return false;
  return TRACKER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * A beacon url: a beacon word as a PATH segment (`/wf/open?u=…`, `/open.aspx`, `/pixel.gif`) or a
 * per-recipient key in the query (`?uid=…`, `&recipient=…`). Never the host and no other query:
 * `p.png?w=120` is a sized picture, and reading its size as a beacon refused a real picture's
 * fetch. The twin of `@ohmail/client-engine`'s `BEACON_PATH`, the rule's home (this node package
 * cannot import it; the dependency runs the other way); the web reader's parity suite holds the
 * literals equal.
 */
export const BEACON_PATH =
  /^[^?#]*[^/?#]\/(?:wf\/open|open|track|tracking|beacon|pixel|spy|imp|impression)(?:[./?#]|$)|[?&](?:mid|eid|uid|rid|recipient|subscriber)\b/i;

/** The beacon rule over the url a server would fetch: unreserved escapes decoded (`/%6fpen` is `/open`). */
export function isBeaconUrl(url: string): boolean {
  return BEACON_PATH.test(decodeUnreservedEscapes(url));
}

/** Read `name="…"` / `name='…'` / `name=bare` from a single HTML tag. */
function attrValue(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return null;
  return (m[2] ?? m[3] ?? m[4] ?? "").trim();
}

/** Read a single CSS declaration value (e.g. `width`) from a style string, `!important` cut. */
function styleProp(style: string, prop: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;!]+)`, "i");
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
    const pixel = isPixelTag(tag) || isBeaconUrl(src);
    if (!pixel && !isKnownTracker(hostOf(src))) continue;  // ordinary remote image
    pushHit(hits, seen, src, pixel);
  }

  for (const m of html.matchAll(/background-image\s*:\s*url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
    const url = m[2]!.trim();
    if (!REMOTE.test(url)) continue;
    if (!isKnownTracker(hostOf(url)) && !isBeaconUrl(url)) continue;
    pushHit(hits, seen, url, isBeaconUrl(url));
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
