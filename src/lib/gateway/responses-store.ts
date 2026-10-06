import "server-only";
import { GateError } from "@/lib/gateway/errors";
import { canReadObject, getObject, payloadJson } from "@/lib/gateway/objects";
import { storedObjectId, storedResponse } from "@/lib/gateway/responses";
import type { Principal, Stored } from "@/types/gateway";
import type { StoredResponse } from "@/types/responses";

export async function findStoredResponse(id: string, principal: Principal): Promise<Stored> {
  const object = await getObject(storedObjectId(id));
  if (!object || object.kind !== "response" || !canReadObject(object, principal)) {
    throw new GateError(404, "not_found", "response not found", { param: "id" });
  }
  return object;
}

export async function loadStoredResponse(id: string, principal: Principal): Promise<StoredResponse & { objectId: string }> {
  const object = await findStoredResponse(id, principal);
  return { ...storedResponse(object.id, payloadJson(object)), objectId: object.id };
}

export async function previousConversation(id: string, principal: Principal) {
  try {
    return (await loadStoredResponse(id, principal)).messages;
  } catch (err) {
    if (err instanceof GateError && err.status === 404) {
      throw new GateError(
        400,
        "previous_response_not_found",
        `previous response with id '${id}' not found`,
        { param: "previous_response_id" },
      );
    }
    throw err;
  }
}
