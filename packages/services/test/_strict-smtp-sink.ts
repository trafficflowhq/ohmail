import net from "node:net";

/**
 * A SUBMISSION SERVER THAT HOLDS THE LINE-LENGTH RULE, on loopback. RFC 5321 §4.5.3.1.6 caps a text
 * line at 1000 octets with its CRLF; a strict server (iCloud's among them) refuses a message carrying
 * a longer one after DATA, so a builder that left an unfolded header or an 8bit body line over 998
 * octets fails there and nowhere a lenient sink would show it. This one refuses exactly that with a
 * 5xx after the final dot, keeps every message it accepted (dot-unstuffed, as the server would
 * store it) and counts the RCPTs of each. Plaintext, no AUTH: the adapter's loopback harness rule.
 */
export interface StrictSmtpSink {
  readonly port: number;
  /** The accepted messages, in order. */
  readonly messages: Buffer[];
  /** The RCPT count of each accepted message. */
  readonly recipients: number[];
  /** Why each refused message was refused. */
  readonly refusals: string[];
  close(): Promise<void>;
}

/** The longest text line, CRLF excluded, a strict server accepts. */
export const SMTP_MAX_LINE_OCTETS = 998;

export async function startStrictSmtpSink(): Promise<StrictSmtpSink> {
  const messages: Buffer[] = [];
  const recipients: number[] = [];
  const refusals: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => sock.destroy());
    let buf = Buffer.alloc(0);
    let inData = false;
    let rcpts = 0;
    let lines: Buffer[] = [];
    let longest = 0;
    const say = (s: string): void => { sock.write(`${s}\r\n`); };
    say("220 sink.example.test ESMTP strict");
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (let nl = buf.indexOf("\r\n"); nl >= 0; nl = buf.indexOf("\r\n")) {
        const line = buf.subarray(0, nl);
        buf = buf.subarray(nl + 2);
        if (inData) {
          if (line.length === 1 && line[0] === 0x2e) {
            inData = false;
            if (longest > SMTP_MAX_LINE_OCTETS) {
              refusals.push(`line of ${longest} octets`);
              say(`500 5.5.2 Line too long (${longest} octets; the limit is ${SMTP_MAX_LINE_OCTETS})`);
            } else {
              messages.push(Buffer.concat(lines.flatMap((l) => [l, Buffer.from("\r\n")])));
              recipients.push(rcpts);
              say("250 2.0.0 queued");
            }
            lines = []; longest = 0; rcpts = 0;
            continue;
          }
          const stored = line.length > 0 && line[0] === 0x2e ? line.subarray(1) : line;
          longest = Math.max(longest, line.length);
          lines.push(Buffer.from(stored));
          continue;
        }
        const cmd = line.toString("latin1");
        const verb = cmd.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO") say("250-sink.example.test\r\n250-SIZE 28311552\r\n250-8BITMIME\r\n250 PIPELINING");
        else if (verb === "HELO") say("250 sink.example.test");
        else if (verb === "MAIL") { rcpts = 0; say("250 2.1.0 OK"); }
        else if (verb === "RCPT") { rcpts += 1; say("250 2.1.5 OK"); }
        else if (verb === "DATA") { inData = true; say("354 End data with <CR><LF>.<CR><LF>"); }
        else if (verb === "RSET") { rcpts = 0; say("250 2.0.0 OK"); }
        else if (verb === "NOOP") say("250 2.0.0 OK");
        else if (verb === "QUIT") { say("221 2.0.0 Bye"); sock.end(); }
        else say("502 5.5.2 Command not implemented");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, messages, recipients, refusals,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Every line of a message longer than the strict server's limit, by length. */
export function overlongLines(message: Buffer): number[] {
  const out: number[] = [];
  let at = 0;
  for (let nl = message.indexOf("\r\n", at); nl >= 0; nl = message.indexOf("\r\n", at)) {
    if (nl - at > SMTP_MAX_LINE_OCTETS) out.push(nl - at);
    at = nl + 2;
  }
  return out;
}
