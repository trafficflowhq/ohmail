import type { AnswerOf, RequestOf } from "@ohmail/wire";
import { answer } from "../../src/responses.js";

type AwayGet = "GET /away-responder";
type AwayPut = "PUT /away-responder";
declare const responder: AnswerOf<AwayGet>;
declare const save: AnswerOf<AwayPut>;

export const read = answer<AwayGet>()(responder);
const { change: _latest, ...storable } = responder;
export const localSave = answer<AwayPut>()(storable);
export const body = responder.body;
export const waiting = save.pending === true ? save.travel.pending : [];

// @ts-expect-error a GET still calls its last decision "change", even in a conditional spread
export const wrongDecision = answer<AwayGet>()({ ...responder, ...(responder.change ? { decision: responder.change } : {}) });
// @ts-expect-error a queued save carries its travel along with the unchanged row
export const queuedWithoutTravel = answer<AwayPut>()({ ...responder, pending: true });
// @ts-expect-error the client reads the row's body by its wire name
export const wrongBodyRead = responder.reply;

export const edit: RequestOf<AwayPut> = { body: "Back soon.", enabled: true };
// @ts-expect-error a client naming the body "reply" would silently reset the text
export const wrongBodyWrite: RequestOf<AwayPut> = { enabled: true, reply: "Back soon." };
// @ts-expect-error the server's decision is not a request field a client may set
export const writeDecision: RequestOf<AwayPut> = { enabled: true, change: responder.change };
