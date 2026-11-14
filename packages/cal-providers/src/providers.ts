/**
 * The calendar's providers as a composing program gets them: each behind the port, each with the
 * request port it is reached through, and none unless the program names it.
 *
 * Nothing here has a default. A provider is served when its word is in `enabled`; a policy on
 * addresses and a lookup are named by the program, because an absent one would have to select
 * either the open branch or a branch no test runs. The request ports are made here, over the
 * product's address gate, and are never handed in: a provider cannot be given a way out that is not
 * the gate's.
 *
 * Microsoft has a switch of its own, made of two things the program must both name: its word, and
 * the base of its API. It is built from Microsoft's own pages and tried against a double.
 */
import type { ZoneSource } from "@ohmail/cal-core";
import { SsrfRefusal, assertPublicHttpUrlShape, type HostResolver } from "@trafficflow/core/net";
import { makeReader as caldavReader } from "./caldav/index.js";
import { GOOGLE_HOSTS, makeReader as googleReader } from "./google/index.js";
import { makeReader as icsReader } from "./ics/index.js";
import { makeReader as microsoftReader, microsoftHosts } from "./microsoft/index.js";
import type { CalendarReader, Clock, ProviderWord } from "./port.js";
import { fixedHostRequest, namedHostRequest, type AdapterDeps, type AddressPolicy, type HttpPort } from "./request/index.js";

export interface ProviderDeps {
  readonly clock: Clock;
  /** ONE zone source for the program, for as long as it runs: a source keeps what it made. */
  readonly zones: ZoneSource;
  /** The lookup of a name. A program's own, from its composition root. */
  readonly resolver: HostResolver;
  /** What this deployment may fetch: `cloud` on a hosted server, `own-network` on a person's own computer or server. */
  readonly policy: AddressPolicy;
  /** The providers the program serves. Any other is not made, and `get` answers `null` for it. */
  readonly enabled: ReadonlySet<ProviderWord>;
  /**
   * Microsoft's second switch: the base of its API, which the program names (`MS_GRAPH_BASE` is
   * Microsoft's own address). `null` where Microsoft is not served; its word without a base is a
   * fault, never a quiet fall back to an address nobody named.
   */
  readonly microsoft: { readonly graphBase: string } | null;
}

export interface CalendarProvider {
  readonly reader: CalendarReader;
  /** The request port the provider is reached through. Its sign-in's trades leave through it too. */
  readonly http: HttpPort;
}

export interface CalendarProviders {
  /** The provider of this word, or `null` when the program did not name it. */
  get(word: ProviderWord): CalendarProvider | null;
}

/** A fault of the composing program, said when the providers are made and never later. */
export class CompositionFault extends TypeError {}

/** Microsoft's base as a hosted server may dial it: a public https address on the scheme's own port. */
function hostedBase(graphBase: string): void {
  try {
    assertPublicHttpUrlShape(graphBase, { httpsOnly: true });
  } catch (err) {
    if (!(err instanceof SsrfRefusal)) throw err;
    throw new CompositionFault("the base named for Microsoft's API is no public https address");
  }
}

export function makeCalendarProviders(deps: ProviderDeps): CalendarProviders {
  const way = { resolver: deps.resolver, policy: deps.policy };
  const adapter = (http: HttpPort): AdapterDeps => ({ http, clock: deps.clock, zones: deps.zones });

  const made = new Map<ProviderWord, CalendarProvider>();
  for (const word of deps.enabled) {
    switch (word) {
      case "ics":
      case "caldav": {
        // A host a person named: redirects are followed, each through the gate again.
        const http = namedHostRequest(way);
        made.set(word, { reader: word === "ics" ? icsReader(adapter(http)) : caldavReader(adapter(http)), http });
        break;
      }
      case "google": {
        const http = fixedHostRequest(GOOGLE_HOSTS, way);
        made.set(word, { reader: googleReader(adapter(http)), http });
        break;
      }
      case "microsoft": {
        if (deps.microsoft === null) throw new CompositionFault("Microsoft's calendar is named without the base of its API");
        const { graphBase } = deps.microsoft;
        // A person's own computer may name a base on its own network (a double on this machine); a hosted server may not.
        if (deps.policy.kind === "cloud") hostedBase(graphBase);
        const http = fixedHostRequest(microsoftHosts(graphBase), way);
        made.set(word, { reader: microsoftReader({ ...adapter(http), graphBase }), http });
        break;
      }
      default:
        throw new CompositionFault("a calendar provider is named that is none of the four");
    }
  }
  return { get: (word) => made.get(word) ?? null };
}
