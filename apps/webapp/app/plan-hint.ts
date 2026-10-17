import { localStorageDoor } from "@ohmail/client-engine/durable";

/**
 * THE PLAN THE SITE'S TIER BUTTONS CARRY (`/join?plan=pro&interval=year`), read from closed sets and
 * kept through the signup's mail round trip: the verification link opens `/verify-email` and then
 * `/join` without the query, in the same browser. It is a hint for the plan page's preselection and
 * never a price; the API and the plan page check it again against the same sets (`planHintOf` in
 * `packages/db`, which `plan-hint.test.ts` holds this copy equal to).
 */
export const PLAN_HINT_PLANS = ["solo", "plus", "pro"] as const;
export const PLAN_HINT_INTERVALS = ["month", "year"] as const;
export interface PlanHint {
  plan?: (typeof PLAN_HINT_PLANS)[number];
  interval?: (typeof PLAN_HINT_INTERVALS)[number];
}

/** The display name of each plan: names, the same in every language. */
export const PLAN_NAMES: Readonly<Record<NonNullable<PlanHint["plan"]>, string>> = { solo: "Solo", plus: "Plus", pro: "Pro" };

/** Each half kept only when it is a member of its closed set; an array's first value, as the page reads `?code`. */
export function planHintOf(plan: unknown, interval: unknown): PlanHint {
  const p = Array.isArray(plan) ? plan[0] : plan;
  const i = Array.isArray(interval) ? interval[0] : interval;
  return {
    ...((PLAN_HINT_PLANS as readonly unknown[]).includes(p) ? { plan: p as PlanHint["plan"] } : {}),
    ...((PLAN_HINT_INTERVALS as readonly unknown[]).includes(i) ? { interval: i as PlanHint["interval"] } : {}),
  };
}

const KEY = "ohmail.signup.plan";
/** A week: long enough for a verification mail read tomorrow, short enough not to follow a person into another signup. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const door = localStorageDoor("signup.plan");

export function rememberPlanHint(hint: PlanHint, now = Date.now()): void {
  if (!hint.plan && !hint.interval) return;
  door.set(KEY, JSON.stringify({ plan: hint.plan, interval: hint.interval, at: now }));
}

/** The hint this browser kept, or none: unreadable, too old, from the future, or never kept. */
export function recalledPlanHint(now = Date.now()): PlanHint {
  const raw = door.get(KEY);
  if (raw === null) return {};
  try {
    const kept = JSON.parse(raw) as { plan?: unknown; interval?: unknown; at?: unknown };
    if (typeof kept.at !== "number" || kept.at > now || now - kept.at > KEEP_MS) return {};
    return planHintOf(kept.plan, kept.interval);
  } catch {
    return {};
  }
}

/** Once the trial has started the hint has done its job; a later visit must not carry it. */
export function forgetPlanHint(): void {
  door.remove(KEY);
}
