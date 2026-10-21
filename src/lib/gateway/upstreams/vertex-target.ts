import type { VertexCredentialKind, VertexModelRoute, VertexTarget } from "@/types/providers";

export const VERTEX_DEFAULT_LOCATION = "global";
export const VERTEX_API_VERSION = "v1";
export const VERTEX_LIST_VERSION = "v1beta1";
export const VERTEX_EXPRESS_BASE_URL = `https://aiplatform.googleapis.com/${VERTEX_API_VERSION}`;
export const VERTEX_ANTHROPIC_VERSION = "vertex-2023-10-16";
export const MAX_VERTEX_CREDENTIAL_CHARS = 16_384;

const MULTI_REGIONS = new Set(["us", "eu"]);
const LOCATION = /^(?:global|us|eu|[a-z]+-[a-z]+[0-9]+)$/;
const PROJECT_ID = /^(?:[a-z][a-z0-9.-]{0,61}[a-z0-9]:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const PROJECT_NUMBER = /^[0-9]{1,20}$/;
const TARGET_PATH = /\/projects\/([^/]+)\/locations\/([^/]+)$/;
const PUBLISHER_RESOURCE = /^publishers\/([^/]+)\/models\/([^/]+)$/i;
const GOOGLE_PUBLISHERS = new Set(["google", "models"]);
const IMAGEN_RATIOS = [
  { label: "1:1", value: 1 },
  { label: "3:4", value: 3 / 4 },
  { label: "4:3", value: 4 / 3 },
  { label: "9:16", value: 9 / 16 },
  { label: "16:9", value: 16 / 9 },
];

export function validVertexLocation(location: string): boolean {
  return LOCATION.test(location);
}

export function validVertexProject(project: string): boolean {
  return PROJECT_ID.test(project) || PROJECT_NUMBER.test(project);
}

export function vertexHost(location: string): string {
  if (location === "global") return "aiplatform.googleapis.com";
  if (MULTI_REGIONS.has(location)) return `aiplatform.${location}.rep.googleapis.com`;
  return `${location}-aiplatform.googleapis.com`;
}

export function vertexBaseUrl(target: VertexTarget): string {
  return `https://${vertexHost(target.location)}/${VERTEX_API_VERSION}/projects/${target.project}/locations/${target.location}`;
}

export function vertexTarget(baseUrl: string): VertexTarget | null {
  const match = TARGET_PATH.exec(baseUrl.trim().replace(/\/+$/, ""));
  if (!match) return null;
  const project = decodeURIComponent(match[1]!);
  const location = decodeURIComponent(match[2]!);
  return validVertexProject(project) && validVertexLocation(location) ? { project, location } : null;
}

function publisherRoute(publisher: string, model: string): VertexModelRoute {
  const name = publisher.toLowerCase();
  if (GOOGLE_PUBLISHERS.has(name)) return { route: "google", model };
  if (name === "anthropic") return { route: "anthropic", model };
  return { route: "openapi", model: `${name}/${model}` };
}

export function vertexModelRoute(model: string): VertexModelRoute {
  const id = model.trim();
  const resource = PUBLISHER_RESOURCE.exec(id);
  if (resource) return publisherRoute(resource[1]!, resource[2]!);
  const slash = id.indexOf("/");
  if (slash > 0 && slash < id.length - 1 && !id.slice(slash + 1).includes("/")) {
    return publisherRoute(id.slice(0, slash), id.slice(slash + 1));
  }
  if (/^claude-/i.test(id)) return { route: "anthropic", model: id };
  return { route: "google", model: id };
}

export function vertexVendor(model: string): string {
  const { route, model: id } = vertexModelRoute(model);
  if (route === "google") return /^(?:gemini|gemma|imagen)/i.test(id) ? "google" : "";
  if (route === "anthropic") return "anthropic";
  return id.slice(0, id.indexOf("/"));
}

export function vertexCredentialKind(text: string): VertexCredentialKind | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("{") ? "service_account" : "api_key";
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function serviceAccountSummary(text: string): { project: string; email: string } | null {
  const json = jsonObject(text.trim());
  if (!json) return null;
  const field = (key: string) => (typeof json[key] === "string" ? (json[key] as string).trim() : "");
  if ((field("type") && field("type") !== "service_account") || !field("client_email").includes("@")) return null;
  if (!field("private_key").includes("PRIVATE KEY")) return null;
  return { project: field("project_id"), email: field("client_email") };
}

export function vertexAspectRatio(size: string): string {
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) return "";
  const wanted = Number(match[1]) / Number(match[2]);
  if (!Number.isFinite(wanted) || wanted <= 0) return "";
  return IMAGEN_RATIOS.reduce((best, ratio) => (Math.abs(ratio.value - wanted) < Math.abs(best.value - wanted) ? ratio : best)).label;
}
