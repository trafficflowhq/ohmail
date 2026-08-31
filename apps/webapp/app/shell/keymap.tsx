"use client";

/**
 * THE KEYBOARD REGISTRY.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * Two complaints, one cause: the basic shortcuts — read, unread and the rest — were not
 * integrated, and nothing in the interface made them discoverable. Both were true, and they
 * had the same cause. `AppShell` owned one `document` keydown listener and every view added another
 * one of its own — six listeners by the end — so nothing could say what `c` does without
 * reading six files, and precedence was whatever order React happened to mount them in.
 * The only key map on screen was a per-view hint strip plus a hand-typed sentence in the (i)
 * panel ("Keyboard: j/k, ↵, y + o/r/c/n/x…"), which is a second list of the bindings and had
 * already drifted from them.
 *
 * ── THE SHAPE ───────────────────────────────────────────────────────────────────────────
 *
 * One listener, here. Everything else DECLARES: `useKeyBindings([...])` from a view, and the
 * bindings are live while that view is mounted and gone when it unmounts. Two consequences
 * are the whole point:
 *
 *   1. **Precedence is a rule, not an accident.** View layers are consulted before global
 *      ones (innermost first within each), and the FIRST match runs. That is what lets the
 *      Screener own `c` (Receipts) while the rest of the product reads `c` as Compose,
 *      without either side knowing the other exists.
 *   2. **The overlay is GENERATED from this registry** (`ShortcutSheet`), by the same
 *      precedence walk the dispatcher uses. It cannot list a key that does nothing and it
 *      cannot omit one that does — there is no second list to keep in step, which is
 *      exactly what the (i) panel's sentence was.
 *
 * A binding declares its own label, so adding one adds its documentation. Deleting the
 * generation step is the mutation `test/keymap.test.ts` watches fail.
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
/* The rules that stop key hints being shown on devices with no keys. It rides with the
   registry rather than with any one component because the chrome it hides is spread across the
   shell, the dock and the reading overlay, and this module is the one thing that is in the
   bundle whenever any of them are. `AppShell` imports it; it never renders conditionally. */
import "./touch-keys.css";

/**
 * Overlay sections, in the order they render. A binding names one; an unknown group would
 * be dropped from the sheet, so the union is closed on purpose.
 */
export type BindingGroup = "navigate" | "message" | "screener" | "app";

export const BINDING_GROUPS: BindingGroup[] = ["navigate", "message", "screener", "app"];

/** How long the first key of a sequence stays armed. */
const SEQUENCE_MS = 1200;

export interface KeyBinding {
  /**
   * The chord, in the registry's own notation:
   *   `"j"` · `"Enter"` · `"Escape"` · `"?"` · `"mod+k"` · `"shift+Enter"` · `"shift+o"`
   * `mod` is ⌘ on macOS and Ctrl elsewhere — one token, because the binding is the same
   * intent on both and duplicating it would let the two drift.
   *
   * A SPACE makes it a two-key sequence: `"g o"` is g-then-o. The ⌘K palette has been
   * advertising `g o` / `g r` / `g e` / `g s` as keyboard hints since it shipped and
   * nothing implemented them; sequences exist so the palette stops lying rather than
   * because a mail client needs a chord grammar.
   */
  chord: string;
  group: BindingGroup;
  /** What it does, in the user's words. This IS the overlay row. */
  label: string;
  run: (e: KeyboardEvent) => void;
  /**
   * Fire even while focus is in a text field. Default false — the typing guard exists so
   * `j` types a `j`. Escape and ⌘K opt in, because a field you cannot leave is a trap.
   */
  inInput?: boolean;
  /**
   * Declared and listed, but inert right now (nothing to act on). It still appears in the
   * overlay: a shortcut that vanishes from the documentation when the list is empty is a
   * shortcut nobody learns.
   */
  disabled?: boolean;
  /**
   * A condition ON THE EVENT, not on the app — it decides whether this keypress is ours,
   * and a `false` falls through to the next binding. It exists for exactly one thing:
   * ↵ while a button has focus belongs to the button. Anything about application state
   * belongs in `disabled`, which the overlay can see.
   */
  when?: (e: KeyboardEvent) => boolean;
}

/**
 * Registration scope, in precedence order: `overlay` beats `view` beats `global`.
 *
 * ── WHY THERE ARE THREE AND NOT TWO ──────────────────────────────────────────────────── 
 *
 * Two scopes said "the innermost VIEW wins", which is right for `c` (Compose everywhere,
 * Receipts in the Screener) and wrong for Escape. Escape's owner is not a view, it is
 * whatever is OPEN ON TOP of one — the `?` sheet, the ⌘K palette, a popover, the reader —
 * and all of those are the shell's, registered from a component that is an ANCESTOR of the
 * view. So the shell's cascade could only ever be `global`, and a view binding beat it
 * unconditionally: with rows selected in the Ohbox, Escape cleared the selection instead of
 * closing the sheet the user was reading.
 *
 * It had been patched once, per-case, by teaching the Ohbox to stand down when the reply
 * editor was open — a predicate in a view, naming one of the shell's eight overlays. Three
 * surfaces stayed broken and the fourth was one new overlay away from breaking again.
 *
 * `overlay` states the missing rank instead: a layer that is open is inner to any view,
 * whatever the component tree says about who mounted whom. It is deliberately narrow — the
 * shell registers ONE binding into it — and it is a scope rather than a flag on a binding
 * because precedence is a property of the LAYER, which is the thing that comes and goes.
 */
export type BindingScope = "overlay" | "view" | "global";

interface Layer {
  id: number;
  scope: BindingScope;
  /** A getter, so a re-render's fresh closures are dispatched, not the mount's stale ones. */
  get: () => KeyBinding[];
}

interface Registry {
  register: (layer: Omit<Layer, "id">) => () => void;
  /** Everything currently bound, in DISPATCH order. Bumps whenever a layer's shape changes. */
  bindings: KeyBinding[];
  /**
   * RUN a chord's binding as if it had been typed, and say whether anything did.
   *
   * ── WHY THIS IS NOT `bindings.find(…).run()` ────────────────────────────────────────────
   *
   * `bindings` is memoised on `version`, which bumps only when a layer's SHAPE changes
   * (chord, group, label, enabled-ness). That is right for everything the array is read for
   * — the overlay renders shape, and a hint is shape — but a binding's `run` is a CLOSURE
   * that changes on every render without changing the shape. So the memoised array holds
   * handlers from the last shape change, and calling one of those runs against stale state.
   *
   * Found in a browser, not reasoned about: the action bar's read switch called
   * `bindings.find("u").run()` and two presses in a row marked the message read TWICE,
   * while two presses of the `u` KEY at the same cadence toggled correctly. `u`'s shape is
   * constant across a read-state flip, so no version bump ever refreshed the array, and the
   * second press re-ran the first press's closure.
   *
   * The dispatcher never had this problem because it walks `ordered()` at KEYPRESS time,
   * and `Layer.get` is a getter for exactly this reason. `press` is that same walk, exposed
   * — so a button and a keystroke are not merely equivalent, they are one code path.
   */
  press: (chord: string) => boolean;
}

const KeymapContext = createContext<Registry | null>(null);

/* ── chord matching ─────────────────────────────────────────────────────────────────── */

/** Focus is somewhere that letters mean letters. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
  return el.isContentEditable === true;
}

/** The first key of a two-key sequence, or null for a single chord. */
export function chordPrefix(chord: string): string | null {
  const i = chord.indexOf(" ");
  return i < 0 ? null : chord.slice(0, i);
}

/**
 * Does `chord` describe this event?
 *
 * The subtle rule is the last one: a plain letter binding must NOT swallow its shifted
 * twin. `⇧O` files-and-marks-read in the Screener and `o` just files; if `o` matched both,
 * the shifted binding registered next to it would be unreachable and the overlay would
 * document a key that never runs.
 */
export function chordMatches(chord: string, e: KeyboardEvent): boolean {
  const parts = chord.split("+");
  const key = parts[parts.length - 1]!;
  const wantMod = parts.includes("mod");
  const wantShift = parts.includes("shift");
  /**
   * AltGr PRODUCES CHARACTERS, Alt CHORDS ARE CEDED — two different facts about the same
   * modifier bit. On many layouts the app's bare punctuation only exists under AltGr
   * (`[`/`]` are AltGr+8/9 on German keyboards), and Windows spells AltGr as ctrl+alt —
   * so a flat `altKey ⇒ no` made those bindings unreachable for exactly the keyboards
   * the keys were added for (review finding, round 1). A keypress composed WITH AltGr is
   * therefore judged by the character it produced, and its alt/ctrl bits are ignored;
   * a plain Alt chord stays refused, which is the collision policy (no Alt bindings).
   */
  /* CHARACTER keys only: the exemption exists because AltGr is how some layouts TYPE the
     character, so it applies exactly where a character was typed (`key.length === 1`).
     AltGr+Enter or AltGr+arrows produce no character — those stay refused as the Alt
     chords they are (review finding, round 2). */
  const altGr =
    key.length === 1
    && typeof e.getModifierState === "function"
    && e.getModifierState("AltGraph");
  if (e.altKey && !altGr) return false;
  if (wantMod !== (e.metaKey || (e.ctrlKey && !altGr))) return false;
  if (wantShift && !e.shiftKey) return false;
  // `?` is itself typed with Shift on most layouts, so only LETTERS are held to the rule.
  if (!wantShift && e.shiftKey && /^[a-z]$/.test(key)) return false;
  return key.length === 1 ? e.key.toLowerCase() === key.toLowerCase() : e.key === key;
}

/** The chord as keycaps, for `<Kbd>`: `"mod+k"` → `["⌘", "K"]`, `"g o"` → `["g", "o"]`. */
export function chordKeys(chord: string): string[] {
  const caps: Record<string, string> = {
    mod: "⌘",
    shift: "⇧",
    Enter: "↵",
    Escape: "esc",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
  };
  return chord.split(" ").flatMap((step) => step.split("+").map((part) => caps[part] ?? part));
}

/* ── the provider ───────────────────────────────────────────────────────────────────── */

export function KeymapProvider({ children }: { children: ReactNode }) {
  const layers = useRef<Layer[]>([]);
  const nextId = useRef(1);
  const [version, bump] = useState(0);

  const register = useCallback((layer: Omit<Layer, "id">) => {
    const entry: Layer = { ...layer, id: nextId.current++ };
    layers.current = [...layers.current, entry];
    bump((v) => v + 1);
    return () => {
      layers.current = layers.current.filter((l) => l.id !== entry.id);
      bump((v) => v + 1);
    };
  }, []);

  /**
   * Dispatch order — overlay layers, then view layers, then global ones, each
   * innermost-first, and the FIRST match runs.
   *
   * It cannot be plain registration order: React runs a CHILD's effects before its
   * parent's, so the view registers before `AppShell` does and a naive "last wins" would
   * hand every contested key to the shell. Worse for the overlays, which the SHELL owns:
   * by mount order they are the outermost thing in the app, and by intent they are the
   * innermost. The scope split states that intent instead of depending on a tree shape
   * that says the opposite. See {@link BindingScope}.
   */
  const ordered = useCallback((): KeyBinding[] => {
    const of = (scope: BindingScope) =>
      layers.current.filter((l) => l.scope === scope).reverse().flatMap((l) => l.get());
    return [...of("overlay"), ...of("view"), ...of("global")];
  }, []);

  /** The half-typed sequence (`g`, waiting for `o`), and its expiry. */
  const pending = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = isTypingTarget(e.target);
      const live = ordered().filter((b) => !b.disabled && (b.inInput || !typing));
      const eligible = (b: KeyBinding) => !b.when || b.when(e);

      // A sequence in flight wins outright: after `g`, the `o` belongs to "go to Ohbox"
      // and not to whatever `o` means on its own.
      const armed = pending.current;
      pending.current = null;
      if (armed && Date.now() - armed.at < SEQUENCE_MS) {
        for (const b of live) {
          if (chordPrefix(b.chord) !== armed.key) continue;
          if (!chordMatches(b.chord.slice(armed.key.length + 1), e) || !eligible(b)) continue;
          e.preventDefault();
          b.run(e);
          return;
        }
        // An unknown continuation cancels the sequence and is NOT re-interpreted as a
        // fresh keypress: `g` then `q` must do nothing, not run whatever `q` is.
        return;
      }

      for (const b of live) {
        if (chordPrefix(b.chord)) continue;
        if (!chordMatches(b.chord, e) || !eligible(b)) continue;
        e.preventDefault();
        b.run(e);
        return;
      }

      // Nothing single-key matched — is this the START of a sequence?
      for (const b of live) {
        const prefix = chordPrefix(b.chord);
        if (prefix && chordMatches(prefix, e)) {
          e.preventDefault();
          pending.current = { key: prefix, at: Date.now() };
          return;
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ordered]);

  /**
   * The dispatcher's own walk, reachable from a click. See {@link Registry.press}.
   *
   * `ordered()` is called HERE rather than closed over, so the handler is the one the
   * current render published — the same guarantee `onKey` gets and for the same reason.
   * A disabled binding is skipped exactly as the dispatcher skips it, so a button driven by
   * this can never do what the key refuses to do.
   */
  const press = useCallback((chord: string): boolean => {
    for (const b of ordered()) {
      if (b.chord !== chord || b.disabled) continue;
      b.run(new KeyboardEvent("keydown", { key: chord }));
      return true;
    }
    return false;
  }, [ordered]);

  const value = useMemo<Registry>(
    // `version` is the dependency that matters: it changes when a layer is added, removed
    // or reshaped, which is exactly when the overlay's content changes. `press` is NOT
    // subject to it — it resolves its handler when it is called.
    () => ({ register, bindings: ordered(), press }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [register, ordered, press, version],
  );

  return <KeymapContext.Provider value={value}>{children}</KeymapContext.Provider>;
}

export function useKeymap(): Registry {
  const ctx = useContext(KeymapContext);
  if (!ctx) throw new Error("useKeyBindings/useKeymap outside a <KeymapProvider>");
  return ctx;
}

/**
 * Declare bindings for as long as the caller is mounted.
 *
 * `bindings` is read through a ref on every keypress, so handlers are never stale and the
 * caller does not have to memoise. Re-registration happens only when the SHAPE changes
 * (chords, labels, enabled-ness) — that is what the overlay renders, and re-registering on
 * every render would churn the layer order for nothing.
 */
export function useKeyBindings(bindings: KeyBinding[], scope: BindingScope = "view"): void {
  const { register } = useKeymap();
  const latest = useRef(bindings);
  latest.current = bindings;
  /* `JSON.stringify` rather than a separator character, and that is not a style choice.
     Concatenating these fields with nothing between them makes chord "ab" + group "c"
     indistinguishable from chord "a" + group "bc", so two different binding sets produce one
     key and the second never re-registers. Any single separator only postpones that until a
     label contains it, and a CONTROL character additionally risks the trap that put raw bytes
     in this file to begin with: one NUL makes the whole file read as binary, after which every
     grep-family tool skips it in silence. JSON escapes its own delimiters, so the encoding is
     unambiguous for every string, and every byte of it is printable. */
  const shape = JSON.stringify(
    bindings.map((b) => [b.chord, b.group, b.label, b.disabled === true, b.inInput === true]),
  );

  useEffect(
    () => register({ scope, get: () => latest.current }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [register, scope, shape],
  );
}

/**
 * DECLARE BINDINGS WHERE A REGISTRY MAY LEGITIMATELY BE ABSENT.
 *
 * `useKeyBindings`'s throw is a real guard and stays: a VIEW that declares its keys into no
 * registry is a bug, silently. This variant exists for exactly one caller — the zone model
 * (`zone-nav.tsx`), which every view mounts as part of itself. The views that carry it are
 * also mounted bare in tests and by surfaces with no keyboard registry at all, and a spatial
 * model with no dispatcher behind it is not a bug there, it is simply absent — the same
 * argument `useBinding` states for reading: no provider means NO keys, never guessed ones.
 * Registration is identical to `useKeyBindings` in every other respect (shape-keyed
 * re-registration, live closures through the ref), so a provider present behaves exactly as
 * if the caller had used the throwing form.
 */
export function useOptionalKeyBindings(bindings: KeyBinding[], scope: BindingScope = "view"): void {
  const ctx = useContext(KeymapContext);
  const latest = useRef(bindings);
  latest.current = bindings;
  // The same JSON shape key as `useKeyBindings`, for the same collision argument.
  const shape = JSON.stringify(
    bindings.map((b) => [b.chord, b.group, b.label, b.disabled === true, b.inInput === true]),
  );
  const register = ctx ? ctx.register : null;
  useEffect(
    () => (register ? register({ scope, get: () => latest.current }) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [register, scope, shape],
  );
}

/**
 * THE BINDING THAT OWNS `chord` RIGHT NOW — so a BUTTON can show its key.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────
 *
 * Reported from the reading view: the action bar does not show its shortcuts. Seven of its
 * eight verbs had a live shortcut and showed none; the eighth
 * carried `kbdHint="s"`, hand-typed at the call site, which rendered as a bare `s` in the
 * label row and read as a stray character rather than as a hint.
 *
 * A second, hand-maintained list of key hints is precisely what this registry deleted from the (i)
 * panel — *"a second list of the bindings [that] had already drifted from them"* — and
 * exactly what the `?` sheet is generated to avoid. So the bar reads the same registry the
 * sheet does, and a hint can no longer be wrong: change the chord and the button follows,
 * delete the binding and the hint disappears with it.
 *
 * ── WHAT IT RETURNS ─────────────────────────────────────────────────────────────────────
 *
 * The binding that would WIN this keypress — `bindings` is already in dispatch order
 * (overlay, then view, then global, innermost first) and the first match is the one the
 * dispatcher would run. So the hint answers the question the reader is actually asking,
 * "what will this key do HERE", which is the same rule `groupedBindings` dedups by.
 *
 * ── AND WHY IT DOES NOT THROW, UNLIKE `useKeymap` ───────────────────────────────────────
 *
 * `useKeymap`'s throw is a real guard: a component that DECLARES bindings into no registry
 * is a bug, silently. Reading one is not the same act. `MessagePane` renders in the desktop
 * shell and in tests that mount a view with no provider at all (`test/ohbox-read-state.test.ts`,
 * `test/conversation.test.ts`), and a message must stay readable without a keyboard registry
 * behind it. No provider means NO hint — never a guessed one.
 */
export function useBinding(chord: string): KeyBinding | null {
  const ctx = useContext(KeymapContext);
  return ctx ? (ctx.bindings.find((b) => b.chord === chord) ?? null) : null;
}

/**
 * THE BINDING THAT WOULD ACTUALLY RUN — {@link useBinding}'s sibling for the hint foot.
 *
 * `useBinding` answers "is this chord spoken for HERE", which is what a button's keycap
 * asks (a disabled owner still owns the key, and the cap must not vanish while the verb
 * rests). A TEACHING line asks the stricter question — "what will this key DO right now" —
 * and a disabled first declaration is not an answer, it is what the dispatcher skips. So
 * this walks past disabled entries to the first LIVE one, exactly as `onKey` filters, and
 * exactly the rule `groupedBindings` dedups by ("Disabled bindings … never shadow an
 * enabled one below them"). Null-safe for `useBinding`'s reason: no provider, no hint —
 * never a guessed one.
 */
export function useEnabledBinding(chord: string): KeyBinding | null {
  const ctx = useContext(KeymapContext);
  return ctx ? (ctx.bindings.find((b) => b.chord === chord && !b.disabled) ?? null) : null;
}

/**
 * PRESS a chord from a click — the companion to {@link useBinding}, and the only safe way
 * to invoke one.
 *
 * `useBinding` answers questions about SHAPE (is this key bound here, is it enabled, what
 * does it say), all of which the memoised array reports correctly because a shape change is
 * what bumps it. Its `run` is the one field that is NOT safe to call from that array — see
 * {@link Registry.press} for the browser-observed failure that establishes this.
 *
 * Returns `false` when nothing enabled is bound to `chord`, so a caller can fall back
 * rather than silently do nothing. Safe with no provider, for the reason `useBinding` is.
 */
export function useKeyPress(): (chord: string) => boolean {
  const ctx = useContext(KeymapContext);
  return ctx ? ctx.press : NO_PRESS;
}

const NO_PRESS = (): boolean => false;

/**
 * The overlay's rows, grouped — the ONE derivation of the sheet from the registry.
 *
 * Deduplicated by chord in dispatch order, so the sheet answers the question the user is
 * actually asking ("what will this key do HERE?") rather than listing every declaration
 * that exists somewhere in the app. Disabled bindings survive the dedup as themselves but
 * never shadow an enabled one below them.
 */
export function groupedBindings(bindings: KeyBinding[]): Array<{ group: BindingGroup; items: KeyBinding[] }> {
  const winner = new Map<string, KeyBinding>();
  for (const b of bindings) {
    const prev = winner.get(b.chord);
    if (!prev) winner.set(b.chord, b);
    else if (prev.disabled && !b.disabled) winner.set(b.chord, b);
  }
  return BINDING_GROUPS.map((group) => ({
    group,
    items: [...winner.values()].filter((b) => b.group === group),
  })).filter((g) => g.items.length > 0);
}
