/** A widget's private route is resolved only after its opaque generation has been verified. */
const EVENT = /^[A-Za-z0-9._:-]{1,128}$/;

/** An opaque generation is the only data exposed to launchers, WidgetKit and the launch URL. */
export const isWidgetGeneration = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

export function widgetGeneration(url: string | null, scheme: string): string | null {
  const prefix = scheme + "://calendar-widget/";
  if (url === null || !url.startsWith(prefix)) return null;
  const generation = url.slice(prefix.length);
  return isWidgetGeneration(generation) ? generation : null;
}

export interface WidgetTarget { readonly event: string; readonly startMs: number }
export function readWidgetTarget(raw: unknown): WidgetTarget | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) ||
      Reflect.ownKeys(raw).length !== 2 || !Object.prototype.hasOwnProperty.call(raw, "event") ||
      !Object.prototype.hasOwnProperty.call(raw, "startMs")) return null;
  const { event, startMs } = raw as Partial<WidgetTarget>;
  return typeof event === "string" && EVENT.test(event) && typeof startMs === "number" &&
    Number.isSafeInteger(startMs) && startMs >= 0 ? { event, startMs } : null;
}

// The router consumes widget launch URLs before they become routes or enter navigation history.
let pendingWidget: string | null = null;
const widgetListeners = new Set<(generation: string) => void>();

export function captureWidgetLink(path: string): boolean {
  if (typeof path !== "string") return false;
  const scheme = ["ohcal", "ohcal-preview"].find((name) => path.startsWith(name + "://calendar-widget/"));
  if (!scheme) return false;
  const generation = widgetGeneration(path, scheme);
  if (generation !== null) {
    if (widgetListeners.size === 0) pendingWidget = generation;
    else for (const listener of widgetListeners) listener(generation);
  }
  return true;
}

export function watchWidgetLinks(listener: (generation: string) => void): () => void {
  widgetListeners.add(listener);
  const prior = pendingWidget;
  pendingWidget = null;
  if (prior !== null) listener(prior);
  return () => { widgetListeners.delete(listener); };
}
