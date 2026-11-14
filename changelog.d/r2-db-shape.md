### The database moves to its 2.0 shape in one step, or not at all

ohmail 2.0 changes how its database is laid out: every row names the account it belongs to, the old search index goes where nothing is found by it alone, and the calendar gets its tables. A store that 1.0 made is moved the first time 2.0 opens it, in a single transaction. Before anything is changed the store is checked against what 1.0.11 leaves behind; afterwards every table is counted, every account is compared with what it had, and every stored password is opened under the install's own key. If any of that fails, or the app is closed half way, nothing was changed and the next start begins again.

On your own server: the server moves the database itself at its first start on 2.0, before it serves. A table of your own in the `public` schema is reported in the log and left alone, unless it uses a name 2.0 needs, in which case the server stops before changing anything and says which. Take a dump before you upgrade.

`pnpm db:setup:prod` on a database that still has the 1.0 layout now refuses unless it is told what the database is, with `--store server` or `--store cloud`. It holds no key, so it moves only a database that stores no password; a server moves its own.

On a phone, everything an update owes is applied together, so an update that is interrupted leaves the store as it was.
