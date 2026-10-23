import net from "node:net";
import { refusalLine, type ProviderRefusal } from "./_providershape.js";

/**
 * A STRICT LOOPBACK IMAP SERVER THAT SIGNS IN THE WAY GOOGLE IS BELIEVED TO: one password, exactly
 * as given, is accepted; every other is answered with a refusal from `gmail.refusals.json` (picked
 * by `refusalFor`, else the plain-Google-password one). Plaintext, for the consent dial. It counts
 * logins and keeps no password; nothing here logs.
 */
export interface GoogleShapedImap {
  port: number;
  /** LOGIN/AUTHENTICATE commands answered, accepted or not. */
  readonly logins: number;
  /** Logins accepted. */
  readonly accepted: number;
  close(): Promise<void>;
}

const CAPS = "IMAP4rev1 UNSELECT IDLE NAMESPACE QUOTA ID XLIST CHILDREN X-GM-EXT-1 XYZZY SASL-IR AUTH=XOAUTH2 AUTH=PLAIN AUTH=PLAIN-CLIENTTOKEN AUTH=OAUTHBEARER";
const CAPS_AFTER = "IMAP4rev1 UNSELECT IDLE NAMESPACE QUOTA ID XLIST CHILDREN X-GM-EXT-1 UIDPLUS ENABLE MOVE CONDSTORE ESEARCH UTF8=ACCEPT LIST-EXTENDED LIST-STATUS LITERAL- SPECIAL-USE";

export async function startGoogleShapedImap(o: {
  accept: string;
  fallback: ProviderRefusal;
  refusalFor?: (pass: string) => ProviderRefusal | null;
}): Promise<GoogleShapedImap> {
  let logins = 0;
  let accepted = 0;
  const open = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    open.add(sock);
    sock.on("close", () => open.delete(sock));
    let buf = "";
    let authed = false;
    let pending: string | null = null;
    const answer = (tag: string, pass: string): void => {
      logins++;
      if (pass === o.accept) {
        accepted++;
        authed = true;
        sock.write(`${tag} OK [CAPABILITY ${CAPS_AFTER}] signed in (Success)\r\n`);
        return;
      }
      sock.write(refusalLine(tag, o.refusalFor?.(pass) ?? o.fallback) + "\r\n");
    };
    const plainPass = (b64: string): string => Buffer.from(b64, "base64").toString("utf8").split("\u0000")[2] ?? "";
    sock.write("* OK Gimap ready for requests from 127.0.0.1 synthetic\r\n");
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (pending !== null) {
          const t = pending;
          pending = null;
          answer(t, plainPass(line));
          continue;
        }
        const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
        if (!m) continue;
        const tag = m[1]!;
        const cmd = m[2]!.toUpperCase();
        const rest = m[3] ?? "";
        if (cmd === "CAPABILITY") sock.write(`* CAPABILITY ${authed ? CAPS_AFTER : CAPS}\r\n${tag} OK Thats all she wrote!\r\n`);
        else if (cmd === "ID") sock.write(`* ID ("name" "GImap")\r\n${tag} OK Success\r\n`);
        else if (cmd === "AUTHENTICATE") {
          const [mech, ir] = rest.split(" ");
          if ((mech ?? "").toUpperCase() !== "PLAIN") { sock.write(`${tag} NO unsupported\r\n`); continue; }
          if (!ir) { pending = tag; sock.write("+ \r\n"); continue; }
          answer(tag, plainPass(ir));
        } else if (cmd === "LOGIN") {
          const q = /^"(?:[^"\\]|\\.)*" "((?:[^"\\]|\\.)*)"$/.exec(rest);
          answer(tag, q ? q[1]!.replace(/\\(.)/g, "$1") : "");
        } else if (cmd === "NAMESPACE") sock.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK Success\r\n`);
        else if (cmd === "ENABLE") sock.write(`* ENABLED\r\n${tag} OK Success\r\n`);
        else if (cmd === "LIST" || cmd === "XLIST" || cmd === "LSUB") sock.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK Success\r\n`);
        else if (cmd === "NOOP") sock.write(`${tag} OK Success\r\n`);
        else if (cmd === "LOGOUT") { sock.write(`* BYE LOGOUT Requested\r\n${tag} OK 73 good day (Success)\r\n`); sock.end(); }
        else sock.write(`${tag} BAD Unknown command\r\n`);
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    get logins() { return logins; },
    get accepted() { return accepted; },
    close: () => new Promise<void>((r) => {
      for (const s of open) s.destroy();
      server.close(() => r());
    }),
  };
}
