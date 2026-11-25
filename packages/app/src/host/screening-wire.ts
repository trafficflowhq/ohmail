import type { ScreenerLearningView } from "@ohmail/wire";
import type * as Payloads from "./payloads.js";
import type { AutoFiledWire, ScreeningWire } from "./wires.js";

const SCREENING_PATH = "/account/screening";
const AUTO_FILED_PATH = "/screener/auto-filed";
type Request = (path: string, init?: RequestInit) => Promise<Response>;

async function checked<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`The mail engine answered ${response.status}`);
  return response.json() as Promise<T>;
}

export function readScreeningResponse(request: Request): Promise<Response> {
  return request(SCREENING_PATH);
}

export function changeScreeningResponse(request: Request, next: Payloads.ScreeningChange): Promise<Response> {
  return request(SCREENING_PATH, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(next),
  });
}

async function preference(response: Response): Promise<Payloads.ScreeningPreference> {
  const body = await checked<Payloads.ScreeningPreference | null>(response);
  if (
    !body ||
    typeof body.defaultBar !== "string" ||
    (body.ohboxBar !== null && typeof body.ohboxBar !== "string")
  ) {
    throw new Error("The screening preference was unreadable");
  }
  return body;
}

export function screeningVia(request: Request): ScreeningWire {
  return {
    read: async () => preference(await readScreeningResponse(request)),
    change: async (next) => preference(await changeScreeningResponse(request, next)),
    readLearning: async (mailboxId) =>
      checked<ScreenerLearningView>(
        await request(`${SCREENING_PATH}?learningMailbox=${encodeURIComponent(mailboxId)}`),
      ),
    changeLearning: async (mailboxId, learningEdit) =>
      checked<ScreenerLearningView>(
        await request(SCREENING_PATH, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ learningMailbox: mailboxId, learningEdit }),
        }),
      ),
  };
}

export function autoFiledVia(request: Request): AutoFiledWire {
  return {
    list: async () => {
      const body = await checked<Partial<Payloads.AutoFiled> | null>(await request(AUTO_FILED_PATH));
      return { items: Array.isArray(body?.items) ? body.items : [], more: body?.more === true };
    },
    putBack: async (messageIds) =>
      checked(
        await request(`${AUTO_FILED_PATH}/undo`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageIds }),
        }),
      ),
  };
}
