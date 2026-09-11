"use client";

/**
 * The keyboard registry. `AppShell` owned one `document` keydown listener and every view added its own — six by
 * the end — so nothing could say what `c` does without reading six files, and precedence was mount order; the
 * only key map on screen was a hand-typed sentence that had already drifted. One listener, here; everything
 * else DECLARES (`useKeyBindings([...])`), live while the view is mounted. Precedence is a rule: view layers
 * before global ones, innermost first, first match runs — the Screener owns `c` while the rest of the product
 * reads it as Compose. The overlay is GENERATED from this registry (`ShortcutSheet`) by the same precedence
 * walk, so it cannot list a dead key or omit a live one. A binding declares its own label, so adding one adds
 * its documentation; deleting the generation step is the mutation `test/keymap.test.ts` watches fail.
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
import { modalIsOpen } from "./modal-gate";
import { modGlyph, useModGlyph } from "./mod-glyph";
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

/**
 * Why a binding is resting — the ONE answer the dispatcher can act on. A union of one, deliberately
 * not a second boolean beside `disabled`: every message verb is `disabled` while the list has no
 * cursor, and the dispatcher could not tell that from "this message may not be forwarded" — so the
 * FIRST press of any message verb on a fresh list did nothing (⌫ read as broken, reported from a
 * real Ohbox). The declaring site says which; omitting this keeps the old behaviour, making the
 * rule additive. A TOKEN, never a sentence: the dispatcher acts on `"no_cursor"` alone; every other
 * member is a reason the `?` sheet turns into words. Trash's two are keys that cannot work there
 * and must keep falling through.
 */
export type DisabledReason = "no_cursor" | "no_erase" | "trash_unavailable";

/**
 * Put a cursor on the first row, and say so — the host's half of the rule
 * above. `label` is the label of the binding that was PRESSED, so the
 * host's sentence names the verb the second press will run ("press again:
 * Move it to Trash"). The return says whether a cursor was actually placed:
 * `false` means there was nothing to place one on (an empty list, or a
 * surface this host holds no cursor for), and the keypress stays exactly as
 * inert as today. A boolean, not a message id: the dispatcher has no
 * business knowing which row — every host owns that choice.
 */
export type CursorPlacer = (label: string) => boolean;

/** How long the first key of a sequence stays armed. */
const SEQUENCE_MS = 1200;

export interface KeyBinding {
  /**
   * The chord, in the registry's notation: `"j"` · `"Enter"` · `"?"` ·
   * `"mod+k"` · `"shift+Enter"`. `mod` is ⌘ on macOS and Ctrl elsewhere —
   * one token, because the binding is the same intent on both and
   * duplicating it would let the two drift. A SPACE makes it a two-key
   * sequence: `"g o"` is g-then-o. The ⌘K palette had advertised
   * `g o`/`g r`/`g e`/`g s` since it shipped with nothing implementing
   * them; sequences exist so the palette stops lying, not because a mail
   * client needs a chord grammar.
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
   * Fire even while a WRITING SURFACE is mounted — see {@link useWritingSurface}. Default
   * false: with the compose form on screen, a chord somebody could TYPE (a bare letter, a
   * shifted one, `?`, a `g …` sequence) reaches no binding, because a blurred composer must
   * not let prose file the message behind it. The opt-ins are the keys that belong to the
   * writing surface's own chrome (the send-later digits) and the `?` sheet, which moves no
   * mail and is the one place the composer's own chords are documented.
   */
  inWriting?: boolean;
  /**
   * Declared and listed, but inert right now (nothing to act on). It still appears in the
   * overlay: a shortcut that vanishes from the documentation when the list is empty is a
   * shortcut nobody learns.
   */
  disabled?: boolean;
  /**
   * WHY it is inert — see {@link DisabledReason}. Set it only where the answer is one of that
   * union's, and only on a `disabled` row: an explanation for an active binding is a sentence
   * nothing can be true of. `"no_cursor"` is the one the dispatcher acts on; the others are read
   * by the `?` sheet, which prints the row's reason as its `title`.
   */
  disabledReason?: DisabledReason;
  /**
   * A condition ON THE EVENT, not on the app — it decides whether this keypress is ours,
   * and a `false` falls through to the next binding. It exists for exactly one thing:
   * ↵ while a button has focus belongs to the button. Anything about application state
   * belongs in `disabled`, which the overlay can see.
   */
  when?: (e: KeyboardEvent) => boolean;
}

/**
 * Registration scope, in precedence order: `overlay` beats `view` beats `global`. Two scopes said "the
 * innermost VIEW wins" — right for `c`, wrong for Escape, whose owner is whatever is OPEN ON TOP of a
 * view (the `?` sheet, the palette, the reader), all registered from an ANCESTOR of the view: the shell's
 * cascade could only be `global`, and a view binding beat it — with rows selected, Escape cleared the
 * selection instead of closing the sheet. It had been patched once per-case (the Ohbox standing down for
 * the reply editor); three surfaces stayed broken. `overlay` states the missing rank: an open layer is
 * inner to any view, whatever the component tree says. A scope, not a flag on a binding: precedence is a
 * property of the LAYER, the thing that comes and goes.
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
  /** The modifier's cap on this keyboard — ⌘ or Ctrl. See {@link useModGlyph}. */
  mod: string;
  /**
   * Run a chord's binding as if typed, and say whether anything did. Not `bindings.find(…).run()`:
   * `bindings` is memoised on `version`, which bumps only when a layer's SHAPE changes — right for
   * the overlay and hints, wrong for `run`, a CLOSURE that changes every render without changing
   * shape, so the memoised array holds handlers from the last shape change. Found in a browser: the
   * action bar's read switch called `find("u").run()` and two presses marked the message read
   * TWICE, while two presses of the KEY toggled correctly — `u`'s shape is constant across a read
   * flip. The dispatcher walks `ordered()` at KEYPRESS time (`Layer.get` is a getter for this
   * reason); `press` is that same walk, exposed — a button and a keystroke are one code path.
   */
  press: (chord: string) => boolean;
  /**
   * A writing surface is on screen — the compose form's claim. While at least one claim is held,
   * the dispatcher refuses every chord a person could TYPE (see {@link KeyBinding.inWriting})
   * unless focus is somewhere letters already mean letters. Returns the release; held for exactly
   * as long as the surface is mounted ({@link useWritingSurface}). A claim on the DISPATCHER, not a
   * layer of bindings: the `?` sheet keeps listing what the keys would do elsewhere (suspension is
   * not documentation), and `press` is untouched — a button click resolving through the registry is
   * a deliberate act, not a keystroke that missed its field.
   */
  claimWriting: () => () => void;
  /**
   * Offer to place the cursor for as long as the caller is mounted — see {@link CursorPlacer};
   * returns the release. A claim rather than a prop: the host that owns the cursor (`AppShell`) is
   * a CHILD of this provider. Exactly one placer answers — the one claimed most recently — and
   * nothing falls through, not even on decline: a placer answers `false` both for "my list is
   * empty" and "not my surface", and a second host asked after a decline would draw a selection
   * ring on a list the pressed verb does not act on. "Most recently" is not "innermost" (React runs
   * a child's effects first — {@link BindingScope} carries that scar); `AppShell` is the only
   * claimant today, and a second would need a scope.
   */
  claimCursorPlacer: (place: CursorPlacer) => () => void;
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
 * Could a person WRITING PROSE press this chord by accident? The test is whether the chord's
 * first gesture produces a character: a bare key of length 1 (`r`, `?`, `/`), a shifted one
 * (`shift+o` — Shift is how capitals are typed), or the opening key of a sequence (`g o`
 * begins with a typed `g`). `mod` chords are excluded — ⌘/Ctrl is never a typing gesture —
 * and NAMED keys (Escape, Enter, Tab, the arrows) have length > 1, so they pass: those are
 * the keys the writing-surface design lets through (see {@link Registry.claimWriting}).
 */
function chordSpellsCharacter(chord: string): boolean {
  const first = chord.split(" ")[0]!;
  const parts = first.split("+");
  return !parts.includes("mod") && parts[parts.length - 1]!.length === 1;
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
  /**
   * A shifted press is a different gesture — for LETTERS and for NAMED keys. The old letters-only
   * rule let a bare `Backspace` binding match ⇧⌫ (measured: over a selection, ⇧⌫ ran the ordinary
   * delete and spent the pick — and ⇧⌫ means "delete permanently" on Windows). The test splits on
   * what Shift can DO to the key: `key.length > 1` — a named key (Backspace, Enter, arrows); Shift
   * cannot change its identity, so a shifted press is a distinct chord a bare binding must not
   * claim (a binding that wants it declares `shift+…`); `/^[a-z]$/` — a letter, unchanged; anything
   * else of length 1 — punctuation, where Shift is the typing gesture (what keeps `?` reachable on
   * every layout).
   */
  if (!wantShift && e.shiftKey && (key.length > 1 || /^[a-z]$/.test(key))) return false;
  return key.length === 1 ? e.key.toLowerCase() === key.toLowerCase() : e.key === key;
}

/**
 * THE MODIFIER'S OWN NAME ON THIS KEYBOARD — re-exported, not defined here.
 *
 * `mod-glyph.ts` holds it, for one reason: the landing page prints a modifier cap too, the
 * marketing tree imports only leaf modules out of `shell/`, and importing this file for a glyph
 * would put the whole registry and `touch-keys.css` into a page with no keyboard behind it. The
 * re-export keeps every caller in the app — and every test — pointing at `./keymap`, which is
 * where the rest of the keyboard vocabulary lives.
 */
export { modGlyph, useModGlyph };

/**
 * The chord as keycaps, for `<Kbd>`: `"mod+k"` → `["Ctrl", "K"]` on a PC, `["⌘", "K"]` on a Mac.
 *
 * `mod` IS REQUIRED, and that is the fix rather than a style preference. It used to default to
 * "⌘" — "which is what a caller with no keyboard in front of it (a test, the server) gets" — and
 * the trouble with that sentence is that it is also what a caller who simply FORGOT gets, on
 * every platform, silently: the shipped bug this whole seam exists to close was hand-typed Mac
 * caps on Linux, and a default that reproduces it is a loaded gun in the signature. Every render
 * has an answer to hand ({@link useModGlyph}); a test that does not care still has to say so.
 */
export function chordKeys(chord: string, mod: string): string[] {
  const caps: Record<string, string> = {
    mod,
    shift: "⇧",
    Enter: "↵",
    Escape: "esc",
    /* The two keys that file a message to Trash, in the glyphs printed on the keys themselves.
       Without a cap here the sheet would render the bare `e.key` string — "Backspace" — which
       is a word in a row of keycaps rather than a key. */
    Backspace: "⌫",
    Delete: "⌦",
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
   * Dispatch order — overlay layers, then view layers, then global ones,
   * each innermost-first; the FIRST match runs. It cannot be plain
   * registration order: React runs a child's effects before its parent's,
   * so the view registers before `AppShell` and a naive "last wins" would
   * hand every contested key to the shell. Worse for the overlays, which
   * the shell owns: by mount order they are the outermost thing in the app,
   * by intent the innermost. The scope split states that intent instead of
   * depending on a tree shape that says the opposite ({@link BindingScope}).
   */
  const ordered = useCallback((): KeyBinding[] => {
    const of = (scope: BindingScope) =>
      layers.current.filter((l) => l.scope === scope).reverse().flatMap((l) => l.get());
    return [...of("overlay"), ...of("view"), ...of("global")];
  }, []);

  /** The half-typed sequence (`g`, waiting for `o`), and its expiry. */
  const pending = useRef<{ key: string; at: number } | null>(null);

  /**
   * How many writing surfaces are mounted right now. A COUNT, not a boolean, for the same
   * reason the modal gate keeps one: two surfaces (however unlikely) must not release each
   * other's claim. A ref rather than state because the dispatcher reads it at KEYPRESS time
   * — nothing renders from it, so a claim must not re-render the whole provider tree.
   */
  const writingSurfaces = useRef(0);
  const claimWriting = useCallback(() => {
    writingSurfaces.current += 1;
    return () => {
      writingSurfaces.current -= 1;
    };
  }, []);

  /**
   * THE CURSOR PLACERS, most recent last — see {@link Registry.claimCursorPlacer}.
   *
   * A ref for the reason `writingSurfaces` is one: the dispatcher reads it at KEYPRESS time and
   * nothing renders from it, so a claim must not re-render the provider's whole subtree. A LIST
   * rather than one slot so that a claim released out of order cannot clear somebody else's —
   * the argument `writingSurfaces` makes for being a count.
   */
  const placers = useRef<CursorPlacer[]>([]);
  const claimCursorPlacer = useCallback((place: CursorPlacer) => {
    placers.current = [...placers.current, place];
    return () => {
      placers.current = placers.current.filter((p) => p !== place);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /*
       * A blocking dialog suspends every binding — asked as a fact about the app, not read off the
       * DOM. The session dialogs mark the mailbox `inert`, which stops focus and hit-testing inside
       * `.app-root` and does nothing about this listener: it is bound to `document`, and the
       * dialog's buttons are siblings of the mailbox. So with the dialog up, `e` still parked the
       * focused message and `d` `d` still ran the delete ceremony — which ends by clicking its own
       * danger button programmatically, something `inert` does not block either. See
       * `modal-gate.ts`.
       */
      if (modalIsOpen()) {
        /*
         * AND THE HALF-TYPED CHORD GOES WITH IT.
         *
         * Returning early suspends the DISPATCH and used to leave `pending` alone, so a sequence
         * could straddle the dialog: press `d`, a dialog opens, keys during it are correctly
         * ignored — and if it closes inside the sequence window a single `d` afterwards completes
         * the `d d` typed before it and deletes. The prefix outlived the state it was typed in,
         * which is the same shape as the gate opening a frame late.
         */
        pending.current = null;
        return;
      }
      const typing = isTypingTarget(e.target);
      /*
       * A mounted composer suspends every typeable chord — measured on the deployed desktop: the
       * compose form opened with nothing focused, and typing ran the mailbox's one-key verbs on the
       * message selected behind the form, letter by letter. Focus-on-mount closes the common case;
       * this closes the rest — focus is one blur away from nowhere, and a blurred composer must
       * still read as "I am writing". Suspended at DISPATCH, as `modalIsOpen()` is: the registry
       * and `?` sheet still know the keys. Only typeable chords are refused
       * (`chordSpellsCharacter`); Escape, Enter, Tab and `mod` chords keep working, and a writing
       * surface opts back in with `inWriting`.
       */
      const writing = writingSurfaces.current > 0;
      const all = ordered();
      /* The two focus rules, factored out because the parked walk at the bottom of this handler
         has to apply exactly the same ones: a message verb pressed inside a text field is a
         character, and one pressed behind a mounted composer is prose. Neither may place a
         cursor either, so the filter is shared rather than restated. */
      const reachable = (b: KeyBinding) =>
        (b.inInput || !typing)
        && !(writing && !typing && !b.inWriting && chordSpellsCharacter(b.chord));
      const live = all.filter((b) => !b.disabled && reachable(b));
      /**
       * THE MESSAGE VERBS RESTING FOR WANT OF A CURSOR — see {@link DisabledReason}.
       *
       * Not merged into `live`: these must not RUN, and the walk that uses them is the last
       * thing this handler tries, after every existing walk has failed. So nothing that does
       * something today changes behaviour — the only presses this can reach are the ones that
       * were silently doing nothing at all.
       */
      const parked = all.filter((b) =>
        b.disabled === true
        && b.disabledReason === "no_cursor"
        && b.group === "message"
        && reachable(b));
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

      /**
       * Nothing live owns this key — but a message verb may be resting for want of a cursor. The
       * first press PLACES the cursor and says so; it performs nothing. The second press is an
       * ordinary press of a live binding — no second code path, no state kept here. Why not place a
       * cursor when the list opens: the Ohbox deliberately stopped (`AppShell.selectedOhbox`
       * records why), and a ⌫ that files the first message because a list happened to be under the
       * cursor is that hazard with a delete on the end. A press is a deliberate act; an arrival is
       * not. Last, after both walks, so this only reaches a keypress that was already inert; single
       * chords only.
       */
      for (const b of parked) {
        if (chordPrefix(b.chord)) continue;
        if (!chordMatches(b.chord, e) || !eligible(b)) continue;
        /* THE MOST RECENT CLAIM, AND ONLY IT — see {@link Registry.claimCursorPlacer} for why a
           declining placer is not followed by a second one. */
        const place = placers.current[placers.current.length - 1];
        /* NOTHING PLACED ⇒ NOTHING CONSUMED. An empty list, or a surface whose cursor no
           claimant holds: the press stays exactly as inert as it is today, `preventDefault`
           included, rather than being swallowed by a rule that could not act on it. */
        if (!place || !place(b.label)) return;
        e.preventDefault();
        return;
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

  const mod = useModGlyph();
  const value = useMemo<Registry>(
    // `version` is the dependency that matters: it changes when a layer is added, removed
    // or reshaped, which is exactly when the overlay's content changes. `press` is NOT
    // subject to it — it resolves its handler when it is called.
    () => ({ register, bindings: ordered(), press, mod, claimWriting, claimCursorPlacer }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [register, ordered, press, mod, claimWriting, claimCursorPlacer, version],
  );

  return <KeymapContext.Provider value={value}>{children}</KeymapContext.Provider>;
}

export function useKeymap(): Registry {
  const ctx = useContext(KeymapContext);
  if (!ctx) throw new Error("useKeyBindings/useKeymap outside a <KeymapProvider>");
  return ctx;
}

/**
 * DECLARE A WRITING SURFACE for as long as the caller is mounted — the compose form's hook.
 * While it is held, the dispatcher refuses every chord a person could type unless focus is
 * in a field already (see {@link Registry.claimWriting} for the whole rule). The throwing
 * `useKeymap` is deliberate: the caller is a view that declares bindings of its own, so a
 * missing provider is already a bug there, silently — the same argument `useKeyBindings`
 * makes.
 */
export function useWritingSurface(): void {
  const { claimWriting } = useKeymap();
  useEffect(() => claimWriting(), [claimWriting]);
}

/**
 * OFFER TO PLACE THE CURSOR for as long as the caller is mounted — the shell's half of
 * {@link DisabledReason}. See {@link Registry.claimCursorPlacer} for the precedence rule.
 *
 * `place` is read through a ref, never closed over, so the dispatcher calls the closure the
 * CURRENT render published rather than the one that was live when the effect ran. That is the
 * same defect `Registry.press` exists to avoid, and it bites harder here: the placer's whole job
 * is to read the list and the cursor as they are at the keypress, and a stale one would place a
 * cursor from a list the user has since left.
 */
export function useCursorPlacer(place: CursorPlacer): void {
  const { claimCursorPlacer } = useKeymap();
  const latest = useRef(place);
  latest.current = place;
  useEffect(
    () => claimCursorPlacer((label) => latest.current(label)),
    [claimCursorPlacer],
  );
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
    /* `disabledReason` is part of the SHAPE: the `?` sheet reads it (a row resting for want of a
       cursor carries the sentence that says so), and it can move while `disabled` stays true —
       `⇧R` on a 1:1 message is disabled before AND after the cursor arrives, for two different
       reasons. Without it here the layer never re-registers and the sheet keeps the old title. */
    bindings.map((b) => [b.chord, b.group, b.label, b.disabled === true, b.inInput === true, b.disabledReason ?? ""]),
  );

  useEffect(
    () => register({ scope, get: () => latest.current }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [register, scope, shape],
  );
}

/**
 * Declare bindings where a registry may legitimately be absent.
 * `useKeyBindings`'s throw is a real guard and stays: a VIEW that declares
 * its keys into no registry is a bug, silently. This variant exists for one
 * caller — the zone model (`zone-nav.tsx`), which every view mounts as part
 * of itself; those views are also mounted bare in tests and by surfaces
 * with no registry, where a spatial model with no dispatcher is simply
 * absent (`useBinding`'s argument: no provider means NO keys, never guessed
 * ones). Registration is otherwise identical to `useKeyBindings`.
 */
export function useOptionalKeyBindings(bindings: KeyBinding[], scope: BindingScope = "view"): void {
  const ctx = useContext(KeymapContext);
  const latest = useRef(bindings);
  latest.current = bindings;
  // The same JSON shape key as `useKeyBindings`, `disabledReason` included, for the same
  // collision argument and the same staleness one.
  const shape = JSON.stringify(
    bindings.map((b) => [b.chord, b.group, b.label, b.disabled === true, b.inInput === true, b.disabledReason ?? ""]),
  );
  const register = ctx ? ctx.register : null;
  useEffect(
    () => (register ? register({ scope, get: () => latest.current }) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [register, scope, shape],
  );
}

/**
 * The binding that owns `chord` right now — so a BUTTON can show its key. Reported from the reading view:
 * seven of the action bar's eight verbs had a live shortcut and showed none; the eighth carried a
 * hand-typed `kbdHint="s"` that read as a stray character. A second hand-maintained hint list is what
 * this registry deleted from the (i) panel — so the bar reads the same registry the `?` sheet does, and a
 * hint cannot be wrong: change the chord and the button follows. Returns the binding that would WIN this
 * keypress (`bindings` is in dispatch order), answering "what will this key do HERE". It does not throw,
 * unlike `useKeymap`: reading is not declaring — `MessagePane` renders in provider-less mounts, and a
 * message must stay readable. No provider means no hint, never a guessed one.
 */
export function useBinding(chord: string): KeyBinding | null {
  const ctx = useContext(KeymapContext);
  return ctx ? (ctx.bindings.find((b) => b.chord === chord) ?? null) : null;
}

/**
 * The binding that would actually RUN — {@link useBinding}'s sibling for
 * the hint foot. `useBinding` answers "is this chord spoken for HERE",
 * which is what a button's keycap asks (a disabled owner still owns the
 * key, and the cap must not vanish while the verb rests). A TEACHING line
 * asks the stricter question — "what will this key DO right now" — and a
 * disabled first declaration is what the dispatcher skips. So this walks
 * past disabled entries to the first LIVE one, exactly as `onKey` filters
 * and `groupedBindings` dedups. Null-safe for `useBinding`'s reason.
 */
export function useEnabledBinding(chord: string): KeyBinding | null {
  const ctx = useContext(KeymapContext);
  return ctx ? (ctx.bindings.find((b) => b.chord === chord && !b.disabled) ?? null) : null;
}

/**
 * PRESS a chord from a click — the companion to {@link useBinding}, and the
 * only safe way to invoke one. `useBinding` answers questions about SHAPE,
 * which the memoised array reports correctly because a shape change bumps
 * it; its `run` is the one field NOT safe to call from that array — see
 * {@link Registry.press} for the browser-observed failure. Returns `false`
 * when nothing enabled is bound to `chord`, so a caller can fall back
 * rather than silently do nothing. Safe with no provider, for the reason
 * `useBinding` is.
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
