/**
 * React Native 0.86's Blob has NO `arrayBuffer()` (measured in the installed
 * `Libraries/Blob/Blob.js`), while the engine's inline-image mint and the attachment share
 * path both read one — on a device the promise dies `blob.arrayBuffer is not a function`
 * inside a catch that renders a blank box, nowhere near anything naming a polyfill. RN's
 * native `FileReader.readAsArrayBuffer` exists, so the standard member is supplied over it.
 * Imported FIRST by the app entry (`app/_layout.tsx`), before anything can hold a Blob.
 * Node and the suite have the native member and are left untouched.
 */

type BlobWithArrayBuffer = Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };

if (
  typeof Blob !== "undefined" &&
  typeof (Blob.prototype as BlobWithArrayBuffer).arrayBuffer !== "function" &&
  typeof FileReader !== "undefined"
) {
  Object.defineProperty(Blob.prototype, "arrayBuffer", {
    value: function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("blob read failed"));
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(this);
      });
    },
    writable: true,
    configurable: true,
  });
}

export {};
