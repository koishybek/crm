// Диагностика AI с сервера Convex (через `npx convex run`): проверка цепочки Convex → AI-сервис → Workers AI.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./lib/functions";
import { extract, toSummary, transcribe, type CatalogHint } from "./ai";

export const uploadUrl = internalMutation({ args: {}, handler: async (ctx) => ctx.storage.generateUploadUrl() });

export const run = internalAction({
  args: { storageId: v.optional(v.id("_storage")), text: v.optional(v.string()) },
  handler: async (ctx, { storageId, text }) => {
    const t0 = Date.now();
    let transcript = text ?? "";
    let sttMs = 0;
    if (storageId) {
      const blob = await ctx.storage.get(storageId);
      if (!blob) throw new Error("нет файла");
      transcript = (await transcribe(blob)).text;
      sttMs = Date.now() - t0;
    }
    const hint: CatalogHint = await ctx.runQuery(internal.catalog._hint, {});
    const x = await extract(transcript, hint, storageId ? "call" : "message");
    return { sttMs, totalMs: Date.now() - t0, transcript, extraction: x, summary: toSummary(x, (id) => hint.services.find((s) => s.id === id)?.label ?? id) };
  },
});
