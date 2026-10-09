import { FAQ_ANSWERS, faqAnswerAnchor } from "./faq-anchors";

/**
 * THE WEBSITE'S EVENTS — every name and parameter the site sends to Google Analytics, in one typed
 * map, and the only `gtag("event", …)` in the app (`test/site-events-census.test.ts`). `send` needs
 * `window.gtag`, which exists only after the visitor accepted, and drops any event whose parameters
 * are not exactly the labels its closed sets allow: no address, no name, nothing typed. Outbound
 * links and scroll depth are Google's own enhanced measurement and are not sent from here.
 */

export const PLANS = ["solo", "plus", "pro", "desktop", "selfhost"] as const;
export const CLOUD_PLANS = ["solo", "plus", "pro"] as const;
export const PATHS = ["cloud", "self-host", "download"] as const;
export const SECTIONS = [
  "hero", "demo", "features", "ai", "compare", "data-ownership", "leave-anytime", "get", "pricing",
  "downloads", "faq",
] as const;
export const PLATFORMS = ["apple", "linux", "windows", "android"] as const;
export const DEMO_ACTIONS = ["start", "expand", "search"] as const;
export const SIGNUP_STEPS = ["email", "tier", "done"] as const;
export const LANGUAGES = ["en", "de"] as const;
export const FAQ_IDS = FAQ_ANSWERS.map(faqAnswerAnchor);

type Of<T extends readonly string[]> = T[number];
export type Plan = Of<typeof PLANS>;
export type Path = Of<typeof PATHS>;
export type Section = Of<typeof SECTIONS>;
export type DemoAction = Of<typeof DEMO_ACTIONS>;
export type SignupStep = Of<typeof SIGNUP_STEPS>;

/** What a press from each `data-ga-lead` placement means: a route choice, a plan card, a Cloud offer. */
type Meaning = { path?: Path; plan?: Plan; cloud?: true };
export const PLACEMENTS = {
  hero: {},
  nav: {},
  trial: {},
  get_desktop: { path: "download" },
  get_shServer: { path: "self-host" },
  get_shHome: { path: "self-host" },
  get_shDesktop: { path: "self-host" },
  get_managed: { path: "cloud", cloud: true },
  pricing_desktop: { path: "download", plan: "desktop" },
  pricing_desktop_notify: { plan: "desktop" },
  pricing_selfhost: { path: "self-host", plan: "selfhost" },
  pricing_solo: { path: "cloud", plan: "solo", cloud: true },
  pricing_plus: { path: "cloud", plan: "plus", cloud: true },
  pricing_pro: { path: "cloud", plan: "pro", cloud: true },
} as const satisfies Record<string, Meaning>;
export type Placement = keyof typeof PLACEMENTS;
const PLACEMENT_IDS = Object.keys(PLACEMENTS) as Placement[];

/** Every event, and for each parameter the closed set its value must come from. */
export const EVENTS = {
  generate_lead: { method: ["signup_cta"], placement: PLACEMENT_IDS },
  select_promotion: { placement: PLACEMENT_IDS },
  select_item: { plan: PLANS },
  begin_checkout: { plan: CLOUD_PLANS },
  sign_up_step: { step: SIGNUP_STEPS },
  sign_up: { method: ["waitlist"] },
  section_view: { section: SECTIONS },
  view_item_list: { list: ["pricing"] },
  faq_open: { question_id: FAQ_IDS },
  choose_path: { path: PATHS },
  demo_interact: { action: DEMO_ACTIONS },
  language_switch: { to: LANGUAGES },
  file_download: { platform: PLATFORMS, transport_type: ["beacon"] },
} as const satisfies Record<string, Record<string, readonly string[]>>;
export type EventName = keyof typeof EVENTS;
type Params<E extends EventName> = { [K in keyof (typeof EVENTS)[E]]: (typeof EVENTS)[E][K] extends readonly (infer V)[] ? V : never };

/** True when `params` has exactly the event's keys, each holding a member of its set. */
export function admissible(name: string, params: Record<string, unknown>): boolean {
  const schema = (EVENTS as Record<string, Record<string, readonly string[]>>)[name];
  if (!schema) return false;
  const keys = Object.keys(params);
  if (keys.length !== Object.keys(schema).length) return false;
  return keys.every((k) => schema[k]?.includes(params[k] as string) === true);
}

/** The one door to Google. Nothing before consent (no `gtag`), nothing that is not a closed label. */
function send<E extends EventName>(name: E, params: Params<E>): boolean {
  if (typeof window === "undefined" || !window.gtag) return false;
  if (!admissible(name, params as Record<string, unknown>)) return false;
  window.gtag("event", name, params);
  return true;
}

/* What this page view has already reported, for the once-per-page-view events. A key is spent only
   by an event that was SENT, so a press before Accept leaves the first one after it reportable. */
let reported = new Set<string>();
function sendOnce<E extends EventName>(key: string, name: E, params: Params<E>): boolean {
  if (reported.has(key) || !send(name, params)) return false;
  reported.add(key);
  return true;
}
/** A new page view: every once-per-view event may fire again. */
export function beginPageView(): void {
  reported = new Set();
}

const isOneOf = <T extends readonly string[]>(set: T, v: string | null | undefined): v is T[number] =>
  v != null && (set as readonly string[]).includes(v);

/** A press anywhere on the website: a CTA by placement, a download by platform, the language link. */
export function reportPress(target: EventTarget | null): void {
  if (!(target instanceof Element)) return;
  const placement = target.closest("[data-ga-lead]")?.getAttribute("data-ga-lead");
  if (isOneOf(PLACEMENT_IDS, placement)) {
    const meaning: Meaning = PLACEMENTS[placement];
    send("generate_lead", { method: "signup_cta", placement });
    if (meaning.cloud) send("select_promotion", { placement });
    if (meaning.plan) send("select_item", { plan: meaning.plan });
    if (meaning.cloud && isOneOf(CLOUD_PLANS, meaning.plan)) send("begin_checkout", { plan: meaning.plan });
    if (meaning.path) sendOnce("path", "choose_path", { path: meaning.path });
    return;
  }
  const platform = target.closest("[data-ga-download]")?.getAttribute("data-ga-download");
  if (isOneOf(PLATFORMS, platform)) {
    send("file_download", { platform, transport_type: "beacon" });
    sendOnce("path", "choose_path", { path: "download" });
    return;
  }
  const to = target.closest("a[hreflang]")?.getAttribute("hreflang");
  if (isOneOf(LANGUAGES, to)) send("language_switch", { to });
}

/** A `<details>` in the FAQ opened: reported by its answer's anchor id, once per question per view. */
export function reportToggle(target: EventTarget | null): void {
  if (!(target instanceof HTMLDetailsElement) || !target.open) return;
  const id = target.querySelector("[id]")?.id;
  if (isOneOf(FAQ_IDS, id)) sendOnce(`faq:${id}`, "faq_open", { question_id: id });
}

/** The live demo, by action, the first time per page view. */
export function reportDemo(action: DemoAction): void {
  sendOnce(`demo:${action}`, "demo_interact", { action });
}

/** Is this key press inside the demo a search? The palette's shortcut, which the hint row names. */
export function isDemoSearchKey(e: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
}

/** A field in the demo that searches: the palette's, or a search box. Duck-typed: another realm. */
export function isDemoSearchField(target: EventTarget | null): boolean {
  const el = target as { closest?: (s: string) => unknown; type?: unknown } | null;
  if (!el || typeof el.closest !== "function") return false;
  return el.type === "search" || el.closest(".palette, [role='search']") != null;
}

/** The website's sign-up dialog, step by step; `done` is the sign-up the website itself completes. */
export function reportSignupStep(step: SignupStep): void {
  send("sign_up_step", { step });
  if (step === "done") send("sign_up", { method: "waitlist" });
}

/**
 * SEEN: half of the section is on screen, or the section fills half the screen — a section taller
 * than two screens can never be half visible, and it is the one most read.
 */
export function sectionSeen(entry: {
  intersectionRatio: number;
  intersectionRect: { height: number };
  rootBounds: { height: number } | null;
}): boolean {
  if (entry.intersectionRatio >= 0.5) return true;
  const screen = entry.rootBounds?.height ?? 0;
  return screen > 0 && entry.intersectionRect.height >= screen / 2;
}

export const SECTION_DWELL_MS = 1000;
const THRESHOLDS = Array.from({ length: 21 }, (_, i) => i / 20);

/**
 * Watches every `[data-ga-section]` under `root`: a section seen for SECTION_DWELL_MS without
 * leaving reports `section_view` once per page view, and pricing also `view_item_list`.
 */
export function observeSections(root: ParentNode): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  const timers = new Map<Element, number>();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const el = entry.target;
      const section = el.getAttribute("data-ga-section");
      if (!isOneOf(SECTIONS, section)) continue;
      if (!sectionSeen(entry)) {
        window.clearTimeout(timers.get(el));
        timers.delete(el);
        continue;
      }
      if (timers.has(el)) continue;
      timers.set(el, window.setTimeout(() => {
        timers.delete(el);
        observer.unobserve(el);
        if (!sendOnce(`section:${section}`, "section_view", { section })) return;
        if (section === "pricing") send("view_item_list", { list: "pricing" });
      }, SECTION_DWELL_MS));
    }
  }, { threshold: THRESHOLDS });
  root.querySelectorAll("[data-ga-section]").forEach((el) => observer.observe(el));
  return () => {
    observer.disconnect();
    timers.forEach((t) => window.clearTimeout(t));
    timers.clear();
  };
}
