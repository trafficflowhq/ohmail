/**
 * THE DOOR PAGE'S SIDE OF ITS BRIDGE: the door's closed table of kinds (`src/shell/door-kinds.ts`) over the page's
 * channel. A kind's fields are nested both ways, since the door's own are named `id` and `ok` as the envelope's are.
 * An answer that carries no answer is a refusal, never an empty success.
 */
import type { DoorEvent, DoorRequests } from "../../../src/shell/door-kinds";
import { BridgeRefused, createChannel, type Envelope, type RequestOptions, type Timers } from "../channel";
import type { PagePort } from "../port";
import type { Requests } from "../../../src/shell/bridge-kinds";

export { BridgeRefused } from "../channel";

/** The keeper answers this migration request directly on the local door's native view. */
type PageRequests = DoorRequests & Pick<Requests, "keepRows">;

export interface DoorBridge {
  readonly epoch: string;
  request<K extends keyof PageRequests>(kind: K, ask: PageRequests[K]["ask"], opts?: RequestOptions): Promise<PageRequests[K]["answer"]>;
  on(handle: (e: DoorEvent) => void): () => void;
  readonly dropped: () => number;
}

const NESTED: Envelope = {
  ask: (ask) => ({ ask }),
  answer: (message) => {
    if (typeof message.answer !== "object" || message.answer === null) throw new BridgeRefused("malformed");
    return message.answer;
  },
};

export function createDoorBridge(port: PagePort, epoch: string, timers?: Timers): DoorBridge {
  const channel = createChannel<DoorEvent>(port, epoch, NESTED, timers);
  return {
    epoch,
    dropped: channel.dropped,
    on: channel.on,
    request: <K extends keyof PageRequests>(kind: K, ask: PageRequests[K]["ask"], opts?: RequestOptions) =>
      channel.request(kind, ask, opts) as Promise<PageRequests[K]["answer"]>,
  };
}
