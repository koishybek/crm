/// <reference types="vite/client" />
// Срок хранения записей звонков и расшифровок (ТЗ п.26.4): по умолчанию год, 0 — бессрочно, настраивает только
// владелец; крон удаляет файлы записей (и ссылку АТС) и тексты расшифровок старше срока и пишет в журнал.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const DAY = 86400_000;
const NOW = new Date("2026-10-14T22:00:00.000Z").getTime();
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: "t-komfort", active: true });
    const operator = await ctx.db.insert("users", { name: "Оператор", email: "op@test.kz", role: "operator", tenantId: "t-komfort", active: true });
    const call = async (days: number, extra: { transcript?: string; recordingUrl?: string } = {}) => {
      const recordingId = await ctx.storage.store(new Blob([`audio-${days}`], { type: "audio/mpeg" }));
      const id = await ctx.db.insert("calls", { tenantId: "t-komfort", direction: "in", from: "77071234567", to: "77273450000", status: "completed", startedAt: ago(days), recordingId, transcript: "Здравствуйте, сломался холодильник", ...extra });
      return { id, recordingId };
    };
    return { owner, operator, old: await call(400, { recordingUrl: "https://pbx.example/rec/1.mp3" }), mid: await call(100), fresh: await call(10) };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  const get = (id: Id<"calls">) => t.run((ctx) => ctx.db.get(id));
  const fileExists = (id: Id<"_storage">) => t.run(async (ctx) => !!(await ctx.db.system.get(id)));
  return { t, ids, as, get, fileExists };
}

describe("срок хранения записей звонков", () => {
  test("по умолчанию — 365 дней: старые записи удаляются вместе с файлом и ссылкой АТС, расшифровки тоже; свежие на месте", async () => {
    const { t, ids, as, get, fileExists } = await setup();
    expect(await as(ids.owner).query(api.retention.settings, {})).toEqual({ recordingsDays: 365, transcriptsDays: 365 });
    expect(await t.mutation(internal.retention.run, {})).toEqual({ recordings: 1, transcripts: 1 });
    const old = await get(ids.old.id);
    expect(old?.recordingId).toBeUndefined();
    expect(old?.recordingUrl).toBeUndefined();
    expect(old?.transcript).toBeUndefined();
    expect(old?.status).toBe("completed");
    expect(await fileExists(ids.old.recordingId)).toBe(false);
    expect((await get(ids.mid.id))?.recordingId).toBe(ids.mid.recordingId);
    expect(await fileExists(ids.mid.recordingId)).toBe(true);
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.find((a) => a.action === "call.retention")).toMatchObject({ actorName: "Система", summary: "Удалено по сроку хранения: записей звонков — 1 (срок 365 дней), расшифровок — 1 (срок 365 дней)" });
    // Повторный проход ничего не находит и в журнал не пишет.
    expect(await t.mutation(internal.retention.run, {})).toEqual({ recordings: 0, transcripts: 0 });
    expect((await t.run((ctx) => ctx.db.query("audit").collect())).filter((a) => a.action === "call.retention")).toHaveLength(1);
  });

  test("владелец сокращает срок: записи — 30 дней, расшифровки — бессрочно", async () => {
    const { t, ids, as, get } = await setup();
    await t.mutation(internal.retention.run, {});
    await as(ids.owner).mutation(api.retention.configure, { recordingsDays: 30, transcriptsDays: 0 });
    expect(await t.mutation(internal.retention.run, {})).toEqual({ recordings: 1, transcripts: 0 });
    const mid = await get(ids.mid.id);
    expect(mid?.recordingId).toBeUndefined();
    expect(mid?.transcript).toBe("Здравствуйте, сломался холодильник");
    expect((await get(ids.fresh.id))?.recordingId).toBe(ids.fresh.recordingId);
    const change = (await t.run((ctx) => ctx.db.query("audit").collect())).find((a) => a.action === "settings.retention");
    expect(change?.summary).toBe("Срок хранения: записи звонков — 30 дней, расшифровки — бессрочно");
  });

  test("0 — бессрочно: ничего не удаляется", async () => {
    const { t, ids, as, get } = await setup();
    await as(ids.owner).mutation(api.retention.configure, { recordingsDays: 0, transcriptsDays: 0 });
    expect(await t.mutation(internal.retention.run, {})).toEqual({ recordings: 0, transcripts: 0 });
    expect((await get(ids.old.id))?.recordingId).toBe(ids.old.recordingId);
  });

  test("настраивает только владелец, срок — целое от 0 до 3650", async () => {
    const { ids, as } = await setup();
    await expect(as(ids.operator).mutation(api.retention.configure, { recordingsDays: 30, transcriptsDays: 30 })).rejects.toThrow("Нет доступа");
    await expect(as(ids.operator).query(api.retention.settings, {})).rejects.toThrow("Нет доступа");
    await expect(as(ids.owner).mutation(api.retention.configure, { recordingsDays: -1, transcriptsDays: 30 })).rejects.toThrow("целое число дней");
    await expect(as(ids.owner).mutation(api.retention.configure, { recordingsDays: 30.5, transcriptsDays: 30 })).rejects.toThrow("целое число дней");
    await expect(as(ids.owner).mutation(api.retention.configure, { recordingsDays: 30, transcriptsDays: 4000 })).rejects.toThrow("целое число дней");
  });
});
