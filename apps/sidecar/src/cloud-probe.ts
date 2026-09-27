import { originNeedsPin } from "@trafficflow/core/pair-link";
import { apiBaseFor, normalizeOrigin, OPERATOR_CA_FILE } from "./cloud-origin.js";
import { createHostFetch, probeHostPin } from "./host-pin-probe.js";
import type { Diagnostic } from "./log.js";
import { operatorCaFiles, probeTransport } from "./operator-ca-fetch.js";

/**
 * THE PAIRING AND SERVER CHECK, `POST /cloud/probe`, for BOTH engines. A question about a remote
 * origin with a candidate body that configures nothing, so the local engine and the cloud engine
 * mount this one handler; neither engine module imports the other. The phone's artifact carries a
 * twin (`phone/cloud-probe.ts`): this module dials, and the phone build has no door that asks it.
 */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** How long the door waits for a server to say hello. Short: somebody is watching a spinner. */
export const PROBE_DEADLINE_MS = 12_000;

/**
 * What answered at the configured address — the self-hosted door's probe. Exported and pure-ish
 * (the `fetch` is a parameter) so the classification can be test-driven, which matters because
 * every branch is a SENTENCE somebody reads when least able to guess. Every refusal names what was
 * tried — the full base — so an operator can see the app dialled `https://…/api/hello` and not
 * something else. The private-CA branch is what this route exists for: a self-host stack issues its
 * own certificates and Node verifies against its compiled-in roots, so it fails
 * `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (measured against the running stack) — the honest answer names
 * the `NODE_EXTRA_CA_CERTS` file to install, never an offer to skip verification, which nothing here can do.
 */
export async function probeCloudServer(
  cloudUrl: string,
  fetchImpl: typeof fetch,
  caFile?: string,
): Promise<Response> {
  const base = cloudUrl.replace(/\/+$/, "");
  const target = `${base}/hello`;
  /* `more` is the structured half of a refusal whose remedy is mechanical — today only the
     certificate's names. It rides in `details` beside `kind`, so a surface can read the two names
     without parsing the sentence, and the sentence carries them too because the window renders the
     engine's message whole (`self-host.ts#probeConfiguredServer`). */
  const refuse = (message: string, kind: string, more?: Record<string, unknown>): Response =>
    json(
      { error: { code: "cloud_probe_failed", message, details: { kind, target, ...(more ?? {}) } } },
      502,
    );

  let res: Response;
  try {
    res = await fetchImpl(target, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_DEADLINE_MS),
    });
  } catch (err) {
    return refuse(...describeProbeFailure(err, target, caFile));
  }

  if (!res.ok) {
    return refuse(
      `${target} answered ${res.status}. That address is reachable, but it is not answering as an ` +
        "ohmail server — check that you gave the address you open ohmail at in a browser.",
      "status",
    );
  }

  let hello: { product?: unknown; flavor?: unknown; needsSetup?: unknown; auth?: unknown };
  try {
    hello = (await res.json()) as typeof hello;
  } catch {
    return refuse(
      `Something answered at ${target}, but not with the greeting an ohmail server sends. Check ` +
        "that you gave the address you open ohmail at in a browser.",
      "not_ohmail",
    );
  }
  /* THE PRODUCT NAME IS THE CHECK, and it is worth having: a 200 with a body is what a router's
     admin page, a NAS, a parked domain and a default nginx all return. Without this the door would
     accept them, configure the install against them, and fail at the sign-in with a sentence about
     credentials — sending somebody to check a password when what is wrong is the address. */
  if (hello.product !== "ohmail") {
    return refuse(
      `Something answered at ${target}, but it is not an ohmail server. Check that you gave the ` +
        "address you open ohmail at in a browser.",
      "not_ohmail",
    );
  }

  /* ── TWO ANSWERS THAT ARE AN OHMAIL SERVER AND STILL NOT A SERVER TO SIGN IN TO ─────────────
     Both were reaching the password form, because every 2xx read as success and the greeting's own
     fields were rendered and then ignored. Raised by review. A server saying `needsSetup` has no
     accounts yet, so every credential typed into the next screen is refused by definition — and the
     person is one step away from the page that would fix it. */
  if (hello.needsSetup === true) {
    return refuse(
      `That is an ohmail server, but it has not been set up yet — there are no accounts on it. ` +
        `Open ${target.replace(/\/api\/hello$/, "")} in a browser and finish setting it up first.`,
      "needs_setup",
    );
  }
  /* And the MANAGED service answering here means somebody typed our address into the field for
     their own server. The doors are not interchangeable: this one has no browser hand-off, and the
     hosted door is the one with the account behind it. */
  if (hello.flavor === "managed") {
    return refuse(
      `${target} is the hosted ohmail service rather than a server you run. Go back and choose ` +
        "“ohmail Cloud” instead.",
      "managed",
    );
  }
  /* AND `local` IS A DESKTOP'S OWN WINDOW DOOR, which is not a door anything may pair with.
     It is the private surface an install serves to ITSELF — no pairing redeem is mounted on it, so
     a client that got this far would configure successfully and then be refused at the redeem with
     a sentence about a token. The two desktop surfaces are told apart by exactly this field: a
     machine offering itself to other devices answers `desktop-host`, and one that is merely running
     answers `local`. Refusing by name here is the difference between "turn same-network access on
     over there" and an error about a pairing code. */
  if (hello.flavor === "local") {
    return refuse(
      `${target} is an ohmail desktop that is not offering itself to other devices. On that ` +
        "computer, open Settings → Devices and turn on access for your other devices, then use " +
        "the pairing code it prints.",
      "local",
    );
  }

  /* Everything here is the SERVER's own answer about itself and none of it is secret — it is what
     that address serves to anyone who asks. The door renders the flavor so somebody who typed our
     address into the self-hosted field can see what they actually reached. */
  return json({
    ok: true,
    target,
    /* THE BASE THIS ANSWER WAS OBTAINED AT, so the caller configures the one that worked instead
       of re-deriving it. The two-step discovery below tries the root and then `/api`, and which of
       them answered is a fact only this side holds; a window that recomposed it would be a second
       opinion about the thing that was just measured. */
    base,
    flavor: typeof hello.flavor === "string" ? hello.flavor : null,
    needsSetup: hello.needsSetup === true,
    auth: hello.auth ?? null,
  });
}

/**
 * A probe's answer, narrowed to the one flavor the paired-desktop door may configure.
 * `probeCloudServer` already refuses the two flavors nothing may pair with (the hosted service, and
 * a desktop not offering itself) with sentences that name what to do. What it does not refuse is a
 * SELF-HOSTED server, right on the self-hosted door but the wrong DOOR when reached from a pairing
 * link — saying so is the difference between moving one screen back and re-printing a pairing code
 * that was never the problem. A refusal is passed through untouched: it was composed where the
 * failure happened, and a second classification here would describe something this function did not observe.
 */
async function refuseUnlessDesktopHost(said: Response, origin: string): Promise<Response> {
  if (!said.ok) return said;
  const body = (await said.clone().json()) as { flavor?: unknown };
  if (body.flavor === "desktop-host") return said;
  return json(
    {
      error: {
        code: "cloud_probe_failed",
        message:
          `${origin} is an ohmail server you run rather than a desktop offering its mailbox to ` +
          "your other devices. Go back and choose “A server I run” instead.",
        details: { kind: "selfhost", target: origin },
      },
    },
    502,
  );
}

/**
 * Where is the API at this origin? — the root, or under `/api`. Discovered, not configured: the
 * hosted service and a desktop host answer at the ROOT, a self-host stack answers under `/api` (one
 * Caddy site carries the web app too), and the person typing the address cannot know which. So both
 * are tried, root first, and the greeting decides (`probeCloudServer` composes every sentence). A
 * second dial is only worth making when the first proved nothing about the ADDRESS: "something
 * answered and was not an ohmail greeting" (`not_ohmail`) is exactly a self-host root, so that is
 * retried; a transport failure or an ohmail server already identified and REFUSED is not — repeating
 * it at a longer path produces the same failure and a worse sentence.
 */
export async function probeCloudDoor(
  origin: string,
  fetchImpl: typeof fetch,
  caFile?: string,
): Promise<Response> {
  const root = origin.replace(/\/+$/, "");
  const atRoot = await probeCloudServer(root, fetchImpl, caFile);
  if (atRoot.ok) return atRoot;

  const kind = await refusalKind(atRoot);
  if (kind !== "status" && kind !== "not_ohmail") return atRoot;
  return probeCloudServer(apiBaseFor(root), fetchImpl, caFile);
}

/**
 * The `details.kind` a refusal carries, or null when it carries none.
 *
 * CLONED, because the caller may still return this very response and a body may be read once.
 * Reading the original would hand the window a refusal whose body has been consumed — a 502 with
 * nothing in it, which the door renders as its own generic sentence and which looks like the
 * engine having failed rather than the server having answered.
 */
async function refusalKind(res: Response): Promise<string | null> {
  try {
    const body = (await res.clone().json()) as { error?: { details?: { kind?: unknown } } };
    const kind = body.error?.details?.kind;
    return typeof kind === "string" ? kind : null;
  } catch {
    return null;
  }
}

/** Node's own TLS verification failures, as the codes it raises them with. */
const TLS_FAILURE_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_UNTRUSTED",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * A thrown probe, as the sentence to show and the kind to record — the classification, alone, so a
 * test can drive every branch with a constructed error and no network.
 *
 * The code is read off the CAUSE as well as the error: `fetch` wraps transport failures in a
 * `TypeError` whose `cause` is the real one, and reading only the outer error would classify every
 * single failure — a wrong name, a refused port, an untrusted certificate — as the same shrug.
 */
export function describeProbeFailure(
  err: unknown,
  target: string,
  caFile?: string,
): [message: string, kind: string, more?: Record<string, unknown>] {
  const failure = transportFailure(err);
  const code = failure?.code ?? null;
  if (code !== null && TLS_FAILURE_CODES.has(code)) {
    if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
      /* THE ONE TLS REFUSAL WHOSE REMEDY IS MECHANICAL — a certificate issued for another name —
         and it used to name neither name, so the person was told to use "the address the
         certificate was issued for" while this process was holding it. */
      const { presented, requested } = certificateNames(failure?.at);
      const shown = presented.slice(0, MAX_CERT_NAMES);
      const rest = presented.length - shown.length;
      const names = shown.length === 0
        ? null
        : `${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
      const message = names === null
        ? `${target} answered, but its certificate is for a different name. Use the address the `
          + "certificate was issued for."
        : `${target} answered, but its certificate is for ${names}`
          + `${requested === null ? "" : `, not ${requested}`}. Use one of the names the `
          + "certificate was issued for, or give that server a certificate for the address you typed.";
      if (names === null) return [message, "tls_name"];
      return [
        message,
        "tls_name",
        { tls: { presented, ...(requested === null ? {} : { requested }) } },
      ];
    }
    if (code === "CERT_HAS_EXPIRED" || code === "CERT_NOT_YET_VALID") {
      return [`${target} answered, but its certificate is not currently valid.`, "tls_validity"];
    }
    return [
      `${target} answered, but its certificate is signed by an authority this computer does not ` +
        "trust — which is what a server that issues its own certificates looks like from here. " +
        `ohmail verifies certificates and will not skip that. Put your server's root certificate ` +
        (caFile
          ? `in ${caFile} and open ohmail again, or `
          : `in a file named ${OPERATOR_CA_FILE} in this app's data folder and open ohmail again, or `) +
        "give the server a certificate from an authority this computer already trusts.",
      "tls_trust",
    ];
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return [
      `Nothing on this network knows the name in ${target}. Check the address, or that this ` +
        "computer can look that name up.",
      "dns",
    ];
  }
  if (code === "ECONNREFUSED") {
    return [`Nothing is answering at ${target}. Check the address and the port.`, "refused"];
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "TimeoutError") {
    return [`${target} did not answer in time. Check the address, and that it is reachable from ` +
      "this computer.", "timeout"];
  }
  const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
  return [`ohmail could not reach ${target}${detail}.`, "unreachable"];
}

/**
 * The first transport code in a thrown value, down `cause` AND through `AggregateError.errors` —
 * both branches load-bearing. `fetch` throws `TypeError: fetch failed` with the real error on
 * `cause`, so reading the outer error alone classifies every failure as the same shrug (measured:
 * an untrusted cert surfaces as `cause.code = UNABLE_TO_GET_ISSUER_CERT_LOCALLY`). And a host with
 * more than one address — every dual-stack server — reports the lot as an `AggregateError` with no
 * `code` and no `cause`; a walker following only `cause` would report "unreachable" for a cert
 * problem it was holding. The first code found wins — a mixed aggregate is a judgement call, and the
 * first attempt's answer is the one the connection would have used.
 */
function transportFailure(err: unknown): { code: string; at: unknown } | null {
  const seen = new Set<unknown>();
  const walk = (cur: unknown, depth: number): { code: string; at: unknown } | null => {
    if (cur === null || cur === undefined || depth > 5 || seen.has(cur)) return null;
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return { code, at: cur };
    if ((cur as { name?: unknown }).name === "TimeoutError") return { code: "TimeoutError", at: cur };
    const nested = (cur as { errors?: unknown }).errors;
    if (Array.isArray(nested)) {
      for (const one of nested) {
        const found = walk(one, depth + 1);
        if (found !== null) return found;
      }
    }
    return walk((cur as { cause?: unknown }).cause, depth + 1);
  };
  return walk(err, 0);
}

/** The code alone, for the branches that need nothing else. ONE walk, so the two cannot diverge. */
function errorCode(err: unknown): string | null {
  return transportFailure(err)?.code ?? null;
}

/** At most this many names go into a sentence somebody reads; a certificate may carry hundreds. */
const MAX_CERT_NAMES = 4;

/**
 * THE TWO NAMES A HOSTNAME MISMATCH IS ABOUT, off the error Node threw — `host` is what was asked
 * for and `cert.subjectaltname` is what the server presented (falling back to the subject's common
 * name for a certificate old enough to have no SAN). Public by construction: they are what that
 * address serves to anyone who connects, and no key, token or fingerprint is read here.
 *
 * The list is TRUNCATED rather than dropped — a wildcard bundle can carry hundreds of names, and a
 * refusal that pastes all of them is one nobody reads.
 */
function certificateNames(at: unknown): { presented: string[]; requested: string | null } {
  const e = at as { host?: unknown; cert?: unknown };
  const requested = typeof e.host === "string" && e.host.trim() !== "" ? e.host.trim() : null;
  const cert = e.cert as { subjectaltname?: unknown; subject?: unknown } | undefined;

  const presented: string[] = [];
  const san = cert?.subjectaltname;
  if (typeof san === "string") {
    for (const entry of san.split(",")) {
      /* `DNS:a.example.com, IP Address:10.0.0.1` — the TYPE is dropped and the value kept, because
         the person is being asked to compare it with the address they typed. */
      const value = entry.trim().replace(/^[A-Za-z ]+:/, "").trim();
      if (value !== "" && !presented.includes(value)) presented.push(value);
    }
  }
  const cn = (cert?.subject as { CN?: unknown } | undefined)?.CN;
  if (presented.length === 0 && typeof cn === "string" && cn.trim() !== "") presented.push(cn.trim());

  return { presented, requested };
}

/** What an engine hands the route: where it keeps things, and the door it is configured for. */
export interface CloudProbeDoor {
  dataDir: string;
  operatorCaFile?: string;
  /** The test seam for a CANDIDATE dial — never the transport of the door being left. */
  fetchImpl?: typeof fetch;
  log?: Diagnostic;
  /**
   * The engine's own configured server, which the no-origin arm probes. `null` on the local
   * engine: it has no cloud base, and that arm refuses rather than invent one.
   */
  configured: { base: string; fetchImpl: typeof fetch; caFile?: string } | null;
}

export const CLOUD_PROBE_ROUTE = "/cloud/probe";

/**
 * The route's body. It takes a CANDIDATE origin deliberately: probing the configured base forced
 * configuring first, which runs `enforceMirrorOwner` and destroyed a whole mirror on a MISTYPED
 * address. The cost (the window can make this dial an origin it chooses) is bounded by
 * `normalizeOrigin`. It asks `/hello`, because only `/hello` names the product and the flavor.
 */
export async function answerCloudProbe(req: Request, door: CloudProbeDoor): Promise<Response> {
  let candidate: unknown = null;
  let wantFlavor: unknown = null;
  let wantPin: unknown = null;
  try {
    const parsed = (await req.json()) as { origin?: unknown; flavor?: unknown; hostPin?: unknown };
    candidate = parsed.origin ?? null;
    wantFlavor = parsed.flavor ?? null;
    wantPin = parsed.hostPin ?? null;
  } catch {
    /* No body, or not JSON: probe what this engine is configured for. */
  }
  if (candidate === null || candidate === undefined) {
    /* THE LOCAL ENGINE HAS NO CONFIGURED SERVER, so this arm refuses there: a fallback would
       invent an address nobody chose. */
    if (door.configured === null) {
      return json(
        {
          error: {
            code: "invalid_request",
            message: "this engine is not configured for a server, so name the address to check",
            details: { kind: "origin_required" },
          },
        },
        400,
      );
    }
    return probeCloudServer(door.configured.base, door.configured.fetchImpl, door.configured.caFile);
  }
  if (typeof candidate !== "string") {
    return json(
      { error: { code: "invalid_request", message: "the origin to probe must be text" } },
      400,
    );
  }
  /* THROUGH THE DOOR'S OWN PARSE, which is the whole of the bound on what this route can be
     made to dial: https, or http on loopback, with no path, query, fragment or credentials.
     The `/api` is composed here rather than accepted, so the path is never the caller's. */
  const origin = normalizeOrigin(candidate);
  if (origin === null) {
    /* CLEARTEXT IS ITS OWN REFUSAL when the door asked for a paired desktop, because it is
       the one shape a person can produce by hand and reasonably expect to work: an address
       copied off a machine that serves plain HTTP. `normalizeOrigin` admits `http:` only on
       loopback, so a rejected `http://<something else>` is exactly that case and deserves
       the sentence rather than the general one about server addresses. */
    const raw = typeof candidate === "string" ? candidate.trim() : "";
    if (wantFlavor === "desktop-host" && /^http:\/\//i.test(raw)) {
      return json(
        {
          error: {
            code: "invalid_request",
            message:
              "That address is not encrypted, so ohmail will not send your mail over it. " +
              "Use the link that computer printed, which always names an encrypted address.",
            details: { kind: "cleartext", target: raw },
          },
        },
        400,
      );
    }
    return json(
      {
        error: {
          code: "invalid_request",
          message:
            "that is not a server address this app can open: it must be https (or http on " +
            "this machine), with nothing after the host",
        },
      },
      400,
    );
  }
  /* ── THE PAIRED-DESKTOP ARM ─────────────────────────────────────────────────────────
     A desktop host is the one door whose certificate nothing can vouch for, so the probe
     has to establish the pin BEFORE it will speak to the address at all. Everything below
     happens with nothing configured — the whole reason this route takes a candidate — so a
     wrong link costs no mirror. */
  if (wantFlavor === "desktop-host") {
    const pin = typeof wantPin === "string" ? wantPin.trim() : "";
    /* AN ADDRESS NO CERTIFICATE CAN BE ISSUED FOR NEEDS THE FINGERPRINT. `originNeedsPin` is
       the pairing grammar's own predicate — the same one the phone applies — rather than a
       second IP test written here, so the two clients cannot disagree about which addresses
       are safe to pair with unpinned. */
    if (pin === "" && originNeedsPin(origin)) {
      return json(
        {
          error: {
            code: "invalid_request",
            message:
              "That link does not carry the other computer's identity, and an address like " +
              "this one cannot be checked without it. Print a fresh pairing code on that " +
              "computer and paste the whole link.",
            details: { kind: "no_pin", target: origin },
          },
        },
        400,
      );
    }
    if (pin !== "") {
      const url = new URL(origin);
      const seen = await probeHostPin({
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port === "" ? 443 : Number(url.port),
        pin,
        /* WRITTEN INTO THE REAL DATA DIRECTORY, and this is a cache warm-up rather than a
           commitment: nothing about the door is configured by a probe, and a leaf left here
           for an address that is never chosen is a public certificate that the next pinned
           connection either uses or replaces on its first verification failure. */
        dataDir: door.dataDir,
        ...(door.log ? { log: door.log } : {}),
      });
      if (!seen.ok) {
        return json(
          {
            error: {
              code: "cloud_probe_failed",
              message: seen.message,
              details: {
                kind: seen.code === "pin_changed" ? "pin_mismatch" : seen.code,
                target: origin,
              },
            },
          },
          502,
        );
      }
      /* AND THE GREETING IS FETCHED OVER THE PINNED CONNECTION, not an ordinary one. Proving
         the key and then asking the question over a connection that did not check it would
         be answering about whatever holds the address now. */
      const pinned = createHostFetch({
        origin, pin, dataDir: door.dataDir, ...(door.log ? { log: door.log } : {}),
      });
      const said = await probeCloudDoor(origin, door.fetchImpl ?? pinned);
      return refuseUnlessDesktopHost(said, origin);
    }
    return refuseUnlessDesktopHost(await probeCloudDoor(origin, door.fetchImpl ?? fetch), origin);
  }

  /* THE ORIGIN, NOT A BASE — `probeCloudDoor` decides whether the API is at the root or
     under `/api` from the server's own greeting, not from anything this window could know.
     AND IT DIALS WITH THE OPERATOR'S OWN CA, read at THIS MOMENT from the shell's path: the
     candidate is somebody's own server and usually issues its own certificates, whose trust
     used to arrive only as `NODE_EXTRA_CA_CERTS` at launch — which a process already running
     cannot be given, so an install moving to such a server probed with the previous door's
     trust and was refused for a reason nothing the person typed could fix. `probeTransport`
     falls back to the platform's `fetch` when no CA is installed, so a publicly-trusted
     server is dialled exactly as before. */
  return probeCloudDoor(
    origin,
    door.fetchImpl ?? probeTransport(door, door.log),
    operatorCaFiles(door).file,
  );
}
