/**
 * Theme management, matching the prototype's contract exactly:
 * - explicit preference is stamped as `data-theme` on <html>;
 * - "system" removes the attribute so the tokens.css
 *   prefers-color-scheme fallback takes over;
 * - toggle() flips the *effective* theme (system+dark → explicit light).
 *
 * SSR-safe by construction: the first client render is deterministic and
 * byte-identical to the server render (defaultPreference + "light" system
 * fallback — no localStorage or matchMedia reads during render). The
 * persisted preference and the real OS theme are adopted in a post-mount
 * effect. To avoid a pre-hydration flash, inline `themeInitScript()`
 * before your app markup: it stamps the persisted `data-theme` before
 * first paint, and the provider leaves that stamp untouched until it has
 * adopted the same stored value.
 *
 * ── THE FACE — paper / ohmarchy (OHMARCHY-PLAN.md §3a) ──────────────────────────────────
 *
 * A SECOND appearance dimension, orthogonal to light/dark: `data-face="ohmarchy"` on
 * <html>, absent = paper. Absence-as-paper is what keeps the paper face byte-identical by
 * construction — no selector in tokens.css changes meaning, and ohmarchy.css only ever
 * matches the stamped state.
 *
 * Three inputs resolve to the effective face, in this order:
 *
 *   1. `facePreference` — this DEVICE's explicit choice ("only this device"), persisted
 *      under `ohmail.face`. It outranks the account on this device because that is what
 *      the scope option promised when it was chosen.
 *   2. `accountFace` — the account-level synced choice, adopted from `GET /consent` by the
 *      host (never fetched here; this package has no wire). Adoption also mirrors it to
 *      `ohmail.face.account` so the NEXT boot's init script stamps it pre-paint — the same
 *      device-caches-the-account's-last-answer move as the shell's boot cache.
 *   3. Detection: a LINUX device with neither defaults to ohmarchy, for that device only
 *      — the wedge this face exists for. Honest limit: a browser reveals "Linux", not
 *      "Omarchy" — this is a deliberate wedge bet on Linux visitors broadly. Android and
 *      ChromeOS also announce Linux and are excluded; an explicit prior choice at either
 *      scope always wins over detection because it sits higher in this list.
 *
 * The ACCOUNT write does not live here: packages/ui has no API client. The host writes
 * `PATCH /consent/settings` through its own transport and then calls `adoptAccountFace`
 * with the echo — the same echo-not-the-argument rule every consent knob keeps.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** Did the value reach the jar — the answer `@ohmail/client-engine`'s door already returns. */
export type StorageVerdict = "stored" | "lost";

/**
 * THE STORAGE DOOR — A SHAPE THIS PACKAGE DECLARES AND DELIBERATELY DOES NOT IMPLEMENT.
 *
 * The provider used to write `localStorage` itself, inside a swallowing `try`: a private window
 * turned "your theme is remembered" into a lie with nothing anywhere saying so. The door that
 * answers lives in `@ohmail/client-engine`, and this package may not import it — a UI package
 * that reaches into the client engine points the dependency graph upward and would drag the
 * engine into every host that mounts a button. So the direction is inverted: the host hands the
 * door in, and this file imports nothing.
 *
 * THERE IS NO `null` DOOR. Absence is the only way to say "this host wired none", so "not
 * supplied" and "supplied as nothing" cannot be confused — see {@link ThemePersistence}.
 */
export interface StorageDoor {
  get(key: string): string | null;
  set(key: string, value: string): StorageVerdict;
  remove(key: string): StorageVerdict;
}

/**
 * WHERE THIS PROVIDER IS KEEPING THE APPEARANCE, as a state a host and a test can READ.
 *
 * `unpersisted` is a first-class answer, not a fallback: with no door (or with `storageKey`
 * null, the explicit opt-out the showcases use) the choice holds for the session and NOTHING is
 * written — never a silent direct write behind the door's back. Two causes reach one state
 * because nothing downstream cares which: either way a reload starts from the default.
 */
export type ThemePersistence = "door" | "unpersisted";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
/** The appearance face — `paper` is today's look, `ohmarchy` the tiling one. */
export type FaceName = "paper" | "ohmarchy";
/** The layout arrangement — `classic` is today's, `zero` the tiling one (3b builds it). */
export type LayoutName = "classic" | "zero";

export interface ThemeContextValue {
  /** The stored preference (may be "system"). */
  preference: ThemePreference;
  /** What is actually rendered right now. */
  resolved: ResolvedTheme;
  setTheme: (preference: ThemePreference) => void;
  /** Flip the effective theme, like the rail's sun row. */
  toggle: () => void;
  /** The face actually rendered right now (preference ?? account ?? detection). */
  face: FaceName;
  /** This device's explicit face choice, or null when it never made one. */
  facePreference: FaceName | null;
  /** The account-level synced face as last adopted, or null for "no account choice". */
  accountFace: FaceName | null;
  /**
   * Post-mount Linux-desktop detection (false during SSR and the first client render).
   * Exposed so a host can decide whether the Option B offer is owed.
   */
  linuxDevice: boolean;
  /** "Only this device": set (or clear, with null) this device's explicit face. */
  setFace: (face: FaceName | null) => void;
  /**
   * The layout arrangement (OHMARCHY-CONTRACT.md). Always concrete; absent attribute reads
   * as "classic". The zero layout itself is 3b's work — the machinery exists first so no
   * second provider ever needs to race the attribute.
   */
  layout: LayoutName;
  setLayout: (layout: LayoutName | null) => void;
  /**
   * Teaching intensity, the contract's one JS-visible switch: 0 (paper, calm) / 1 (ohmarchy,
   * loud). Derived from the face — CSS reads the same fact as `--teach`.
   */
  teach: 0 | 1;
  /**
   * Adopt what the account said (from the host's `GET /consent` read or a settings write's
   * echo) — NEVER a write to the account. Mirrors to storage for the next boot's pre-paint
   * stamp. Null means "the account has no preference" and clears the mirror.
   */
  adoptAccountFace: (face: FaceName | null) => void;
  /**
   * Where this provider is keeping the appearance — `unpersisted` when the host wired no
   * {@link StorageDoor} (or turned `storageKey` off), and then nothing is written at all. A state
   * a host can render and a test can read, rather than a silence to be inferred.
   */
  persistence: ThemePersistence;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isPreference(v: unknown): v is ThemePreference {
  return v === "light" || v === "dark" || v === "system";
}

function isFace(v: unknown): v is FaceName {
  return v === "paper" || v === "ohmarchy";
}

function isLayout(v: unknown): v is LayoutName {
  return v === "classic" || v === "zero";
}

/**
 * "A Linux desktop, as far as a browser can tell" — the Option B detection, shared by the
 * provider and (re-encoded, kept in sync by ui's own face test) the init script.
 *
 * `navigator.platform` still carries "Linux x86_64" on every Linux desktop browser and is
 * the narrowest signal available; Android and ChromeOS both ALSO report Linux platforms, so
 * their UA markers subtract. This cannot see Omarchy, only Linux — OHMARCHY-PLAN.md §5
 * names that limit and takes the bet; the guardrails are that the default is device-only,
 * one tap flips it back, and an explicit choice always outranks it.
 */
export function linuxDesktopDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform ?? "";
  const ua = navigator.userAgent ?? "";
  return /Linux/.test(platform) && !/Android|CrOS/.test(ua);
}

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStored(door: StorageDoor, storageKey: string): ThemePreference | null {
  const stored = door.get(storageKey);
  return isPreference(stored) ? stored : null;
}

/**
 * A tiny inline script that stamps the persisted theme on <html> before
 * first paint (same contract as the provider: absent attribute = follow
 * the system, which tokens.css resolves via prefers-color-scheme).
 * Render it as the first child of <body> (or in <head>):
 *
 *   <script dangerouslySetInnerHTML={{ __html: themeInitScript() }} />
 */
export function themeInitScript(
  storageKey = "ohmail.theme",
  opts: {
    /**
     * Stamp the FACE and LAYOUT axes too. OPT-IN, and false is the safe default on purpose
     * (review-caught): every host mounts this provider — the landing, the admin console —
     * but only hosts that wired the face CONTROLS may activate the face, or a Linux visitor
     * gets an ohmarchy landing with no way back. The product door passes true.
     */
    faces?: boolean;
    faceStorageKey?: string;
    accountFaceStorageKey?: string;
    layoutStorageKey?: string;
  } = {},
): string {
  const key = JSON.stringify(storageKey);
  const themeHalf =
    `(function(){try{var t=localStorage.getItem(${key});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
  if (!opts.faces) return themeHalf + `})()`;
  const faceKey = JSON.stringify(opts.faceStorageKey ?? "ohmail.face");
  const accountKey = JSON.stringify(opts.accountFaceStorageKey ?? "ohmail.face.account");
  const layoutKey = JSON.stringify(opts.layoutStorageKey ?? "ohmail.layout");
  /* The face half re-encodes the provider's resolution order verbatim: device pin, account
     mirror, Linux-desktop detection (see linuxDesktopDevice — the regexes here must match
     it), paper. Only the "ohmarchy" outcome stamps; paper is absence. EACH STORAGE READ SITS
     IN ITS OWN try (review-caught): a blocked jar must fall through to the detection, not
     skip it — otherwise a sandboxed context flashes paper and re-skins after hydration. */
  return (
    themeHalf +
    `var f=null;try{f=localStorage.getItem(${faceKey})}catch(e){}` +
    `if(f!=="paper"&&f!=="ohmarchy"){try{f=localStorage.getItem(${accountKey})}catch(e){}}` +
    `if(f!=="paper"&&f!=="ohmarchy")f=(/Linux/.test(navigator.platform||"")&&!/Android|CrOS/.test(navigator.userAgent||""))?"ohmarchy":"paper";` +
    `if(f==="ohmarchy")try{document.documentElement.dataset.face="ohmarchy"}catch(e){}` +
    `var l=null;try{l=localStorage.getItem(${layoutKey})}catch(e){}` +
    `if(l==="zero")try{document.documentElement.dataset.layout="zero"}catch(e){}})()`
  );
}

export interface ThemeProviderProps {
  children: ReactNode;
  /** Initial preference; defaults to following the system. */
  defaultPreference?: ThemePreference;
  /**
   * The key the preference is kept under, through {@link ThemeProviderProps.storage}. `null`
   * turns persistence off for ALL FOUR keys — the host's explicit opt-out, and the same named
   * state as passing no door ({@link ThemePersistence}).
   */
  storageKey?: string | null;
  /** Device-pin key for the face; `storageKey === null` turns it off with the rest. */
  faceStorageKey?: string;
  /** Account-mirror key for the face (what the init script reads on the next boot). */
  accountFaceStorageKey?: string;
  /** Device key for the layout; `storageKey === null` turns it off with the rest. */
  layoutStorageKey?: string;
  /**
   * Activate the FACE and LAYOUT axes on this host. OPT-IN, default false (review-caught):
   * the provider is mounted by every surface — landing, admin — but only a host whose UI
   * wired the face controls may detect/stamp it, or a Linux visitor's landing flips to a
   * half-skinned ohmarchy with no control anywhere to flip back. With false the provider is
   * exactly the pre-face provider: face reads "paper", teach 0, nothing stamped, storage
   * untouched.
   */
  faces?: boolean;
  /**
   * THE DOOR EVERY WRITE GOES THROUGH, handed in by the host — see {@link StorageDoor}.
   *
   * Omit it and this provider persists nothing ({@link ThemePersistence} `unpersisted`): the
   * choice holds for the session, no jar is touched, and the host has not accidentally promised
   * a memory. There is no `null` door, so "no host wired one" cannot be confused with "one was
   * supplied and is empty".
   *
   * Hoist it out of the render — `const DOOR = localStorageDoor("theme")` at module scope. A door
   * built inline is a new object every render; the provider reads it through a ref so that costs
   * nothing, but the intent is one door per host, not one per frame.
   */
  storage?: StorageDoor;
}

/** The door that writes nothing, for a host that wired none. Reads answer "no stored value". */
const NO_DOOR: StorageDoor = {
  get: () => null,
  set: () => "lost",
  remove: () => "lost",
};

export function ThemeProvider({
  children,
  defaultPreference = "system",
  storageKey = "ohmail.theme",
  faceStorageKey = "ohmail.face",
  accountFaceStorageKey = "ohmail.face.account",
  layoutStorageKey = "ohmail.layout",
  faces = false,
  storage,
}: ThemeProviderProps) {
  /**
   * PERSISTENCE IS DECIDED ONCE, HERE. `storage` absent = the host wired no door;
   * `storageKey === null` = the host turned persistence off (showcases, tests). Two causes, one
   * state, because nothing below cares which: either way no jar is touched and a reload starts
   * from the default.
   */
  const persistence: ThemePersistence =
    storage !== undefined && storageKey !== null ? "door" : "unpersisted";
  /**
   * THE ONE GATE. Every read and every write below goes through this ref and nothing else checks
   * `storageKey === null` again — six such checks stood beside it, and a second mechanism covering
   * the first is a pair of guards neither of which can be watched fail (measured: mutating this
   * line left every case green).
   *
   * A ref rather than a dependency because a door is a CAPABILITY, not data: which door a mounted
   * provider uses cannot change under it, and this keeps every effect's dependency list exactly
   * what it was before the door existed.
   */
  const doorRef = useRef<StorageDoor>(NO_DOOR);
  doorRef.current = persistence === "door" && storage ? storage : NO_DOOR;
  // null = not yet hydrated: render with the deterministic default and do
  // NOT touch <html> — the themeInitScript stamp stays in charge until the
  // stored preference has been adopted post-mount.
  const [stored, setStored] = useState<ThemePreference | null>(null);
  const [system, setSystem] = useState<ResolvedTheme>("light");
  // undefined = not yet hydrated (the same contract as `stored === null` above; the face
  // needs a third state because null is meaningful — "adopted, and no pin exists").
  const [devicePin, setDevicePin] = useState<FaceName | null | undefined>(undefined);
  const [accountFace, setAccountFaceState] = useState<FaceName | null>(null);
  const [linux, setLinux] = useState(false);
  // undefined = not yet hydrated, devicePin's contract; null = adopted, no stored layout.
  const [layoutPin, setLayoutPin] = useState<LayoutName | null | undefined>(undefined);

  const preference: ThemePreference = stored ?? defaultPreference;

  // Post-mount adoption: persisted preference + the real OS theme.
  // Declared first so the stamp effect below runs with the adopted value.
  useEffect(() => {
    setStored((current) => {
      if (current !== null) return current; // a click beat us to it — user wins
      return (storageKey ? readStored(doorRef.current, storageKey) : null) ?? defaultPreference;
    });
    setSystem(systemTheme());
  }, [storageKey, defaultPreference]);

  // Post-mount face adoption: the device pin, the account mirror (the previous session's
  // adopted answer — the live one arrives via adoptAccountFace when the host's consent
  // read lands), and the Linux detection. SSR and the first client render stay "paper".
  useEffect(() => {
    if (!faces) return; // the axis is not active on this host — leave storage and state alone
    setDevicePin((current) => {
      if (current !== undefined) return current; // a click beat us to it — user wins
      const raw = doorRef.current.get(faceStorageKey);
      return isFace(raw) ? raw : null;
    });
    setAccountFaceState((current) => {
      if (current !== null) return current; // a live adoption beat the mirror — it wins
      const raw = doorRef.current.get(accountFaceStorageKey);
      return isFace(raw) ? raw : null;
    });
    setLayoutPin((current) => {
      if (current !== undefined) return current; // a click beat us to it — user wins
      const raw = doorRef.current.get(layoutStorageKey);
      return isLayout(raw) ? raw : null;
    });
    setLinux(linuxDesktopDevice());
  }, [faces, storageKey, faceStorageKey, accountFaceStorageKey, layoutStorageKey]);

  // Stamp <html data-theme> exactly like the prototype: absent = system.
  // Skipped until adoption so hydration never clobbers the pre-paint stamp.
  useEffect(() => {
    if (stored === null) return;
    const root = document.documentElement;
    if (stored === "system") delete root.dataset.theme;
    else root.dataset.theme = stored;
    // The door answers "lost" for a blocked jar and raises the host's own notice; the in-memory
    // preference still applies, which is what makes the degradation honest rather than silent.
    if (storageKey) doorRef.current.set(storageKey, stored);
  }, [stored, storageKey]);

  // Track the OS preference while in system mode.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(mq.matches ? "dark" : "light");
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const resolved: ResolvedTheme = preference === "system" ? system : preference;
  const face: FaceName =
    devicePin ?? accountFace ?? (linux ? "ohmarchy" : "paper");
  const layout: LayoutName = layoutPin ?? "classic";
  const teach: 0 | 1 = face === "ohmarchy" ? 1 : 0;

  // Stamp <html data-face> — absent = paper. Skipped until adoption, so the init script's
  // pre-paint stamp is never clobbered by a hydrating render that has not read storage yet.
  useEffect(() => {
    if (!faces || devicePin === undefined) return;
    const root = document.documentElement;
    if (face === "ohmarchy") root.dataset.face = "ohmarchy";
    else delete root.dataset.face;
  }, [faces, devicePin, face]);

  // Stamp <html data-layout> — absent = classic, the same skip-until-adoption contract.
  useEffect(() => {
    if (!faces || layoutPin === undefined) return;
    const root = document.documentElement;
    if (layout === "zero") root.dataset.layout = "zero";
    else delete root.dataset.layout;
  }, [faces, layoutPin, layout]);

  const setTheme = useCallback((p: ThemePreference) => setStored(p), []);
  const toggle = useCallback(() => {
    setStored((prev) => {
      const current = prev ?? defaultPreference;
      const effective = current === "system" ? systemTheme() : current;
      return effective === "dark" ? "light" : "dark";
    });
  }, [defaultPreference]);

  const setFace = useCallback(
    (next: FaceName | null) => {
      setDevicePin(next);
      // The in-memory choice applies either way; "lost" is what the host's notice is for.
      if (next === null) doorRef.current.remove(faceStorageKey);
      else doorRef.current.set(faceStorageKey, next);
    },
    [storageKey, faceStorageKey],
  );

  const setLayout = useCallback(
    (next: LayoutName | null) => {
      setLayoutPin(next);
      if (next === null) doorRef.current.remove(layoutStorageKey);
      else doorRef.current.set(layoutStorageKey, next);
    },
    [storageKey, layoutStorageKey],
  );

  const adoptAccountFace = useCallback(
    (next: FaceName | null) => {
      setAccountFaceState(next);
      // A lost mirror write means the NEXT boot's init script cannot stamp the account's face
      // pre-paint; the account answer itself lives on the server and is re-adopted then.
      if (next === null) doorRef.current.remove(accountFaceStorageKey);
      else doorRef.current.set(accountFaceStorageKey, next);
    },
    [storageKey, accountFaceStorageKey],
  );

  const value = useMemo(
    () => ({
      preference,
      resolved,
      setTheme,
      toggle,
      face,
      facePreference: devicePin ?? null,
      accountFace,
      linuxDevice: linux,
      setFace,
      layout,
      setLayout,
      teach,
      adoptAccountFace,
      persistence,
    }),
    [preference, resolved, setTheme, toggle, face, devicePin, accountFace, linux, setFace, layout, setLayout, teach, adoptAccountFace, persistence],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}

/**
 * The theme, or `null` when there is no provider — for a component that renders BOTH inside
 * the app shell and outside it.
 *
 * `useTheme` throws off-provider, and that is correct for the app's own chrome, which always
 * has one. `MessageBody` does not: it is mounted bare in the desktop shell and in unit tests
 * that render it directly (`message-body.test.ts`), and a message must still render there.
 * So it reads the theme through this and treats `null` as light — the same default the
 * provider itself starts from before it has adopted a preference.
 */
export function useOptionalTheme(): ThemeContextValue | null {
  return useContext(ThemeContext);
}
