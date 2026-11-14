import { nodeHostResolver, pinnedHttpRequest, privateNetworkPin, type HostResolver } from "@trafficflow/core/net";
import type { EntitlementsFetch } from "@trafficflow/db/cloud";

/** An entitlements answer is a small JSON object; more than this is not one. */
export const PRIVATE_ANSWER_MAX_BYTES = 1024 * 1024;

/** The service's name did not resolve to private addresses only: a call fault, and no byte left. */
export class NotPrivateNetworkError extends Error {
  constructor() {
    super("the service's private name does not resolve to private addresses only; nothing was sent");
    this.name = "NotPrivateNetworkError";
  }
}

/**
 * The `fetch` a bearer rides over plain http (`ServiceAddress.transport === "http-private"`).
 *
 * At EVERY call the name is resolved again and every answer must be a private address
 * (`privateNetworkPin`); the socket then connects only to those addresses (`pinnedHttpRequest`),
 * follows no redirect and takes `Host` from the URL. A name that answers one public address, or
 * none, throws before anything is written.
 *
 * `onFirstDial` is told once which address family the pin had and how many addresses, never an
 * address.
 */
export function privateNetworkFetch(
  resolver: HostResolver = nodeHostResolver,
  onFirstDial?: (seen: { family: 4 | 6; addresses: number }) => void,
): EntitlementsFetch {
  let told = false;
  return async (url, init) => {
    const pin = await privateNetworkPin(new URL(url).hostname, resolver);
    if (pin === null) throw new NotPrivateNetworkError();
    if (!told) {
      told = true;
      onFirstDial?.({ family: pin[0]!.includes(":") ? 6 : 4, addresses: pin.length });
    }
    const res = await pinnedHttpRequest(url, {
      method: init.method,
      headers: { ...init.headers, "content-length": String(Buffer.byteLength(init.body)) },
      body: init.body,
      pin,
      signal: init.signal,
    });
    return {
      status: res.status,
      json: async () => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of res.stream) {
          const bytes = chunk as Buffer;
          size += bytes.length;
          if (size > PRIVATE_ANSWER_MAX_BYTES) {
            res.stream.destroy();
            throw new Error("the service's answer is larger than an entitlements answer can be");
          }
          chunks.push(bytes);
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      },
    };
  };
}
