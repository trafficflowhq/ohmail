import type { OnlyNamesOf, ParamsOf, RequestOf, RouteName } from "@ohmail/wire";
import { MutationRejectedError } from "../types.js";

/**
 * What one call carries: what its route's path names (required when it names anything), its
 * query, its body as the wire declares it, and the transport's own options. `B` is the type of
 * the body as it was written, held to the wire's names (`OnlyNamesOf`): a field under a name
 * the route's request does not have is refused wherever it is written, a spread member included.
 */
export type CallOf<R extends RouteName, B extends RequestOf<R> = RequestOf<R>> =
  & (keyof ParamsOf<R> extends never ? { params?: ParamsOf<R> } : { params: ParamsOf<R> })
  & ([RequestOf<R>] extends [never] ? { body?: never } : { body?: B & OnlyNamesOf<B, RequestOf<R>> })
  & {
    query?: URLSearchParams | string;
    idempotencyKey?: string; signal?: AbortSignal; pressAgeMs?: number; urgent?: boolean; searchLane?: string; echoLater?: boolean;
  };

/**
 * ONE CALL, BY THE WIRE'S NAME FOR IT: the type of the one door every request of the engine's
 * client leaves through. Stated here, apart from the client, so that what it refuses can be
 * held from outside (`packages/api/test/contract/wire-drift.fixture.ts`).
 */
export type WireCall = <R extends RouteName, B extends RequestOf<R> = RequestOf<R>>(name: R, o: CallOf<R, B>) => Promise<Response>;

/**
 * A ROUTE'S NAME, AS A REQUEST. The name is the wire's, `"METHOD /pattern"`: the method is what
 * stands before the first space, and each `:name` of the pattern is filled from `params`,
 * percent-encoded. A parameter the pattern names and `params` does not carry is refused HERE,
 * before anything is sent: sent as written, `/messages/:id/body` is a request about a letter
 * called `:id`. The types already ask for every parameter; this is for the caller they did not
 * reach. Not retryable: asking again sends the same missing name.
 */
export function routePath(name: string, params: Readonly<Record<string, unknown>>): { method: string; path: string } {
  const at = name.indexOf(" ");
  const method = name.slice(0, at);
  const path = name.slice(at + 1).split("/").map((segment) => {
    if (!segment.startsWith(":")) return segment;
    const value = params[segment.slice(1)];
    if (typeof value !== "string") {
      throw new MutationRejectedError(`${name} was asked without its ${segment.slice(1)}`, {
        code: "protocol", retryable: false,
      });
    }
    return encodeURIComponent(value);
  }).join("/");
  return { method, path };
}
