/** PNG bytes to pixels and back; the one place that knows the codec. */
import { PNG } from "pngjs";

/** @param {Uint8Array} bytes @returns {import("./png.d.mts").Picture} */
export function decode(bytes) {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
}

/** @param {import("./png.d.mts").Picture} picture @returns {Buffer} */
export function encode(picture) {
  const png = new PNG({ width: picture.width, height: picture.height });
  png.data = Buffer.from(picture.data);
  return PNG.sync.write(png);
}

/** The size a PNG declares, read from its header alone. @param {Uint8Array} bytes */
export function size(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString("latin1", 12, 16) !== "IHDR") throw new Error("png: not a PNG");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
