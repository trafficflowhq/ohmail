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
| `@ohmail/app-logic/press` | the one seam a press leaves the interface through, and Undo |
| `@ohmail/app-logic/mail-state` | the mailbox state ladder and its keys |
| `@ohmail/app-logic/doors` | the first run, pairing, an update, the wall |
| `@ohmail/app-logic/geometry`, `/keys`, `/screener`, `/text` | geometry under the text size, key lists, and the types behaviour shares with the views |

The files that were moved here out of the web app's shell are still imported one by one
(`@ohmail/app-logic/<folder>/<file>`), by the shell they came from and by its tests: a move
changes where a module lives, not which modules a page loads. Each has its own line in
`package.json` for that, and the line goes when the old shell's last import of the file does.

## Two twins

`geometry/ui-zoom.ts` and `keys/scroll-keys.ts` are the kit's `ui-zoom.ts` and its scroll keys,
kept equal by `apps/webapp/test/app-logic-twins.test.ts`. Behaviour does not import the kit, and
the kit needs both for itself until it is rewritten; then it stops exporting them and the twin
test goes.
