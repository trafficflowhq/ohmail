/**
 * THE ACCOUNT'S PLANS AND PRICES, as the server reads them from its billing program
 * (`GET /account/plans`). Prices are in the currency's minor unit; a price is `null` when the
 * billing program could not confirm it, and a plan without a confirmed price is still listed.
 */

export type PlanName = "solo" | "plus" | "pro";
export type PlanInterval = "month" | "year";

/** One plan: what it holds, and its price for each interval. */
export interface PlanRowWire {
  plan: PlanName;
  mailboxes: number;
  storageBytes: number;
  monthlyCredits: number;
  price: { month: number | null; year: number | null };
}

/** Every plan, the storage add-on, and what this account is on (`null` with no subscription). */
export interface PlansCardWire {
  currency: string;
  plans: PlanRowWire[];
  /** One unit of extra storage, billed monthly; `null` where the billing program offers none. */
  storageAddon: { unitBytes: number; maxUnits: number; price: number | null } | null;
  current: { plan: PlanName; interval: PlanInterval; storageAddonUnits: number } | null;
}

/**
 * `metered: false`: this server runs no billing program, so nothing is for sale here. `card: null`:
 * it does, but the program does not answer this read.
 */
export type AccountPlansAnswer = { metered: false } | { metered: true; card: PlansCardWire | null };
