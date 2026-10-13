import { isValidElement, type ReactElement } from "react";

export type TreeElement = ReactElement<Record<string, unknown>>;

export function elementsIn(node: unknown): TreeElement[] {
  if (Array.isArray(node)) return node.flatMap(elementsIn);
  if (!isValidElement(node)) return [];
  const element = node as TreeElement;
  return [element, ...elementsIn(element.props.children)];
}

export function elementsOf(node: unknown, type: unknown): TreeElement[] {
  return elementsIn(node).filter((element) => element.type === type);
}

export function onlyElement(node: unknown, type: unknown): TreeElement {
  const found = elementsOf(node, type);
  if (found.length !== 1) throw new Error(`expected one element, found ${found.length}`);
  return found[0]!;
}
