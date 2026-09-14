/**
 * THE APPEARANCE THIS PHONE KEEPS — the light/dark preference and the face pin, in ONE record.
 *
 * Both were in memory: a relaunch returned the scheme to Auto and dropped the pin. Persisting
 * one without the other is an incoherence somebody would report, so there is one key and one
 * record and they cannot drift apart. There is no pre-paint stamp to protect on a phone (React
 * Native paints nothing before JS), so the boot read is an ordinary async read.
 *
 * The ORDERING lives here rather than in the provider because this workspace has no React
 * Native renderer: logic inside a component is logic no test can drive. The one rule that has
 * been wrong on every surface once — a boot read that resolves AFTER a press must not publish
 * the pre-press value — is a field on this object and a test below drives it directly.
 */
import type { FaceName } from "../theme/face";
import type { ThemePref } from "./model";
import type { SecureKV } from "./servers";

/** One keystore row, holding both axes. The name is the pair, not either half. */
export const APPEARANCE_KEY = "ohmail.appearance";

/** What that row holds. */
export interface StoredAppearance {
  themePref: ThemePref;
  facePin: FaceName | null;
}

export const DEFAULT_APPEARANCE: StoredAppearance = { themePref: "system", facePin: null };

const isPref = (v: unknown): v is ThemePref => v === "system" || v === "light" || v === "dark";
const isFace = (v: unknown): v is FaceName => v === "paper" || v === "ohmarchy";

/**
 * Read the row, or `null` for anything that is not one. A row whose HALVES are unreadable is
 * still a row — an unknown scheme falls to Auto and an unknown face to "no pin", which is what
 * this phone would have shown anyway; only unparseable text is no row at all.
 */
export function decodeAppearance(raw: string | null): StoredAppearance | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const row = parsed as Record<string, unknown>;
  return {
    themePref: isPref(row.themePref) ? row.themePref : "system",
    facePin: isFace(row.facePin) ? row.facePin : null,
  };
}

export const encodeAppearance = (value: StoredAppearance): string => JSON.stringify(value);

export interface AppearanceStore {
  /** Read the stored row and publish it — unless a press got there first. */
  boot: () => Promise<void>;
  setTheme: (pref: ThemePref) => void;
  setFacePin: (face: FaceName | null) => void;
  /** Stop publishing: a boot read still in flight finishes its keystore work and says nothing. */
  dispose: () => void;
}

/**
 * The store's whole machine. `apply` publishes a record (the provider's two setters);
 * `kv` absent means nothing is persisted and the choice holds for the session — the bare
 * component render a unit test does, named rather than silently failing.
 */
export function appearanceStore(
  kv: SecureKV | undefined,
  apply: (next: StoredAppearance) => void,
): AppearanceStore {
  let live: StoredAppearance = { ...DEFAULT_APPEARANCE };
  let chosen = false;
  let dropped = false;

  /* One writer, both axes, always from the LIVE record — a write of one axis that carried a
     stale copy of the other is how a pair drifts apart. A refused keystore leaves the in-memory
     choice standing: the phone has no notice for this, and a thrown write would take the press
     down with it. */
  const persist = (): void => {
    void kv?.set(APPEARANCE_KEY, encodeAppearance(live)).catch(() => {});
  };
  const publish = (next: StoredAppearance): void => {
    live = next;
    if (!dropped) apply(next);
  };

  return {
    boot: async () => {
      let raw: string | null = null;
      try {
        raw = (await kv?.get(APPEARANCE_KEY)) ?? null;
      } catch {
        raw = null; // an unreadable keystore is "no stored appearance", never a crash at launch
      }
      const stored = decodeAppearance(raw);
      if (stored === null || chosen || dropped) return;
      publish(stored);
    },
    setTheme: (pref) => {
      chosen = true;
      publish({ ...live, themePref: pref });
      persist();
    },
    setFacePin: (face) => {
      chosen = true;
      publish({ ...live, facePin: face });
      persist();
    },
    dispose: () => {
      dropped = true;
    },
  };
}
