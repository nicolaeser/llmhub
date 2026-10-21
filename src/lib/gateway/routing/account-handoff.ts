import { asRecord, asString } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { isResponsesSignature } from "@/lib/gateway/protocols/reasoning-signature";
import type { JsonMap } from "@/types/gateway";
import type { AccountPin } from "@/types/routing";

const FOREIGN_REASONING = /encrypted content|could not be (verified|decrypted)|invalid_encrypted_content/i;

export function historyLength(body: JsonMap | null | undefined): number {
  const messages = asRecord(body)?.messages;
  return Array.isArray(messages) ? messages.length : 0;
}

function withoutAccountReasoning(message: unknown): unknown {
  const rec = asRecord(message);
  if (!rec || asString(rec.role) !== "assistant" || !Array.isArray(rec.thinking_blocks)) return message;
  const kept = rec.thinking_blocks.filter((block) => !isResponsesSignature(asRecord(block)?.signature));
  if (kept.length === rec.thinking_blocks.length) return message;
  const copy: JsonMap = { ...rec };
  if (kept.length) copy.thinking_blocks = kept;
  else delete copy.thinking_blocks;
  return copy;
}

export function dropAccountReasoning(body: JsonMap | null | undefined, before = Infinity): boolean {
  const messages = asRecord(body)?.messages;
  if (!body || !Array.isArray(messages)) return false;
  let changed = false;
  const next = messages.map((message, index) => {
    if (index >= before) return message;
    const stripped = withoutAccountReasoning(message);
    if (stripped !== message) changed = true;
    return stripped;
  });
  if (changed) body.messages = next;
  return changed;
}

export function nextPin(
  providerId: string,
  pinned: AccountPin | null,
  switchedInRequest: boolean,
  history: number,
): AccountPin {
  if (pinned?.providerId === providerId && !switchedInRequest) return pinned;
  if (!pinned && !switchedInRequest) return { providerId, handoffAt: 0 };
  return { providerId, handoffAt: history };
}

export function rejectsForeignReasoning(err: unknown): boolean {
  if (!(err instanceof GateError) || err.status !== 400) return false;
  return FOREIGN_REASONING.test(err.message) || FOREIGN_REASONING.test(err.code);
}
