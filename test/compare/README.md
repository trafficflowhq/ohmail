# test/compare

Holds a rendered state of the product against its reference picture. A screen of the next major version is
done when each of its states compares green here, or stands in `declared.json` with its reason.

## What is compared

A reference is a picture and a data file read from the same page at the same moment (`scene.mjs`). The
data file holds what the picture shows and nothing else:

- the landmarks, headings and controls in order, each with its role, its name, its box and the values a
  token carries;
- the words inside each of them, with the colour and the type they are drawn in;
- every element that paints (a fill, a border, a shadow, an icon), with its box, and with the box of
  what a stylesheet draws before or after it. A sheet is a plain element and a row's words sit in spans
  inside its button: this is where their tokens show;
- how each of these is turned on the screen, when it is;
- the font faces that arrived.

What is hidden, clipped away, outside the window or wholly under something opaque is not in it.

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
| names | roles and names in order, and the words each node shows | always |
| boxes | each node's box, each painted surface's and that of what a stylesheet draws before or after one, within `tolerance.box` CSS pixels | always |
| drawn | colour, type, radius, padding, paint, an icon's strokes and shapes, and how each of them is turned: the computed strings must be equal; and each face the reference's words are set in must have loaded | always |
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

The first three questions are a chosen set of readings, not the picture. What they do not say, a state
whose picture nobody accepted does not fail on. Known to be unread:

- what a clip, a mask, a filter or a blend mode does, on an icon, around it or on any element. An icon
  says that a clip, a mask or a filter is on it or inside it, and nothing more;
- what a gradient or a pattern holds that a shape is filled with, and a marker at a line's end;
- a picture that is no inline `svg`: an `img` is not read, turned or not; a background image says its
  file's name, and not where it lies in its box; a box cut to a shape by a mask or a clip says its fill
  and its box;
- a line under or through words, a shadow behind them, and where words stand inside their node;
- where a box drawn before or after an element lies, when the element does not hold it in place;
- a turn that comes from a path a box is set on (`offset-path`) or from a vanishing point on the
  element around it: a box says the turn of its `transform`, `rotate` and `scale` alone. The product
  uses neither; the reference a vanishing point on the way into a state only, and a picture is taken
  when that is over.

The picture catches each of these on an accepted state, by the mark line: `compare.test.ts` holds six
of them, at either scale, green on the first three questions and red on the mark. Two things pass both:

- marks of `tolerance.mark` pixels or fewer, however many: an 8 px chevron drawn as a background image
  and moved inside its box at a scale of one is ten pixels, and a pattern of dots made bars in a 12 px
  box is nine marks of four. One letter changed in small type is as small as that (a full stop for a
  comma is six pixels); the names question reads the words;
- a difference under the pixel line: one step of every channel at once, which two machines may round
  apart. A colour that differs by that step is red on the drawn values.

The reference draws its icons as inline `svg`, a slot's caret as a bordered box turned by a rule and
the line through a sign as a box drawn after it: all three are read. Where one of its scrolling
columns fades out under a mask, the picture shows it.

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
card placed a pixel apart, a row fitted by measuring): two draws of such a state differ in a data file
or by a mark over the mark line. Their picture is one of their draws, and such a key never goes into
`accepted.json` before the reference draws it one way.

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
changes (a token, an icon no longer turned, the caret pointing the other way), and red on every colour
of the reference's default block wherever that colour shows in a proved state.