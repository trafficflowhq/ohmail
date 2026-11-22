/**
 * THE PLACES' OWN CHORDS. A place's registration prints the keys that go to it (`rail.keyHint`). Where they are `g`
 * and one more key, the frame binds them, for its life and whatever place is on screen: the key and the rail entry
 * then cannot say two things. Any other key a registration prints (Search's `/`) is its owner's to bind.
 *
 * The key sheet lists each chord under Navigate, by the sentence the registration names (`rail.keyLabel`, a key of
 * the `shortcuts` namespace) or else by the place's own label.
 *
 * AND THE DIGITS, as today's shell bound them: `1` to `7` go to the places the rail draws first, in its order, always
 * (outside a text field, like every single key; a held digit goes once). Only the places a person flicks between are
 * numbered, the groups of the Ohbox and the streams, the Screener and the piles: Settings, Search, History, Drafts,
 * Trash and the tags have keys of their own. The frame binds them from the registrations; no place binds a digit.
 * Each is listed under Navigate with its place's chord sentence, so the key sheet folds the two into one row.
 */
import { useMemo, type ReactNode } from "react";
import { leaveRailAfterGoTo, useKeyBindings, type KeyBinding } from "@ohmail/app-logic/keys";
import { useFrame, usePaletteOffers } from "./commands.js";
import { NONE } from "../host/contract.js";
import { useTextLookup } from "../text/index.js";
import {
  RAIL_GROUPS,
  RAIL_ORDER,
  type FrameCommands,
  type FramePlaces,
  type PlaceEntry,
  type PlaceRail,
  type RailGroupId,
} from "./contract.js";

/** `g`, a space, and one more key. */
const GOES = /^g \S$/;

export interface PlaceChord {
  readonly chord: string;
  readonly place: PlaceEntry;
  readonly rail: PlaceRail;
}

/**
 * The chords the frame binds for a host's places, in the rail's order. Two places that print one chord are
 * refused, by name: which of them a key reaches is never left to the order of a list.
 */
export function placeChords(places: FramePlaces): readonly PlaceChord[] {
  const chords: PlaceChord[] = [];
  for (const id of RAIL_ORDER) {
    const place = places[id];
    if (place === NONE || place.rail === null) continue;
    const chord = place.rail.keyHint;
    if (chord === undefined || !GOES.test(chord)) continue;
    const taken = chords.find((c) => c.chord === chord);
    if (taken) throw new Error(`two places print the keys "${chord}": ${taken.place.id} and ${place.id}`);
    chords.push({ chord, place, rail: place.rail });
  }
  return chords;
}

/** The rail's groups whose places are numbered: where a person flicks between the places they read. */
const NUMBERED: readonly RailGroupId[] = ["main", "screener", "later"];
/** There is no key `8` and up among them: a further place is simply not numbered. */
const DIGITS = 7;

export interface PlaceDigit {
  readonly digit: string;
  readonly place: PlaceEntry;
  readonly rail: PlaceRail;
}

/** The digits of a host's places: the numbered groups' places in the order the rail draws them, `1` first. */
export function placeDigits(places: FramePlaces): readonly PlaceDigit[] {
  const drawn: { place: PlaceEntry; rail: PlaceRail }[] = [];
  for (const group of RAIL_GROUPS) {
    if (!NUMBERED.includes(group)) continue;
    for (const id of RAIL_ORDER) {
      const place = places[id];
      if (place === NONE || place.rail === null || place.rail.group !== group) continue;
      drawn.push({ place, rail: place.rail });
    }
  }
  return drawn.slice(0, DIGITS).map((d, i) => ({ digit: String(i + 1), ...d }));
}

/** The sentence a key to a place is listed by: the registration's (`rail.keyLabel`), else the place's own name. */
type Lookup = ReturnType<typeof useTextLookup>;
const goesTo = (words: Lookup, place: PlaceEntry, rail: PlaceRail): string =>
  rail.keyLabel === undefined ? words(place.id)(rail.label) : words("shortcuts")(rail.keyLabel);

/** The bindings, declared for as long as the frame stands. It draws nothing. */
function Bound({
  chords,
  digits,
  go,
}: {
  chords: readonly PlaceChord[];
  digits: readonly PlaceDigit[];
  go: FrameCommands["go"];
}): null {
  const words = useTextLookup();
  const { host } = useFrame();
  const goTo = (place: PlaceEntry) => () => {
    go({ place: place.id });
    /* A go-to by key hands the keys from the rail back to the list, as a press on the entry does not. */
    leaveRailAfterGoTo();
  };
  const destinations = chords.map(({ chord, place, rail }) => {
    const disabledReason = rail.navigationRefusal?.(host);
    return {
      id: `mail.go.${place.id}`,
      chord,
      icon: rail.icon,
      label: goesTo(words, place, rail),
      ...(disabledReason === undefined ? {} : { disabled: true, disabledReason }),
      run: goTo(place),
    };
  });
  usePaletteOffers("mail", destinations, true);
  const bindings: KeyBinding[] = [
    ...destinations.map(({ chord, label, run, disabled, disabledReason }) => ({
      chord,
      label,
      run,
      group: "navigate" as const,
      ...(disabled ? { disabled, disabledReason } : {}),
    })),
    ...digits.map(({ digit, place, rail }) => ({
      chord: digit,
      group: "navigate" as const,
      label: goesTo(words, place, rail),
      /* A held digit is one go-to: a repeat falls through to nothing. */
      when: (e: KeyboardEvent) => !e.repeat,
      run: goTo(place),
    })),
  ];
  useKeyBindings(bindings, "global");
  return null;
}

/** Mounted once by the frame, under its registry. Where no place prints a chord or takes a digit, nothing is declared. */
export function PlaceChords({ places, go }: { places: FramePlaces; go: FrameCommands["go"] }): ReactNode {
  const chords = useMemo(() => placeChords(places), [places]);
  const digits = useMemo(() => placeDigits(places), [places]);
  return chords.length + digits.length === 0 ? null : <Bound chords={chords} digits={digits} go={go} />;
}
