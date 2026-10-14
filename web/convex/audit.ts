// Журнал действий: чтение (ТЗ п.5 «Лиды: история», п.15, п.20 «Audit Log», п.27).
// Пишет журнал только lib/audit.ts — в той же мутации, что и само действие. Публичных функций
// правки и удаления записей нет: журнал нельзя «подчистить» из интерфейса или через API.
import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./lib/functions";
import { inScope, OWNER, requireRole, scopeOf, TEAM, type Me } from "./lib/access";
import { loadCatalog } from "./catalog";
import { auditEntity } from "./schema";
import { AUDIT_QUERY_MAX, auditSearchKey, canSeeEntityHistory } from "../src/data/audit";
import type { AuditEntity, AuditEntry } from "../src/data/types";

const toEntry = (r: Doc<"audit">): AuditEntry => ({
  id: r._id,
  at: r.at,
  actorId: r.actorId,
  actorName: r.actorName,
  actorRole: r.actorRole,
  action: r.action,
  entity: r.entity,
  entityId: r.entityId,
  summary: r.summary,
});

/** Самая большая страница журнала. */
const MAX_PAGE = 200;
/**
 * Поиск по тексту отбирает строки уже после чтения страницы, поэтому с поиском читаем в 10 раз больше
 * строк (но не больше 1000) — иначе страницы с редкими совпадениями были бы почти пустыми.
 */
const SEARCH_SCAN = 10;
const MAX_SCAN = 1000;
/** «История» в карточке — последние действия по объекту. */
const HISTORY_LIMIT = 100;

/** Граница периода: любая дата → ISO UTC, как поле at. Мусор — понятная ошибка, а не пустой журнал. */
function isoBound(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new ConvexError(`Неверная дата: ${label}`);
  return new Date(t).toISOString();
}

/**
 * Журнал целиком — только владелец. Новые сверху; фильтры: период, кто действовал
 * (сотрудник или "system" — система, AI и каналы), тип объекта и текст описания без учёта регистра.
 */
export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    from: v.optional(v.string()),
    to: v.optional(v.string()),
    actorId: v.optional(v.union(v.id("users"), v.literal("system"))),
    entity: v.optional(auditEntity),
    q: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<PaginationResult<AuditEntry>> => {
    await requireRole(ctx, OWNER);
    const from = isoBound(a.from, "начало периода");
    const to = isoBound(a.to, "конец периода");
    const needle = auditSearchKey((a.q ?? "").slice(0, AUDIT_QUERY_MAX));

    // Кто действовал — по индексу by_actor (у системы и каналов actorId нет), иначе — по времени.
    const actor = a.actorId === "system" ? undefined : a.actorId;
    const rows =
      a.actorId === undefined
        ? ctx.db.query("audit").withIndex("by_at", (q) => {
            const lower = from ? q.gte("at", from) : q;
            return to ? lower.lte("at", to) : lower;
          })
        : ctx.db.query("audit").withIndex("by_actor", (q) => {
            const who = q.eq("actorId", actor);
            const lower = from ? who.gte("at", from) : who;
            return to ? lower.lte("at", to) : lower;
          });
    const newest = rows.order("desc");
    const scoped = a.entity ? newest.filter((q) => q.eq(q.field("entity"), a.entity)) : newest;

    const size = Math.max(1, Math.min(Math.floor(a.paginationOpts.numItems), MAX_PAGE));
    const res = await scoped.paginate({ ...a.paginationOpts, numItems: needle ? Math.min(size * SEARCH_SCAN, MAX_SCAN) : size });
    const page = needle ? res.page.filter((r) => auditSearchKey(r.summary).includes(needle)) : res.page;
    return { ...res, page: page.map(toEntry) };
  },
});

/** Руководитель направления видит историю только своих заявок и заказов — как и сами заявки и заказы. */
async function managerSees(ctx: QueryCtx, me: Me, entity: AuditEntity, entityId: string): Promise<boolean> {
  const scope = scopeOf(me);
  if (entity === "order") {
    const id = ctx.db.normalizeId("orders", entityId);
    const o = id ? await ctx.db.get(id) : null;
    return !!o && inScope(scope, o.category);
  }
  if (entity === "lead") {
    const id = ctx.db.normalizeId("leads", entityId);
    const l = id ? await ctx.db.get(id) : null;
    if (!l) return false;
    const category = (await loadCatalog(ctx)).services.find((s) => s.id === l.serviceId)?.category;
    return !!category && inScope(scope, category);
  }
  return false;
}

/**
 * «История» объекта в его карточке, новые сверху. Владелец — любой объект; оператор — заявки, заказы,
 * клиенты, исполнители и звонки; руководитель — только заявки и заказы своего направления; исполнитель — ничего.
 * null — объекта нет или он не в направлении руководителя (как leads.get и orders.detail).
 */
export const forEntity = query({
  args: { entity: auditEntity, entityId: v.string() },
  handler: async (ctx, { entity, entityId }): Promise<AuditEntry[] | null> => {
    const me = await requireRole(ctx, TEAM);
    if (!canSeeEntityHistory(me.role, entity)) throw new ConvexError("Нет доступа");
    if (entityId.length > 100) return null;
    if (me.role === "manager" && !(await managerSees(ctx, me, entity, entityId))) return null;
    const rows = await ctx.db
      .query("audit")
      .withIndex("by_entity", (q) => q.eq("entity", entity).eq("entityId", entityId))
      .order("desc")
      .take(HISTORY_LIMIT);
    return rows.map(toEntry);
  },
});
