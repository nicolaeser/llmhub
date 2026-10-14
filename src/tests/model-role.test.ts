import assert from "node:assert/strict";
import test from "node:test";
import { chatChoices, choicesForRole, modelRole, type ModelChoice } from "@/lib/models/model-role";

test("model names map to the endpoint they can actually serve", () => {
  assert.equal(modelRole(["text-embedding-3-large"]), "embedding");
  assert.equal(modelRole(["bge-m3"]), "embedding");
  assert.equal(modelRole(["gte-large"]), "embedding");
  assert.equal(modelRole(["e5-large"]), "embedding");
  assert.equal(modelRole(["voyage-3"]), "embedding");
  assert.equal(modelRole(["nomic-embed-text"]), "embedding");
  assert.equal(modelRole(["cohere-rerank-v3"]), "rerank");
  assert.equal(modelRole(["jina-reranker-v2"]), "rerank");
  assert.equal(modelRole(["mistral-ocr-2505"]), "ocr");
  assert.equal(modelRole(["whisper-1"]), "media");
  assert.equal(modelRole(["tts-1-hd"]), "media");
  assert.equal(modelRole(["dall-e-3"]), "media");
  assert.equal(modelRole(["gpt-image-1"]), "media");
  assert.equal(modelRole(["FLUX.1-dev"]), "media");
  assert.equal(modelRole(["omni-moderation-latest"]), "moderation");
  assert.equal(modelRole(["gpt-4o"]), "chat");
  assert.equal(modelRole(["claude-3-5-sonnet"]), "chat");
  assert.equal(modelRole(["text-embedding-3-small", "docs"]), "embedding");
  assert.equal(modelRole(["gpt-4o", "docs"]), "chat");
});

test("a picker keeps the saved alias and hides models of another kind", () => {
  const models: ModelChoice[] = [
    { alias: "gpt-4o", label: "GPT-4o", role: "chat" },
    { alias: "embed", label: "Embed", role: "embedding" },
    { alias: "rerank", label: "Rerank", role: "rerank" },
    { alias: "ocr", label: "OCR", role: "ocr" },
  ];
  assert.deepEqual(
    choicesForRole(models, "embedding").map((model) => model.alias),
    ["embed"],
  );
  assert.deepEqual(
    choicesForRole(models, "embedding", "gpt-4o").map((model) => model.alias),
    ["embed", "gpt-4o"],
  );
  assert.deepEqual(
    choicesForRole(models.filter((model) => model.role !== "embedding"), "rerank").map((model) => model.alias),
    ["rerank"],
  );
  assert.deepEqual(
    choicesForRole(
      models.filter((model) => model.role !== "embedding"),
      "embedding",
    ).map((model) => model.alias),
    [],
  );
  assert.deepEqual(
    chatChoices(models).map((model) => model.alias),
    ["gpt-4o"],
  );
  assert.deepEqual(
    chatChoices(models.filter((model) => model.role !== "chat")).map((model) => model.alias),
    [],
  );
});
