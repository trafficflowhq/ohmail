/**
 * THE MAILBOX SELF-CHECK'S REQUEST — over an injected transport, with no door in this module, for
 * `trash-wire.ts`'s reason: the served host client has no bridge, and `scan:host` refuses the shell
 * command's name in the bundle a phone is handed. One bare GET; the answer is the engine's reading,
 * handed back raw for the pane to narrow. A non-2xx answer throws with its status.
 */
export async function selfCheckVia(
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>,
  mailboxId: string,
): Promise<unknown> {
  const res = await fetchImpl(`/mailboxes/${encodeURIComponent(mailboxId)}/self-check`);
  if (!res.ok) throw new Error(`the mail engine answered ${res.status}`);
  return res.json();
}
