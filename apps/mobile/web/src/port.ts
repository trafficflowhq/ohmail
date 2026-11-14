/**
 * The page's end of the bridge, as the platform gives it. Android injects `ohmailShell` into this
 * origin's main frame only (the web message listener); iOS gives a script message handler and
 * delivers native's messages as an argument to `__ohmailShell`. Text in, text out; nothing else.
 */
export interface PagePort {
  post(text: string): void;
  listen(take: (text: string) => void): () => void;
}

interface AndroidPort {
  postMessage(text: string): void;
  addEventListener(type: "message", h: (e: { data: unknown }) => void): void;
  removeEventListener(type: "message", h: (e: { data: unknown }) => void): void;
}
interface IosHandler {
  postMessage(text: string): Promise<unknown>;
}

export function pagePort(): PagePort | null {
  const g = globalThis as unknown as {
    ohmailShell?: AndroidPort;
    webkit?: { messageHandlers?: { ohmailShell?: IosHandler } };
    __ohmailShell?: (m: string) => void;
  };
  const android = g.ohmailShell;
  if (android && typeof android.postMessage === "function") {
    return {
      post: (text) => android.postMessage(text),
      listen: (take) => {
        const h = (e: { data: unknown }) => {
          if (typeof e.data === "string") take(e.data);
        };
        android.addEventListener("message", h);
        return () => android.removeEventListener("message", h);
      },
    };
  }
  const ios = g.webkit?.messageHandlers?.ohmailShell;
  if (ios) {
    return {
      post: (text) => void ios.postMessage(text),
      listen: (take) => {
        g.__ohmailShell = (m) => {
          if (typeof m === "string") take(m);
        };
        return () => {
          delete g.__ohmailShell;
        };
      },
    };
  }
  return null;
}
