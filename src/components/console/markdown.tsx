"use client";

import { createContext, useContext, type ComponentProps, type JSX } from "react";
import type { Root, RootContent, Text } from "mdast";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, Chip, Separator, Table } from "@heroui/react";
import { Image as ImageGlyph, Square, SquareCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import { splitPiiPlaceholders } from "@/lib/gateway/pii";
import CopyButton from "./copy-button";

type MdNode = NonNullable<ExtraProps["node"]>;
type MdChild = MdNode["children"][number];
type Md<T extends keyof JSX.IntrinsicElements> = ComponentProps<T> & ExtraProps;

const TableSection = createContext<"head" | "body">("body");
const RowHeaderCell = createContext<MdChild | undefined>(undefined);

const LINK_CLASS = "text-accent underline underline-offset-2";

function piiTexts(node: Text): Text[] {
  return splitPiiPlaceholders(node.value).map((part) =>
    part.entity
      ? { type: "text", value: part.text, data: { hName: "span", hProperties: { dataPii: part.entity } } }
      : { type: "text", value: part.text },
  );
}

function markPii(parent: { children: RootContent[] }) {
  parent.children = parent.children.flatMap((child): RootContent[] => {
    if (child.type === "text") return piiTexts(child);
    if ("children" in child) markPii(child);
    return [child];
  });
}

const remarkPii = () => (tree: Root) => markPii(tree);

const PLUGINS = [remarkGfm];
const PII_PLUGINS = [remarkGfm, remarkPii];

function safeHref(href: string): string | null {
  if (href.startsWith("/") && !href.startsWith("//") && !href.includes("\\")) {
    return href;
  }
  try {
    const url = new URL(href);
    if (url.protocol === "http:" || url.protocol === "https:") return href;
  } catch {
    return null;
  }
  return null;
}

function textOf(node: MdChild): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textOf).join("");
  return "";
}

function firstElement(node: MdChild | undefined, tagName: string) {
  if (node?.type !== "element") return undefined;
  return node.children.find(
    (child) => child.type === "element" && child.tagName === tagName,
  );
}

function codeLanguage(node: MdChild | undefined): string {
  if (node?.type !== "element") return "";
  const classes = node.properties.className;
  const list = Array.isArray(classes) ? classes.map(String) : [];
  return list.find((name) => name.startsWith("language-"))?.slice(9) ?? "";
}

function MdLink({ href, children }: Md<"a">) {
  const safe = safeHref(href ?? "");
  if (!safe) return <span>{children}</span>;
  if (safe.startsWith("/")) {
    return (
      <Link href={safe} className={LINK_CLASS}>
        {children}
      </Link>
    );
  }
  return (
    <a href={safe} target="_blank" rel="noreferrer noopener" className={LINK_CLASS}>
      {children}
    </a>
  );
}

function MdImage({ src, alt }: Md<"img">) {
  const t = useTranslations("Markdown");
  const safe = typeof src === "string" ? safeHref(src) : null;
  const label = alt || t("image");
  if (!safe) return <span className="text-muted">{label}</span>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noreferrer noopener"
      className={`inline-flex items-center gap-1 ${LINK_CLASS}`}
    >
      <ImageGlyph size={14} aria-hidden />
      {label}
    </a>
  );
}

function MdPre({ node }: Md<"pre">) {
  const t = useTranslations("Markdown");
  const code = firstElement(node, "code");
  const language = codeLanguage(code);
  const text = code ? textOf(code).replace(/\n$/, "") : "";
  return (
    <Card variant="secondary" className="gap-0 p-0">
      <div className="flex items-center justify-between gap-2 py-1 pr-1 pl-3">
        <span className="font-mono text-xs text-muted">
          {language || t("code")}
        </span>
        <CopyButton text={text} label={t("copyCode")} />
      </div>
      <Separator />
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">
        <code>{text}</code>
      </pre>
    </Card>
  );
}

function MdCode({ children }: Md<"code">) {
  return (
    <code className="rounded bg-default px-1 py-0.5 font-mono text-xs break-words">
      {children}
    </code>
  );
}

function MdTable({ node, children }: Md<"table">) {
  const t = useTranslations("Markdown");
  const hasBody = Boolean(firstElement(node, "tbody"));
  return (
    <Table variant="secondary">
      <Table.ScrollContainer>
        <Table.Content aria-label={t("table")}>
          {children}
          {hasBody ? null : <Table.Body>{[]}</Table.Body>}
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}

function MdHead({ node, children }: Md<"thead">) {
  return (
    <TableSection.Provider value="head">
      <RowHeaderCell.Provider value={firstElement(firstElement(node, "tr"), "th")}>
        <Table.Header>{children}</Table.Header>
      </RowHeaderCell.Provider>
    </TableSection.Provider>
  );
}

function MdBody({ children }: Md<"tbody">) {
  return <Table.Body>{children}</Table.Body>;
}

function MdRow({ children }: Md<"tr">) {
  const section = useContext(TableSection);
  if (section === "head") return <>{children}</>;
  return <Table.Row>{children}</Table.Row>;
}

function MdHeaderCell({ node, children }: Md<"th">) {
  const rowHeader = useContext(RowHeaderCell);
  return (
    <Table.Column isRowHeader={Boolean(node) && node === rowHeader}>
      {children}
    </Table.Column>
  );
}

function MdCell({ children }: Md<"td">) {
  return <Table.Cell>{children}</Table.Cell>;
}

function MdList({ className, children }: Md<"ul">) {
  const tasks = className?.includes("contains-task-list");
  return (
    <ul className={tasks ? "space-y-1" : "list-disc space-y-1 pl-5"}>
      {children}
    </ul>
  );
}

function MdOrderedList({ start, children }: Md<"ol">) {
  return (
    <ol start={start} className="list-decimal space-y-1 pl-5">
      {children}
    </ol>
  );
}

function MdListItem({ className, children }: Md<"li">) {
  if (className?.includes("task-list-item")) {
    return <li className="flex items-start gap-2">{children}</li>;
  }
  return <li className="pl-1">{children}</li>;
}

function MdSpan({ node, children }: Md<"span">) {
  const t = useTranslations("Guardrails");
  const entity = node?.properties.dataPii;
  if (typeof entity !== "string") return <span>{children}</span>;
  return (
    <Chip size="sm" variant="soft" color="warning">
      {t("entityLabel", { id: entity })}
    </Chip>
  );
}

function MdInput({ type, checked }: Md<"input">) {
  if (type !== "checkbox") return null;
  return checked ? (
    <SquareCheck size={14} aria-hidden className="mt-1 shrink-0 text-accent" />
  ) : (
    <Square size={14} aria-hidden className="mt-1 shrink-0 text-muted" />
  );
}

const COMPONENTS: Components = {
  h1: ({ children }) => (
    <h2 className="text-lg font-semibold tracking-tight">{children}</h2>
  ),
  h2: ({ children }) => (
    <h3 className="text-base font-semibold tracking-tight">{children}</h3>
  ),
  h3: ({ children }) => <h4 className="text-sm font-semibold">{children}</h4>,
  h4: ({ children }) => <h4 className="text-sm font-semibold">{children}</h4>,
  h5: ({ children }) => <h4 className="text-sm font-semibold">{children}</h4>,
  h6: ({ children }) => <h4 className="text-sm font-semibold">{children}</h4>,
  p: ({ children }) => <p>{children}</p>,
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  blockquote: ({ children }) => (
    <blockquote className="space-y-2 border-l-2 border-border pl-3 text-muted">
      {children}
    </blockquote>
  ),
  hr: () => <Separator />,
  a: MdLink,
  img: MdImage,
  pre: MdPre,
  code: MdCode,
  table: MdTable,
  thead: MdHead,
  tbody: MdBody,
  tr: MdRow,
  th: MdHeaderCell,
  td: MdCell,
  ul: MdList,
  ol: MdOrderedList,
  li: MdListItem,
  input: MdInput,
  span: MdSpan,
};

export default function Markdown({
  text,
  pii = false,
  muted = false,
}: {
  text: string;
  pii?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`min-w-0 space-y-3 text-sm leading-relaxed break-words ${muted ? "text-muted" : "text-foreground"}`}
    >
      <ReactMarkdown remarkPlugins={pii ? PII_PLUGINS : PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
