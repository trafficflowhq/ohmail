# @ohmail/app-logic

Behaviour without a screen: hooks and plain functions the views call. No markup, no styles, no
web framework (React itself is allowed; the web shell's router, links and text package are not).

It may import `@ohmail/client-engine` and `@trafficflow/core`, and nothing else of the product:
never the component kit, the tokens, or an app. `test/borders.test.ts` builds every file here and
refuses a bundle that reaches one of them.

## Doors

New code imports a folder's door. A door is the folder's `index.ts` and names what the folder offers.

| Door | Holds |
|---|---|
| `@ohmail/app-logic/storage` | the storage scope: whose keys these are, and the doors to what a browser keeps |
| `@ohmail/app-logic/session` | the session's truth, the sync scheduler, the resume lane, vitals, the boot cache |
| `@ohmail/app-logic/engine` | the context a shell's provider fills, and the hooks that read an engine |
| `@ohmail/app-logic/lists` | the list, stream and held windows, columns, older mail, folders |
| `@ohmail/app-logic/reading` | what turns a letter read, the reader's holder, the conversation on screen |
| `@ohmail/app-logic/reader` | the reading column's behaviour: its visit, its letters' text and pictures, the squares' walk, its own verbs |
| `@ohmail/app-logic/press` | the one seam a press leaves the interface through, and Undo |
| `@ohmail/app-logic/mail-state` | the mailbox state ladder and its keys, and the binding every view reads it through |
| `@ohmail/app-logic/consent` | the consent row: what the account allows and when it was set, the read it takes, where a change travelled |
| `@ohmail/app-logic/doors` | the first run, pairing, an update, the wall |
| `@ohmail/app-logic/ohbox` | the Ohbox's behaviour: placement by arrival, the picks, the read hold, Undo's place, its keys; and the door its model stands behind |
| `@ohmail/app-logic/keys` | the keyboard registry and its bindings, the zones the arrows walk, focus that follows the list |
| `@ohmail/app-logic/layout` | what the window's width says about the layout |
| `@ohmail/app-logic/screener` | the Screener's state, its decision journal, and the types a decision shares with the views |
| `@ohmail/app-logic/writing` | sending once, the send lock, the composer's and the reply's drafts, the rich text |
| `@ohmail/app-logic/text` | the catalogue's reader as behaviour takes it, how an address is shown, and the interface's languages |
| `@ohmail/app-logic/geometry` | geometry under the text size |
| `@ohmail/app-logic/mailboxes/connect/<file>` | connecting a mailbox: the sealed password, what a connect, a test and an edit send, a refusal and its sentence, the two consents, the second factor's machine, the one form's machine and hook |
| `@ohmail/app-logic/mailboxes/first-run/<file>` | the first run: its rules and its pull rate moved out of the shell's stage, the seed offer (the scope required), the readers of the wire's answers and of a refused write, its hooks one a step, its states |
| `@ohmail/app-logic/mailboxes/pane/<file>` | the Mailboxes pane: its rows' rules (moved out of the shell's pane), the verbs by capability, the list, the one slot of gated presses, the take-over check, the plain presses, the readers of the check and the filings (moved out of the shell's two files), the row's sentences and its times |
| `@ohmail/app-logic/mailboxes/contract`, `/pane-contract`, `/moved` | the connect form's and the pane's types as the host contract names them, and the moved rules as the old shell's files still import them: each one path of two names, which every shell's bundle resolves |

`mailboxes/` has no door of its own: its files are imported one by one, each by its own line of `package.json`. A
path of two names under this package is read by the test runner as a file, so a folder's door one level down would not
resolve there.

Behaviour is handed its words: a hook that speaks takes a `Translator` (or a small record of them) from its mount,
never a catalogue of its own.

The files that were moved here out of the web app's shell are still imported one by one
(`@ohmail/app-logic/<folder>/<file>`), by the shell they came from and by its tests: a move
changes where a module lives, not which modules a page loads. Each has its own line in
`package.json` for that, and the line goes when the old shell's last import of the file does.

## The twins

`geometry/ui-zoom.ts` and `keys/scroll-keys.ts` are the kit's `ui-zoom.ts` and its scroll keys,
and `screener/decision.ts` holds the kit's quiet destinations, `DECISION_QUIET`; all are
kept equal by `apps/webapp/test/app-logic-twins.test.ts`. Behaviour does not import the kit, and
the kit needs both for itself until it is rewritten; then it stops exporting them and the twin
test goes.
