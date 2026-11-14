/** What every step of the join shares: the progress it lists, the sentences under the page's own, Sign out again. */
import type { ReactNode } from "react";
import { Dot } from "@ohmail/ui/base";
import type { Text } from "../../text/index.js";
import type { JoinDoor, JoinState, JoinStation } from "./door.js";

export { refusalOf, SignOutAgain, type Refusal } from "../stage/pending.js";

/** The station the step on screen stands at: the sent mail is the address's station; done is past every one. */
function stationOf(at: JoinState["at"], stations: readonly JoinStation[]): number {
  const shown = at === "sent" && stations.includes("verify") ? "verify" : at;
  return shown === "done" ? stations.length : stations.indexOf(shown as JoinStation);
}

/** Where a station stands: behind, the step on screen, or ahead. */
type Standing = "done" | "now" | "todo";
const DOT: Readonly<Record<Standing, "ink" | "hot" | "ring">> = { done: "ink", now: "hot", todo: "ring" };

/**
 * HOW FAR THE SETUP IS: the stations this path has, as dots in a list the setup names, each said by its name and
 * carrying where it stands (behind, now, ahead), as the card's list did; the one on screen is the current step, and
 * organizing (the first run's, after this page) ends the list.
 */
export function Progress({ door, join }: { door: JoinDoor; join: Text }): ReactNode {
  const { state, stations } = door;
  const now = stationOf(state.at, stations);
  const organized: Standing =
    state.at === "done" && state.mailbox !== null && !state.decisionAhead ? "done" : "todo";
  return (
    <ol className="way-join-progress" aria-label={join("progress")}>
      {stations.map((station, i) => {
        const standing: Standing = i < now ? "done" : i === now ? "now" : "todo";
        return (
          <li key={station} data-state={standing} aria-current={standing === "now" ? "step" : undefined}>
            <Dot kind={DOT[standing]} />
            <span className="way-unseen">{join(`rail_${station}`)}</span>
          </li>
        );
      })}
      <li data-state={organized}>
        <Dot kind={DOT[organized]} />
        <span className="way-unseen">{join("rail_organize")}</span>
      </li>
    </ol>
  );
}

/** What each step hands its part. */
export interface StepProps<S extends JoinState["at"]> {
  readonly door: JoinDoor;
  readonly state: Extract<JoinState, { at: S }>;
  readonly join: Text;
  readonly progress: ReactNode;
}
