import type { KitSubject } from "../harness.js";
import { editor } from "./mail/editor.js";
import { letters } from "./mail/letters.js";
import { lists } from "./mail/lists.js";
import { reading } from "./mail/reading.js";
import { settings } from "./mail/settings.js";
import { shell } from "./mail/shell.js";

/** One subject for every row of `test/reference/mail/states.json`. */
export const subjects: KitSubject[] = [...shell, ...lists, ...reading, ...letters, ...editor, ...settings];
