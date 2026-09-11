"use client";

/**
 * The language control, as a context — the one thing Settings needs that neither host can give it directly.
 * `SettingsView` is shared and may not import `app/api-client` (the publish denies it); every other control there
 * takes an injected `ReactNode`, but the language row is the one control both surfaces genuinely have — a standalone
 * install has no account but still has a language, so a Cloud-injected node would leave the desktop with no selector.
 * So the ROW is shared and the PERSISTENCE is injected — a context, not a prop, because the provider sits at the root
 * and the row eleven levels down. Cloud: write the account (`PATCH /consent/settings`), then swap the catalogue;
 * desktop: swap the catalogue, `localStorage` is the whole persistence. Absent provider ⇒ `useAppLocale()` is `null`
 * ⇒ the row is not drawn — the honest degradation, and forty-odd provider-less unit tests keep working.
 */

import { createContext, useContext } from "react";
import type { AppLocale } from "./locale";

export interface LocaleControls {
  /** The locale being rendered right now — what the selector shows as chosen. */
  locale: AppLocale;
  /** The offered set, in the order the selector draws them. */
  locales: readonly AppLocale[];
  /**
   * Switch. Resolves when the new catalogue is rendering; REJECTS when the account write failed,
   * in which case the locale has NOT changed — the same "resolve to what the database holds"
   * contract `useConsentState`'s setters keep, and for the same reason: a control that silently
   * did nothing is the failure a user cannot report.
   */
  setLocale: (next: AppLocale) => Promise<void>;
  /**
   * Apply without asking the server — the boot adoption, a separate verb on purpose. When
   * `GET /consent` lands it carries the account's stored locale, which WINS over what this device
   * remembered (an account preference follows you to a machine you have never signed in on).
   * Adopting it must not travel back through {@link setLocale}: on the Cloud client that method's
   * job is to WRITE the account, so adoption would PATCH the value it just read, on every tab, on
   * every boot — and a failed write of a value nobody changed would reject into a control nobody
   * touched. Adoption is local-only: remember on this device, swap the catalogue, nothing else.
   * `AppShell` is the only caller.
   */
  adoptLocale: (next: AppLocale) => Promise<void>;
  /** A switch is in flight — the selector disables itself rather than queueing two. */
  busy: boolean;
  /**
   * How far the choice reaches, because the row says so and the two hosts differ. `account` — the
   * preference is written to the account and follows the person to every browser ("Applies to this
   * app everywhere you sign in"). `install` — `localStorage` IS the persistence: that is the
   * desktop on BOTH its doors — the Cloud adapter is aliased out of the bundle and `apiConfigured()`
   * is false, so even an install pointed at a hosted account writes the language nowhere but here;
   * the account-wide sentence was rendered there anyway, and it was false. REQUIRED rather than
   * defaulted: a default would have to be `account`, the claim that is wrong on the surface most
   * likely to be added next, and an absent field would select it silently.
   */
  scope: "account" | "install";
}

export const LocaleContext = createContext<LocaleControls | null>(null);

/** `null` where no host wired a provider — the demo's bare panes, and unit tests. */
export function useAppLocale(): LocaleControls | null {
  return useContext(LocaleContext);
}
