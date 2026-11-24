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
import { Component, useState, type MouseEvent, type ReactNode } from "react";
import { Button, EndDot } from "@ohmail/ui/base";
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
  readonly place: Route["place"];
  readonly children: ReactNode;
}
interface BoundaryState {
  readonly kind: string | null;
  readonly at: string;
}

export class PlaceBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { kind: null, at: this.props.at };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { kind: errorKind(error) };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.at === state.at ? null : { kind: null, at: props.at };
  }

  componentDidCatch(error: unknown): void {
    /* The route key and the exception can carry private parts (an Address place names a correspondent):
       the line rides only the place's name and the safe kind, for a log and never for control flow. */
    console.error("[view] render failed", this.props.place, errorKind(error));
  }

  private readonly again = (): void => this.setState({ kind: null });

  render(): ReactNode {
    return this.state.kind === null ? (
      this.props.children
    ) : (
      <PlaceFailed again={this.again} kind={this.state.kind} place={this.props.place} />
    );
  }
}

// Only standard class names are safe to report. An error's name and message can both carry mail content.
function errorKind(error: unknown): string {
  try {
    for (const type of [
      TypeError,
      RangeError,
      SyntaxError,
      ReferenceError,
      URIError,
      EvalError,
      AggregateError,
      Error,
    ]) {
      if (error instanceof type) return type.name;
    }
  } catch {
    // A thrown object may even refuse a prototype lookup.
  }
  return typeof error;
}

function PlaceFailed({
  again,
  kind,
  place,
}: {
  readonly again: () => void;
  readonly kind: string;
  readonly place: Route["place"];
}) {
  const t = useText("viewError");
  const ohbox = useText("ohbox");
  const { commands, host } = useFrame();
  const [copied, setCopied] = useState(false);
  const { version, commit } = host.device.build;
  const details = version
    ? t("detailsWithVersion", { kind, version, build: commit || "dev", place })
    : t("details", { kind, build: commit || "dev", place });
  async function copy(event: MouseEvent<HTMLButtonElement>) {
    try {
      const clipboard = event.currentTarget.ownerDocument.defaultView?.navigator.clipboard;
      if (!clipboard) return;
      await clipboard.writeText(details);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <section className="fr-place-failed" aria-label={t("title")}>
      <div className="fr-place-failed-alert" role="alert">
        <h2 className="oh-text oh-display fr-place-failed-title">
          <EndDot kind="hot">{t("paneTitle")}</EndDot>
        </h2>
        <p className="oh-text fr-place-failed-line">{t("body")}</p>
        <p className="oh-text fr-place-failed-details">
          <code>{details}</code>
        </p>
        <div className="fr-place-failed-actions">
          <Button kind="ink" onPress={again}>
            {t("action")}
          </Button>
          <Button kind="quiet" onPress={(event) => void copy(event)}>
            {t(copied ? "copied" : "copyDetails")}
          </Button>
          <Button
            kind="quiet"
            icon="ohbox"
            onPress={() => {
              again();
              commands.go({ place: "ohbox" });
            }}
          >
            {ohbox("title")}
          </Button>
        </div>
      </div>
    </section>
  );
}
