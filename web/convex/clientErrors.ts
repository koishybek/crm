// Ошибки интерфейса (ТЗ п.26.5): браузер присылает текст ошибки, путь экрана и версию сборки — без данных людей
// (чистит src/data/clientErrors.ts, здесь — ещё раз). Принимаем и от невошедших (экран входа тоже ломается),
// поэтому — лимиты на отправителя и общий. Одинаковые за сутки — одна строка со счётчиком. Список — владельцу.
import { v } from "convex/values";
import { mutation, query } from "./lib/functions";
import { currentUser, OWNER, requireRole } from "./lib/access";
import { sha256Hex } from "./lib/crypto";
import { nowIso } from "./lib/domain";
import { hitLimit } from "./lib/rateLimit";
import { scrubBuild, scrubErrorPath, scrubErrorText, type ClientErrorRow } from "../src/data/clientErrors";
import { publicTenant } from "./lib/tenant";
import { forTenant } from "./lib/tenantDb";

const DAY_MS = 86400_000;
/** С одного пользователя (или от всех невошедших вместе) — 20 за 10 минут; всего — 300 в час. */
const PER_SENDER = 20;
const SENDER_WINDOW_MS = 10 * 60_000;
const TOTAL = 300;
const TOTAL_WINDOW_MS = 3600_000;
/** Длиннее — обрезаем до чистки: больше нужного не обрабатываем. */
const RAW_MAX = 4000;

export const report = mutation({
  args: { message: v.string(), path: v.string(), build: v.string(), kind: v.union(v.literal("error"), v.literal("rejection")) },
  handler: async (pub, a): Promise<void> => {
    const message = scrubErrorText(a.message.slice(0, RAW_MAX));
    if (!message) return;
    const me = await currentUser(pub);
    // Ошибка видна владельцу своей компании; до входа (экран входа, форма заявки) — первой компании платформы.
    const tenantId = me?.tenantId ?? (await publicTenant(pub));
    if (!tenantId) return;
    const ctx = me ? pub : forTenant(pub, tenantId);
    // Лимит исчерпан — молча: интерфейс не должен сыпать ошибками об ошибках.
    if (!(await hitLimit(ctx, `clientError:${me?._id ?? "anon"}`, PER_SENDER, SENDER_WINDOW_MS))) return;
    if (!(await hitLimit(ctx, "clientError:all", TOTAL, TOTAL_WINDOW_MS))) return;
    const path = scrubErrorPath(a.path.slice(0, RAW_MAX));
    const build = scrubBuild(a.build.slice(0, 200));
    const sig = sha256Hex(`${a.kind}\n${message}\n${path}\n${build}`).slice(0, 32);
    const at = nowIso();
    const same = await ctx.db
      .query("clientErrors")
      .withIndex("by_sig", (q) => q.eq("sig", sig).gt("lastAt", new Date(Date.now() - DAY_MS).toISOString()))
      .first();
    if (same) await ctx.db.patch(same._id, { count: same.count + 1, lastAt: at });
    else await ctx.db.insert("clientErrors", { sig, message, path, build, kind: a.kind, role: me?.role, count: 1, firstAt: at, lastAt: at });
  },
});

/** Последние ошибки интерфейса — для «Состояния системы». */
export const recent = query({
  args: {},
  handler: async (ctx): Promise<ClientErrorRow[]> => {
    await requireRole(ctx, OWNER);
    const rows = await ctx.db.query("clientErrors").withIndex("by_last").order("desc").take(20);
    return rows.map((r) => ({ id: r._id, message: r.message, path: r.path, build: r.build, kind: r.kind, role: r.role, count: r.count, firstAt: r.firstAt, lastAt: r.lastAt }));
  },
});
