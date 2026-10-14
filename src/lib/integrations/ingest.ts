import type {
  AuthMethod,
  EndpointDraft,
  EndpointParameter,
  IngestResult,
  IntegrationProtocol,
  JsonSchema,
  SideEffect,
  SpecKind,
} from "@/types/integrations";
import { slugify } from "@/lib/integrations/sanitize";

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sideEffect(method: string, operationId: string, summary: string): SideEffect {
  const name = `${operationId} ${summary}`.toLowerCase();
  if (method === "DELETE" || /\b(delete|destroy|remove|löschen|drop)\b/.test(name)) return "destructive";
  if (/\b(permission|role|secret|password|credential|token)\b/.test(name)) return "sensitive";
  if (method === "GET" || method === "HEAD") return "read";
  return "write";
}

function schemaOf(value: unknown): JsonSchema {
  const rec = record(value);
  return rec ?? {};
}

function parametersOf(value: unknown): EndpointParameter[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const rec = record(item);
    if (!rec || typeof rec.name !== "string") return [];
    const place = rec.in === "query" || rec.in === "header" || rec.in === "path" ? rec.in : "query";
    return [{ name: rec.name, in: place, required: rec.required === true || place === "path", schema: schemaOf(rec.schema) }];
  });
}

function endpoint(input: {
  method: string;
  path: string;
  operationId: string;
  summary: string;
  parameters?: EndpointParameter[];
  requestSchema?: JsonSchema;
  responseSchema?: JsonSchema;
  authRequired?: boolean;
  extras?: Record<string, unknown>;
}): EndpointDraft {
  const method = input.method.toUpperCase();
  return {
    operationId: slugify(input.operationId),
    method,
    path: input.path,
    summary: input.summary,
    parameters: input.parameters ?? [],
    headers: {},
    requestSchema: input.requestSchema ?? {},
    responseSchema: input.responseSchema ?? {},
    authRequired: input.authRequired !== false,
    errors: [],
    rateLimit: null,
    sideEffect: sideEffect(method, input.operationId, input.summary),
    enabled: false,
    origin: "local",
    protocolExtras: input.extras ?? {},
  };
}

function authFromScheme(scheme: Json): AuthMethod | null {
  const type = text(scheme.type).toLowerCase();
  const http = text(scheme.scheme).toLowerCase();
  if (type === "apikey") return "api_key";
  if (type === "http" && http === "basic") return "basic";
  if (type === "http" && http === "bearer") return "bearer";
  if (type === "oauth2" || type === "openidconnect") return "oauth2";
  return type ? "custom" : null;
}

function openApiAuth(doc: Json): AuthMethod[] {
  const components = record(doc.components);
  const schemes = record(components?.securitySchemes) ?? record(doc.securityDefinitions) ?? {};
  const methods = new Set<AuthMethod>();
  for (const scheme of Object.values(schemes)) {
    const rec = record(scheme);
    const method = rec ? authFromScheme(rec) : null;
    if (method) methods.add(method);
  }
  return [...methods];
}

function responseSchema(operation: Json): JsonSchema {
  const responses = record(operation.responses);
  const ok = record(responses?.["200"]) ?? record(responses?.["201"]) ?? {};
  const content = record(ok.content);
  const json = record(content?.["application/json"]);
  return schemaOf(json?.schema ?? ok.schema);
}

function requestSchema(operation: Json): JsonSchema {
  const body = record(operation.requestBody);
  const content = record(body?.content);
  const json = record(content?.["application/json"]);
  if (json?.schema) return schemaOf(json.schema);
  const params = Array.isArray(operation.parameters) ? operation.parameters : [];
  const form = params.find((item) => record(item)?.in === "body");
  return schemaOf(record(form)?.schema);
}

function parseOpenApi(doc: Json): IngestResult {
  const paths = record(doc.paths) ?? {};
  const limitations: string[] = [];
  if (doc.openapi == null && doc.swagger == null) limitations.push("spec_kind_uncertain");
  if (record(doc.components)?.callbacks || Object.values(paths).some((item) => record(item)?.callbacks)) {
    limitations.push("callbacks_not_imported");
  }
  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const baseUrl = text(record(servers[0])?.url) || text(doc.host);
  const endpoints: EndpointDraft[] = [];
  for (const [path, item] of Object.entries(paths)) {
    const pathItem = record(item);
    if (!pathItem) continue;
    for (const method of ["get", "post", "put", "patch", "delete", "head"]) {
      const operation = record(pathItem[method]);
      if (!operation) continue;
      const content = record(record(operation.requestBody)?.content);
      if (content && !content["application/json"] && Object.keys(content).some((key) => key.includes("xml"))) {
        limitations.push("xml_body_not_fully_modeled");
      }
      endpoints.push(
        endpoint({
          method,
          path,
          operationId: text(operation.operationId) || `${method}_${path}`,
          summary: text(operation.summary) || text(operation.description).slice(0, 240),
          parameters: parametersOf(operation.parameters ?? pathItem.parameters),
          requestSchema: requestSchema(operation),
          responseSchema: responseSchema(operation),
          extras: { tags: operation.tags ?? [] },
        }),
      );
    }
  }
  const info = record(doc.info);
  return {
    kind: "openapi",
    protocol: "rest",
    name: text(info?.title) || "Imported API",
    description: text(info?.description).slice(0, 2000),
    baseUrl,
    authMethods: openApiAuth(doc),
    endpoints,
    limitations: [...new Set(limitations)],
  };
}

function postmanUrl(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = record(value);
  if (!rec) return "";
  if (typeof rec.raw === "string") {
    try {
      const url = new URL(rec.raw);
      return `${url.pathname}${url.search}`;
    } catch {
      return rec.raw;
    }
  }
  const path = Array.isArray(rec.path) ? `/${rec.path.join("/")}` : "";
  return path || "/";
}

function walkPostman(items: unknown, endpoints: EndpointDraft[], limitations: string[]) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    const rec = record(item);
    if (!rec) continue;
    if (Array.isArray(rec.item)) walkPostman(rec.item, endpoints, limitations);
    const request = record(rec.request);
    if (!request) continue;
    const method = text(request.method) || "GET";
    if (method === "GRAPHQL") limitations.push("postman_graphql_not_expanded");
    endpoints.push(
      endpoint({
        method,
        path: postmanUrl(request.url) || "/",
        operationId: text(rec.name) || method,
        summary: text(rec.name),
        extras: { postman: true },
      }),
    );
  }
}

function postmanAuth(collection: Json): AuthMethod[] {
  const auth = record(collection.auth);
  const type = text(auth?.type);
  if (type === "bearer") return ["bearer"];
  if (type === "apikey") return ["api_key"];
  if (type === "basic") return ["basic"];
  if (type === "oauth2") return ["oauth2"];
  return [];
}

function parsePostman(doc: Json): IngestResult {
  const info = record(doc.info);
  const endpoints: EndpointDraft[] = [];
  const limitations: string[] = [];
  walkPostman(doc.item, endpoints, limitations);
  return {
    kind: "postman",
    protocol: "rest",
    name: text(info?.name) || "Postman collection",
    description: text(info?.description).slice(0, 2000),
    baseUrl: "",
    authMethods: postmanAuth(doc),
    endpoints,
    limitations,
  };
}

function graphqlFields(sdl: string, typeName: string): { name: string; args: string }[] {
  const match = new RegExp(`type\\s+${typeName}\\s*\\{([\\s\\S]*?)\\n\\}`, "i").exec(sdl);
  if (!match) return [];
  const fields: { name: string; args: string }[] = [];
  for (const line of match[1]!.split("\n")) {
    const field = /^\s*([A-Za-z_][A-Za-z0-9_]*)(\([^)]*\))?/.exec(line);
    if (!field || field[1] === typeName) continue;
    fields.push({ name: field[1]!, args: field[2] ?? "" });
  }
  return fields;
}

function parseGraphql(sdl: string): IngestResult {
  const limitations: string[] = [];
  if (/type\s+Subscription\b/.test(sdl)) limitations.push("graphql_subscriptions_not_imported");
  const endpoints = [
    ...graphqlFields(sdl, "Query").map((field) =>
      endpoint({
        method: "POST",
        path: "/",
        operationId: field.name,
        summary: `Query ${field.name}`,
        extras: { graphql: "query", args: field.args },
      }),
    ),
    ...graphqlFields(sdl, "Mutation").map((field) =>
      endpoint({
        method: "POST",
        path: "/",
        operationId: field.name,
        summary: `Mutation ${field.name}`,
        extras: { graphql: "mutation", args: field.args },
      }),
    ),
  ];
  for (const item of endpoints) {
    if (item.protocolExtras.graphql === "query") item.sideEffect = "read";
  }
  return {
    kind: "graphql",
    protocol: "graphql",
    name: "GraphQL API",
    description: "",
    baseUrl: "",
    authMethods: [],
    endpoints,
    limitations,
  };
}

function unsupported(protocol: IntegrationProtocol, kind: SpecKind, reason: string): IngestResult {
  return {
    kind,
    protocol,
    name: "Unsupported specification",
    description: "",
    baseUrl: "",
    authMethods: [],
    endpoints: [],
    limitations: [reason, "adapter_not_implemented"],
  };
}

export function ingestDocument(document: unknown): IngestResult {
  if (typeof document === "string") {
    const trimmed = document.trim();
    if (trimmed.startsWith("<?xml") || /<wsdl:|\bwsdl\b/i.test(trimmed) || /soap:Envelope/i.test(trimmed)) {
      return unsupported("soap", "unknown", "soap_detected");
    }
    if (/^\s*syntax\s*=\s*"proto/.test(trimmed) || /\bservice\s+\w+\s*\{/.test(trimmed) && /\brpc\s+/.test(trimmed)) {
      return unsupported("grpc", "unknown", "grpc_detected");
    }
    if (/type\s+Query\b|type\s+Mutation\b|schema\s*\{/.test(trimmed)) return parseGraphql(trimmed);
    try {
      return ingestDocument(JSON.parse(trimmed) as unknown);
    } catch {
      return unsupported("other", "unknown", "document_not_json");
    }
  }
  const doc = record(document);
  if (!doc) return unsupported("other", "unknown", "document_not_object");
  if (typeof doc.openapi === "string" || typeof doc.swagger === "string" || record(doc.paths)) return parseOpenApi(doc);
  if (record(doc.info) && (Array.isArray(doc.item) || text(record(doc.info)?.schema).includes("postman"))) {
    return parsePostman(doc);
  }
  if (doc.__schema || doc.data && record(record(doc.data)?.__schema)) {
    return unsupported("graphql", "graphql", "graphql_introspection_needs_normalization");
  }
  const manual = record(doc.endpoint);
  if (manual && typeof manual.path === "string" && typeof manual.method === "string") {
    return {
      kind: "manual",
      protocol: "rest",
      name: text(doc.name) || "Manual API",
      description: text(doc.description),
      baseUrl: text(doc.baseUrl),
      authMethods: [],
      endpoints: [endpoint({ method: manual.method, path: manual.path, operationId: text(manual.operationId) || manual.path, summary: text(manual.summary) })],
      limitations: [],
    };
  }
  if (record(doc.schema) || doc.$schema) {
    return {
      kind: "json_schema",
      protocol: "other",
      name: text(doc.title) || "JSON Schema",
      description: "",
      baseUrl: "",
      authMethods: [],
      endpoints: [],
      limitations: ["json_schema_is_not_an_endpoint_list"],
    };
  }
  return unsupported("other", "unknown", "unrecognized_specification");
}

export function classifySideEffect(method: string, operationId: string, summary = ""): SideEffect {
  return sideEffect(method, operationId, summary);
}
