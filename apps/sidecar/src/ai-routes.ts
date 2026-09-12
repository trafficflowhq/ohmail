import { jsonResponse, type Route } from "@trafficflow/api/local";
import { ServiceError } from "@trafficflow/services/mail";
import type { LocalAi, LocalAiSettingsInput } from "./ai-provider.js";

/**
 * THE FOUR ROUTES A STANDALONE INSTALL SERVES FOR ITS OWN AI, AND NOBODY ELSE DOES.
 *
 * They are defined here, in the local engine, rather than in the shared route table — which is
 * the same reason the shared table has no `ai-settings` module of its own. A hosted deployment's
 * AI switch governs ITS spend on ITS models and is a billing control; this is a person pointing
 * their own install at their own model. The two look alike from a distance and share nothing:
 * different storage, different failure states, different question. A hosted host cannot mount
 * these because it has no name for them.
 *
 *   GET    /local/ai         what is configured, whether it works, and where content would go
 *   PUT    /local/ai         replace the settings; the API key is accepted here and never returned
 *   DELETE /local/ai         forget the provider and the stored key
 *   POST   /local/ai/verify  ask the endpoint whether it is really there
 *
 * ── THE COST CLASSES, AND WHY THE VERIFICATION IS NOT `paid` ────────────────────────────────
 *
 * Every route in this product declares what it causes, and a route that declared nothing would
 * not compile. `GET` reads stored settings (`read`). `PUT`/`DELETE` write them (`work`). The
 * verification opens a connection to a third party on the caller's behalf (`connection`) — and
 * it is NOT `paid`, which is a property of the implementation and not an accident of
 * classification: it authenticates by listing models and asking for one by name, both free. A
 * verification that ran a completion would be a settings pane that charges the account holder
 * for pressing Save.
 *
 * ── WHAT THE RESPONSES DO NOT CONTAIN ───────────────────────────────────────────────────────
 *
 * No route returns the API key, in any shape, under any state — `hasKey` is the whole of what is
 * said about it. There is no read path for the key at all: it is decrypted into a request header
 * and nowhere else.
 */

/** `PUT` bodies only. Malformed JSON is a 400, never a silent empty object. */
async function readSettingsBody(req: Request): Promise<LocalAiSettingsInput> {
  const text = await req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as LocalAiSettingsInput;
  } catch {
    throw new ServiceError("invalid_request", 400, "the request body is not valid JSON");
  }
}

/**
 * The routes, closed over the one live object that owns the settings.
 *
 * A factory rather than a module-level array because there is exactly one of these per process
 * and it holds the decryption key path: handing it in explicitly means nothing can reach the
 * store except by being given it, and a hosted route table has no way to be given it.
 */
export function localAiRoutes(ai: LocalAi): Route[] {
  return [
    {
      method: "GET",
      pattern: "/local/ai",
      relay: false,  /* served by this engine; never forwarded */
      cost: "read",
      handler: async () => jsonResponse(ai.status(), { status: 200 }),
    },
    {
      /**
       * PUT and not PATCH: the body describes the configuration that should be in force
       * afterwards, and a partial update of a thing whose parts select where mail content is
       * sent is a way to end up somewhere nobody chose. Omitted model fields keep their current
       * value; an omitted `apiKey` keeps the stored one, so changing a model does not require
       * re-typing a key.
       *
       * The reply is the same object `GET` returns, already carrying the verification this write
       * triggered — so a settings surface learns in one round trip whether what it just saved
       * actually works, rather than saving and then discovering.
       */
      method: "PUT",
      pattern: "/local/ai",
      relay: false,  /* served by this engine; never forwarded */
      cost: "work",
      handler: async (req) => jsonResponse(await ai.save(await readSettingsBody(req)), { status: 200 }),
    },
    {
      method: "DELETE",
      pattern: "/local/ai",
      relay: false,  /* served by this engine; never forwarded */
      cost: "work",
      handler: async () => jsonResponse(await ai.clear(), { status: 200 }),
    },
    {
      /**
       * `POST` because it has an effect: it reaches out, and it records what it found. A `GET`
       * that made an outbound request and wrote the result would be a `GET` that is not one.
       */
      method: "POST",
      pattern: "/local/ai/verify",
      relay: false,  /* served by this engine; never forwarded */
      cost: "connection",
      handler: async () => jsonResponse(await ai.verify(), { status: 200 }),
    },
  ];
}
