/**
 * THE ONE OFF-ORIGIN DESTINATION OF THE CLOUD WEB CLIENT: the storage project's signed-upload path,
 * where a send whose files exceed the inline 3 MB PUTs them (`HttpAdapter` staging). One module for
 * the readers that must agree: `next.config.mjs` (the build check and every non-demo policy),
 * `app/security-headers.ts` (the nonce policy), `app/shell/engine-config.ts` (which grants the page
 * may PUT to) and the mailbox page (whether it offers the staged ceiling at all).
 */

/**
 * The build variable: the origin of the storage project the API's upload grants point at. Unset: no
 * policy change, and sends cap at 3 MB.
 */
export const STAGING_ORIGIN_VAR = "NEXT_PUBLIC_STAGING_ORIGIN";

/** Where a grant addresses its upload under that origin. Nothing else there is admitted. */
const UPLOAD_PATH = "/storage/v1/object/upload/sign/";

/** A host by name: lower-case labels, at least two, the last one starting with a letter (no IP). */
const NAMED_HOST = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?$/;

/**
 * The `connect-src` source for a storage origin: its signed-upload path and nothing wider, so the
 * project's other paths stay refused. Only an https origin written exactly (a named host; no wildcard,
 * port, path, query, fragment or credentials) makes one; anything else is null.
 *
 * @param {string | undefined | null} raw
 * @returns {string | null}
 */
export function stagingUploadSource(raw) {
  const value = (raw ?? "").trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // `origin` drops a path, query, fragment, credentials and a default port, and lower-cases the host:
  // a value that is not equal to its own origin carried one of them.
  if (url.protocol !== "https:" || url.port !== "" || url.origin !== value) return null;
  return NAMED_HOST.test(url.hostname) ? `${url.origin}${UPLOAD_PATH}` : null;
}

/**
 * The validated origin, or null when unset. The build refuses the variable on a self-host build (its
 * uploads ride the install's own origin) and refuses a value that is not one https origin.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ selfhost: boolean }} build
 * @returns {string | null}
 */
export function assertStagingOrigin(env, { selfhost }) {
  const raw = (env[STAGING_ORIGIN_VAR] ?? "").trim();
  if (raw === "") return null;
  if (selfhost) {
    throw new Error(`${STAGING_ORIGIN_VAR} must not be set on an OHMAIL_FLAVOR=selfhost build — its uploads go to its own origin`);
  }
  if (stagingUploadSource(raw) === null) {
    throw new Error(`${STAGING_ORIGIN_VAR} must be the storage project's https origin, written exactly: no path, port or wildcard`);
  }
  return raw;
}

/** Is `source` exactly one {@link stagingUploadSource} makes? */
const isUploadSource = (/** @type {string} */ source) =>
  source.endsWith(UPLOAD_PATH) && stagingUploadSource(source.slice(0, -UPLOAD_PATH.length)) !== null;

/**
 * `csp` with the upload source added to `connect-src`, every other directive byte for byte. No
 * source returns `csp` unchanged; a policy without `connect-src`, or a source of any other shape,
 * is refused rather than extended.
 *
 * @param {string} csp
 * @param {string | null | undefined} source
 * @returns {string}
 */
export function withStaging(csp, source) {
  if (source === null || source === undefined) return csp;
  if (!isUploadSource(source)) throw new Error("not a storage upload source");
  const directives = csp.split("; ");
  if (!directives.some((d) => d.split(" ")[0] === "connect-src")) throw new Error("policy has no connect-src");
  return directives.map((d) => (d.split(" ")[0] === "connect-src" ? `${d} ${source}` : d)).join("; ");
}

/**
 * May this page PUT to `url`? What its policy admits: its own origin, or a URL under the upload
 * source. A grant it may not reach fails the same way on every retry, so the send ends instead.
 *
 * @param {string} url
 * @param {string | null} source
 * @param {string} pageOrigin
 * @returns {boolean}
 */
export function stagingAdmits(url, source, pageOrigin) {
  let u;
  try {
    u = new URL(url, pageOrigin || undefined);
  } catch {
    return false;
  }
  if (pageOrigin !== "" && u.origin === pageOrigin) return true;
  return source !== null && `${u.origin}${u.pathname}`.startsWith(source);
}
