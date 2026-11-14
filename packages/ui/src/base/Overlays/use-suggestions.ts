/**
 * How a field that suggests behaves, whatever it suggests: when it asks, what it keeps, what the keys do. The
 * field stays a plain text field and keeps the caret; nothing is ever taken by itself.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import {
  suggestionId,
  type SuggestionGroup,
  type SuggestionRow,
  type SuggestionVia,
} from "./SuggestionList.js";

/* What a field waits for, in ms, and how much must be typed before a source is asked. A pause is no motion. */
const MIN = 3;
const PAUSE = 200;
/* How long a row an answer put first must have stood before Enter or Tab takes it unasked: the time to see it. */
const SEEN = 300;
const SIGN = 400;
const DROP = 2000;
const KEEP = 300_000;
const NONE: readonly never[] = [];

/** The answers a source gave, kept for a while by the text they answer. */
export interface SuggestionStore<R extends SuggestionRow = SuggestionRow> {
  get(text: string): readonly SuggestionGroup<R>[] | undefined;
  set(text: string, groups: readonly SuggestionGroup<R>[]): void;
}

/**
 * A store of a caller's own, where the answers should outlive the field. It is keyed by the typed text alone: one
 * store holds what ONE source answered under ONE set of everything else the answer depends on (the account, the
 * language, whatever the caller's `ask` sends along or leaves out of its rows). Make one for each such set, never
 * one above them: a store shared wider hands one person's answers to another.
 */
export function suggestionStore<R extends SuggestionRow = SuggestionRow>(
  keep: number = KEEP,
): SuggestionStore<R> {
  const kept = new Map<string, { at: number; groups: readonly SuggestionGroup<R>[] }>();
  return {
    get(text) {
      const found = kept.get(text);
      if (found && Date.now() - found.at <= keep) return found.groups;
      kept.delete(text);
      return undefined;
    },
    set(text, groups) {
      const now = Date.now();
      for (const [key, was] of kept) if (now - was.at > keep) kept.delete(key);
      kept.set(text, { at: now, groups });
    },
  };
}

export interface SuggestionsOptions<R extends SuggestionRow = SuggestionRow> {
  /** The listbox's id, as `SuggestionList` takes it. */
  id: string;
  /** What stands in the field, and where what a person types goes. */
  text: string;
  onText: (text: string) => void;
  /** What the device itself can offer for a text: answered at once, from the first character, never asked for. */
  own?: (text: string) => readonly SuggestionGroup<R>[];
  /** The question to a source that takes time. `signal` is given up when the text changes or the answer is too slow. */
  ask?: (text: string, signal: AbortSignal) => Promise<readonly SuggestionGroup<R>[]>;
  /**
   * The typed text is an answer of its own: no row is on by itself, and the text is a stop between the last
   * row and the first (a place). False: the first row is on (a recipient).
   */
  free: boolean;
  /** A row was taken: by a press, by Enter or by Tab. The field's text is the caller's to set. */
  onTake: (row: R, via: SuggestionVia) => void;
  /** How many characters before `ask`; how long the typing must rest; when the wait is shown; when it is given up. */
  min?: number;
  pause?: number;
  sign?: number;
  drop?: number;
  /** How long an answer is kept for its text. `store`: a store of the caller's own in its place. */
  keep?: number;
  store?: SuggestionStore<R>;
}

/** What a field that suggests carries: spread on its input. */
export interface SuggestionField {
  role: "combobox";
  "aria-autocomplete": "list";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  "aria-activedescendant": string | undefined;
  autoComplete: "off";
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onBlur: () => void;
}

export interface Suggestions<R extends SuggestionRow = SuggestionRow> {
  field: SuggestionField;
  /** `SuggestionList`'s props but its name and where it stands. */
  list: {
    id: string;
    groups: readonly SuggestionGroup<R>[];
    query: string;
    active: number | null;
    busy: boolean;
    onActive: (index: number) => void;
    onTake: (row: R) => void;
  };
  /** A row of `ask` is among the rows: where a source wants its credit shown, it stands now. */
  answered: boolean;
  /** Whether the list used the key. A field with keys of its own asks this first. */
  keys: (event: KeyboardEvent<HTMLElement>) => boolean;
  /** Shows what there is without a key: on an empty field the device's own (a sheet that opens on the field). */
  open: () => void;
  close: () => void;
}

type Timer = ReturnType<typeof setTimeout>;
interface Out {
  pause?: Timer;
  sign?: Timer;
  drop?: Timer;
  flight?: AbortController;
}
/** Nothing is waited for any more, and a question that is out is given up. */
function giveUp(out: { current: Out }): void {
  const { pause, sign, drop, flight } = out.current;
  for (const timer of [pause, sign, drop]) clearTimeout(timer);
  flight?.abort();
  out.current = {};
}

/** A source that takes time: one question out at a time, the last answers standing until it is answered. */
function useAnswers<R extends SuggestionRow>(options: SuggestionsOptions<R>) {
  const { ask, min = MIN, pause = PAUSE, sign = SIGN, drop = DROP } = options;
  const [answers, setAnswers] = useState<readonly SuggestionGroup<R>[]>(NONE);
  const [busy, setBusy] = useState(false);
  const [own] = useState(() => suggestionStore<R>(options.keep));
  const store = options.store ?? own;
  const out = useRef<Out>({});
  useEffect(() => () => giveUp(out), []);

  const rest = () => {
    giveUp(out);
    setBusy(false);
  };
  const settle = (groups: readonly SuggestionGroup<R>[]) => {
    rest();
    setAnswers(groups);
  };
  const question = (typed: string) => {
    rest();
    if (!ask || typed.length < min) return setAnswers(NONE);
    const kept = store.get(typed);
    if (kept) return setAnswers(kept);
    out.current.pause = setTimeout(() => {
      const flight = new AbortController();
      const current = () => out.current.flight === flight;
      out.current = {
        flight,
        sign: setTimeout(() => setBusy(true), sign),
        /* Too slow: its rows go, and it is not asked again until the text changes. */
        drop: setTimeout(() => settle(NONE), drop),
      };
      new Promise<readonly SuggestionGroup<R>[]>((resolve) => resolve(ask(typed, flight.signal))).then(
        (groups) => {
          if (!current()) return;
          store.set(typed, groups);
          settle(groups);
        },
        () => {
          if (current()) settle(NONE);
        },
      );
    }, pause);
  };
  return { answers, busy, question, rest };
}

/**
 * Whether the row that is on by itself (`self`, its id) has only just been put there by an answer. An answer lands
 * a pause and a round trip after the last letter, inside the moment a typist presses Enter: a row nobody has had
 * the time to see is not taken. Only an answer that brings another first row counts; the device's own rows follow
 * the typing itself.
 */
function useUnseen(self: string | null, answers: readonly unknown[]): () => boolean {
  const put = useRef({ id: self, answers, at: 0 });
  useLayoutEffect(() => {
    const was = put.current;
    if (self === was.id && answers === was.answers) return;
    const landed = self !== null && self !== was.id && answers !== was.answers;
    put.current = { id: self, answers, at: landed ? Date.now() : was.at };
  });
  return () => Date.now() - put.current.at < SEEN;
}

/** The row an arrow goes to. `null`: the typed text, a stop of its own where it is an answer. */
function stepped<R extends SuggestionRow>(
  rows: readonly R[],
  active: number | null,
  down: boolean,
  free: boolean,
): R | null {
  const last = rows.length - 1;
  const from = active ?? -1;
  const to = down ? (from === last ? -1 : from + 1) : from === -1 ? last : from - 1;
  const next = to === -1 && !free ? (down ? 0 : last) : to;
  return next === -1 ? null : rows[next]!;
}

export function useSuggestions<R extends SuggestionRow = SuggestionRow>(
  options: SuggestionsOptions<R>,
): Suggestions<R> {
  const { id, text, onText, own, free, onTake } = options;
  const { answers, busy, question, rest } = useAnswers(options);
  /* Shut until a person types: a field that was filled offers nothing. */
  const [shut, setShut] = useState(true);
  const [unasked, setUnasked] = useState(false);
  /*
   * The row the keys are on, held as the row itself: a newer answer can land between the arrow and the Enter, and
   * what Enter takes is the row a person saw under the keys, never one that stands in its place by then.
   */
  const [at, setAt] = useState<R | null>(null);
  const typing = useRef(false);
  const typed = text.trim();

  const close = () => {
    rest();
    setShut(true);
    setUnasked(false);
    setAt(null);
  };
  /* `byHand`: by the arrow or by the screen, which on an empty field shows the device's own. */
  const show = (byHand: boolean) => {
    setShut(false);
    setUnasked(byHand && !typed);
    setAt(null);
    question(typed);
  };
  /* What a person typed opens the list and asks; a text that was set from outside shuts it. */
  const onChanged = useRef({ show, close });
  useLayoutEffect(() => {
    onChanged.current = { show, close };
  });
  useLayoutEffect(() => {
    if (typing.current) onChanged.current.show(false);
    else onChanged.current.close();
  }, [text]);
  useLayoutEffect(() => {
    typing.current = false;
  });

  const groups = shut
    ? NONE
    : [...(own && (typed || unasked) ? own(text) : NONE), ...answers].filter((group) => group.rows.length);
  const rows = groups.flatMap((group) => group.rows);
  const found = at === null ? -1 : rows.findIndex((row) => row.id === at.id);
  /* The first row is on by itself only while the keys were put on none: never in the place of a row that left. */
  const active = found >= 0 ? found : at !== null || free || !rows.length ? null : 0;
  /* The row under the keys is no longer among the rows: the newer answer came without it. */
  const left = at !== null && found < 0 ? at : null;
  const shown = rows.length > 0;
  const unseen = useUnseen(at === null && active !== null ? rows[active]!.id : null, answers);

  const take = (row: R, via: SuggestionVia) => {
    close();
    onTake(row, via);
  };
  const keys = (event: KeyboardEvent<HTMLElement>): boolean => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return false;
    const { key } = event;
    if (key === "ArrowDown" || key === "ArrowUp") {
      if (shown) setAt(stepped(rows, active, key === "ArrowDown", free));
      else if (key === "ArrowDown") show(true);
      else return false;
      event.preventDefault();
      return true;
    }
    if (key !== "Enter" && key !== "Tab" && key !== "Escape") return false;
    if (!shown && (key === "Escape" || !left)) return false;
    const fresh = at === null && unseen();
    const on = left ?? (active === null || fresh ? null : rows[active]!);
    const row = key === "Escape" || event.shiftKey ? null : on;
    /* Enter on a row and Esc are the list's alone. Tab goes on by itself; with no row the key is the form's own. */
    if (key === "Escape" || (key === "Enter" && row)) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (row) take(row, key === "Enter" ? "enter" : "tab");
    else close();
    return key === "Escape" || row !== null;
  };

  return {
    field: {
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-expanded": shown,
      "aria-controls": shown ? id : undefined,
      "aria-activedescendant": shown && active !== null ? suggestionId(id, active) : undefined,
      autoComplete: "off",
      value: text,
      onChange: (event) => {
        typing.current = true;
        onText(event.currentTarget.value);
      },
      onKeyDown: (event) => void keys(event),
      onBlur: close,
    },
    list: {
      id,
      groups,
      query: text,
      active,
      busy: busy && shown,
      onActive: (index) => setAt(rows[index] ?? null),
      onTake: (row) => take(row, "press"),
    },
    answered: !shut && answers.some((group) => group.rows.length),
    keys,
    open: () => show(true),
    close,
  };
}
