import type { PhoneAccountRequest } from "../../src/shell/bridge-kinds";
import type { Bridge } from "./bridge";
import { bridgeFetch } from "./bridge-fetch";

export class AccountRefusal extends Error {
  constructor(readonly status: number, readonly code?: string, readonly details?: unknown) {
    super("Account request refused");
  }
}

export function accountFetch(bridge: Bridge, scope: string) {
  const requestOnBridge = bridgeFetch(bridge, scope);
  return async function request<T>(path: string, method = "GET", body?: object, signal?: AbortSignal): Promise<T> {
    const answer = await requestOnBridge(path, {
      method, signal,
      ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }),
    });
    return readAnswer<T>(answer);
  };
}

type WithoutScope<T> = T extends object ? Omit<T, "scope"> : never;

export function nativeAccountFetch(bridge: Bridge, scope: string) {
  return async function request<T>(ask: WithoutScope<Exclude<PhoneAccountRequest, { do: "deletePage" | "settingsPage" }>>): Promise<T> {
    const { result } = await bridge.request("phone.account", { scope, ...ask });
    if (!result || (result.body !== null && result.body.as !== "text")) throw new Error("Missing account confirmation");
    return readAnswer<T>(new Response(result.body?.text ?? null, { status: result.status }));
  };
}

async function readAnswer<T>(answer: Response): Promise<T> {
  if (!answer.ok) {
    const envelope = await answer.json().catch(() => null);
    throw new AccountRefusal(answer.status, envelope?.error?.code, envelope?.error?.details);
  }
  return answer.status === 204 ? undefined as T : await answer.json() as T;
}
