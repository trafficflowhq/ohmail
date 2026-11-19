/**
 * A PLACE THAT THROWS WHILE IT DRAWS STAYS INSIDE ITS PANE. The frame draws every pane a place hands (its list, its
 * reading column, its wide pane, the kept body) inside one boundary of its own: a throw in a place's render (a windowed
 * list looping to "Maximum update depth exceeded", a stored row missing a field) degrades to a card in that pane, while
 * the rail, the notices and every way out stay. The card says today's crash card's sentences and offers the way to the
 * Ohbox; the throw is reported as today's per-view boundary reported it. A move to another place, or to another part
 * of one, clears a failed pane: the boundary is keyed where its pane is (one mounted instance per body, as the panes
 * are) and cleared when the address's place or part changes, so a healthy pane is never mounted again by a move.
 * A mount never writes a boundary of its own: the frame's is around every pane it draws.
 */
import { Component, type ReactNode } from "react";
import { Empty } from "@ohmail/ui/base";
import { useText } from "../text/index.js";
import { useFrame } from "./commands.js";
import type { Route } from "./contract.js";

/** Where a pane is: the place and its part. A letter alone is no move: a pane that failed over it stays failed. */
export function boundaryAt(route: Pick<Route, "place" | "sub">): string {
  return route.sub === null ? route.place : `${route.place}/${route.sub}`;
}

interface BoundaryProps {
  /** Where the pane is (`boundaryAt`): a change clears a failed pane. */
  readonly at: string;
  readonly children: ReactNode;
}
interface BoundaryState {
  readonly failed: boolean;
  readonly at: string;
}

export class PlaceBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, at: this.props.at };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.at === state.at ? null : { failed: false, at: props.at };
  }

  componentDidCatch(error: unknown): void {
    /* Today's report, word for word: the place and what was caught, for a log line and never for control flow. */
    console.error("[view] render failed", this.props.at, error);
  }

  private readonly again = (): void => this.setState({ failed: false });

  render(): ReactNode {
    return this.state.failed ? <PlaceFailed again={this.again} /> : this.props.children;
  }
}

/** The card in the failed pane: today's sentences, and the way to the Ohbox (at the Ohbox, the same press draws it again). */
function PlaceFailed({ again }: { readonly again: () => void }) {
  const t = useText("viewError");
  const ohbox = useText("ohbox");
  const { commands } = useFrame();
  return (
    <section aria-label={t("title")}>
      <Empty
        label={t("title")}
        act={{
          label: ohbox("title"),
          icon: "ohbox",
          kind: "ink",
          onPress: () => {
            again();
            commands.go({ place: "ohbox" });
          },
        }}
      />
      <p className="oh-text">{t("body")}</p>
    </section>
  );
}
