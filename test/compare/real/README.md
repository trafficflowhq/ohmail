# test/compare/real

The real-app measure: a place as the REAL web entry draws it, held against the same state of the design
reference, element by element and value by value. It is the comparison's sibling (`../README.md`) and sees what
the comparison cannot: the comparison draws states pages that load the faces themselves, carry a rail written by
hand and stand the frame's own columns, so the shell a person runs is on none of its pages. This measure bundles
the pages the frame's browser tests bundle (`apps/webapp/test/frame/demo-page/entry.tsx`, and `web-page/entry.tsx`
for what only the web's rail draws), with the product page's stylesheets and body, and opens them in the pinned
browser beside the reference.

## The one command

```bash
REAL_MEASURE_STUDIO=<the studio's checkout> node --import tsx test/compare/real/measure.mts
```

From the repository's root, on an installed tree. Options: `--subjects frame,ohbox` and `--looks 1440-paper-light`
read only those; `--ref <tag or commit>` (or `REAL_MEASURE_REF`) names the pinned reference by another name; `--out <folder>`
(default `build/real-measure/`). It ends in one line: `GREEN` (exit 0) or `RED` (exit 1), with the counts.

Without a reference it says so in one line and ends `SKIPPED`, exit 0: CI has none. As in the comparison,
`COMPARE_REQUIRE_REFERENCE=1` turns that skip into `RED`. The measure is a workstation proof: run by a mount's
builder before the push, and at a milestone.

## The reference

The design reference lives in a private repository, and nothing of it is in this one. Its place is an input at run
time, read the way the comparison reads it (`../studio.mjs`): the app simulation's folder, and nothing else, is
unpacked with `git archive` at ONE commit into a temporary folder and served on loopback for the run; the reference's
page reaches nothing else. That commit is pinned in this tree: `reference.json` holds the studio's commit the
declared list was read against, and the measure reads it when no reference is named. A `--ref` that resolves to
another commit ends in one line, `real-measure: reference <commit> is not the pinned <pin>: not a verdict`, and RED:
the list holds the app against the pin only. The pin moves only in a commit that also brings `declared.json` up to
date: write the new commit into `reference.json`, run, and declare or mend every row the run reads. Each run prints
the commit it read.

A state of the reference is named by its key in `../registry.json` (`open=none&screen=ohbox`); each look adds its
own `device`, `face` and `scheme` as the registry's variants say them.

## What a row is

For each element of a subject, on both sides: its box (x, y, width, height), and by its kind:

| Kind | Values |
|---|---|
| box | background, corners, border, shadow, padding, gap, opacity |
| text | the words, the face the browser DREW them in (Chromium's own answer: a web font or the system's), the font list asked for, weight, size, line height, letter spacing, variations, colour, background, padding |
| icon | view box, stroke, stroke width, fill, colour |

A value is the browser's computed string: equal or a row. A box's edges and size are held to the comparison's
own `tolerance.box` (`../tolerance.json`), nothing more. An element on one side only is one row (`present`), one
drawn on one side and hidden on the other one row (`visible`). Where an element names `in`, its place is read from
that element's corner on both sides, so a shift of the whole counts once, on the anchor. A count's digits are
each world's mail: a count's words are not compared, and its width (and the width of the name beside it) only
where both sides hold as many digits.

A row: look, subject, element, property, the app's value, the reference's value. `rows.tsv` holds every row with
the task that removes it or `UNDECLARED`; `undeclared.json` the rows not declared yet in the declared list's form;
`gone.tsv` the declared rows that no longer occur; `readings/<look>.json` every value read.

## The looks

Eight, named as the comparison's own pictures name a look (`<width>-<face>-<scheme>`): 390 (844 high, a phone
under a finger), 1440 (900) and 2000 (1240) wide; paper light and dark at each; ohmarchy dark at 1440 and 2000.
The face and scheme are set on the app as a person's device stores them (`ohmail.face`, `ohmail.theme`), with
the system's scheme emulated alike.

## GREEN, and the declared list

`declared.json` names the differences that are meant for now. GREEN means: no row stands that is not declared,
and every declared row of a look and subject that was read still occurs (the list only shrinks: a row that left
is taken out). A run that could not read a subject (its page never drew it, or never stood still) is RED, and so
is a finder that throws on either side (`FAULT … finder of <element> threw on the <side>`): a broken finder is a
stale table, never an element that is absent.

An entry is the comparison's own form as far as it fits:

```json
{ "subject": "frame", "reason": "why it differs, and what draws it", "since": "2026-11-17",
  "removedBy": "the task whose landing makes these rows go",
  "rows": [{ "element": "Ohbox.label", "property": "face", "looks": ["1440-paper-light"], "app": "Arimo (system)" }] }
```

One entry a cause. Its reason says what draws the difference (the file and line) and its `removedBy` names the task
that removes it; a row a place can draw away now is never declared. A row's `app` is the app's value it was
declared at, as `rows.tsv` writes it: a row read at another value is UNDECLARED (a second change to a property
already declared is not covered by the first one's reason), so mend it, or write the new value with its reason.
A row without `app` holds any value. `undeclared.json` hands the rows of a run in this form, one entry a subject
with its reason and remover to be written, one row a value: split it by cause.

## Adding a subject

A place is added in its mount's pull request, as one row of `SUBJECTS` in `subjects.ts`:

1. `id`: the place's id in the journeys' vocabulary (`test/journeys/vocabulary/places.ts`).
2. `page`: the real entry it is drawn on (`demo`, or `web` for what only the web's host draws).
3. `route`: the vocabulary's route of the place (`PLACES.<id>.route`).
4. `reference`: the reference's state at the same moment, by its registry key (a key `registry.json` holds, for example `screen=search&state=empty`).
   Where the two worlds' mail differs (a search's results, a letter open, a list's rows: the app holds its own
   mailbox, the reference its invented one), pick the state that shows no mail of its own, an empty or
   nothing-open one (`screen=search&state=empty`, `open=none&screen=ohbox`), and read the place's own parts (its
   head, its field, its sheet). What a place draws only with mail in it is left unread, as the reader's open letter
   is (see "What it does not read").
5. `ready`: a finder each side draws once the place stands (the place's head on both).
6. `desk` and `phone`: its elements, each `box`, `text` or `icon` with a finder on each side (`null` where a side
   has none), `in` for its anchor inside the place, `count` for a count.
7. `looks`: only where the place has no phone or no desktop form; absent, all eight.
8. Run the command with `--subjects <id>`, read `rows.tsv`, and mend what the place can draw away.
9. Declare what stays, with its cause and remover; run again until GREEN.

A finder is an expression over the helpers of `page.mjs` (`q`, `qa`, `within`, `byText`, `railEntry`,
`refEntry`, `dockEntry`, `footPull`, `headBell`, `groupHead`); read the reference's own page for its names. A
helper the list lacks (a place's entry found by its words, say) goes into `page.mjs`, among `markElement`'s
`helpers`, named for what it finds, and is listed here and in `subjects.ts`'s header: a finder is run inside the
page, where only those helpers stand, so a helper written in `subjects.ts` is never seen.

Built: `frame` (the rail with its foot, the columns' handles, the dock), `ohbox` (the list's sheet and head),
`reader` (the reading column with nothing open) and `frame-web` (the web's offer of the desktop app). The next two
are Write (`compose`, against `screen=compose&state=blank`) and Settings' Account pane (`settings-account`, against
`screen=settings&sec=account`), each added by the change that mounts it.

## What it does not read

Hover, focus and pressed states; text sizes other than one; the fold widths; a letter open in the reader (the
two worlds hold different letters); the pictures (the comparison holds those); a Mac's fallback face (this reads
the face the browser drew where it runs).
