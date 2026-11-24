import type { MessageBody, WithheldMarker } from "@ohmail/wire";
import { useCallback, useRef, useState } from "react";
import {
  createSessionBodyDoor,
  type OlderBodyOutcome,
  type OlderBodyWire,
  type SessionBodyHeld,
} from "@ohmail/client-engine";

export interface OlderBodyDoor {
  /** Is there a wire behind this door at all? False ⇒ `bodyFor`/`open` are inert. */
  available: boolean;
  /** The `MessageBody` the pane renders for a reach-past row — see the header for the states. */
  bodyFor(m: { id: string; snippet: string }): MessageBody;
  /**
   * Fetch on show. One ask per row per session; `retry: true` REPLACES whatever is held — the
   * human's press must dispatch even while a hung first ask still reads `loading` (the junk
   * window's measured finding, inherited through the shared door rather than re-learned).
   */
  open(messageId: string, opts?: { retry?: boolean }): void;
}

/** A resting `MessageBody` in one expression — every non-full state shares this shape. */
function resting(text: string, state: MessageBody["state"], withheld?: WithheldMarker): MessageBody {
  return {
    text,
    state,
    html: null,
    loadedRemoteContent: false,
    unsubscribe: "no_header",
    unsubscribeUrl: null,
    ...(withheld !== undefined ? { withheld } : {}),
  };
}

/** A session-held body for a page row the local mirror does not hold. */
export function useOlderBodyDoor(wire: OlderBodyWire | undefined, mayRead?: () => boolean): OlderBodyDoor {
  const [held, setHeld] = useState<ReadonlyMap<string, SessionBodyHeld<OlderBodyOutcome>>>(() => new Map());
  /**
   * The door instance is the session cache, so it must survive re-renders: `useState`'s lazy
   * initializer runs once for the mount React keeps (StrictMode's discarded twin never receives
   * an `open` — those come from callbacks and effects, which fire only on the kept mount).
   * `setHeld` is identity-stable, so handing it to the door as `onChange` is safe.
   */
  const [door] = useState(() =>
    createSessionBodyDoor<OlderBodyOutcome>({ onChange: setHeld, reopenFailed: false }),
  );
  /** The wire behind a stable identity — `consent-state.ts`'s `link`, for the same reason. */
  const link = useRef<OlderBodyWire | undefined>(wire);
  link.current = wire;
  const owner = useRef(mayRead);
  owner.current = mayRead;

  const open = useCallback(
    (messageId: string, opts: { retry?: boolean } = {}) => {
      const w = link.current;
      if (w === undefined) return;
      door.open(
        messageId,
        async () => {
          if (owner.current?.() === false) throw new Error("The mailbox session has changed");
          const answer = await w.body(messageId);
          if (owner.current?.() === false) throw new Error("The mailbox session has changed");
          return answer;
        },
        opts,
      );
    },
    [door],
  );

  const bodyFor = useCallback(
    (m: { id: string; snippet: string }): MessageBody => {
      if (owner.current?.() === false) return resting(m.snippet, "failed");
      const have = held.get(m.id);
      if (!have) return resting(m.snippet, "snippet");
      if (have.phase === "loading") return resting(m.snippet, "loading");
      if (have.phase === "failed") return resting(m.snippet, "failed");
      const o = have.outcome;
      if (o.kind === "gone") return resting(m.snippet, "withheld", "expunged");
      if (o.withheld !== null) return resting(m.snippet, "withheld", o.withheld);
      return {
        text: o.text,
        state: "full",
        html: o.html,
        loadedRemoteContent: o.loadedRemoteContent,
        unsubscribe: o.unsubscribe,
        unsubscribeUrl: o.unsubscribeUrl,
      };
    },
    [held],
  );

  return { available: wire !== undefined, bodyFor, open };
}
