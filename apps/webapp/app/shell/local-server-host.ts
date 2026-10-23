import { asAuthHint, type AuthHint } from "./providers";

/**
 * IS THIS HOST THIS COMPUTER? The client's copy of `loopbackHarnessReason` (core `imap-types.ts`):
 * 127.0.0.0/8, ::1 (`[::1]` too, which the engine dials at ::1) and the exact name `localhost`,
 * never a `*.localhost` name. For the long-wait door's pending line and its held Test only; every
 * sentence after the answer is the engine's own reading (`details.localServer`, `errorLocalServer`).
 * Held to the original by one shared table.
 */
export function isLocalServerHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h === "localhost") return true;
  const v6 = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (v6 === "::1" || v6 === "0:0:0:0:0:0:0:1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) && parts[0] === 127;
}

/**
 * THE ENGINE'S OWN READING of a probe refusal: the server that refused is on this computer
 * (`details.localServer`, stamped by the service from the host it dialled). Structural, so the
 * desktop's wire error and the hosted `ApiError` read alike.
 */
export function refusedByLocalServer(err: unknown): boolean {
  const e = err as { code?: unknown; details?: unknown } | null | undefined;
  if (typeof e !== "object" || e === null || e.code !== "mailbox_probe_failed") return false;
  return (e.details as { localServer?: unknown } | null | undefined)?.localServer === true;
}

/** Which leg refused: `details.transport`, the incoming one when unsaid. */
export function refusalTransport(err: unknown): "imap" | "smtp" {
  const d = (err as { details?: unknown } | null | undefined)?.details;
  return (d as { transport?: unknown } | null | undefined)?.transport === "smtp" ? "smtp" : "imap";
}

/**
 * WHY GOOGLE REFUSED THE SIGN-IN (`details.authHint`, stamped by the service on an incoming `auth`
 * refusal from one of its hosts), or `null`. Structural like the two above; a word outside the
 * closed set is no hint, so an older or newer server degrades to the generic sentence.
 */
export function refusalAuthHint(err: unknown): AuthHint | null {
  const e = err as { code?: unknown; details?: unknown } | null | undefined;
  if (typeof e !== "object" || e === null || e.code !== "mailbox_probe_failed") return null;
  return asAuthHint((e.details as { authHint?: unknown } | null | undefined)?.authHint);
}

/**
 * The `mailboxes.probe_*` key: a local server's own sentence for `auth`, and for `timeout` on the
 * incoming leg only — the two-minute wait is that leg's; the submission leg keeps its 20 s. Google's
 * refused sign-in says its own (`probe_auth_gmail_<hint>`), the incoming leg only.
 */
export function probeCopyKey(
  reason: string, localServer: boolean, transport: "imap" | "smtp" = "imap", authHint?: AuthHint | null,
): string {
  if (reason === "auth" && transport === "imap" && !localServer && authHint) return `probe_auth_gmail_${authHint}`;
  const own = reason === "auth" || (reason === "timeout" && transport === "imap");
  return localServer && own ? `probe_${reason}_local` : `probe_${reason}`;
}
