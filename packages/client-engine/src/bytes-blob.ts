/**
 * BYTES INTO A BLOB, ON A RUNTIME THAT CANNOT BUILD ONE.
 *
 * React Native's Blob is native-backed: `createFromParts` throws on every ArrayBuffer and view,
 * so a phone can HOLD one the platform made and never MAKE its own. Invisible on a paired door
 * (XHR delivers a native blob) and fatal on a standalone one, where the app builds the response
 * itself and the fetch polyfill constructs the Blob. The bytes are the carrier and the Blob only
 * the container consumers agreed on, so where it cannot be built this hands back one shaped like
 * it over the same bytes. Web, desktop and node build the real thing and never meet the carrier.
 */

/**
 * The Blob members the product reads off attachment bytes: `size`, `type`, `arrayBuffer()`
 * (the share path and the inline mint), `text()` (the calendar part) and `slice()`. `stream()`
 * is deliberately ABSENT rather than present-and-throwing — React Native has no ReadableStream,
 * and a capability that is there and fails is the exact shape this module exists to answer.
 */
class ByteCarrier {
  readonly size: number;

  /* `raw`, not `bytes`: lib.dom's Blob declares its own `bytes()`, and a PRIVATE member of that
     name collapses `Blob & ByteCarrier` to `never` at the `instanceof` narrowing below. */

  constructor(private readonly raw: Uint8Array, readonly type: string) {
    this.size = raw.byteLength;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const b = this.raw;
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }

  async text(): Promise<string> {
    return decodeUtf8(this.raw);
  }

  slice(start?: number, end?: number, contentType?: string): Blob {
    return new ByteCarrier(this.raw.subarray(start ?? 0, end ?? this.size), contentType ?? this.type) as unknown as Blob;
  }

  /** The same bytes under a new type — what a synchronous re-typing needs and a Blob part cannot give. */
  retype(type: string): Blob {
    return new ByteCarrier(this.raw, type) as unknown as Blob;
  }
}

/**
 * `TextDecoder` where the runtime has it, and a decoder of our own where it does not: Hermes
 * ships no WHATWG encoding API on every release, and a carrier that answers `text()` with
 * mojibake would be a silent wrong answer rather than a missing one.
 */
function decodeUtf8(bytes: Uint8Array): string {
  const D = (globalThis as { TextDecoder?: new () => { decode: (b: Uint8Array) => string } }).TextDecoder;
  if (typeof D === "function") return new D().decode(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    let cp: number;
    if (b < 0x80) { cp = b; i += 1; }
    else if (b < 0xe0) { cp = ((b & 0x1f) << 6) | (bytes[i + 1]! & 0x3f); i += 2; }
    else if (b < 0xf0) { cp = ((b & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f); i += 3; }
    else { cp = ((b & 0x07) << 18) | ((bytes[i + 1]! & 0x3f) << 12) | ((bytes[i + 2]! & 0x3f) << 6) | (bytes[i + 3]! & 0x3f); i += 4; }
    out += String.fromCodePoint(cp);
  }
  return out;
}

/** Can this runtime build a Blob from bytes? Probed on one byte, never cached — a runtime the app patches at boot may answer differently than it did at import. */
export function canBuildBlobFromBytes(): boolean {
  const B = (globalThis as { Blob?: new (parts: unknown[]) => unknown }).Blob;
  if (typeof B !== "function") return false;
  try {
    new B([new Uint8Array(1)]);
    return true;
  } catch {
    return false;
  }
}

/** A Blob over `bytes` — the real one where the runtime builds it, the carrier where it refuses. */
export function bytesBlob(bytes: Uint8Array | ArrayBuffer, type: string): Blob {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const B = (globalThis as { Blob?: new (parts: unknown[], opts?: { type?: string }) => Blob }).Blob;
  if (typeof B === "function") {
    try {
      return new B([view], { type });
    } catch {
      /* the carrier below — React Native refuses an ArrayBufferView part */
    }
  }
  return new ByteCarrier(view, type) as unknown as Blob;
}

/**
 * The same bytes under `type`. A Blob is re-typed by wrapping it as a PART, which React Native
 * accepts for a native blob and would stringify for a carrier — `[object Object]` where the file
 * should be — so a carrier is re-typed from the bytes it already holds.
 */
export function retypedBlob(blob: Blob, type: string): Blob {
  if (blob.type === type) return blob;
  if (blob instanceof ByteCarrier) return blob.retype(type);
  return new Blob([blob], { type });
}

/**
 * ONE READ of an adapter response's bytes, for both doors. `res.blob()` where the runtime can
 * build a Blob — the browser's cheap path, no copy into the JS heap. Where it cannot, the bytes
 * come out as an ArrayBuffer instead, which the polyfill answers from its own body for a response
 * the app built and from the native blob for one the platform delivered; asking `blob()` first and
 * catching would be too late, because the polyfill marks the body used before it throws.
 */
export async function responseBlob(res: Response): Promise<Blob> {
  if (canBuildBlobFromBytes()) return await res.blob();
  const buf = await res.arrayBuffer();
  return bytesBlob(buf, (res.headers.get("content-type") ?? "").split(";")[0]!.trim());
}
