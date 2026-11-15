import { createServer, type AddressInfo, type Socket } from "node:net";

/** A change of protocol, with the two lines that ask for one: the answer a pinned request never takes. */
export const SWITCH = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n";

/**
 * A far side of a test's own on 127.0.0.1, raw: it answers a request's first bytes with `act` and ends nothing
 * by itself. `close` ends the listener and every connection it took.
 */
export async function farSide(act: (socket: Socket) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const taken: Socket[] = [];
  const server = createServer((socket) => {
    taken.push(socket);
    socket.on("error", () => undefined);
    socket.once("data", () => act(socket));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      for (const socket of taken) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
