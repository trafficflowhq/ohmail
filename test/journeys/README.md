# Journeys

What a person does and sees, on the built app, found by role and name.

    TF_JOURNEYS=selfhost npx vitest run test/journeys        # W-s: a self-hosted server
    TF_JOURNEYS=managed  npx vitest run test/journeys        # W-m: the managed build
    TF_JOURNEYS=demo     npx vitest run test/journeys        # W-d: the demo, no server
    TF_JOURNEYS=host     npx vitest run apps/desktop/test/journeys-host.test.ts   # H: the page a desktop serves

Unset, every journeys file is skipped and only `guards.test.ts` runs. Set, a missing build or browser
fails. `TF_JOURNEYS_LANG=de` runs the same journeys over the German catalogue. The first file builds the
web app (`next build`); the others start what it built, as long as the web app's and the packages' files
are the ones it was built from (git's trees, or the files themselves where there is no git).
`TF_JOURNEYS_BUILT=1` trusts a build that is already in `apps/webapp/.next`. `TF_JOURNEYS_DEBUG=1` prints what the page showed when a journey fails,
and `TF_JOURNEYS_RECORD=<dir>` keeps the server's log of method and pattern per place.

The desktop's four doors are read in jsdom over a real engine by
`apps/desktop/test/journeys-doors.test.tsx`; that file runs with the suite.

## How a journey is written

- **`vocabulary/`** is the only place that knows how a thing is found. `places.ts` has each place's
  address and the landmark that says you are there. `controls.ts` has each control's role and the
  catalogue key of its name. `acts.ts` says how a surface performs an act. `world.ts` plants the mail
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

One file per place: the views, each Settings section, the open message, and the doors.
