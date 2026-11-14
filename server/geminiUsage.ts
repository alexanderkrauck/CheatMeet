import type { GoogleGenAI } from "@google/genai";
import type { UsageRecorder, UsageStart, UsageTokens } from "../shared/usage";
import { processingSignal, remainingProcessingMs } from "./processing/budget";

type Client = Pick<GoogleGenAI, "models">;
type Request = Parameters<GoogleGenAI["models"]["generateContent"]>[0];
export type GeminiUsageContext = Pick<UsageStart, "owner" | "ownerLabel" | "meetingId" | "storage" | "operation" | "features">;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Meter the actual SDK attempt, not the saved report. The caller retains retry
 * and output-validation semantics; a response is accounted before JSON parsing. */
export async function generateMetered(
  client: Client,
  request: Request,
  context: GeminiUsageContext,
  recorder?: UsageRecorder,
) {
  const dispatch = () => {
    const signal = processingSignal();
    if (!signal) return client.models.generateContent(request);
    // Durable admission can take time. Recompute immediately before SDK entry,
    // and do not dispatch at all after the worker's analysis window expires.
    const timeout = remainingProcessingMs(request.config?.httpOptions?.timeout ?? 120_000);
    return client.models.generateContent({ ...request, config: { ...request.config,
      httpOptions: { ...request.config?.httpOptions, timeout },
      abortSignal: request.config?.abortSignal ? AbortSignal.any([signal, request.config.abortSignal]) : signal,
    } });
  };
  if (!recorder) return dispatch();
  if (!context.owner) throw new Error("Verified usage owner missing");
  const id = await recorder.begin({ ...context, provider: "gemini", kind: "tokens", model: request.model });
  const settle = async (update: Parameters<UsageRecorder["finish"]>[2]) => {
    // Do not turn an already paid successful generation into a retry because an
    // accounting write failed. Its durable pending entry exposes the gap.
    try { await recorder.finish(context.owner, id, update); }
    catch { console.warn(JSON.stringify({ event: "usage_settlement_failed", provider: "gemini", usageId: id })); }
  };
  let response: Awaited<ReturnType<Client["models"]["generateContent"]>>;
  try {
    response = await dispatch();
  } catch (cause) {
    // A rejected SDK promise does not prove whether upstream performed work.
    await settle({ state: "unknown", evidence: "unknown" });
    throw cause;
  }
  const usage = response.usageMetadata;
  const tokens: UsageTokens = {
    input: count(usage?.promptTokenCount),
    output: count(usage?.candidatesTokenCount),
    thinking: count(usage?.thoughtsTokenCount),
    cached: count(usage?.cachedContentTokenCount),
    total: count(usage?.totalTokenCount),
  };
  // Non-optional proto3 scalar counters omit zero values in JSON. Decode these
  // defaults only within a complete usage block, never for absent metadata.
  // google/ai/generativelanguage/v1beta/generative_service.proto, UsageMetadata.
  if (usage && tokens.input !== null && tokens.output !== null && tokens.total !== null) {
    if (usage.cachedContentTokenCount === undefined) tokens.cached = 0;
    if (usage.thoughtsTokenCount === undefined && tokens.total === tokens.input + tokens.output + (count(usage.toolUsePromptTokenCount) ?? 0))
      tokens.thinking = 0;
  }
  await settle({
    state: "completed",
    evidence: usage ? "provider" : "unknown",
    tokens,
    ...(typeof response.responseId === "string" ? { providerRequestId: response.responseId } : {}),
    ...(typeof response.modelVersion === "string" ? { modelVersion: response.modelVersion } : {}),
  });
  return response;
}
