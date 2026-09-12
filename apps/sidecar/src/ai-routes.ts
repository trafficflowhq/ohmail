import { jsonResponse, type Route } from "@trafficflow/api/local";
import { ServiceError } from "@trafficflow/services/mail";
import type { LocalAi, LocalAiSettingsInput } from "./ai-provider.js";

/**
 * The four routes a standalone install serves for its own AI, and nobody else does — defined here in
 * the local engine rather than the shared table, the same reason it has no shared `ai-settings`: a
 * hosted deployment's AI switch is a billing control over its own spend, while this is a person
 * pointing their own install at their own model; a hosted host cannot mount these because it has no
 * name for them. `GET` reads settings, `PUT`/`DELETE` write them, `POST /verify` opens a connection
 * to a third party (`connection`) and is NOT `paid` — it authenticates by listing models and asking
 * for one by name, both free. No route returns the API key in any shape — `hasKey` is the whole of
 * what is said, and the key is decrypted into a request header and nowhere else.
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
       * PUT and not PATCH: the body describes the configuration that should be in force afterwards,
       * and a partial update of a thing whose parts select where mail content is sent is a way to end
       * up somewhere nobody chose. Omitted model fields keep their current value; an omitted `apiKey`
       * keeps the stored one, so changing a model does not require re-typing a key. The reply is the
       * same object `GET` returns, already carrying the verification this write triggered — so a
       * settings surface learns in one round trip whether what it saved works.
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
