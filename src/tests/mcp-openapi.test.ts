import assert from "node:assert/strict";
import test from "node:test";
import { buildHostedRequest, templateAllows } from "@/lib/mcp/hosted";
import { importOpenApi, readApiDocument } from "@/lib/mcp/openapi";

const openapi = {
  openapi: "3.1.0",
  info: { title: "Pet Store", description: "Pets and orders.\n\nLonger text." },
  servers: [{ url: "https://{region}.pets.example.com/v1/", variables: { region: { default: "eu" } } }],
  security: [{ key: [] }],
  components: {
    securitySchemes: { token: { type: "http", scheme: "bearer" }, key: { type: "apiKey", in: "header", name: "X-Api-Key" } },
    parameters: { Limit: { name: "limit", in: "query", schema: { type: "integer", maximum: 100 }, description: "Page size" } },
    schemas: {
      Base: { type: "object", properties: { id: { type: "string", readOnly: true }, tag: { type: "string" } } },
      Pet: {
        allOf: [
          { $ref: "#/components/schemas/Base" },
          { type: "object", required: ["name"], properties: { name: { type: "string" }, owner: { $ref: "#/components/schemas/Pet" } } },
        ],
      },
    },
  },
  paths: {
    "/pets": {
      get: { operationId: "listPets", summary: "List pets", parameters: [{ $ref: "#/components/parameters/Limit" }] },
      post: {
        operationId: "createPet",
        summary: "Create a pet",
        parameters: [{ name: "dry-run", in: "query", schema: { type: "boolean" } }, { name: "X-Trace", in: "header" }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } },
      },
    },
    "/pets/{pet-id}": {
      parameters: [{ name: "pet-id", in: "path", required: true, schema: { type: "string" } }],
      get: { operationId: "getPet", summary: "Get a pet" },
      delete: { operationId: "deletePet", summary: "Delete a pet" },
      post: { operationId: "archivePet", summary: "Remove a pet from the shop" },
    },
    "/files/{path}%2A": { get: { operationId: "badPath" } },
  },
};

test("readApiDocument accepts JSON and YAML specs and ignores prose", () => {
  assert.equal(readApiDocument(JSON.stringify(openapi))?.openapi, "3.1.0");
  assert.equal(readApiDocument("```json\n" + JSON.stringify(openapi) + "\n```")?.openapi, "3.1.0");
  const yaml = readApiDocument(`swagger: "2.0"
info:
  title: Legacy
host: legacy.example.com
basePath: /api
schemes: [http]
securityDefinitions:
  basic: { type: basic }
paths:
  /items/{id}:
    put:
      operationId: putItem
      parameters:
        - { name: id, in: path, required: true, type: string }
        - { name: body, in: body, schema: { type: object, properties: { label: { type: string } } } }
`);
  assert.equal(yaml?.swagger, "2.0");
  const imported = importOpenApi(yaml!);
  assert.equal(imported.server.baseUrl, "http://legacy.example.com/api");
  assert.equal(imported.server.internal, true);
  assert.equal(imported.server.authType, "basic");
  assert.equal(imported.server.authHeader, "");
  assert.deepEqual(imported.tools[0]!.inputSchema, {
    type: "object",
    properties: { id: { type: "string" }, label: { type: "string" } },
    required: ["id"],
  });
  assert.equal(readApiDocument("# Pets API\n\nGET /pets lists pets."), null);
  assert.equal(readApiDocument('{"name":"not a spec"}'), null);
});

test("importOpenApi turns every operation into a callable tool", () => {
  const imported = importOpenApi(openapi);
  assert.equal(imported.operations, 6);
  assert.deepEqual(imported.server, {
    name: "Pet Store",
    description: "Pets and orders.",
    baseUrl: "https://eu.pets.example.com/v1",
    internal: false,
    authType: "header",
    authHeader: "X-Api-Key",
    notes: "",
  });
  assert.deepEqual(
    imported.tools.map((tool) => [tool.name, tool.method, tool.path, tool.action]),
    [
      ["listPets", "GET", "/pets", "read"],
      ["createPet", "POST", "/pets", "write"],
      ["getPet", "GET", "/pets/{pet_id}", "read"],
      ["archivePet", "POST", "/pets/{pet_id}", "delete"],
      ["deletePet", "DELETE", "/pets/{pet_id}", "delete"],
    ],
  );
  const [list, create, get] = imported.tools;
  assert.deepEqual(list!.inputSchema.properties, { limit: { type: "integer", maximum: 100, description: "Page size" } });
  assert.deepEqual(list!.query, ["limit"]);
  assert.deepEqual(create!.query, ["dry-run"]);
  const fields = create!.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(fields).sort(), ["dry-run", "name", "owner", "tag"]);
  assert.deepEqual(fields.owner, {});
  assert.deepEqual(create!.inputSchema.required, ["name"]);
  assert.deepEqual(get!.inputSchema.required, ["pet_id"]);
  const request = buildHostedRequest(imported.server.baseUrl, create!, { name: "Ada", "dry-run": true, id: "x" });
  assert.deepEqual(request, {
    url: "https://eu.pets.example.com/v1/pets?dry-run=true",
    method: "POST",
    body: '{"name":"Ada"}',
  });
  assert.deepEqual(buildHostedRequest(imported.server.baseUrl, get!, { pet_id: "7" }), {
    url: "https://eu.pets.example.com/v1/pets/7",
    method: "GET",
  });
});

test("builder templates select actions", () => {
  assert.equal(templateAllows("readonly", "write"), false);
  assert.equal(templateAllows("writes", "write"), true);
  assert.equal(templateAllows("writes", "delete"), false);
  assert.equal(templateAllows("full", "delete"), true);
  assert.equal(templateAllows("custom", "delete"), true);
});
