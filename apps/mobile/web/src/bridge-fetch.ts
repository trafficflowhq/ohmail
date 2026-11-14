/**
 * THE PAGE'S ONE TRANSPORT: the client engine's requests, as the bridge's `http` kind. The adapter's
 * base is empty, so every request it makes is a root-relative path; this refuses anything else before
 * it is posted. Native composes the server, the base and the bearer, and answers with what the page
 * may read. The page names no host, holds no credential and sends no cookie.
 */
import type { Body, HttpMethod } from "../../src/shell/bridge-kinds";
import type { Bridge } from "./bridge";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const METHODS = new Set<string>(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const NO_BODY = new Set([101, 204, 205, 304]);

function b64Of(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function bodyOf(body: RequestInit["body"]): Promise<Body | null> {
  if (body == null) return null;
  if (typeof body === "string") return { as: "text", text: body };
  if (body instanceof Uint8Array) return { as: "b64", b64: b64Of(body) };
  if (body instanceof ArrayBuffer) return { as: "b64", b64: b64Of(new Uint8Array(body)) };
  if (body instanceof Blob) return { as: "b64", b64: b64Of(new Uint8Array(await body.arrayBuffer())) };
  throw new TypeError("the shell's transport carries text and bytes only");
}

export function bridgeFetch(bridge: Bridge, scope: string): Fetch {
  return async (url, init = {}) => {
    if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) {
      throw new TypeError("the page names no host: a request is a root-relative path");
    }
    const method = (init.method ?? "GET").toUpperCase();
    if (!METHODS.has(method)) throw new TypeError(`the shell's transport does not carry ${method}`);
    const headers: [string, string][] = [];
    new Headers(init.headers).forEach((value, name) => headers.push([name.toLowerCase(), value]));
    const answer = await bridge.request(
      "http",
      { scope, method: method as HttpMethod, path: url, headers, body: await bodyOf(init.body) },
      init.signal ? { signal: init.signal } : {},
    );
    const bytes = answer.body === null ? null
      : answer.body.as === "text" ? answer.body.text
      : Uint8Array.from(atob(answer.body.b64), (c) => c.charCodeAt(0));
    return new Response(NO_BODY.has(answer.status) ? null : bytes, { status: answer.status, headers: answer.headers as [string, string][] });
  };
}
