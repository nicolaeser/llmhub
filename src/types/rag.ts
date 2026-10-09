import type { JsonMap, Principal } from "@/types/gateway";
import type { OutputGuard } from "@/types/guardrails";

export type VectorScope = "project" | "member" | "user" | "organization";

export type VectorStoreOwner = {
  orgId: string | null;
  projectId: string | null;
  memberId: string | null;
  userId: string | null;
};

export type VectorStoreStatus = "expired" | "in_progress" | "completed";

export type VectorFileStatus = "in_progress" | "completed" | "failed" | "cancelled";

export type VectorFileErrorCode = "server_error" | "unsupported_file" | "invalid_file" | "rate_limit_exceeded";

export type VectorFileError = { code: VectorFileErrorCode; message: string };

export type ChunkingType = "auto" | "static";

export type ChunkingStrategy =
  | { type: "auto" }
  | { type: "static"; static: { max_chunk_size_tokens: number; chunk_overlap_tokens: number } };

export type ChunkSettings = {
  type: ChunkingType;
  maxTokens: number;
  overlapTokens: number;
};

export type TextChunk = { text: string; tokens: number; position: number };

export type AttributeValue = string | number | boolean;

export type Attributes = Record<string, AttributeValue>;

export type ComparisonOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "nin";

export type ComparisonFilter = {
  type: ComparisonOperator;
  key: string;
  value: AttributeValue | AttributeValue[];
};

export type CompoundFilter = { type: "and" | "or"; filters: AttributeFilter[] };

export type AttributeFilter = ComparisonFilter | CompoundFilter;

export type TermBag = { hashes: Uint32Array; freqs: Uint16Array; length: number };

export type FileCounts = {
  in_progress: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
};

export type StoreUsage = { counts: FileCounts; usageBytes: number };

export type FileIndex = {
  stamp: number;
  dims: number;
  ids: string[];
  positions: Int32Array;
  vectors: Int8Array;
  scales: Float32Array;
  termStarts: Uint32Array;
  termHashes: Uint32Array;
  termFreqs: Uint16Array;
  lengths: Uint32Array;
  bytes: number;
};

export type IndexedFile = {
  fileId: string;
  filename: string;
  attributes: Attributes;
  index: FileIndex;
};

export type Ranker = "none" | "auto" | "default-2024-11-15" | "default-2024-08-21";

export type RankingOptions = {
  ranker: Ranker;
  scoreThreshold: number;
  embeddingWeight: number;
  textWeight: number;
};

export type SearchRequest = {
  queries: string[];
  filters: AttributeFilter | null;
  maxResults: number;
  ranking: RankingOptions;
  rerankModel: string | null;
};

export type SearchHit = {
  storeId: string;
  fileId: string;
  filename: string;
  chunkId: string;
  position: number;
  score: number;
  attributes: Attributes;
  text: string;
};

export type ScoredChunk = {
  storeId: string;
  file: IndexedFile;
  slot: number;
  score: number;
};

export type SearchableStore = {
  id: string;
  embeddingModel: string;
  embeddingDimensions: number;
  dimensions: number;
  rerankModel: string;
  expiresAfterDays: number | null;
};

export type IngestSnapshot =
  | { kind: "key"; keyId: string }
  | { kind: "user"; userId: string; orgId: string; actor: string };

export type Extraction =
  | { kind: "text"; text: string }
  | { kind: "ocr"; document: JsonMap }
  | { kind: "error"; error: VectorFileError };

export type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

export type VectorStoreDefaults = {
  embedding_model: string;
  embedding_dimensions: number;
  ocr_model: string;
  rerank_model: string;
};

export type ListQuery = {
  limit: number;
  order: "asc" | "desc";
  after: string | null;
  before: string | null;
};

export type FileSearchTool = {
  vectorStoreIds: string[];
  maxResults: number;
  filters: AttributeFilter | null;
  ranking: RankingOptions;
  original: JsonMap;
};

export type FileSearchRun = {
  final: JsonMap;
  items: JsonMap[];
  transcript: JsonMap[];
};

export type FileSearchContext = {
  principal: Principal;
  model: string;
  aliases: string[];
  outputGuard: OutputGuard | null;
  tool: FileSearchTool;
  stores: SearchableStore[];
  include: string[] | null;
};

export type VectorStoreView = {
  id: string;
  name: string;
  description: string;
  scope: VectorScope;
  orgId: string | null;
  orgName: string;
  projectId: string | null;
  projectName: string;
  memberId: string | null;
  memberName: string;
  userId: string | null;
  userName: string;
  embeddingModel: string;
  embeddingDimensions: number;
  rerankModel: string;
  ocrModel: string;
  chunkMaxTokens: number;
  chunkOverlapTokens: number;
  status: VectorStoreStatus;
  fileCounts: FileCounts;
  usageBytes: number;
  expiresAfterDays: number | null;
  expiresAt: string | null;
  lastActiveAt: string;
  createdAt: string;
};

export type VectorFileView = {
  fileId: string;
  filename: string;
  status: VectorFileStatus;
  error: VectorFileError | null;
  usageBytes: number;
  chunkCount: number;
  attributes: Attributes;
  createdAt: string;
};

export type KnowledgeCompany = { id: string; alias: string };

export type KnowledgeProject = { id: string; alias: string; orgId: string };

export type KnowledgeView = {
  stores: VectorStoreView[];
  companies: KnowledgeCompany[];
  projects: KnowledgeProject[];
  defaults: VectorStoreDefaults;
  aliases: string[];
  canManage: boolean;
  maxUploadBytes: number;
};

export type UploadStatus = "pending" | "done" | "failed";

export type UploadItem = { key: string; name: string; status: UploadStatus; error: string };
