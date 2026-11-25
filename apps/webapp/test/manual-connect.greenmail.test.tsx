/** @vitest-environment jsdom */
import { randomUUID } from "node:crypto";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApp, apiRoutes } from "@trafficflow/api";
import { mailboxCredentials } from "@trafficflow/db";
import { serviceUp } from "@trafficflow/db/testing";
import { FIXED_NOW, makeDeps, req, seedSession } from "../../../packages/api/test/helpers.js";
import { draw, J, M, O, P } from "../../../packages/app/test/mailboxes/connect/support.js";
import { greenmailEndpoint, readLaneGreenmail } from "../../../scripts/lib/lane-greenmail-env.mjs";
import { ApiError, mailboxes } from "../app/api-client";
import { webConnectWire } from "../app/(product)/mailbox/connect-wire";
import { withNodeBlobs } from "./fixtures/node-blobs";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.skipIf(!serviceUp("greenmail").up)("first run connects both GreenMail servers through the labeled ports", async () => {
  const { db, deps } = await withNodeBlobs(makeDeps);
  // makeDeps stubs both probes. GreenMail supplies both sockets for this test.
  vi.restoreAllMocks();
  delete deps.services!.smtpVerify;
  const session = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  const app = createApp(apiRoutes);
  vi.spyOn(mailboxes, "create").mockImplementation(async (body) => {
    const response = await app.handle(req("POST", "/mailboxes", {
      bearer: session.token, body: JSON.stringify(body),
    }), deps);
    const result = await response.json();
    if (!response.ok) throw new ApiError(response.status, result.error.code, result.error.message, result.error.details);
    return result;
  });

  const wire = webConnectWire({ owner: () => session.accountId, returned: "page", leave: () => undefined });
  const view = draw(wire, { purpose: { kind: "firstRun" } });
  const { imapHost, imapPort, smtpHost, smtpPort } = greenmailEndpoint(process.env, readLaneGreenmail(process.cwd()));
  const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const press = () => fireEvent.click(screen.getByRole("button", { name: J.manualConnect }));
  fill(O.address, [randomUUID(), "example.invalid"].join("@"));
  fireEvent.click(screen.getByRole("button", { name: P.otherLabel }));
  fireEvent.click(screen.getByText(J.manualPorts));
  fill(O.imapHost, imapHost);
  fill(M.imapPortLabel, String(imapPort));
  fill(O.smtpHost, smtpHost);
  fill(M.smtpPortLabel, String(smtpPort));
  fill(O.password, "test");
  press();

  await waitFor(() => expect(view.done.map((result) => result.kind)).toEqual(["connected"]));

  const stored = await db.select({ transport: mailboxCredentials.transport, meta: mailboxCredentials.meta }).from(mailboxCredentials);
  expect(stored).toEqual(expect.arrayContaining([
    { transport: "imap", meta: expect.objectContaining({ host: imapHost, port: imapPort, secure: false }) },
    { transport: "smtp", meta: expect.objectContaining({ host: smtpHost, port: smtpPort, secure: false }) },
  ]));
}, 30_000);
