import { NextResponse } from "next/server";
import { buildToken } from "../shell/app-update";

/**
 * WHICH BUILD IS THIS ORIGIN SERVING RIGHT NOW.
 *
 * One fact, for one reader: a tab that loaded some time ago and wants to know whether it is
 * still the app this origin serves (`app/shell/build-watch.ts`). A browser client is downloaded
 * once and then left running for weeks, and nothing about a deployment tells the tabs already
 * open that they are looking at an older program.
 *
 * ── IT ANSWERS A DIGEST, NOT THE COMMIT ────────────────────────────────────────────────────
 *
 * The honest name for a build is its commit, and this deliberately does not publish it. The
 * comparison the reader performs needs only to know whether two builds are the SAME, which a
 * digest answers exactly as well while telling a stranger nothing about this deployment's
 * history. `buildToken` folds the release number in beside the commit so that a deployment with
 * no commit to name — an image built from a tarball, where the sha is "dev" — still changes its
 * token when it is upgraded; without that, every such deployment would carry one token for ever
 * and no tab would ever be told anything.
 *
 * ── WHY BOTH VALUES ARE COMPILE-TIME CONSTANTS, AND WHY THAT IS THE POINT ──────────────────
 *
 * `NEXT_PUBLIC_BUILD` and `NEXT_PUBLIC_APP_VERSION` are inlined by `next.config.mjs` into
 * everything it compiles, this handler included. So the value below is baked into the build it
 * describes, and a request served by a new deployment is answered by that deployment's own
 * copy of this file. A runtime environment read would answer whatever the running process was
 * configured with, which is a different question and would keep answering the old build's name
 * through a deployment that changed nothing but the code.
 *
 * ── NOT UNDER `/api` ───────────────────────────────────────────────────────────────────────
 *
 * `/api/*` is proxied to the API deployment, and a filesystem route there is a SHADOW of that
 * proxy — `next.config.mjs` enumerates the single deliberate one and a guard holds it to
 * exactly one. This is a fact about the web deployment rather than about the API, so it lives
 * at its own path and shadows nothing.
 */
export const runtime = "nodejs";
/* Never prerendered and never cached: a cached answer is the answer of the build that was
   serving when it was cached, which is precisely the build the reader is trying to notice has
   been replaced. */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return NextResponse.json(
    { build: buildToken(process.env.NEXT_PUBLIC_APP_VERSION, process.env.NEXT_PUBLIC_BUILD) },
    { headers: { "cache-control": "no-store, max-age=0" } },
  );
}
