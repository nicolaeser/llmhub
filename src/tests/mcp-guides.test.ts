import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeDesktopMcpConfig,
  MCP_TOOLS,
  mcpGuide,
  mcpTool,
  mcpUrls,
  type McpGuideValues,
} from "@/app/(app)/developer/_components/mcp-guides";

const values: McpGuideValues = { origin: "https://hub.example", key: "sk-hub-test", shell: "posix" };
const endpoint = "https://hub.example/api/v1/mcp";

function codeOf(tool: (typeof MCP_TOOLS)[number]["id"], step: string, input = values): string {
  const found = mcpGuide(tool, input).steps.find((item) => item.id === step);
  assert.ok(found?.code, `${tool} has a ${step} snippet`);
  return found.code.text;
}

test("the hub MCP endpoint and its legacy SSE address sit under /api/v1/mcp", () => {
  assert.deepEqual(mcpUrls("https://hub.example"), { endpoint, sse: `${endpoint}/sse` });
});

test("unknown tool ids fall back to the first MCP tool", () => {
  assert.equal(mcpTool("aider").id, "claudeCode");
  assert.equal(mcpTool(null).id, "claudeCode");
  assert.equal(mcpTool("gemini").id, "gemini");
});

test("Claude Code adds the hub as a user-scoped HTTP server with a bearer header", () => {
  assert.equal(
    codeOf("claudeCode", "add"),
    `claude mcp add --transport http --scope user llmhub ${endpoint} --header "Authorization: Bearer sk-hub-test"`,
  );
  const notes = mcpGuide("claudeCode", values).notes;
  assert.equal(notes.find((note) => note.id === "twice")?.args?.setting, '"ANTHROPIC_CUSTOM_HEADERS": "X-LLMHub-MCP: off"');
});

test("Codex reads the key from LLMHUB_API_KEY in the chosen shell", () => {
  assert.equal(codeOf("codex", "config"), `[mcp_servers.llmhub]\nurl = "${endpoint}"\nbearer_token_env_var = "LLMHUB_API_KEY"`);
  assert.equal(codeOf("codex", "key"), 'export LLMHUB_API_KEY="sk-hub-test"');
  assert.equal(codeOf("codex", "key", { ...values, shell: "windows" }), '$env:LLMHUB_API_KEY = "sk-hub-test"');
  assert.ok(mcpGuide("codex", values).notes.some((note) => note.id === "persist"));
});

test("JSON configs carry the endpoint and the Authorization header in each client's shape", () => {
  const auth = { Authorization: "Bearer sk-hub-test" };
  assert.deepEqual(JSON.parse(codeOf("opencode", "config")).mcp.llmhub, {
    type: "remote",
    url: endpoint,
    enabled: true,
    headers: auth,
  });
  assert.deepEqual(JSON.parse(codeOf("cursor", "config")), { mcpServers: { llmhub: { url: endpoint, headers: auth } } });
  assert.deepEqual(JSON.parse(codeOf("vscode", "config")), {
    servers: { llmhub: { type: "http", url: endpoint, headers: auth } },
  });
  assert.deepEqual(JSON.parse(codeOf("gemini", "config")), { mcpServers: { llmhub: { httpUrl: endpoint, headers: auth } } });
});

test("Claude Desktop bridges through mcp-remote and allows plain HTTP only off localhost", () => {
  const config = JSON.parse(codeOf("claudeDesktop", "config")).mcpServers.llmhub;
  assert.equal(config.command, "npx");
  assert.deepEqual(config.args, ["-y", "mcp-remote", endpoint, "--header", "Authorization:${LLMHUB_AUTH}"]);
  assert.deepEqual(config.env, { LLMHUB_AUTH: "Bearer sk-hub-test" });

  const lan = { ...values, origin: "http://10.0.0.5:3000" };
  const lanArgs = JSON.parse(claudeDesktopMcpConfig(lan, mcpUrls(lan.origin))).mcpServers.llmhub.args;
  assert.ok(lanArgs.includes("--allow-http"));
  const local = { ...values, origin: "http://localhost:3000" };
  const localArgs = JSON.parse(claudeDesktopMcpConfig(local, mcpUrls(local.origin))).mcpServers.llmhub.args;
  assert.ok(!localArgs.includes("--allow-http"));
});

test("the generic guide lists the header, the SSE fallback, and a tools/list check per shell", () => {
  const guide = mcpGuide("other", values);
  assert.deepEqual(guide.steps.find((step) => step.id === "fields")?.fields, [
    { id: "url", value: endpoint },
    { id: "header", value: "Authorization" },
    { id: "value", value: "Bearer sk-hub-test" },
  ]);
  assert.deepEqual(guide.steps.find((step) => step.id === "sse")?.fields, [{ id: "sse", value: `${endpoint}/sse` }]);
  const posix = codeOf("other", "test");
  assert.match(posix, /^curl https:\/\/hub\.example\/api\/v1\/mcp \\/);
  assert.match(posix, /-d '\{"jsonrpc":"2\.0","id":1,"method":"tools\/list"\}'/);
  const windows = codeOf("other", "test", { ...values, shell: "windows" });
  assert.match(windows, /^Invoke-RestMethod -Uri "https:\/\/hub\.example\/api\/v1\/mcp" -Method Post/);
  assert.match(windows, /Authorization = "Bearer sk-hub-test"/);
});

test("every MCP tool guide ends with the shared check step", () => {
  for (const tool of MCP_TOOLS) {
    const steps = mcpGuide(tool.id, values).steps;
    assert.equal(steps.at(-1)?.id, "check", tool.id);
  }
});
