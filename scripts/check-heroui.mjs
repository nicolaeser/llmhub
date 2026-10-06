#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const sourceRoot = path.join(root, "src");

const legacyImports = new Set([
  "HeroUIProvider",
  "CardBody",
  "CardFooter",
  "CardHeader",
  "CheckboxContent",
  "CheckboxControl",
  "CheckboxIndicator",
  "CheckboxRoot",
  "DropdownItem",
  "DropdownMenu",
  "DropdownRoot",
  "DropdownTrigger",
  "ModalBackdrop",
  "ModalBody",
  "ModalContainer",
  "ModalContent",
  "ModalDialog",
  "ModalFooter",
  "ModalHeader",
  "ModalHeading",
  "ModalRoot",
  "ModalTrigger",
  "NavbarBrand",
  "NavbarContent",
  "NavbarItem",
  "NavbarMenu",
  "NavbarMenuItem",
  "NavbarMenuToggle",
  "PopoverContent",
  "PopoverDialog",
  "PopoverRoot",
  "PopoverTrigger",
  "RadioContent",
  "RadioControl",
  "RadioIndicator",
  "RadioRoot",
  "SelectItem",
  "SelectPopover",
  "SelectRoot",
  "SelectTrigger",
  "SelectValue",
  "SwitchContent",
  "SwitchControl",
  "SwitchRoot",
  "SwitchThumb",
  "TableBody",
  "TableCell",
  "TableColumn",
  "TableContent",
  "TableHeader",
  "TableRoot",
  "TableRow",
  "TableScrollContainer",
  "ToastProvider",
  "TooltipContent",
  "TooltipRoot",
  "TooltipTrigger",
]);

const pressableButtons = new Set(["Button", "CloseButton", "ToggleButton"]);

const nativeControls = new Map([
  ["button", "Button"],
  ["select", "Select"],
  ["textarea", "TextArea"],
  ["input", "Input"],
]);

const nativeInputTypes = new Set(["file", "hidden"]);

function nativeControlMessage(tag) {
  return `Use the HeroUI ${nativeControls.get(tag)} instead of a native <${tag}>.`;
}

function collectSourceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (rel === "src/pg" || rel === "src/generated") continue;
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (/\.generated\.(tsx?|jsx?)$/.test(entry.name)) continue;
    if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function lineCol(text, index) {
  const until = text.slice(0, index);
  const lines = until.split(/\r?\n/);
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function parseNamedImports(specifierBlock) {
  const out = [];
  for (const part of specifierBlock.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tokens = trimmed.replace(/^type\s+/, "").split(/\s+as\s+/);
    const imported = tokens[0]?.trim();
    const local = (tokens[1] ?? tokens[0])?.trim();
    if (imported) out.push({ imported, local });
  }
  return out;
}

function openingTagSlice(text, start, tagLength) {
  let i = start + tagLength;
  let depth = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (depth === 0 && ch === ">") break;
    i += 1;
  }
  return text.slice(start, i + 1);
}

function auditWithRegex(files) {
  const errors = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file).split(path.sep).join("/");
    const report = (index, message) => {
      const { line, column } = lineCol(text, index);
      errors.push(`${rel}:${line}:${column} ${message}`);
    };

    const importRe =
      /import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([^}]*)\}\s+from\s+["']@heroui\/react["']/g;
    let importMatch;
    while ((importMatch = importRe.exec(text))) {
      if (importMatch[1] === "HeroUIProvider") {
        report(
          importMatch.index,
          "Do not use HeroUIProvider; HeroUI v3 needs no provider wrapper.",
        );
      }
      for (const { imported } of parseNamedImports(importMatch[2])) {
        if (imported === "HeroUIProvider") {
          report(
            importMatch.index,
            "Do not use HeroUIProvider; HeroUI v3 needs no provider wrapper.",
          );
        } else if (legacyImports.has(imported)) {
          report(
            importMatch.index,
            `Use the HeroUI compound API instead of the flat ${imported} import.`,
          );
        }
      }
    }

    const defaultImportRe =
      /import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s+from\s+["']@heroui\/react["']/g;
    let defaultMatch;
    while ((defaultMatch = defaultImportRe.exec(text))) {
      if (defaultMatch[1] === "HeroUIProvider") {
        report(
          defaultMatch.index,
          "Do not use HeroUIProvider; HeroUI v3 needs no provider wrapper.",
        );
      }
    }

    const providerIdx = text.search(/\bHeroUIProvider\b/);
    if (providerIdx >= 0) {
      report(
        providerIdx,
        "Do not use HeroUIProvider; HeroUI v3 needs no provider wrapper.",
      );
    }

    for (const tag of nativeControls.keys()) {
      const tagRe = new RegExp(`<${tag}(?=[\\s>/])`, "g");
      let tagMatch;
      while ((tagMatch = tagRe.exec(text))) {
        const opening = openingTagSlice(text, tagMatch.index, `<${tag}`.length);
        const type = /\btype=["']([\w-]+)["']/.exec(opening)?.[1];
        if (tag === "input" && type && nativeInputTypes.has(type)) continue;
        report(tagMatch.index, nativeControlMessage(tag));
      }
    }

    for (const name of pressableButtons) {
      const buttonRe = new RegExp(`<${name}\\b`, "g");
      let buttonMatch;
      while ((buttonMatch = buttonRe.exec(text))) {
        const opening = openingTagSlice(text, buttonMatch.index, `<${name}`.length);
        if (/\bonClick\b/.test(opening)) {
          report(buttonMatch.index, `${name} must use onPress instead of onClick.`);
        }
      }
    }
  }
  return errors;
}

function auditWithTypeScript(ts, files) {
  const errors = [];

  function rawTagName(name) {
    if (ts.isIdentifier(name)) return name.text;
    if (ts.isJsxNamespacedName(name)) {
      return `${name.namespace.text}:${name.name.text}`;
    }
    return `${rawTagName(name.expression)}.${name.name.text}`;
  }

  function openingOf(node) {
    if (ts.isJsxElement(node)) return node.openingElement;
    if (ts.isJsxSelfClosingElement(node)) return node;
    return null;
  }

  function attributeNames(opening) {
    return new Set(
      opening.attributes.properties
        .filter(ts.isJsxAttribute)
        .map((attribute) => rawTagName(attribute.name)),
    );
  }

  for (const file of files) {
    const text = ts.sys.readFile(file);
    if (text === undefined) continue;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") || file.endsWith(".jsx")
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS,
    );
    const heroImports = new Map();

    const report = (node, message) => {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      errors.push(
        `${path.relative(root, file).split(path.sep).join("/")}:${position.line + 1}:${position.character + 1} ${message}`,
      );
    };

    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (statement.moduleSpecifier.text !== "@heroui/react") continue;

      if (statement.importClause?.name?.text === "HeroUIProvider") {
        report(
          statement.importClause.name,
          "Do not use HeroUIProvider; HeroUI v3 needs no provider wrapper.",
        );
      }

      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        heroImports.set(element.name.text, imported);
        if (imported === "HeroUIProvider") {
          report(
            element,
            "Do not use HeroUIProvider; HeroUI v3 needs no provider wrapper.",
          );
        } else if (legacyImports.has(imported)) {
          report(
            element,
            `Use the HeroUI compound API instead of the flat ${imported} import.`,
          );
        }
      }
    }

    const visit = (node) => {
      const isElement = ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
      if (isElement) {
        const opening = openingOf(node);
        const raw = opening ? rawTagName(opening.tagName) : "";
        const imported = heroImports.get(raw.split(".")[0]);
        const resolved = imported
          ? [imported, ...raw.split(".").slice(1)].join(".")
          : raw;
        const attributes = opening ? attributeNames(opening) : new Set();

        if (raw === "HeroUIProvider" || resolved === "HeroUIProvider") {
          report(node, "Do not use HeroUIProvider; HeroUI v3 needs no provider wrapper.");
        }

        if (nativeControls.has(raw)) {
          const typeAttr = opening.attributes.properties.find(
            (attribute) =>
              ts.isJsxAttribute(attribute) && rawTagName(attribute.name) === "type",
          );
          const type =
            typeAttr && typeAttr.initializer && ts.isStringLiteral(typeAttr.initializer)
              ? typeAttr.initializer.text
              : "";
          if (!(raw === "input" && nativeInputTypes.has(type))) {
            report(node, nativeControlMessage(raw));
          }
        }

        if (pressableButtons.has(resolved) && attributes.has("onClick")) {
          report(node, `${resolved} must use onPress instead of onClick.`);
        } else if (pressableButtons.has(raw) && attributes.has("onClick")) {
          report(node, `${raw} must use onPress instead of onClick.`);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return errors;
}

const files = collectSourceFiles(sourceRoot);
let ts;
try {
  const mod = await import("typescript");
  ts = mod.default ?? mod;
} catch {
  ts = null;
}

const errors =
  ts && typeof ts.createSourceFile === "function"
    ? auditWithTypeScript(ts, files)
    : auditWithRegex(files);

if (errors.length > 0) {
  console.error(`HeroUI audit failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`HeroUI audit passed for ${files.length} TypeScript source files.`);
