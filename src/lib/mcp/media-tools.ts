import { levelIncludes } from "@/lib/mcp/resolve";
import type { McpAccessLevel, McpMediaKind, McpToolAction } from "@/types/mcp";

export const GENERATE_IMAGE_TOOL = "generate_image";
export const TEXT_TO_SPEECH_TOOL = "text_to_speech";
export const GENERATE_VIDEO_TOOL = "generate_video";
export const GET_VIDEO_TOOL = "get_video";
export const TRANSCRIBE_AUDIO_TOOL = "transcribe_audio";

export const MEDIA_KIND_TOOLS: Record<McpMediaKind, readonly { name: string; action: McpToolAction }[]> = {
  image: [{ name: GENERATE_IMAGE_TOOL, action: "write" }],
  speech: [{ name: TEXT_TO_SPEECH_TOOL, action: "write" }],
  video: [
    { name: GENERATE_VIDEO_TOOL, action: "write" },
    { name: GET_VIDEO_TOOL, action: "read" },
  ],
  transcription: [{ name: TRANSCRIBE_AUDIO_TOOL, action: "read" }],
};

export function mediaToolsAt(level: McpAccessLevel, kinds: readonly McpMediaKind[]): string[] {
  return kinds.flatMap((kind) => MEDIA_KIND_TOOLS[kind]).filter((tool) => levelIncludes(level, tool)).map((tool) => tool.name);
}
