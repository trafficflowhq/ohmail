# test/compare

Holds a rendered state of the product against its reference picture. A screen of the next major version is
done when each of its states compares green here, or stands in `declared.json` with its reason.

## What is compared

A reference is a picture and a data file read from the same page at the same moment (`scene.mjs`). The
data file holds what the picture shows and nothing else:

- the landmarks, headings and controls in order, each with its role, its name, its box, the state a
  person sees it in and the values a token carries;
- the words inside each of them, what a field shows among them, with the colour and the type they are
  drawn in;
- every element that paints (a fill, a border, a shadow, an icon, a picture), with its box, and with the
  box of what a stylesheet draws before or after it. A sheet is a plain element and a row's words sit in
  spans inside its button: this is where their tokens show;
- how each of these is turned on the screen, when it is;
- the font faces that arrived.

What is hidden, clipped away, outside the window or wholly under something opaque is not in it. Hidden
is the browser's own answer where it gives one (`checkVisibility`): a closed details' content and what
`content-visibility: hidden` or `hidden="until-found"` keeps from the picture; and words the browser lays
out nowhere, such as those written inside a progress, a meter, a canvas or a video in its place, are
not read either. A list box's options are: it draws their words itself.

### What the drawn values say: `paint-properties.json`

Which computed properties the words, a painted box and a shape of an icon say is not written in the
reader. It is the lists of `paint-properties.json`, which `render.mjs` hands to `scene.mjs` with every
read: a property is said because it stands on a list, and nothing is said that does not. Each row names
the specification whose property table it comes from. For words: the properties of CSS Fonts (every
`font-variant` long hand, features, variations, kerning, optical sizing, stretch, synthesis), CSS Text
(transform of case, spacing of letters and words, indent, white space where it shows), CSS Text
Decoration (a line under, over or through words with its style, colour, thickness and offset; shadow;
emphasis marks), CSS Writing Modes, where a cut line ends and how many lines it keeps, and the
`-webkit-` stroke, fill and discs a browser still honours. For boxes: backgrounds, borders and their
corners, outline, shadow, opacity, filter and backdrop filter, blend mode, clip path, clip and mask, a
picture's fit, a list's marker, a control the browser draws itself. For a shape: its fill and stroke and
their parts, its geometry, markers and baselines.

A listed property is said only where its computed value is not its initial one, so a plain, upright
thing says no more than its type. Inheritance is read as the browser paints it: a property that is
inherited is read on the element the words stand in; one that belongs to the line (indent, where a cut
line ends) on the box that lays out the line; and a line under or through words on every box around the
words that declares one, as far out as the browser passes it in. That is the box that draws it, and a
child's own computed value says none there: a struck letter whose line is drawn by its button says the
line. It stops where the browser stops it, at a box lifted out of the flow or set in a line as a box of
its own.

Every property the pinned browser computes stands in the file once: on a list, under `elsewhere` when
another reading holds it (a turn, what is visible, a control's padding, a short hand, a second name for
the same value), under `notComputed` when a specification's table names it and the browser neither
computes nor parses it (every such name that paints, each once), or under
`notListed` with the reason (where a box is and how large, where a line breaks and words stand in it,
motion, what a person does, what has no effect in the browser the pictures are drawn in, what an icon
keeps for something else to draw). `paint-properties.test.ts` enumerates the browser's computed style
and fails on a name the file does not place or places twice, and on a `notComputed` name the browser
computes or parses; it holds every row's initial value against an element nothing
styled, and holds that every listed property is said where it alone moves and that the reader says no
key the file does not name.

### What a control shows, and the state it is in

What a control shows is its words: a text field's or text area's value, or its hint while that is what
shows; the option a closed select shows; the words on a button written as an input. They are runs of
words of the control, so the names question reads them letter by letter and the drawn values read their
type, as for any other words: `ben` for `tom` in the search field is another screen. Their white space
is read as the control holds it, so `ben tom` for `bent om` is another screen too, and so is a space at
the end of a value (`Offers ` for `Offers`), though the picture is the same. A page's words are held
together without theirs, however the page cut them into pieces, and so are both sides where only one
shows a control's words: a field's value against the same words in a box with a field's role is the
same screen. A field's kind is the one the
browser made of it: a type it does not know is a text field and says what it shows. A password field,
and any field drawn as discs, never says its value: it says that it is filled, and with how many
characters.

The state a person sees a control in is said on the names question too, in one order: checked or mixed,
pressed, open, expanded or collapsed, selected, current, disabled, invalid, read-only, a range's or a
meter's value, a select's chosen options, that a field shows its hint. A box ticked for one that is not
is another state of the screen, as other words are. Nothing of this reads a value that is not on the
page.

### How a thing is turned

Everything the data file says is painted also says how it is turned: a control, the words in it, a
surface, a box a stylesheet draws before or after an element, and each shape of an icon. It is one
reading (`turnOf` in `scene.mjs`): of the matrix the browser puts the thing on the screen with,
everything around it folded in, the part that is left when where the thing is and how large it is drawn
are taken out. That is what a person sees as a turn, and it is said as one: `45deg`, `mirrored`, or the
matrix itself for a slant or a squash.

So a caret drawn as a bordered box and pointed by a rule, a line a stylesheet draws through a sign, a
letter used as an arrow and a row's mirrored words each read apart from the same thing turned another
way. The same thing moved, zoomed, scrolled or drawn at another device scale reads the same, and so does
one turn however it is written and on whichever element around the thing. A thing that stands upright
says nothing: a data file of upright things holds no turn at all.

A shape inside an `svg` is asked of the browser. An element of the page has no such question: its
`transform`, `rotate` and `scale` are read as the browser computed them and folded into those of the
elements around it, and a box that is a part of a line takes none, as in the browser. Words also say
the way their line is written when that is not left to right. A box a stylesheet draws says its size,
and where it lies from its element's corner when the element holds it in place; the words it draws say
their type.

### An icon

An icon (an inline `svg`) says what a person sees of it:

- each fill and each stroke of its shapes, once; a stroke with its width, cap and join, its dashes
  where it has any, that it keeps its width in an icon drawn larger, and that it lies under its fill;
- how many shapes it draws, and a digest of each one's kind, its geometry, and where the browser puts
  it on the screen. That last is one matrix a shape, as the browser resolved it, so a chevron turned
  or mirrored is another icon wherever the turn is written: on the path, on a group, on the `svg`, or
  on an element around it, by `transform` or by `rotate` and `scale`. The matrix is read from the
  icon's middle in the icon's own units: the same icon moved, zoomed, or drawn at another size or
  device scale says the same (its box says those), and one turn says the same however it is written;
- a shape nobody sees is not counted: not displayed or fully see-through, itself or by a group around
  it, or kept in `defs`, a `symbol` or a clip and drawn by nothing. What a `use` draws is counted
  where it is used;
- a picture inside it (`image`) is a shape of its own kind, and a word inside it says where it is
  anchored. The word's face is read with the page's words.

Two icons of the same box, colour and stroke are therefore two inks. Two ways of drawing the same
pixels, such as a mirror written as other path data and as a transform, read apart: red, where a person
would say green.

The comparison (`compare.ts`) asks four questions:

| Question | Reads | Fails a run |
|---|---|---|
| names | roles and names in order, the state each control is in, and the words each node shows, a field's among them | always |
| boxes | each node's box, each painted surface's and that of what a stylesheet draws before or after one, within `tolerance.box` CSS pixels | always |
| drawn | what the lists of `paint-properties.json` say of the words, of every painted box and of an icon's shapes, a control's padding, and how each of them is turned: the computed strings must be equal; and each face the reference's words are set in must have loaded | always |
| picture | the share of differing pixels, over the whole picture and inside each node's region; and the largest mark, the differing pixels that touch one another | for a state in `accepted.json`; for any state when over `tolerance.grossRatio` of the picture differs; otherwise it reports |

A picture of another size is red and is never scaled. A picture is taken once the page stands still: the
same scene and the same pixels on two looks, a moment apart. `tolerance.json` holds every number and says
why. The picture's pixel line sits just above one step of every channel, which two machines may round a
blend apart by; every two surfaces of the design are further apart than that, in every theme.

### The mark line

An accepted picture is the same picture, not a near one, and a share of pixels does not hold it to
that: a 16 px icon is a four-hundredth of its row, and a caret turned over moves some thirty pixels of
a screen. So the picture is also read the way a person reads it. Differing pixels that touch one
another, a corner counts, are one mark, and a mark of more than `tolerance.mark` pixels fails an
accepted state whatever share of anything it is. The marks are read with every differing pixel in; the
shares leave out what pixelmatch takes for a soft edge, which is most of a thin stroke that moved.

The line is measured: above the largest mark two draws of one steady state ever showed, below the
smallest mark that was changed on purpose (`tolerance.json` has both). A state whose own
two draws show a larger mark is named in `unsteady.json`. For a state nobody accepted the mark is
reported, as the rest of the picture is: there the drawn values are the guard.

### Known limits

What `paint-properties.json` lists is read by the drawn values, accepted or not. What it does not list
is read by the picture alone, and fails a state only once its picture was accepted, by the mark line:
where words stand inside their node and where a line breaks; where a box drawn before or after an
element lies when the element does not hold it in place; and what an icon keeps for something else to
draw, a gradient's stops, the shapes of a clip or a mask, a marker's or a pattern's insides (an icon's
ink says which of these a shape names, not what one holds). `compare.test.ts` holds three of them, at
either scale, green on the first three questions and red on the mark; the file names each group with
its reason. So is what a frame, a canvas or a video shows: the data file says that one is there, and
its box. The reference draws a mail as its sender wrote it in a frame (42 states on five screens),
and that is the sender's design, not the app's. What a stylesheet writes into a list's marker, a first letter or
line or a backdrop is not read either (a list item's kind of marker is), and the reference's sheets
write none of them.

Which of two painted things lies on top is read by the questions only where one covers the other whole
(it is then not seen, and not said); where they only partly overlap, both are seen and which lies on top
(`z-index`, the order they are written in) is read by the picture alone, by the mark. Accepted because
the boxes question holds where each of the two is, so only their order can move unread, and an
accepted picture fails on it far over the line (99 to 600 pixels measured).

Three more things are read by the picture alone, each red on the mark once accepted (224 to 2,304
pixels measured) and none in the reference:

- a part of a control that a stylesheet draws through a pseudo-element, such as a range's knob
  (`::-webkit-slider-thumb`): the control's own box and state are read, the part's paint is not.
  Accepted because the reference styles no such part, and one the product brings in is a new thing to
  accept by its picture;
- the picture of an image button (`<input type="image">`), which is no `img` and says no `shows`.
  Accepted because the reference has none; its box is read, and its name where `aria-label` gives
  it (named by its `alt` alone, it reads as a text field with no name);
- where a long value is scrolled inside its field: the whole value is read, which part of it shows is
  not. Accepted because the value and the field's box are read, and only its scrolled place can move
  unread.

What is on neither list and under the mark line passes both, and that is the whole of it:

- a mark of `tolerance.mark` pixels or fewer that no listed property draws, in an accepted picture: a
  pattern inside a 12 px icon whose dots are made bars is nine marks of four pixels at a scale of one,
  and sixteen at a scale of two. Accepted because the line has to stand above the noise of two draws of
  one steady state (twelve pixels at a scale of one), and because the reference's icons keep no
  pattern, gradient, marker, clip or mask inside them: a product icon that brings one in is red on
  its ink, which says that a shape names one.
- a difference under the pixel line: one step of every channel at once, which two machines may round
  apart. Accepted because no two surfaces of the design are that close, and a colour that differs by
  that step on a listed property is red on the drawn values.

Of the three such marks measured before the lists, the 8 px picture moved inside its box (ten pixels at
a scale of one) is now read by the drawn values (`background-position`); the pattern, at both scales,
is the first item above.

The other way round, the drawn values read apart two ways of drawing the same pixels: a mirror written
as other path data and as a transform, or a square fill turned a half. Red, where a person would say
green; the product writes such a thing once, the way the reference does.

The reference draws its icons as inline `svg`, a slot's caret as a bordered box turned by a rule and
the line through a sign as a box drawn after it: all three are read. Where one of its scrolling
columns fades out under a mask, the mask is read, and the picture shows what it does.

## The reference

The design reference lives in a private repository. What is here of it:

- `registry.json`: every registered state of the app under one key (its address's query, parameters
  sorted), derived by `capture.mjs`. Never edited by hand.
- `manifest.json`: one row a picture, with its size and checksums.
- `archive.lock.json`: the pictures themselves are too heavy for this repository's history, so they live
  in a pinned archive, one file a screen, each named here with its file name, its SHA-256 and its size.
  `fetch.mjs` puts the shards a run needs into `build/reference/` and refuses one that does not match.

The archive has no home yet: the lock names no address (`urls` is empty for every shard), and no job runs
the comparison. Until it has one, a comparison against the reference runs on a workstation that was given
the shards as a folder: `node test/compare/fetch.mjs --from <that folder>` checks each against the lock
and unpacks it. Without them the run says in one line what is missing and skips what reads them; the
product's own pictures are compared either way. The job follows when the archive has a home, and sets
`COMPARE_REQUIRE_REFERENCE=1`, which turns that skip into a failure.

`unsteady.json` names the registered states the reference itself draws differently from run to run (a
card placed a pixel apart, a row fitted by measuring), 25 today: two draws of such a state differ in a
data file or by a mark over the mark line (60 pixels and more). Their picture is one of their draws,
and such a key never goes into `accepted.json` before the reference draws it one way. A state a later
draw finds unsteady is added there by its key.

`count.test.ts` holds that every registered state has a picture and none is older than its state. A
registered screen that is no screen of the app is named in `no-picture.json` with its reason: its states
stay in the registry, and no picture of it is taken or packed.

## Running it

```bash
npx vitest run test/compare                           # the tool's own tests; needs no archive
node test/compare/fetch.mjs --from <a folder>         # the canary shard, and one per screen with subjects
npx vitest run --config vitest.compare.config.ts      # every subject against its picture
```

`COMPARE_REQUIRE_REFERENCE=1` on the last line fails the run when a shard it reads is not in
`build/reference/`; without it, that is one line and a skip.

What a red state drew is written to `build/compare/` (`.actual.png`, `.actual.json`, `.diff.png`).

The states pages are not the shell a person runs. What the REAL web entry draws, place by place, is held against
the reference by the real-app measure, `real/` (its README has its one command).

## Adding a screen

Add `subjects/<screen>.ts`, named after the screen's id in `registry.json`, exporting `subjects`: one
`{ key, open }` for each state the screen builds. `open` draws the state on the page it is handed; the
window, the scale and the scheme come from the picture's row. Compare each state once, and one named
state in each of the screen's seven links (the registry rows that carry `link`).

A difference that is meant goes into `declared.json` as `{ key, reason, since }`, with `nodes` to declare
single controls and keep the rest failing. When a screen is accepted its keys go into `accepted.json`,
and from then on its picture fails too.

A subject not named after a registered screen is one of the product's own (`own:` keys, pictures in
`own/`, rows in `own/rows.json`). `COMPARE_WRITE_OWN=1 npx vitest run --config vitest.compare.config.ts`
takes those pictures anew; read them before committing.

## After the reference is tagged again

```bash
node test/compare/capture.mjs --studio <the studio's checkout> --tag <tag> --out <a scratch folder> \
  --pack --canary marks --revision <n> [--home <where the shards can be fetched, ending in />]
node --import tsx test/compare/prove.mjs --studio <the studio's checkout> --tag <tag> --work <an empty folder>
```

`capture.mjs` draws every registered state from the tag, served on loopback, and writes the registry, the
manifest, the shards and their lock, and exits 1 when a registered state has no picture. Without `--home`
the lock names no address. The data files are read by `scene.mjs` as it stands: after a change to the
reader every data file is derived again, and the comparison refuses a data file another reader wrote.
Read `problems.json` and look at the pictures before handing the shards on: one a screen at least. Draw a
few screens a second time into another folder (`--only <screen>,…`) and hold the two manifests' checksums
together: a state the reference draws differently from run to run is a fault of the reference, and its
picture is only one of its draws; name such states in the pull request.

Once shards have been given out, replace only those of screens where a state moved, under a new revision,
and move their rows. A screen whose every state still compares green against its pinned picture keeps its
shard, its rows and its tag: `manifest.json` names the tag shard by shard. A checksum alone does not say
that a state moved, because two draws of one tag differ in a byte in about one picture in fifty; the
comparison does. A state without a subject is never compared, so its new picture is never red.
`prove.mjs` shows the tool green on the reference against itself, red on each of a list of single
changes (a token, an icon no longer turned, the caret pointing the other way, the line through a letter gone), and red on every colour
of the reference's default block wherever that colour shows in a proved state.