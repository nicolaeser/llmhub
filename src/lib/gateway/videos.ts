import "server-only";
import { asRecord, ownerId } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { canReadObject, getObject, putObject, updateObjectPayload } from "@/lib/gateway/objects";
import type { JsonMap, Principal } from "@/types/gateway";

export async function videoRecord(principal: Principal, id: string) {
  const object = await getObject(id);
  const upstreamId = typeof object?.meta.upstream_id === "string" ? object.meta.upstream_id : "";
  if (!object || object.kind !== "video" || !upstreamId || !canReadObject(object, principal)) {
    throw new GateError(404, "not_found", "video not found", { param: "id" });
  }
  const model = typeof object.meta.model === "string" ? object.meta.model : "";
  return { object, model, upstreamId };
}

export async function storeVideo(principal: Principal, model: string, upstream: unknown): Promise<JsonMap> {
  const json = asRecord(upstream) ?? {};
  const upstreamId = typeof json.id === "string" ? json.id : "";
  if (!upstreamId) throw new GateError(502, "upstream_error", "upstream returned no video id");
  const stored = await putObject({
    kind: "video",
    owner: ownerId(principal),
    contentType: "application/json",
    payload: Buffer.from(JSON.stringify(json)),
    meta: { model, upstream_id: upstreamId },
  });
  return { ...json, id: stored.id };
}

export async function refreshVideo(id: string, upstream: unknown): Promise<JsonMap> {
  const json = asRecord(upstream) ?? {};
  await updateObjectPayload(id, Buffer.from(JSON.stringify(json)));
  return { ...json, id };
}
