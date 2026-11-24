import { randomUuid } from "../../src/random-uuid";

// The bundled WKWebView page uses a custom scheme. WebKit can withhold randomUUID
// there while still providing getRandomValues, including for the shared setup form.
if (typeof crypto.randomUUID !== "function") {
  Object.defineProperty(crypto, "randomUUID", { value: randomUuid });
}
