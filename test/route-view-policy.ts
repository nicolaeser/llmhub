import { readdirSync } from "node:fs";
import path from "node:path";

export const NEXT_ROUTE_SPECIAL_TSX = [
  "page.tsx",
  "layout.tsx",
  "loading.tsx",
  "error.tsx",
  "not-found.tsx",
  "template.tsx",
  "default.tsx",
  "route.tsx",
  "global-not-found.tsx",
  "global-error.tsx",
  "forbidden.tsx",
  "unauthorized.tsx",
] as const;

const SPECIAL = new Set<string>(NEXT_ROUTE_SPECIAL_TSX);

const METADATA_TSX =
  /^(icon|apple-icon|opengraph-image|twitter-image)(\d+)?\.tsx$/;

const ROUTE_ACTION_FILES = new Set([
  "_action.ts",
  "_action.tsx",
  "_actions.ts",
  "_actions.tsx",
]);

const WHOLE_PAGE_EXTRACT = /^[a-z0-9]+(?:-[a-z0-9]+)*-page\.(?:ts|tsx)$/;

export function isNextRouteSpecialTsx(filename: string): boolean {
  return SPECIAL.has(filename) || METADATA_TSX.test(filename);
}

export function isAllowedAppTsx(filename: string): boolean {
  if (isNextRouteSpecialTsx(filename)) return true;
  return ROUTE_ACTION_FILES.has(filename);
}

export function isWholePageExtractName(filename: string): boolean {
  return WHOLE_PAGE_EXTRACT.test(filename);
}

export function isForbiddenAppViewTsx(filename: string): boolean {
  if (!filename.endsWith(".tsx")) return false;
  return !isAllowedAppTsx(filename);
}

export function isRouteColocatedView(filePath: string): boolean {
  return filePath.split(path.sep).includes("_components");
}

export function isForbiddenAppViewFile(filePath: string): boolean {
  if (isRouteColocatedView(filePath)) return false;
  return isForbiddenAppViewTsx(path.basename(filePath));
}

export function listForbiddenAppViewFiles(appRoot: string): string[] {
  const found: string[] = [];

  function walk(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && isForbiddenAppViewFile(full)) {
        found.push(full);
      }
    }
  }

  walk(appRoot);
  return found.sort();
}

export function listWholePageExtractFiles(appRoot: string): string[] {
  const found: string[] = [];

  function walk(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (
        entry.isFile() &&
        isRouteColocatedView(full) &&
        isWholePageExtractName(entry.name)
      ) {
        found.push(full);
      }
    }
  }

  walk(appRoot);
  return found.sort();
}

const SOURCE_EXT = [".tsx", ".ts"];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated") continue;
      found.push(...sourceFiles(full));
    } else if (entry.isFile() && SOURCE_EXT.some((ext) => entry.name.endsWith(ext))) {
      found.push(full);
    }
  }
  return found;
}

function stripExt(file: string): string {
  return file.replace(/\.(tsx|ts)$/, "");
}

export function moduleSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)\s[^"'`;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(re)) specs.push(match[1] ?? match[2]);
  return specs;
}

export function importersOf(srcRoot: string, readFile: (file: string) => string) {
  const graph = new Map<string, Set<string>>();
  for (const file of sourceFiles(srcRoot)) {
    for (const spec of moduleSpecifiers(readFile(file))) {
      let target: string | null = null;
      if (spec.startsWith("@/")) target = path.join(srcRoot, spec.slice(2));
      else if (spec.startsWith(".")) target = path.resolve(path.dirname(file), spec);
      if (!target) continue;
      const key = stripExt(target);
      if (!graph.has(key)) graph.set(key, new Set());
      graph.get(key)!.add(file);
    }
  }
  return (file: string) => [...(graph.get(stripExt(file)) ?? [])];
}

export function routeKey(srcRoot: string, file: string): string {
  const appRoot = path.join(srcRoot, "app");
  const rel = path.relative(appRoot, file);
  if (rel.startsWith("..")) {
    return path.relative(srcRoot, file).split(path.sep)[0];
  }
  const segments = rel.split(path.sep).slice(0, -1);
  const cut = segments.indexOf("_components");
  return ["app", ...(cut === -1 ? segments : segments.slice(0, cut))].join("/");
}

export function listSourceFiles(dir: string): string[] {
  return sourceFiles(dir).sort();
}
