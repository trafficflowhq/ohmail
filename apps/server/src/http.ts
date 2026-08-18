/**
 * THE HAND-ROLLED node:http ADAPTER — this host's own name for it.
 *
 * The implementation moved to `packages/core/src/adapters/http-host.ts` — verbatim, all four
 * ruled correctness points and the x-vercel-drop/XFF-append included — the day a second
 * long-running host (the desktop engine's loopback host door, published to the tailnet by
 * `tailscale serve`) needed the same translation: IncomingMessage/ServerResponse ⇄ fetch
 * Request/Response must not exist as two hand-kept copies. Same shape as `wake-hub.ts`, and for
 * the same reason: this module stays as the composition's own name so `index.ts` and the
 * real-socket suite in `test/http-adapter.test.ts` are untouched, and so that suite keeps proving
 * the exact import path this host serves through.
 *
 * Everything this host relies on is unchanged: the half-duplex stream body, `getSetCookie()`
 * multi-value folding, streaming responses with backpressure, the byte cap and the two slowloris
 * timeouts. The caps themselves stay HERE (`config.ts`: `BODY_MAX_BYTES`,
 * `SELF_HOST_SEND_MAX_TOTAL_BYTES`) — the adapter owns the mechanism, each host owns its numbers.
 */
export {
  makeHttpServer, toWebRequest, writeWebResponse, BodyTooLargeError,
  type AdapterOptions,
} from "@trafficflow/core/adapters/http-host";
