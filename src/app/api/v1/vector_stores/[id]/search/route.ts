import { NextResponse } from "next/server";
import { gateRequest, gateResponse, requestPath } from "@/lib/gateway/gate";
import { parseBody, searchableStore, searchRequest } from "@/lib/rag/api";
import { hitJson, searchStores } from "@/lib/rag/search";
import { readableStore, usableStore } from "@/lib/rag/stores";
import { searchVectorStoreSchema } from "@/schemas/rag";

export const maxDuration = 120;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const principal = await gateRequest(req);
    const { id } = await ctx.params;
    const store = usableStore(await readableStore(principal, id));
    const body = await parseBody(req, searchVectorStoreSchema);
    const hits = await searchStores({
      principal,
      endpoint: requestPath(req),
      stores: [searchableStore(store)],
      request: searchRequest(body),
    });
    return NextResponse.json({
      object: "vector_store.search_results.page",
      search_query: body.query,
      data: hits.map(hitJson),
      has_more: false,
      next_page: null,
    });
  } catch (err) {
    return gateResponse(err, req);
  }
}
