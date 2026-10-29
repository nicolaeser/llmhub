import { isValidElement } from "react";
import AreaMessages from "@/components/i18n/area-messages";

export function areaContent(node: unknown, area: string): unknown {
  if (!isValidElement<{ area: string; children: unknown }>(node) || node.type !== AreaMessages) {
    throw new Error(`expected <AreaMessages area="${area}">`);
  }
  if (node.props.area !== area) throw new Error(`expected area ${area}, got ${node.props.area}`);
  return node.props.children;
}
