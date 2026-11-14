# Journeys

What a person does and sees, on the built app, found by role and name.

    TF_JOURNEYS=selfhost npx vitest run test/journeys/journeys/   # W-s: a self-hosted server
    TF_JOURNEYS=managed  npx vitest run test/journeys/journeys/   # W-m: the managed build
    TF_JOURNEYS=demo     npx vitest run test/journeys/journeys/   # W-d: the demo, no server
    TF_JOURNEYS=host     npx vitest run apps/desktop/test/journeys-host.test.ts   # H: the page a desktop serves
    TF_JOURNEYS=stack    ...                                     # W-i: the self-hosted stack from its images (below)
    TF_JOURNEYS=desktop  ...                                     # D-s: the Linux desktop's preview AppImage
    TF_JOURNEYS=android  ...                                     # P-p: the phone's web view on an emulator

A vitest path is a filter on every file's path, so the journeys are named by their own folder: a bare
`test/journeys` also takes `apps/desktop/test/journeys-*`. `stack`, `desktop` and `android` each need their
rig; a bench that is named and missing fails, never skips. `TF_JOURNEYS_SIZE=medium|compact` runs the
window at 719 or 390 wide (expanded, 1440, unless named).

The stack has one way in: from the repository's root, `.github/scripts/selfhost-smoke.sh --build --dir
deploy/selfhost --tag <tag> --commit "$(git rev-parse HEAD)" --journeys` builds the three images, boots them,
runs the first-run ceremony and its checks, hands over the invites (`TF_JOURNEYS_STACK`), runs the journeys of
W-i and tears the stack down. `journeys.yml`'s `stack` job runs exactly that.

Unset, every journeys file is skipped and only `guards.test.ts` runs. Set, a missing build or browser
fails. `TF_JOURNEYS_LANG=de` runs the same journeys over the German catalogue. The first file builds the
web app (`next build`); the others start what it built, as long as the web app's and the packages' files
are the ones it was built from (git's trees, or the files themselves where there is no git).
`TF_JOURNEYS_BUILT=1` trusts a build that is already in `apps/webapp/.next`. `TF_JOURNEYS_DEBUG=1` prints what the page showed when a journey fails,
and `TF_JOURNEYS_RECORD=<dir>` keeps the server's log of method and pattern per place.

The desktop's four doors are read in jsdom over a real engine by
`apps/desktop/test/journeys-doors.test.tsx`; that file runs with the suite.

## The seam

Every bench gives a journey the same words, `bench/seam.ts`: a `Person` arrives at a place, acts on a
control, sees it, reads its rows; a `Bench` makes accounts, plants the world, faults a door. The window
behind it is the bench's: a Playwright page for the web, the stack and the phone's web view
(`bench/dom-playwright.ts`), the desktop's window driver for the desktop. A journey never reaches past the
seam. `guards.test.ts` holds every file under `journeys/` to a list of what it may import (`bench/seam`,
`bench/journey`, `bench/web`, `bench/panes`, `bench/totp`, a vocabulary file, vitest, a `node:` module), in
every spelling (`import`, `export … from`, `import type`, `import()`), and never a bench module's every name at
once (`* as`). It refuses the names `page`, `context` and `located` anywhere in a journey's code (a member, a
binding, a field taken apart, a parameter), a driver's `page`, `context`, `find` or `located` read by brackets,
and a journey that keeps what `see` found.

A failing act prints no credential: an address's hash only when it is one of the app's routes (`#/…`), and of
a box that dropped words, how many characters it kept, never the words.

A bench that stands in for another setting (`vocabulary/surfaces.ts`: the stack for W-s, the desktop and the
paired phone for W-s) runs a journey of that setting only when its standing list names it
(`bench/standing/`). A smaller size runs only the titles `bench/standing/sizes.ts` lists for it.

## Who writes which line

A screen's seat changes the vocabulary and nothing else here:

- its place's rows in `vocabulary/controls.ts` and `vocabulary/places.ts`;
- its place's titles in `bench/standing/sizes.ts` once the place is drawn at that size, and on the phone its
  place id in `vocabulary/surfaces.ts` `PHONE_SEATED`;
- a journey's text only where its flow gained a step, said in its pull request;
- a journey that walks a control the new view no longer has leaves with that seat, by a row in
  `tools/retirement.tsv` naming the test seen red in its place. It is never skipped.

The benches, `guards.test.ts`, this file, `vocabulary/index.ts`, `controls-doors.ts` (until the doors'
seat takes its rows), `surfaces.ts`, `world.ts`, `catalogue.ts` and the standing lists are the journeys'
own. A new journey goes into a new file, `<place>.<set>.journeys.test.ts`.

## How a journey is written

- **`vocabulary/`** is the only place that knows how a thing is found. `places.ts` has each place's
  address and the landmark that says you are there; `guards.test.ts` reads each address through the
  frame's own route. `controls.ts` and `controls-doors.ts` have each control's role and the catalogue key
  of its name, read through `index.ts`. `acts.ts` says how a surface performs an act. `world.ts` plants the mail
  a journey starts from. `panes.ts` is which Settings sections each setting lists today.
- **A journey names things, never finds them.** `person.act("press", "reply")`,
  `person.see("conversation", { named })`. No selector, no sentence, no wait for time: `guards.test.ts`
  refuses them in every file here.
- **A name is the catalogue's text, whole.** Reword a button and no journey changes. A control whose
  name the app follows with a count is marked `counted`; one the world names (a conversation, a tag)
  is `nameFrom: "visible"`.
- **A keyboard act presses the key the control announces** (`aria-keyshortcuts`). No key of the product
  is written here.
- **One promise per journey**, and each file exports `GUARDS`: the title, the faults it stands for (plain
  keys), the settings it exists in, and what it needs. A journey is skipped in a setting it does not
  exist in, and fails where it needs something the bench does not have.
- **Three promises hold for every journey:** no request leaves the machine, the page logs no error, and
  nothing is retried: a box is filled once, and words it drops are a fault. A journey that expects a
  logged line (a refused door logs its status) says so in `tolerates`.
- **A door of the server can be made to fail:** `b.faults` refuses a request at the wire or holds it,
  asked and unanswered, until `b.release()`. A journey about a slow or silent server holds the door; it
  never waits for time.
- **Which sections a menu lists is held, not their order.** Where a thing stands is the design's.
- **A fault that stands today has a journey marked `open`:** it is expected to fail, and turns the run red
  the day it stops failing.

One file per place, or more than one (`<place>.<set>.journeys.test.ts`): the views, each Settings section,
the open message, and the doors.
