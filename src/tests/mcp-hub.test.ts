import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { MCP_LEGACY_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION } from "@/lib/mcp/client";
import { answerMcp, INVALID_PARAMS } from "@/lib/mcp/endpoint";
import { HUB_MCP_INFO, hubMcpTools } from "@/lib/mcp/hub";
import type { JsonMap, Principal } from "@/types/gateway";

const principal = {
  actor: "k",
  teamId: "",
  orgId: "org1",
  userId: "",
  memberId: "",
  models: [],
  routeLimits: {},
  key: { token_id: "key1", project_id: "" },
} as unknown as Principal;

function tool(name: string, action?: string) {
  return {
    name,
    title: name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    ...(action ? { action } : {}),
  };
}

function reset() {
  recordedPrisma.reset({
    mcpServer: {
      findMany: () => [
        {
          id: "pets",
          name: "Pets",
          url: "https://api.example.com/v1",
          authType: "none",
          authHeader: "",
          authSecret: "",
          oauthGrant: "authorization_code",
          oauthClientId: "",
          oauthScopes: "",
          transport: "streamable_http",
          protocolVersion: MCP_PROTOCOL_VERSION,
          kind: "hosted",
          spec: { tools: [] },
          internal: false,
          enabled: true,
          global: true,
          globalAccess: "all",
          toolsRestricted: false,
          allowedTools: [],
          tools: [tool("list_pets", "read"), tool("delete_pet", "delete"), tool("ping")],
          oauthLogin: null,
          assignments: [
            {
              serverId: "pets",
              orgId: "org1",
              teamId: null,
              projectId: null,
              memberId: null,
              keyId: null,
              access: "inherit",
              extraTools: [],
              blockedTools: ["delete_pet"],
            },
          ],
        },
      ],
    },
  });
}

async function rpc(body: JsonMap | null): Promise<{ status: number; json: JsonMap | null }> {
  const reply = await answerMcp(body, new Headers(), hubMcpTools(principal), AbortSignal.timeout(5_000));
  return { status: reply.status, json: reply.body as JsonMap | null };
}

test("the hub negotiates the client's legacy version and lists the caller's tools without blocked actions", async () => {
  reset();
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  assert.equal(init.status, 200);
  assert.equal((init.json!.result as JsonMap).protocolVersion, "2025-06-18");
  assert.deepEqual((init.json!.result as JsonMap).serverInfo, HUB_MCP_INFO);
  const future = await rpc({ jsonrpc: "2.0", id: 9, method: "initialize", params: { protocolVersion: "2099-01-01" } });
  assert.equal((future.json!.result as JsonMap).protocolVersion, MCP_LEGACY_PROTOCOL_VERSION);

  const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = ((listed.json!.result as JsonMap).tools as JsonMap[]).map((item) => item.name);
  assert.deepEqual(tools, ["mcp__Pets__list_pets", "mcp__Pets__ping"]);
  const read = ((listed.json!.result as JsonMap).tools as JsonMap[])[0]!;
  assert.deepEqual(read.annotations, { readOnlyHint: true });
  assert.equal(((listed.json!.result as JsonMap).tools as JsonMap[])[1]!.annotations, undefined);

  const missing = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mcp__Pets__delete_pet", arguments: {} } });
  assert.deepEqual(missing.json!.error, { code: INVALID_PARAMS, message: "Unknown tool: mcp__Pets__delete_pet" });

  const note = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(note.status, 202);
  assert.equal(note.json, null);
});
