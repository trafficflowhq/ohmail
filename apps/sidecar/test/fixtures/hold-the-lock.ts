import { lockDataDir } from "../../src/db.js";

/**
 * ANOTHER ENGINE'S LOCK, IN A PROCESS OF ITS OWN: takes the data-directory lock on argv[2] the way
 * the engine does, says `held` on stdout, and keeps it until it is killed. `datadir-lock-hold.test.ts`
 * spawns it with argv[0] renamed, which is all it takes for macOS's `ps -o comm` to read another name.
 */
const dir = process.argv[2];
if (dir === undefined || dir === "") throw new Error("usage: hold-the-lock.ts <data directory>");
lockDataDir(dir);
process.stdout.write("held\n");
setInterval(() => undefined, 60_000);
