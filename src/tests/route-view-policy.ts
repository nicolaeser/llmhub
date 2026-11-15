import { readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export const NEXT_ROUTE_SPECIAL_TSX = [
  "page.tsx",
  "layout.tsx",
  "loading.tsx",
  "error.tsx",
  "not-found.tsx",
  "template.tsx",
  "default.tsx",
  "global-not-found.tsx",
  "global-error.tsx",
  "forbidden.tsx",
  "unauthorized.tsx",
] as const;

const SPECIAL = new Set<string>(NEXT_ROUTE_SPECIAL_TSX);

const METADATA_TSX =
  /^(icon|apple-icon|opengraph-image|twitter-image)(\d+)?\.tsx$/;

const WHOLE_PAGE_EXTRACT = /^[a-z0-9]+(?:-[a-z0-9]+)*-page\.(?:ts|tsx)$/;

export function isNextRouteSpecialTsx(filename: string): boolean {
  return SPECIAL.has(filename) || METADATA_TSX.test(filename);
}

export function isAllowedAppTsx(filename: string): boolean {
  if (isNextRouteSpecialTsx(filename)) return true;
  return filename === "_action.ts";
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
  const filename = path.basename(filePath);
  if (filename.endsWith(".tsx")) return isForbiddenAppViewTsx(filename);
  if (!filename.endsWith(".ts")) return false;
  return filename !== "_action.ts" && filename !== "route.ts" &&
    filename !== "robots.ts" && filename !== "sitemap.ts" &&
    !isNextRouteSpecialTsx(filename.replace(/\.ts$/, ".tsx"));
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
      if (entry.name === "generated" || entry.name === "tests") continue;
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
  const tree = parseSource(source);
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return specs;
}

function parseSource(source: string) {
  return ts.createSourceFile("policy.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

export function isReExportOnly(source: string): boolean {
  const statements = parseSource(source).statements.filter((node) =>
    !ts.isImportDeclaration(node) &&
    !(ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression)),
  );
  return statements.length > 0 && statements.every((node) =>
    ts.isExportDeclaration(node) ||
    (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)),
  );
}

export function passThroughComponents(source: string): string[] {
  const found: string[] = [];
  function inspect(name: string, body: ts.ConciseBody | undefined) {
    if (!/^[A-Z]/.test(name) || !body) return;
    let expression: ts.Expression | undefined;
    if (ts.isBlock(body)) {
      if (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0])) return;
      expression = body.statements[0].expression;
    } else expression = body;
    while (expression && ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (expression && ts.isJsxSelfClosingElement(expression) && /^[A-Z]/.test(expression.tagName.getText())) {
      found.push(name);
    }
  }
  for (const node of parseSource(source).statements) {
    if (ts.isFunctionDeclaration(node)) inspect(node.name?.text ?? "Page", node.body);
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
          inspect(decl.name.text, decl.initializer.body);
        }
      }
    }
  }
  return found;
}

export function importersOf(srcRoot: string, readFile: (file: string) => string) {
  const graph = new Map<string, Set<string>>();
  const files = sourceFiles(srcRoot);
  const known = new Set(files.map(stripExt));
  for (const file of files) {
    for (const spec of moduleSpecifiers(readFile(file))) {
      let target: string | null = null;
      if (spec.startsWith("@/")) target = path.join(srcRoot, spec.slice(2));
      else if (spec.startsWith(".")) target = path.resolve(path.dirname(file), spec);
      if (!target) continue;
      const direct = stripExt(target);
      const key = known.has(direct) ? direct : path.join(direct, "index");
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

export function routeOwnersOf(srcRoot: string, importers: (file: string) => string[]) {
  return (file: string): string[] => {
    const owners = new Set<string>();
    const visited = new Set<string>();
    function visit(target: string) {
      if (visited.has(target)) return;
      visited.add(target);
      for (const importer of importers(target)) {
        const owner = routeKey(srcRoot, importer);
        if (owner.startsWith("app/")) owners.add(owner);
        else visit(importer);
      }
    }
    visit(file);
    return [...owners].sort();
  };
}
