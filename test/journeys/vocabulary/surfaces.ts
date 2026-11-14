import type { Setting } from "../bench/seam.js";

/**
 * WHICH SETTING ANOTHER STANDS IN FOR. A bench whose setting is a key here runs a journey written for the
 * value's setting when the journey's title is on that bench's standing list (`bench/standing/`): the
 * self-hosted web from its images is the self-hosted web; the desktop against a self-hosted server and the
 * paired phone show that server's web.
 */
export const MIRRORS: Readonly<Partial<Record<Setting, Setting>>> = { "W-i": "W-s", "D-s": "W-s", "P-p": "W-s" };

/** The places the phone has seated; a phone's journey of a place runs only once its id stands here. Each phone seat adds its own. */
export const PHONE_SEATED: readonly string[] = [];
