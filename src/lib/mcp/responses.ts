import "server-only";
import { newId } from "@/lib/gateway/core";
import { chatToResponse, outputText } from "@/lib/gateway/protocols/responses";
import type { ResponsesStreamEncoder } from "@/lib/gateway/protocols/responses-stream";
import type { JsonMap } from "@/types/gateway";
import type { McpCallRecord, McpChatRun, McpStreamSink } from "@/types/mcp";

export function mcpCallItem(record: McpCallRecord, id = `mcp_${newId()}`): JsonMap {
  const failed = record.outcome.isError;
  return {
    id,
    type: "mcp_call",
    status: failed ? "failed" : "completed",
    server_label: record.bound.serverName,
    name: record.bound.tool.name,
    arguments: record.call.arguments,
    output: failed ? null : record.content,
    error: failed ? record.content : null,
  };
}

export function mcpResponse(run: McpChatRun, skeleton: JsonMap): JsonMap {
  const answered = chatToResponse(run.final, skeleton);
  const earlier = run.steps.slice(0, -1).flatMap((step) => {
    const message: JsonMap = { ...step.message };
    delete message.tool_calls;
    const converted = chatToResponse({ choices: [{ index: 0, message, finish_reason: "stop" }] }, skeleton);
    return [...(converted.output as JsonMap[]), ...step.calls.map((record) => mcpCallItem(record))];
  });
  const output = [...earlier, ...(answered.output as JsonMap[])];
  return { ...answered, output, output_text: outputText(output) };
}

export function responsesSink(
  encoder: ResponsesStreamEncoder,
  onDone: (transcript: JsonMap[]) => Promise<void>,
): McpStreamSink {
  const ids = new Map<number, string>();
  return {
    start: () => encoder.start(),
    chunk: (chunk) => encoder.push(chunk),
    toolStart(call, bound) {
      const id = `mcp_${newId()}`;
      const begun = encoder.beginItem(
        {
          id,
          type: "mcp_call",
          status: "in_progress",
          server_label: bound.serverName,
          name: bound.tool.name,
          arguments: call.arguments,
          output: null,
          error: null,
        },
        ["response.mcp_call.in_progress"],
      );
      ids.set(begun.index, id);
      return begun;
    },
    toolEnd(index, record) {
      const item = mcpCallItem(record, ids.get(index));
      return encoder.endItem(index, item, [
        record.outcome.isError ? "response.mcp_call.failed" : "response.mcp_call.completed",
      ]);
    },
    finish: () => encoder.finish(),
    fail: (message) => encoder.fail(message),
    done: onDone,
  };
}
