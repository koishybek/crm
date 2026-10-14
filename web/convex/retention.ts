// Срок хранения записей звонков и расшифровок (ТЗ п.26.4). Владелец задаёт сроки в «Настройках» (по умолчанию —
// 365 дней, 0 — бессрочно); раз в сутки крон удаляет файлы записей (и ссылку АТС на запись) и тексты расшифровок
// у звонков старше срока, с записью в журнал. Звонок, AI-резюме и заявка остаются.
// Чтобы не перечитывать каждый день уже очищенные звонки, для каждого вида помним, до какого startedAt дошли.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./lib/functions";
import { OWNER, requireRole } from "./lib/access";
import { audit } from "./lib/audit";
import { dropFile } from "./lib/files";
import { RETENTION_DEFAULT_DAYS, retentionLabel, retentionProblem, type RetentionSettings } from "../src/data/retention";
import { perTenant } from "./lib/tenant";

type Kind = "recordings" | "transcripts";
const DAYS_KEY: Record<Kind, string> = { recordings: "retentionRecordingsDays", transcripts: "retentionTranscriptsDays" };
const UPTO_KEY: Record<Kind, string> = { recordings: "retentionRecordingsUpTo", transcripts: "retentionTranscriptsUpTo" };
const BATCH = 100;
const DAY_MS = 86400_000;

async function setting(ctx: QueryCtx, key: string) {
  return ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

async function putSetting(ctx: MutationCtx, key: string, value: string): Promise<void> {
  const row = await setting(ctx, key);
  if (row) await ctx.db.patch(row._id, { value });
  else await ctx.db.insert("settings", { key, value });
}

async function days(ctx: QueryCtx, kind: Kind): Promise<number> {
  const raw = (await setting(ctx, DAYS_KEY[kind]))?.value;
  const n = raw === undefined ? NaN : Number(raw);
  return retentionProblem(n) === null ? n : RETENTION_DEFAULT_DAYS;
}

export const settings = query({
  args: {},
  handler: async (ctx): Promise<RetentionSettings> => {
    await requireRole(ctx, OWNER);
    return { recordingsDays: await days(ctx, "recordings"), transcriptsDays: await days(ctx, "transcripts") };
  },
});

export const configure = mutation({
  args: { recordingsDays: v.number(), transcriptsDays: v.number() },
  handler: async (ctx, a): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    const problem = retentionProblem(a.recordingsDays) ?? retentionProblem(a.transcriptsDays);
    if (problem) throw new ConvexError(problem);
    const before = { recordings: await days(ctx, "recordings"), transcripts: await days(ctx, "transcripts") };
    if (before.recordings === a.recordingsDays && before.transcripts === a.transcriptsDays) return;
    await putSetting(ctx, DAYS_KEY.recordings, String(a.recordingsDays));
    await putSetting(ctx, DAYS_KEY.transcripts, String(a.transcriptsDays));
    await audit(ctx, me, "settings.retention", `Срок хранения: записи звонков — ${retentionLabel(a.recordingsDays)}, расшифровки — ${retentionLabel(a.transcriptsDays)}`, {
      meta: { before, after: { recordings: a.recordingsDays, transcripts: a.transcriptsDays } },
    });
  },
});

/** Что убрать у звонка; null — у него этого уже нет. */
function cleanup(kind: Kind, c: Doc<"calls">): Partial<Doc<"calls">> | null {
  if (kind === "recordings") return c.recordingId || c.recordingUrl ? { recordingId: undefined, recordingUrl: undefined } : null;
  return c.transcript ? { transcript: undefined } : null;
}

/** Один вид, одна пачка: звонки с прошлой отметки до границы срока. Пачка полная — продолжать. */
async function sweep(ctx: MutationCtx, kind: Kind, nowMs: number): Promise<{ removed: number; more: boolean }> {
  const d = await days(ctx, kind);
  if (d === 0) return { removed: 0, more: false };
  const cutoff = new Date(nowMs - d * DAY_MS).toISOString();
  const upTo = (await setting(ctx, UPTO_KEY[kind]))?.value ?? "";
  const calls = await ctx.db
    .query("calls")
    .withIndex("by_started", (q) => q.gte("startedAt", upTo).lt("startedAt", cutoff))
    .take(BATCH);
  let removed = 0;
  for (const c of calls) {
    const patch = cleanup(kind, c);
    if (!patch) continue;
    if (kind === "recordings" && c.recordingId) await dropFile(ctx, c.recordingId);
    await ctx.db.patch(c._id, patch);
    removed++;
  }
  const last = calls[calls.length - 1]?.startedAt;
  if (last && last !== upTo) await putSetting(ctx, UPTO_KEY[kind], last);
  // Отметка не сдвинулась (сотня звонков с одним временем) — не крутимся, следующая пачка завтра.
  return { removed, more: calls.length === BATCH && last !== upTo };
}

/** Раз в сутки (crons.ts); большие хвосты — пачками по 100, следующая пачка — сразу следом. */
export const run = internalMutation({
  args: {},
  handler: async (cronCtx): Promise<{ recordings: number; transcripts: number }> => perTenant(cronCtx, internal.retention.run, { recordings: 0, transcripts: 0 }, async (ctx) => {
    const now = Date.now();
    const rec = await sweep(ctx, "recordings", now);
    const tr = await sweep(ctx, "transcripts", now);
    if (rec.removed || tr.removed) {
      const parts = [rec.removed ? `записей звонков — ${rec.removed} (срок ${retentionLabel(await days(ctx, "recordings"))})` : "", tr.removed ? `расшифровок — ${tr.removed} (срок ${retentionLabel(await days(ctx, "transcripts"))})` : ""].filter(Boolean);
      await audit(ctx, "Система", "call.retention", `Удалено по сроку хранения: ${parts.join(", ")}`, { meta: { recordings: rec.removed, transcripts: tr.removed } });
    }
    if (rec.more || tr.more) await ctx.scheduler.runAfter(0, internal.retention.run, {});
    return { recordings: rec.removed, transcripts: tr.removed };
  }),
});
