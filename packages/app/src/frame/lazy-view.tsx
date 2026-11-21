"use client";

import {
  Component,
  Suspense,
  createContext,
  lazy,
  useContext,
  type ComponentProps,
  type ComponentType,
  type LazyExoticComponent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Button } from "@ohmail/ui/base";
import { useText } from "../text/index.js";

/**
 * THE ONE DOOR TO A CODE-SPLIT VIEW. `React.lazy` keeps a rejected import for the life of the
 * page, so one failed chunk fetch made every later open of that view throw the same failure
 * until a reload. Here the failure renders a sentence with a Try again press rather than the
 * view's crash card, and the door is replaced once that sentence is on screen, so Try again and
 * the next open both ask again. Not sooner: a render landing between the rejection and the
 * catch would read the new door and fetch again before anyone saw the failure. A chunk the server
 * no longer has (the tab outlived an update) says so and offers Reload instead.
 * Every `lazy()` in the app goes through this (`test/lazy-view-retries.test.tsx` holds the census).
 */
// Typed over the component, as `React.lazy` is: inferring props through `ComponentType`'s union fails.
export function lazyView<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
  frame: {
    /** Painted while the chunk is in flight; nothing by default. */
    loading?: (props: ComponentProps<T>) => ReactNode;
    failed?: (retry: () => void, props: ComponentProps<T>) => ReactNode;
  } = {},
): ComponentType<ComponentProps<T>> {
  const failed = frame.failed ?? ((retry: () => void) => <LoadFailedPane onRetry={retry} />);
  const open = (remedy: ChunkLoadRemedy | null): Door<T> => {
    const door: Door<T> = {
      failed: false,
      View: lazy(() =>
        load().catch(async (cause: unknown) => {
          const updated = (await remedy?.replaced(cause)) ?? false;
          door.failed = true;
          // Nobody is waiting on this door (the view closed first), so no render will surface the
          // failure: the next open asks again. A waiting boundary is mounted — the Suspense is inside it.
          if (mounted === 0 && current === door) current = null;
          throw new ViewLoadFailed(cause, updated);
        }),
      ),
    };
    return door;
  };
  let current: Door<T> | null = null;
  let mounted = 0;
  const renew = (): void => {
    if (current?.failed) current = null;
  };
  function LazyView(props: ComponentProps<T>): ReactElement {
    const remedy = useContext(ChunkLoadContext);
    /* `current` is read inside the boundary's render, so a retry renders the replacement. The
       Suspense sits INSIDE the boundary: a retry that suspended at one above it was never
       committed, and the failure after it went past this boundary to the view's crash card. */
    return (
      <LoadBoundary
        failed={(retry) => failed(retry, props)}
        shown={renew}
        present={(delta) => {
          mounted += delta;
        }}
        render={() => {
          current ??= open(remedy);
          const Door = current.View;
          return (
            <Suspense fallback={frame.loading?.(props) ?? null}>
              <Door {...props} />
            </Suspense>
          );
        }}
      />
    );
  }
  return LazyView;
}

type Door<T extends ComponentType<any>> = { failed: boolean; View: LazyExoticComponent<T> };

/** A failed import, told apart from a render throw: only this one is the boundary's to answer. */
export class ViewLoadFailed extends Error {
  /** `updated`: the server no longer has this tab's build, so only a reload helps. */
  constructor(
    readonly reason: unknown,
    readonly updated = false,
  ) {
    super("the view's code did not load");
    this.name = "ViewLoadFailed";
  }
}

type BoundaryProps = {
  render: () => ReactNode;
  failed: (retry: () => void) => ReactNode;
  /** Told once the failure is on screen, which is when the door may be replaced. */
  shown: () => void;
  present: (delta: 1 | -1) => void;
};

/* A render throw that is not a load failure is thrown on, to the view boundary above and its
   crash card; this boundary answers only the fetch it can retry. */
class LoadBoundary extends Component<BoundaryProps, { caught: { error: unknown } | null }> {
  state: { caught: { error: unknown } | null } = { caught: null };

  static getDerivedStateFromError(error: unknown): { caught: { error: unknown } } {
    return { caught: { error } };
  }

  componentDidMount(): void {
    this.props.present(1);
  }
  componentWillUnmount(): void {
    this.props.present(-1);
  }

  componentDidCatch(error: unknown): void {
    if (!(error instanceof ViewLoadFailed)) return;
    console.error("[view] code did not load");
    this.props.shown();
  }

  render(): ReactNode {
    const { caught } = this.state;
    if (caught == null) return this.props.render();
    if (!(caught.error instanceof ViewLoadFailed)) throw caught.error;
    return (
      <BuildReplaced.Provider value={caught.error.updated}>
        {this.props.failed(() => this.setState({ caught: null }))}
      </BuildReplaced.Provider>
    );
  }
}

export interface ChunkLoadRemedy {
  replaced(cause: unknown): Promise<boolean>;
  reload(): void;
}

export const ChunkLoadContext = createContext<ChunkLoadRemedy | null>(null);

const BuildReplaced = createContext(false);

/** The sentence and the press, for any frame a caller puts them in. */
export function LoadFailed({ onRetry }: { onRetry: () => void }): ReactElement {
  const t = useText("viewError");
  const remedy = useContext(ChunkLoadContext);
  if (useContext(BuildReplaced) && remedy !== null) {
    return (
      <div className="view-fail-card" role="alert">
        <p>{t("updated")}</p>
        <Button onPress={() => remedy.reload()}>{t("action")}</Button>
      </div>
    );
  }
  return (
    <div className="view-fail-card" role="alert">
      <p>{t("loadFailed")}</p>
      <Button onPress={onRetry}>{t("tryAgain")}</Button>
    </div>
  );
}

function LoadFailedPane({ onRetry }: { onRetry: () => void }): ReactElement {
  return (
    <section className="view view-fail">
      <LoadFailed onRetry={onRetry} />
    </section>
  );
}
