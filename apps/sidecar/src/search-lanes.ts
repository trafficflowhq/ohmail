import { ServiceError, type SearchSupersede } from "@trafficflow/services/mail";

/**
 * THE WINDOW'S SEARCH LANES — a newer question from the same walker supersedes its older requests.
 *
 * The window names each `GET /search` with `x-ohmail-search-lane: <lane>.<generation>`: the lane is
 * one walker (a random id), the generation its question counter, which only grows. The store has one
 * connection and nothing can cancel a running statement, so a superseded request is stopped at the
 * service's next check point (`SearchSupersede`) and answers `409 search_superseded`. No query text
 * reaches the header, this registry or a log. The local door only: a paired device's doors are not
 * wired, so it cannot supersede the window's searches.
 */
export const SEARCH_LANE_HEADER = "x-ohmail-search-lane";
/** Lanes kept, the least recently used dropped first. */
export const SEARCH_LANES_KEPT = 64;

const LANE = /^([a-z0-9]{1,32})\.(\d{1,15})$/;

interface Pending { generation: number; superseded: boolean }
interface Lane { latest: number; pending: Set<Pending> }

export interface SearchLaneTicket {
  supersede: SearchSupersede;
  /** The request answered: its entry goes. */
  done(): void;
}

export interface SearchLanes {
  /** A GET /search with a well-formed lane header joins its lane; anything else is `null`, never refused. */
  admit(req: Request): SearchLaneTicket | null;
  census(): { lanes: number; pending: number };
}

const superseded = (): ServiceError =>
  new ServiceError("search_superseded", 409, "a newer search from this window replaced this one");

export function createSearchLanes(kept = SEARCH_LANES_KEPT): SearchLanes {
  const lanes = new Map<string, Lane>();
  return {
    admit(req) {
      if (req.method !== "GET" || new URL(req.url).pathname !== "/search") return null;
      const m = LANE.exec(req.headers.get(SEARCH_LANE_HEADER) ?? "");
      if (m === null) return null;
      const id = m[1]!;
      const generation = Number(m[2]);
      const lane = lanes.get(id) ?? { latest: -1, pending: new Set<Pending>() };
      lanes.delete(id);
      lanes.set(id, lane);
      for (const old of lanes.keys()) {
        if (lanes.size <= kept) break;
        lanes.delete(old);
      }
      // An older generation is stale on arrival; a newer one marks every older request still pending.
      const entry: Pending = { generation, superseded: generation < lane.latest };
      if (generation > lane.latest) {
        for (const p of lane.pending) if (p.generation < generation) p.superseded = true;
        lane.latest = generation;
      }
      lane.pending.add(entry);
      const check = (): void => { if (entry.superseded) throw superseded(); };
      return {
        supersede: {
          check,
          // Two immediates: the first runs before the loop's next read, the second after it, so a
          // request that arrived during the last statement is admitted before the check.
          turn: () => new Promise<void>((resolve, reject) => {
            setImmediate(() => setImmediate(() => { try { check(); resolve(); } catch (err) { reject(err); } }));
          }),
        },
        done: () => { lane.pending.delete(entry); },
      };
    },
    census() {
      let pending = 0;
      for (const l of lanes.values()) pending += l.pending.size;
      return { lanes: lanes.size, pending };
    },
  };
}
