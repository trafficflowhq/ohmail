/** A decoded picture: RGBA, four bytes a pixel, rows from the top. */
export interface Picture {
  width: number;
  height: number;
  data: Uint8Array;
}

export function decode(bytes: Uint8Array): Picture;
export function encode(picture: Picture): Buffer;
export function size(bytes: Uint8Array): { width: number; height: number };
