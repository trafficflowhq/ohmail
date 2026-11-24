/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEVICE_SIGN_IN_KEY, retireDeviceSignIn, webDeviceSignIn,
} from "../app/(product)/mailbox/device-sign-in";
import { ApiError } from "../app/api-client";
import { forgetThisTab } from "../app/sign-out";

const fake = vi.hoisted(() => ({
  owner: "fixture-account" as string | null,
  start: vi.fn(),
  poll: vi.fn(),
}));

vi.mock("../app/api-client", async (original) => {
  const actual = await original<typeof import("../app/api-client")>();
  return {
    ...actual,
    apiOwnerHolds: () => true,
    boundApiOwner: () => fake.owner,
    mailboxes: { ...actual.mailboxes, deviceOAuthStart: fake.start, deviceOAuthPoll: fake.poll },
  };
});

const record = () => ({ handle: "fixture-handle", deadline: Date.now() + 90_000, account: fake.owner });
const reply = () => ({
  state: record().handle, userCode: "FIXTURE-CODE", verificationUri: "https://microsoft.com/devicelogin",
  expiresAt: new Date(record().deadline).toISOString(), intervalMs: 5_000,
});

beforeEach(() => {
  fake.owner = "fixture-account";
  fake.start.mockReset();
  fake.poll.mockReset();
  sessionStorage.clear();
});

afterEach(retireDeviceSignIn);

it("the tab's sign-out sweep forgets a visible ceremony and clears its handle", async () => {
  fake.start.mockResolvedValue(reply());
  expect((await webDeviceSignIn.begin("microsoft")).ok).toBe(true);
  expect(webDeviceSignIn.live.read()?.kind).toBe("shown");
  expect(sessionStorage.getItem(DEVICE_SIGN_IN_KEY)).not.toBeNull();

  expect(forgetThisTab().deviceCeremonySwept).toBe(true);
  expect(webDeviceSignIn.live.read()).toBeNull();
  expect(sessionStorage.getItem(DEVICE_SIGN_IN_KEY)).toBeNull();
});

it("a late start cannot rewrite the signed-out tab even when the same account returns", async () => {
  let answer!: (value: ReturnType<typeof reply>) => void;
  fake.start.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
  const start = webDeviceSignIn.begin("microsoft");
  expect(fake.start).toHaveBeenCalledTimes(1);

  forgetThisTab();
  answer(reply());
  expect((await start).ok).toBe(false);
  expect(sessionStorage.getItem(DEVICE_SIGN_IN_KEY)).toBeNull();
  expect(webDeviceSignIn.live.read()).toBeNull();
});

it("a refusal to remove the handle is reported by the tab's sign-out sweep", () => {
  const remove = Storage.prototype.removeItem;
  const spy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) {
    if (key === DEVICE_SIGN_IN_KEY) throw new Error("Storage unavailable");
    remove.call(this, key);
  });
  try {
    const sweep = forgetThisTab();
    expect(sweep.deviceCeremonySwept).toBe(false);
    expect(sweep.survivors).toContain(DEVICE_SIGN_IN_KEY);
  } finally {
    spy.mockRestore();
  }
});

it("a start waits for a named account and discards an answer overtaken by another account", async () => {
  fake.owner = null;
  expect((await webDeviceSignIn.begin("microsoft")).ok).toBe(false);
  expect(fake.start).not.toHaveBeenCalled();

  fake.owner = "fixture-account";
  let answer!: (value: ReturnType<typeof reply>) => void;
  fake.start.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
  const start = webDeviceSignIn.begin("microsoft");
  expect(fake.start).toHaveBeenCalledWith(expect.objectContaining({ expectedOwner: fake.owner }));

  fake.owner = "other-fixture-account";
  answer(reply());
  expect((await start).ok).toBe(false);
  expect(sessionStorage.getItem(DEVICE_SIGN_IN_KEY)).toBeNull();
  expect(webDeviceSignIn.live.read()).toBeNull();
});

it("stopping aborts a poll and a late approval does not reopen the device sign-in", async () => {
  let answer!: (value: object) => void;
  fake.start.mockResolvedValue(reply());
  fake.poll.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
  const unsubscribe = webDeviceSignIn.live.subscribe(() => {});
  try {
    await webDeviceSignIn.begin("microsoft");
    expect(fake.poll).toHaveBeenCalledTimes(1);
    const request = fake.poll.mock.calls[0]?.[1] as { signal: AbortSignal };
    webDeviceSignIn.stop();
    expect(request.signal.aborted).toBe(true);
    answer({ status: "granted", mailbox: { id: "fixture-mailbox" }, created: true });
    await Promise.resolve();
    expect(sessionStorage.getItem(DEVICE_SIGN_IN_KEY)).toBeNull();
    expect(webDeviceSignIn.live.read()).toBeNull();
  } finally {
    unsubscribe();
  }
});

it("approval publishes the connected mailbox and forgets the ceremony", async () => {
  fake.start.mockResolvedValue(reply());
  fake.poll.mockResolvedValue({ status: "granted", mailbox: { id: "fixture-mailbox" }, created: true });
  const unsubscribe = webDeviceSignIn.live.subscribe(() => {});
  try {
    await webDeviceSignIn.begin("microsoft");
    expect(webDeviceSignIn.live.read()).toEqual({
      kind: "connected", connected: { mailboxId: "fixture-mailbox", address: null }, created: true,
    });
    expect(fake.poll).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(DEVICE_SIGN_IN_KEY)).toBeNull();
  } finally {
    unsubscribe();
  }
});

it("an expired record is removed before any poll or display", () => {
  sessionStorage.setItem(DEVICE_SIGN_IN_KEY, JSON.stringify({ ...record(), deadline: Date.now() - 1 }));
  const unsubscribe = webDeviceSignIn.live.subscribe(() => {});
  try {
    webDeviceSignIn.resume();
    expect(fake.poll).not.toHaveBeenCalled();
    expect(webDeviceSignIn.live.read()).toBeNull();
    expect(sessionStorage.getItem(DEVICE_SIGN_IN_KEY)).toBeNull();
  } finally {
    unsubscribe();
  }
});

it("a device start projects only status and a known refusal code", async () => {
  for (const code of ["oauth_device_unconfigured", "broker_echo"]) {
    fake.start.mockRejectedValue(new ApiError(503, code, reply().userCode, { reason: "broker_echo" }));
    const answer = await webDeviceSignIn.begin("microsoft");
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error("expected a refusal");
    expect(answer.refusal.status).toBe(503);
    expect(answer.refusal.message === "", "start refusal carries no response text").toBe(true);
    expect(answer.refusal.details.reason).toBeNull();
    expect(answer.refusal.code).toBe(code === "oauth_device_unconfigured" ? code : null);
    expect(sessionStorage.getItem(DEVICE_SIGN_IN_KEY)).toBeNull();
  }
});

it.each([
  { status: 400, code: "oauth_device_state_invalid", kind: "ended" },
  { status: 503, code: "upstream_unavailable", kind: "shown" },
])("a $kind device poll strips response text and details", async ({ status, code, kind }) => {
  fake.start.mockResolvedValue(reply());
  fake.poll.mockRejectedValue(new ApiError(status, code, reply().userCode, { reason: "broker_echo" }));
  const unsubscribe = webDeviceSignIn.live.subscribe(() => {});
  try {
    expect((await webDeviceSignIn.begin("microsoft")).ok).toBe(true);
    const current = webDeviceSignIn.live.read();
    expect(current?.kind).toBe(kind);
    if (!current || !("refusal" in current)) throw new Error("expected a refusal");
    expect(current.refusal?.status).toBe(status);
    expect(current.refusal?.message === "", "poll refusal carries no response text").toBe(true);
    expect(current.refusal?.details.reason).toBeNull();
    expect(current.refusal?.code).toBe(code);
  } finally {
    unsubscribe();
  }
});
