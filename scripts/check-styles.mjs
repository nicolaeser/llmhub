#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const STYLESHEET = "src/styles/globals.css";
const HEROUI_THEMES = path.join(ROOT, "node_modules", "@heroui", "styles", "dist", "themes");
const THEME_CLASSES = new Set(["light", "dark"]);
const IMAGE_ROUTE = /(?:^|\/)(?:icon|apple-icon|opengraph-image|twitter-image)\d*\.tsx$/;

const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

const HARD_RULES = [
  {
    pattern: /\bdark:[^\s"']+/,
    message: "Do not use dark: modifiers; HeroUI tokens adapt in both themes.",
  },
  {
    pattern: /\b(?:[\w-]+:)*text-\[[0-9.]+(?:px|rem)\]/,
    message: "Use text-xs through text-xl; do not write literal type sizes.",
  },
  {
    pattern: /\b(?:[\w-]+:)*overflow(?:-[xy])?-(?:hidden|clip)\b/,
    message: "Do not clip overflow (overflow-hidden / overflow-clip); content must remain reachable.",
  },
  {
    pattern: /\b(?:[\w-]+:)*(?:text|bg|border|ring|outline|divide|fill|stroke|from|via|to|placeholder)-default-[0-9]{2,3}\b/,
    message: "There is no default-N scale; use text-muted, bg-default, or a HeroUI component.",
  },
  {
    pattern: new RegExp(
      `\\b(?:[\\w-]+:)*(?:text|bg|border|ring|outline|divide|fill|stroke|from|via|to|placeholder|decoration|shadow)-(?:${PALETTE})-[0-9]{2,3}\\b`,
    ),
    message: "Do not use raw Tailwind palette colors; use HeroUI semantic tokens.",
  },
  {
    pattern: /\b(?:[\w-]+:)*(?:text-white|text-black|bg-black)\b/,
    message: "Do not hard-code white or black; use foreground, accent-foreground, or another HeroUI token.",
  },
  {
    pattern: /\b(?:[\w-]+:)*bg-(?:linear|radial|conic|gradient)-/,
    message: "Do not paint gradients; HeroUI tokens and components carry the visual language.",
  },
  {
    pattern: /\brounded-[\w[\]-]*\s[^"'`]*\bborder-border\b[^"'`]*\bbg-surface\b|\bbg-surface\b[^"'`]*\bborder-border\b[^"'`]*\brounded-/,
    message: "Do not hand-roll bordered panels; use HeroUI Card or Surface.",
  },
  {
    pattern: /\bstyle=\{\{/,
    message: "Do not use inline style objects; use Tailwind layout utilities or HeroUI props.",
    imageRoutesExempt: true,
  },
];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (rel === "src/generated") continue;
      out.push(...walk(full));
      continue;
    }
    if (/\.generated\.(tsx?|jsx?|css)$/.test(entry.name)) continue;
    if (/\.(tsx?|jsx?|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function heroTokens() {
  const tokens = new Set();
  if (!fs.existsSync(HEROUI_THEMES)) return null;
  for (const file of walk(HEROUI_THEMES)) {
    if (!file.endsWith(".css")) continue;
    for (const match of fs.readFileSync(file, "utf8").matchAll(/(--[\w-]+)\s*:/g)) {
      tokens.add(match[1]);
    }
  }
  return tokens;
}

const errors = [];
const files = walk(SRC);
const relOf = (file) => path.relative(ROOT, file).split(path.sep).join("/");

for (const file of files) {
  const rel = relOf(file);
  if (rel.endsWith(".css")) {
    if (rel !== STYLESHEET) {
      errors.push(`${rel}: the only stylesheet is ${STYLESHEET}.`);
    }
    continue;
  }
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of HARD_RULES) {
      if (rule.pattern.test(line) && !(rule.imageRoutesExempt && IMAGE_ROUTE.test(rel))) {
        errors.push(`${rel}:${index + 1}: ${rule.message}`);
      }
    }
    if (/\bimport\s+["'][^"']+\.css["']/.test(line) && rel !== "src/app/layout.tsx") {
      errors.push(`${rel}:${index + 1}: only src/app/layout.tsx imports ${STYLESHEET}.`);
    }
  });
}

const stylesheet = path.join(ROOT, STYLESHEET);
if (!fs.existsSync(stylesheet)) {
  errors.push(`${STYLESHEET} is missing`);
} else {
  const css = fs.readFileSync(stylesheet, "utf8");
  if (!/@import\s+["']tailwindcss["']/.test(css)) {
    errors.push(`${STYLESHEET}: must import tailwindcss`);
  }
  if (!/@import\s+["']@heroui\/styles["']/.test(css)) {
    errors.push(`${STYLESHEET}: must import @heroui/styles`);
  }
  if (/\/\*/.test(css)) {
    errors.push(`${STYLESHEET}: no comments`);
  }
  if (/@keyframes|@theme|@utility|@apply/.test(css)) {
    errors.push(`${STYLESHEET}: only HeroUI token overrides; no @keyframes, @theme, @utility, or @apply`);
  }
  const selectors = css
    .replace(/\{[^{}]*\}/g, "{}")
    .split("{}")
    .map((chunk) => chunk.replace(/@[^;{]*;/g, "").replace(/@layer\s+\w+\s*\{/g, ""));
  for (const selector of selectors) {
    for (const match of selector.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
      if (!THEME_CLASSES.has(match[1])) {
        errors.push(`${STYLESHEET}: custom class .${match[1]} is not allowed; use HeroUI components or Tailwind utilities`);
      }
    }
  }
  const official = heroTokens();
  if (official) {
    for (const match of css.matchAll(/(--[\w-]+)\s*:/g)) {
      if (!official.has(match[1])) {
        errors.push(`${STYLESHEET}: ${match[1]} is not a HeroUI token; override official tokens only`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`Style audit failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Style audit passed for ${files.length} source files.`);
