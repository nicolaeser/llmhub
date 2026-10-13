import { readFileSync } from "node:fs";
import ts from "typescript";

export type JsxNode = { tag: string; attributes: Map<string, string>; children: JsxNode[] };
export type JsxSource = { imports: Map<string, { from: string; name: string }>; elements: JsxNode[] };

function attributeText(attribute: ts.JsxAttribute, source: ts.SourceFile): string {
  const value = attribute.initializer;
  if (!value) return "true";
  if (ts.isStringLiteral(value)) return value.text;
  if (ts.isJsxExpression(value)) return value.expression?.getText(source) ?? "";
  return value.getText(source);
}

export function readJsx(file: string): JsxSource {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = new Map<string, { from: string; name: string }>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.name) imports.set(clause.name.text, { from, name: "default" });
    const bindings = clause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      imports.set(element.name.text, { from, name: (element.propertyName ?? element.name).text });
    }
  }
  const elements: JsxNode[] = [];
  const visit = (node: ts.Node, parent: JsxNode | null): void => {
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (!opening) {
      ts.forEachChild(node, (child) => visit(child, parent));
      return;
    }
    const element: JsxNode = { tag: opening.tagName.getText(source), attributes: new Map(), children: [] };
    for (const property of opening.attributes.properties) {
      if (ts.isJsxAttribute(property)) element.attributes.set(property.name.getText(source), attributeText(property, source));
    }
    parent?.children.push(element);
    elements.push(element);
    ts.forEachChild(node, (child) => visit(child, element));
  };
  visit(source, null);
  return { imports, elements };
}

export function importedAs(source: JsxSource, from: string, name = "default"): string | null {
  for (const [local, binding] of source.imports) {
    if (binding.from === from && binding.name === name) return local;
  }
  return null;
}

export function rendersComponent(source: JsxSource, local: string | null): boolean {
  return local !== null && source.elements.some((element) => element.tag.split(".")[0] === local);
}
