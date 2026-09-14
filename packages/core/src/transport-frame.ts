/**
 * `@trafficflow/core/transport-frame` — THE BYTE THE TRANSPORT REFUSES ON, in one place.
 *
 * The local engine is reached over a length-prefixed stdio frame codec (`apps/sidecar/src/
 * frame.ts`): a body longer than {@link TRANSPORT_FRAME_MAX_BODY_BYTES} is refused before a byte
 * is allocated, and the refusal is fatal — the stream has no resync point. The number lives HERE
 * and not beside the codec because the thing that BUILDS a response has to know it too. A page
 * correct by every row rule is still undeliverable if its bytes do not fit, and two literals in
 * two packages is exactly how that stayed invisible: 100 stored drafts inside the documented row
 * limit made a 34 854 075-byte page against a 33 554 432-byte cap, and the bootstrap never
 * completed.
 *
 * Constants only, and no imports: this leaf is read by the codec, by the page builder and by a
 * census, and anything else it reached would travel with it into all three.
 */

/**
 * The largest body one frame carries.
 *
 * Sized against what the API actually returns rather than "big enough": a `/sync` page and an
 * on-demand attachment fetch are the two large ones, and `DEFAULT_SYNC_BATCH_MAX_BYTES` in the
 * IMAP adapter is 32 MB. Match it and stop. Raising it is never the answer to a page that does
 * not fit — the page is what is wrong, and the next transport has its own number anyway.
 */
export const TRANSPORT_FRAME_MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * What a frame carries BESIDES the rows, held back from the page's own budget: the response
 * envelope the rows sit in (`asOfSeq`, `nextCursor`, `window`, the array's punctuation), the
 * header JSON and the eight-byte preamble.
 *
 * Reserved rather than measured per page, because the page is built before its envelope exists —
 * and generous by a wide margin: a cursor is a few hundred base64 characters and the header is
 * bounded by `MAX_HEADER_BYTES` (64 KiB) on the same wire.
 */
export const TRANSPORT_FRAME_ENVELOPE_RESERVE_BYTES = 128 * 1024;

/**
 * What the ROWS of one page may weigh. The single number a paginator bounds itself by, and the
 * only correct way to spend {@link TRANSPORT_FRAME_MAX_BODY_BYTES}.
 */
export const PAGE_MAX_ROW_BYTES =
  TRANSPORT_FRAME_MAX_BODY_BYTES - TRANSPORT_FRAME_ENVELOPE_RESERVE_BYTES;
