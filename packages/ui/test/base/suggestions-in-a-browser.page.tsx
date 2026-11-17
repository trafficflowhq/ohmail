/**
 * The page `suggestions-in-a-browser.test.tsx` bundles and mounts in a real browser: a field that suggests, wired
 * as a screen wires it, with the kit's own parts, listeners and sheets.
 */
import { useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import {
  Icon,
  markTyped,
  SuggestionCredit,
  SuggestionList,
  useSuggestions,
  type IconName,
  type SuggestionGroup,
  type SuggestionRow,
} from "../../src/base/index.js";
import { EventForm } from "../../src/calendar/index.js";
import { Composer, Recipients } from "../../src/mail/index.js";

const place = (id: string, icon: IconName, primary: string, secondary?: string): SuggestionRow => ({
  id,
  mark: <Icon name={icon} size={20} />,
  primary,
  secondary,
});
const WORLD = {
  en: {
    head: "Your places",
    list: "Place suggestions",
    credit: "© OpenStreetMap contributors",
    own: [place("own-1", "history", "Technikum, room 3"), place("own-2", "history", "Tecknau station")],
    found: [
      place("a", "place", "Swiss Science Center Technorama", "Technoramastrasse 1, 8404 Winterthur"),
      place("b", "house", "Technikumstrasse 9", "8400 Winterthur"),
      place("c", "road", "Technikumstrasse", "8400 Winterthur"),
      place("d", "place", "Technopark Winterthur", "Technoparkstrasse 2, 8406 Winterthur"),
      place("e", "town", "Tecknau", "Basel-Landschaft"),
    ],
  },
  de: {
    head: "Deine Orte",
    list: "Ortsvorschläge",
    credit: "© OpenStreetMap-Mitwirkende",
    own: [place("own-1", "history", "Technikum, Besprechungszimmer 3")],
    found: [
      place(
        "a",
        "place",
        "Technische Sammlungen der Bundesrepublik Deutschland",
        "Helmut-Kohl-Allee 4, 53113 Bonn, Deutschland",
      ),
      place("b", "road", "Technischer-Rat-Josef-Zinnbauer-Straße", "84130 Dingolfing, Deutschland"),
      place("c", "house", "Technikumstrasse 9", "8400 Winterthur"),
      place("d", "town", "Tecknau", "Basel-Landschaft"),
    ],
  },
} as const;

/** A card that cuts what leaves it, in a column the list must stay inside: an event's form with its Place row. */
function PlaceField({ lang = "en", low, inline }: { lang?: "en" | "de"; low?: boolean; inline?: boolean }) {
  const words = WORLD[lang];
  const [text, setText] = useState("");
  const at = useRef<HTMLInputElement | null>(null);
  const column = useRef<HTMLDivElement | null>(null);
  /* A row is offered where one of its words begins with what was typed. */
  const begins = (rows: readonly SuggestionRow[], typed: string) =>
    rows.filter((r) => markTyped(r.primary, typed).some((part) => part.typed));
  const offers = useSuggestions({
    id: "place-list",
    text,
    onText: setText,
    own: (typed): SuggestionGroup[] => [
      { head: words.head, rows: begins(words.own, typed) },
      { rows: begins(words.found, typed) },
    ],
    free: true,
    onTake: (row) => setText(row.primary),
  });
  const card: CSSProperties = inline
    ? { position: "absolute", inset: "auto 0 0 0", padding: 16, background: "var(--sheet)" }
    : {
        position: "absolute",
        left: 420,
        top: low ? "auto" : 180,
        bottom: low ? 60 : "auto",
        width: 320,
        overflow: "hidden",
      };
  return (
    <div ref={column} id="column" style={{ position: "absolute", inset: inline ? 0 : "0 0 0 260px" }}>
      <div id="card" style={card}>
        <EventForm
          rows={[
            {
              id: "place",
              icon: "place",
              items: [
                {
                  kind: "text",
                  value: text,
                  label: "Place",
                  placeholder: "A place",
                  suggests: offers.field,
                  ref: at,
                },
              ],
            },
          ]}
        />
        <SuggestionList
          {...offers.list}
          label={words.list}
          foot={<SuggestionCredit href="https://maps.example/copyright">{words.credit}</SuggestionCredit>}
          {...(inline
            ? ({ placement: "inline" } as const)
            : ({ anchor: at, boundary: column, align: "text" } as const))}
        />
      </div>
      <p id="taken" style={{ position: "absolute", left: 0, top: 0 }}>
        {text}
      </p>
    </div>
  );
}

const PEOPLE = [
  { id: "ben", name: "Ben Arnold", address: "ben@lichtgrat.example" },
  { id: "rahel", name: "Rahel Beck", address: "rahel@lichtgrat.example" },
  { id: "tim", name: "Tim Berger", address: "tim@gassenblatt.example", tag: "wrote to you" },
];

/** A letter's head with the people a line can take, and something under it that the list must stand over. */
function Letter() {
  const [typed, setTyped] = useState("");
  const [took, setTook] = useState("");
  return (
    <div style={{ position: "absolute", left: 200, top: 120, width: 620 }}>
      <Recipients
        lines={[{ id: "to", label: "To", people: [], typed }]}
        onType={(_line, value) => setTyped(value)}
        suggest={{
          label: "Address suggestions",
          people: (text) =>
            text.trim()
              ? PEOPLE.filter((p) =>
                  `${p.name} ${p.address}`.toLowerCase().includes(text.trim().toLowerCase()),
                )
              : [],
          onTake: (_line, person) => {
            setTook(person.address);
            setTyped("");
          },
        }}
      />
      <button id="under" type="button" style={{ display: "block", width: "100%", height: 200 }}>
        the letter's text
      </button>
      <p id="taken">{took}</p>
    </div>
  );
}

/** A letter whose signature comes back as its own words while it is typed over, as an app that keeps them hands it. */
function Signed() {
  const [text, setText] = useState("Mila Brunner");
  return (
    <div style={{ position: "absolute", left: 200, top: 120, width: 620 }}>
      <Composer
        label="New message"
        head={null}
        signature={{ label: "Signature", text, onChange: setText }}
        foot={{ label: "Add to the message" }}
      >
        <p>The letter.</p>
      </Composer>
      <p id="kept">{text}</p>
    </div>
  );
}

const SCENES = {
  place: () => <PlaceField />,
  "place-low": () => <PlaceField low />,
  "place-german": () => <PlaceField lang="de" />,
  "place-sheet": () => <PlaceField lang="de" inline />,
  letter: () => <Letter />,
  signed: () => <Signed />,
};
export type Scene = keyof typeof SCENES;

(window as unknown as { mountScene: (host: Element, scene: Scene) => void }).mountScene = (host, scene) => {
  createRoot(host).render(SCENES[scene]());
};
