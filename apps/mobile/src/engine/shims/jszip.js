/**
 * THE ZIP ARCHIVER, REFUSED — imported at module scope by the attachments service, never
 * constructed on this path.
 *
 * Only the two download-all routes build an archive. The phone's app opens attachments one at a
 * time and never asks for either route, and the phone is no host, so nothing relays one to it.
 * The refusal names the missing capability instead of failing somewhere that reads like a server.
 */
"use strict";

class JSZip {
  constructor() {
    throw new Error(
      "Downloading attachments as one zip is not available in this app. " +
        "Open each attachment on its own; the zip routes are served by the desktop and web apps.",
    );
  }
}

module.exports = JSZip;
