import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { NEXT_ROUTE_SPECIAL_TSX } from "../route-view-policy";

type Directive = "use client" | "use server" | null;
type ModuleFacts = { directive: Directive; imports: string[]; paths: string[]; unresolvedNamespaces: number };

const RESOLVE_SUFFIXES = ["", ".tsx", ".ts", "/index.tsx", "/index.ts"];

function isTypeOnlyImport(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return !clause.name && !!bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

function isTypeOnlyExport(statement: ts.ExportDeclaration): boolean {
  if (statement.isTypeOnly) return true;
  const clause = statement.exportClause;
  return !!clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
}

const TRANSLATOR_METHODS = new Set(["rich", "markup", "raw", "has"]);
const DEPENDENCY_HOOKS = new Set(["useCallback", "useMemo", "useEffect", "useLayoutEffect"]);

function isHookDependency(node: ts.Identifier): boolean {
  const list = node.parent;
  if (!ts.isArrayLiteralExpression(list) || !ts.isCallExpression(list.parent)) return false;
  const hook = list.parent.expression;
  return ts.isIdentifier(hook) && DEPENDENCY_HOOKS.has(hook.text) && list.parent.arguments[1] === list;
}

function keyPrefixes(argument: ts.Expression | undefined): string[] {
  if (!argument) return [""];
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return [argument.text];
  if (ts.isTemplateExpression(argument)) {
    const head = argument.head.text;
    return [head.slice(0, Math.max(head.lastIndexOf("."), 0))];
  }
  if (ts.isConditionalExpression(argument)) return [...keyPrefixes(argument.whenTrue), ...keyPrefixes(argument.whenFalse)];
  if (ts.isParenthesizedExpression(argument)) return keyPrefixes(argument.expression);
  return [""];
}

function enclosingScope(node: ts.Node): ts.Node {
  let current = node.parent;
  while (current && !ts.isBlock(current) && !ts.isSourceFile(current) && !ts.isFunctionLike(current)) current = current.parent;
  return current ?? node.getSourceFile();
}

function translatorKeys(declaration: ts.VariableDeclaration & { name: ts.Identifier }): string[] {
  const name = declaration.name.text;
  const keys: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name && node !== declaration.name) {
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node) {
        keys.push(...keyPrefixes(parent.arguments[0]));
      } else if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        TRANSLATOR_METHODS.has(parent.name.text) &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent
      ) {
        keys.push(...keyPrefixes(parent.parent.arguments[0]));
      } else if (!isHookDependency(node)) {
        keys.push("");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(enclosingScope(declaration));
  return keys;
}

function messagePaths(namespace: string, call: ts.CallExpression): string[] {
  const declaration = call.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== call || !ts.isIdentifier(declaration.name)) {
    return [namespace];
  }
  return translatorKeys(declaration as ts.VariableDeclaration & { name: ts.Identifier }).map((key) => (key ? `${namespace}.${key}` : namespace));
}

function readModule(file: string): ModuleFacts {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const first = source.statements[0];
  const prologue = first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) ? first.expression.text : null;
  const directive: Directive = prologue === "use client" || prologue === "use server" ? prologue : null;
  const imports: string[] = [];
  const paths: string[] = [];
  let unresolvedNamespaces = 0;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && !isTypeOnlyImport(statement)) {
      imports.push(statement.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && !isTypeOnlyExport(statement)) {
      imports.push(statement.moduleSpecifier.text);
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const [argument] = node.arguments;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && argument && ts.isStringLiteral(argument)) {
        imports.push(argument.text);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "useTranslations") {
        if (argument && ts.isStringLiteral(argument)) paths.push(...messagePaths(argument.text, node));
        else unresolvedNamespaces += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { directive, imports, paths, unresolvedNamespaces };
}

function resolveSpecifier(srcRoot: string, from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(srcRoot, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else return null;
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile() && /\.(tsx|ts)$/.test(candidate)) return candidate;
  }
  return null;
}

const moduleFacts = new Map<string, ModuleFacts>();

function factsOf(file: string): ModuleFacts {
  let known = moduleFacts.get(file);
  if (!known) {
    known = readModule(file);
    moduleFacts.set(file, known);
  }
  return known;
}

export type ClientTranslationUse = { path: string; file: string };

export function clientTranslationUses(srcRoot: string, entries: string[]): { uses: ClientTranslationUse[]; unresolved: string[] } {
  const seen = new Set<string>();
  const queue = entries.map((file) => ({ file, client: false }));
  const uses: ClientTranslationUse[] = [];
  const unresolved: string[] = [];
  while (queue.length > 0) {
    const next = queue.shift()!;
    const module = factsOf(next.file);
    const client = module.directive === "use client" || (next.client && module.directive !== "use server");
    const key = `${client ? "client" : "server"}:${next.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (client) {
      for (const messagePath of module.paths) uses.push({ path: messagePath, file: next.file });
      if (module.unresolvedNamespaces > 0) unresolved.push(next.file);
    }
    for (const specifier of module.imports) {
      const target = resolveSpecifier(srcRoot, next.file, specifier);
      if (target) queue.push({ file: target, client });
    }
  }
  return { uses, unresolved };
}

const OUTSIDE_ROOT_LAYOUT = new Set(["route.tsx", "global-error.tsx", "global-not-found.tsx"]);
const ROUTE_UI_FILES = new Set<string>(NEXT_ROUTE_SPECIAL_TSX.filter((name) => !OUTSIDE_ROOT_LAYOUT.has(name)));

export function routeUiFiles(dir: string, { recursive }: { recursive: boolean }): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive && entry.name !== "_components") found.push(...routeUiFiles(full, { recursive }));
    } else if (ROUTE_UI_FILES.has(entry.name)) {
      found.push(full);
    }
  }
  return found.sort();
}

export function isCoveredBy(messagePath: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => messagePath === entry || messagePath.startsWith(`${entry}.`));
}
