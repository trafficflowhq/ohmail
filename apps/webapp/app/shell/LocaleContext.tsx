"use client";

/**
 * THE LANGUAGE CONTROL, as a context — the one thing Settings needs and neither host can give it
 * directly.
 *
 * `SettingsView` is shared: the Cloud client renders it and so does the desktop binary, out of the
 * same file, and it may not import `app/api-client` (the publish DENYs it) so it cannot write a
 * preference to an account itself. Every other control in that pane solves this by taking an
 * injected `ReactNode` — `remoteImagesSection`, `awaySection`, `accountSection`. The language row
 * deliberately does NOT, and the reason is that it is the one control both surfaces genuinely have:
 * a standalone install has no account but it still has a language, so a node injected by the Cloud
 * host would leave the desktop with no selector at all.
 *
 * So the ROW is shared and the PERSISTENCE is injected — through this context rather than through a
 * prop, because the provider sits at the root of the tree (it owns which messages are rendered) and
 * the row sits eleven levels down inside a pane. What each host puts in `setLocale`:
 *
 *  · the Cloud client — write the account (`PATCH /consent/settings`), then swap the catalogue;
 *  · the desktop — swap the catalogue, and `localStorage` is the whole of the persistence.
 *
 * Absent provider ⇒ `useAppLocale()` is `null` ⇒ the row is not drawn. That keeps the forty-odd
 * unit tests that render one pane with no provider working unchanged, and it is the honest
 * degradation rather than a selector that cannot select.
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
   * APPLY WITHOUT ASKING THE SERVER — the boot adoption, and a separate verb on purpose.
   *
   * When `GET /consent` lands it carries the account's stored locale, which is the value that WINS
   * over whatever this device had remembered locally (that is the guard: an account preference
   * follows you to a machine you have never signed in on). Adopting it must not travel back out
   * through {@link setLocale}, because on the Cloud client that method's whole job is to WRITE the
   * account — so adoption would PATCH the value it just read, on every tab, on every boot, and a
   * failed write of a value nobody changed would reject into a control nobody touched.
   *
   * So adoption is local-only: remember it on this device, swap the catalogue, and nothing else.
   * `AppShell` is the only caller.
   */
  adoptLocale: (next: AppLocale) => Promise<void>;
  /** A switch is in flight — the selector disables itself rather than queueing two. */
  busy: boolean;
}

export const LocaleContext = createContext<LocaleControls | null>(null);

/** `null` where no host wired a provider — the demo's bare panes, and unit tests. */
export function useAppLocale(): LocaleControls | null {
  return useContext(LocaleContext);
}
