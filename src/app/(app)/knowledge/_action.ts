"use server";

import { runAction } from "@/lib/http/action-result";
import {
  createKnowledge,
  deleteKnowledge,
  listKnowledgeFiles,
  loadKnowledge,
  removeKnowledgeFile,
  updateKnowledge,
} from "@/lib/rag/knowledge";

export async function loadKnowledgeAction(...args: Parameters<typeof loadKnowledge>) {
  return runAction(() => loadKnowledge(...args));
}

export async function createKnowledgeAction(...args: Parameters<typeof createKnowledge>) {
  return runAction(() => createKnowledge(...args));
}

export async function updateKnowledgeAction(...args: Parameters<typeof updateKnowledge>) {
  return runAction(() => updateKnowledge(...args));
}

export async function deleteKnowledgeAction(...args: Parameters<typeof deleteKnowledge>) {
  return runAction(() => deleteKnowledge(...args));
}

export async function listKnowledgeFilesAction(...args: Parameters<typeof listKnowledgeFiles>) {
  return runAction(() => listKnowledgeFiles(...args));
}

export async function removeKnowledgeFileAction(...args: Parameters<typeof removeKnowledgeFile>) {
  return runAction(() => removeKnowledgeFile(...args));
}
