/**
 * THE DOOR PAGE'S SIDE OF ITS BRIDGE: the door's closed table of kinds (`src/shell/door-kinds.ts`) over the page's
 * channel. A kind's fields are nested both ways, since the door's own are named `id` and `ok` as the envelope's are.
 * An answer that carries no answer is a refusal, never an empty success.
 */
import type { DoorEvent, DoorKind, DoorRequests } from "../../../src/shell/door-kinds";
import { BridgeRefused, createChannel, type Envelope, type RequestOptions, type Timers } from "../channel";
import type { PagePort } from "../port";

export { BridgeRefused } from "../channel";

export interface DoorBridge {
  readonly epoch: string;
  request<K extends DoorKind>(kind: K, ask: DoorRequests[K]["ask"], opts?: RequestOptions): Promise<DoorRequests[K]["answer"]>;
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
    request: <K extends DoorKind>(kind: K, ask: DoorRequests[K]["ask"], opts?: RequestOptions) =>
      channel.request(kind, ask, opts) as Promise<DoorRequests[K]["answer"]>,
  };
}
