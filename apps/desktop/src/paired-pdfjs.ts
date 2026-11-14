import { pdfFrom } from "./window-pdfjs";

export { seam } from "./window-pdfjs";

/** The paired app can open through a deep link. Its worker always lives at this origin's root. */
export const getDocument = pdfFrom(
  () => import(/* @vite-ignore */ new URL("/pdf.min.mjs", window.location.href).href),
  () => new URL("/pdf.worker.min.mjs", window.location.href),
);
