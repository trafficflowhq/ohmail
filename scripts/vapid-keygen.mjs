#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  MINT THIS DEPLOYMENT'S OWN VAPID KEYPAIR — for the new-mail wake, and for nothing else
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A UnifiedPush connector registers with the phone's distributor by handing it a VAPID PUBLIC
 * key (RFC 8292), and from then on it renders only messages carrying a signature it can check
 * against that key. So the server that sends the wake must hold the matching PRIVATE key. That
 * pair identifies YOUR server to YOUR phones and it is the whole of what this script makes.
 *
 * ── EVERY DEPLOYMENT GENERATES ITS OWN. NEVER COPY ANYBODY ELSE'S, INCLUDING OURS. ────────────
 *
 * The private key is not a shared secret with a value — it is the thing that lets a server
 * prove it is the one your phone registered with. Two deployments sharing a private key means
 * either of them can send wakes that the other's phones accept, and neither operator can tell.
 * There is no registry to enrol in and nothing to pay for: run this, keep the private half, and
 * the pair is yours. It never expires and it never needs rotating unless it leaks.
 *
 * Rotating it DOES cost something, which is why it is worth generating once and keeping: every
 * phone registered with the old public key stops rendering wakes until it registers again. That
 * is a re-registration, not a re-pairing — mail keeps arriving throughout, because the wake is a
 * latency improvement over the foreground sync the app does regardless.
 *
 * ── WHAT THE TWO VALUES ARE, PRECISELY ────────────────────────────────────────────────────────
 *
 * Both are base64url, unpadded, which is the encoding the Web Push ecosystem uses everywhere:
 *
 *   · the PUBLIC key is the uncompressed P-256 point (X9.62 `0x04 || X || Y`) — 65 bytes, so
 *     always exactly 87 characters. This is what the phone is given, and it is not a secret: it
 *     is served to clients by the API and it appears in the `k=` field of every wake's
 *     `Authorization` header.
 *   · the PRIVATE key is the raw 32-byte scalar — always exactly 43 characters. It belongs in
 *     the organizer's environment and NOWHERE else: not in a repository, not in a log, not in a
 *     support ticket, not in the mirror.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────────────────────────
 *
 *   node scripts/vapid-keygen.mjs                  print a fresh pair, for pasting into `.env`
 *   node scripts/vapid-keygen.mjs --out DIR        write the pair into DIR (0600) plus a README
 *   node scripts/vapid-keygen.mjs --check          verify the pair already in the environment
 *
 * `--check` reads `TF_VAPID_PUBLIC_KEY` and `TF_VAPID_PRIVATE_KEY` and answers whether they are
 * each well formed and are actually each other's counterpart. It derives the public point from
 * the private scalar and compares — so a pair from two different generations, which is the
 * failure a copy-paste produces and the one that looks like nothing at all until a phone never
 * rings, is caught by a command an operator can run. **It prints no private material, on any
 * path, including its failures.**
 */
import { createECDH, generateKeyPairSync, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const b64u = (b) => Buffer.from(b).toString("base64url");

/** Decode base64url and REQUIRE the exact byte length, because a short scalar is a silent bug. */
function decodeExact(value, bytes, what) {
  if (typeof value !== "string" || value === "") return { err: `${what} is empty` };
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return { err: `${what} is not unpadded base64url (it has characters outside A-Z a-z 0-9 - _)` };
  }
  const buf = Buffer.from(value, "base64url");
  if (buf.length !== bytes) {
    return { err: `${what} decodes to ${buf.length} bytes, and must be exactly ${bytes}` };
  }
  return { buf };
}

/**
 * Derive the public point from a private scalar.
 *
 * `createECDH().setPrivateKey()` computes and caches the matching public key, which is the only
 * thing here that needs the curve at all — this is a multiplication by the generator, not an
 * exchange with anybody.
 */
function publicFromPrivate(rawPrivate) {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(rawPrivate);
  return ecdh.getPublicKey();
}

function generate() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const rawPrivate = Buffer.from(jwk.d, "base64url");
  const rawPublic = Buffer.concat([
    Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url"),
  ]);
  // Belt and braces on our own output: assert the pair before handing it over, so a bad pair can
  // never be the thing an operator spends an afternoon on.
  if (!publicFromPrivate(rawPrivate).equals(rawPublic)) {
    console.error("refusing to emit a keypair whose halves do not match — this is a bug, not a config problem");
    process.exit(1);
  }
  return { publicKey: b64u(rawPublic), privateKey: b64u(rawPrivate) };
}

const README = (publicKey) => `# This deployment's VAPID keypair

These two files are the identity your server uses to send new-mail wakes to phones
running the ohmail app. They were generated on this machine and they are yours.

  public.key   the uncompressed P-256 point, base64url, 87 characters.
               NOT a secret. It is handed to every phone that registers, and it
               travels in the \`k=\` field of every wake request.

  private.key  the raw 32-byte scalar, base64url, 43 characters.
               A SECRET. Whoever holds it can send wakes your phones will accept.

Wire them up as:

  TF_VAPID_PUBLIC_KEY=${publicKey}
  TF_VAPID_PRIVATE_KEY=<the contents of private.key>

Both the api and the organizer read the public key; ONLY the organizer needs the
private one, because it is the process that signs and sends. Setting the public key
without the private one is a working configuration with the encrypted wake off: the
api will serve the key, phones will register, and the organizer will log
\`push_wake_vapid_unconfigured\` and skip them rather than send something no phone
can render.

Losing private.key costs a re-registration on every phone and nothing else. Mail
keeps arriving: the app syncs when you open it regardless, and the wake only ever
makes that sooner.

Never commit these, and never reuse another deployment's pair.
`;

function main(argv) {
  if (argv.includes("--check")) {
    const pub = decodeExact(process.env.TF_VAPID_PUBLIC_KEY, 65, "TF_VAPID_PUBLIC_KEY");
    const priv = decodeExact(process.env.TF_VAPID_PRIVATE_KEY, 32, "TF_VAPID_PRIVATE_KEY");
    const problems = [pub.err, priv.err].filter(Boolean);
    if (problems.length) {
      for (const p of problems) console.error(`  ✗ ${p}`);
      process.exit(1);
    }
    if (pub.buf[0] !== 0x04) {
      console.error("  ✗ TF_VAPID_PUBLIC_KEY is not in uncompressed point form (it must start with 0x04)");
      process.exit(1);
    }
    let derived;
    try {
      derived = publicFromPrivate(priv.buf);
    } catch {
      console.error("  ✗ TF_VAPID_PRIVATE_KEY is not a valid P-256 scalar");
      process.exit(1);
    }
    // Constant-time, and not because a timing attack is plausible against a local CLI — because
    // the alternative is `Buffer.equals` on secret-derived material, and picking the careful one
    // by default is cheaper than deciding each time whether it matters.
    if (derived.length !== pub.buf.length || !timingSafeEqual(derived, pub.buf)) {
      console.error("  ✗ the two keys are not a pair — the public key does not match the private one.");
      console.error("    This is what a copy-paste from two different generations looks like, and");
      console.error("    nothing else will report it: phones register happily and never ring.");
      process.exit(1);
    }
    console.log("  ✓ TF_VAPID_PUBLIC_KEY and TF_VAPID_PRIVATE_KEY are a matching P-256 pair");
    return;
  }

  const { publicKey, privateKey } = generate();
  const outAt = argv.indexOf("--out");
  if (outAt !== -1) {
    const dir = argv[outAt + 1];
    if (!dir || dir.startsWith("-")) {
      console.error("--out needs a directory");
      process.exit(1);
    }
    const at = resolve(dir);
    mkdirSync(at, { recursive: true, mode: 0o700 });
    writeFileSync(`${at}/public.key`, `${publicKey}\n`, { mode: 0o644 });
    /**
     * ── THE PRIVATE KEY: WRITTEN 0600, AND THEN MADE 0600 AGAIN ────────────────────────────────
     *
     * `mode` on `writeFileSync` applies only when the file is CREATED. Node ignores it for an
     * existing inode, so re-running `--out` over a `private.key` that was already 0644 replaced the
     * contents with a fresh private key and kept the permissive mode — while printing "0600" and
     * telling the operator it was fine. Reproduced before fixing: `chmod 0644` on an existing
     * `private.key`, re-run, still `-rw-r--r--`.
     *
     * Written with the mode FIRST so a newly created file is never briefly world-readable (a
     * create-then-chmod has exactly that window, and on a shared box that window is the bug), and
     * then `chmodSync` unconditionally so the existing-file path converges too. Both are needed:
     * neither one alone covers both cases.
     */
    const privPath = `${at}/private.key`;
    writeFileSync(privPath, `${privateKey}\n`, { mode: 0o600 });
    chmodSync(privPath, 0o600);
    // The directory is the second half of the same story: `mkdirSync`'s mode is also
    // creation-only, so a pre-existing 0755 `vapid/` stayed group- and world-traversable.
    chmodSync(at, 0o700);
    writeFileSync(`${at}/README.md`, README(publicKey), { mode: 0o644 });
    console.log(`wrote the keypair to ${at}`);
    console.log(`  public.key   ${publicKey}`);
    console.log(`  private.key  (0600, not printed)`);
    console.log(`  README.md    what each half is for and where it goes`);
    return;
  }

  console.log("# A fresh VAPID keypair for this deployment. Generated locally; nothing was sent anywhere.");
  console.log("# The private key below is a SECRET — it goes in the organizer's environment and nowhere else.");
  console.log("");
  console.log(`TF_VAPID_PUBLIC_KEY=${publicKey}`);
  console.log(`TF_VAPID_PRIVATE_KEY=${privateKey}`);
}

main(process.argv.slice(2));
