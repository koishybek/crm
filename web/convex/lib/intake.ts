// Приём заявки из внешнего канала — один путь для бота Telegram, формы сайта, публичного API и сообщений
// (WhatsApp, OLX): клиент по телефону (найти или создать) → заявка → история клиента → уведомление команде → журнал.
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { AiSummary, SourceId, Urgency } from "../../src/data/types";
import { CITIES } from "../../src/data/catalog";
import { insertClient } from "../clients";
import { loadCatalog } from "../catalog";
import { env } from "../env";
import { audit, type AuditActor } from "./audit";
import { nextNumber, notify, nowIso, staffIds, TENANT } from "./domain";

/** Каналы, в которых клиенту удобно отвечать сообщением, — они становятся «предпочитаемым каналом» нового клиента. */
const MESSENGERS: SourceId[] = ["telegram", "whatsapp", "olx", "instagram"];

export interface IntakeInput {
  source: SourceId;
  /** Уже нормализованный номер «7XXXXXXXXXX». */
  phone: string;
  name?: string;
  /** Имя нового клиента, если он не представился: «Клиент из Telegram». */
  fallbackName: string;
  serviceId?: string;
  city?: string;
  address?: string;
  urgency?: Urgency;
  description: string;
  comment?: string;
  ai?: AiSummary;
  /** Сообщение клиента — в историю клиента рядом с заявкой. */
  message?: { title: string; text: string };
  actor: AuditActor;
  /** «из Telegram», «с сайта», «через API» — в уведомлении и журнале. */
  via: string;
  /** Дополнительные детали для журнала (без персональных данных). */
  auditMeta?: Record<string, string | number | boolean>;
}

export interface IntakeResult {
  leadId: Id<"leads">;
  number: number;
  clientId: Id<"clients">;
  newClient: boolean;
  serviceId: string;
}

/**
 * Имя из внешнего источника (форма, API, профиль в мессенджере) уходит в выгрузки CSV/Excel:
 * «=», «+», «-», «@» в начале Excel принял бы за формулу — срезаем.
 */
export const safeName = (raw: string | undefined): string => (raw ?? "").replace(/^[\s=+\-@]+/, "").trim().slice(0, 80);

/** На кого записать заявку из канала: первый активный владелец. */
async function intakeOperator(ctx: MutationCtx): Promise<Id<"users"> | null> {
  const owners = await ctx.db
    .query("users")
    .withIndex("by_role", (q) => q.eq("role", "owner"))
    .collect();
  return (owners.find((u) => u.active !== false) ?? owners[0])?._id ?? null;
}

/**
 * Создать заявку. null — в базе ещё нет владельца (заявку не на кого записать); в этом случае ничего не пишем.
 * Услуга не из справочника → «Другое — уточнить»: оператор уточнит.
 */
export async function intakeLead(ctx: MutationCtx, a: IntakeInput): Promise<IntakeResult | null> {
  const operatorId = await intakeOperator(ctx);
  if (!operatorId) return null;
  const cat = await loadCatalog(ctx);
  const active = cat.services.filter((s) => s.active !== false);
  const svc = active.find((s) => s.id === a.serviceId) ?? active.find((s) => s.id === "other") ?? active[0] ?? cat.services[0];
  if (!svc) return null;
  const city = a.city?.trim().slice(0, 60) || env("COMPANY_CITY") || CITIES[0];

  let client = await ctx.db
    .query("clients")
    .withIndex("by_phone", (q) => q.eq("phone", a.phone))
    .first();
  const newClient = !client;
  if (!client) {
    const id = await insertClient(ctx, {
      name: safeName(a.name) || a.fallbackName,
      phone: a.phone,
      city,
      address: a.address?.slice(0, 200),
      source: a.source,
      preferredChannel: MESSENGERS.includes(a.source) ? a.source : undefined,
    });
    client = (await ctx.db.get(id))!;
  }

  const at = nowIso();
  const number = await nextNumber(ctx);
  const leadId = await ctx.db.insert("leads", {
    tenantId: TENANT,
    number,
    clientId: client._id,
    clientName: client.name,
    clientPhone: client.phone,
    source: a.source,
    serviceId: svc.id,
    city,
    description: a.description.trim().slice(0, 2000) || "Клиент оставил заявку",
    urgency: a.urgency ?? "normal",
    status: "new",
    operatorId,
    createdAt: at,
    ai: a.ai,
    comment: a.comment?.trim().slice(0, 2000) || undefined,
  });
  if (a.message) {
    await ctx.db.insert("interactions", { clientId: client._id, kind: "message", channel: a.source, title: a.message.title, text: a.message.text.slice(0, 1000), at });
  }
  await ctx.db.insert("interactions", { clientId: client._id, kind: "lead", channel: a.source, title: "Новая заявка", text: svc.label, at, leadId });
  await ctx.db.patch(client._id, { lastActivityAt: at });

  const what = svc.id === "other" ? "услугу уточнить" : svc.label;
  await notify(ctx, await staffIds(ctx, svc.category), `Новая заявка №${number} ${a.via}: ${what} (${client.name})`, { link: `/leads?open=${leadId}`, tone: "info" });
  await audit(ctx, a.actor, "lead.create", `Заявка №${number} ${a.via}: ${svc.label}`, {
    entityId: leadId,
    meta: { source: a.source, serviceId: svc.id, newClient, ...a.auditMeta },
  });
  return { leadId, number, clientId: client._id, newClient, serviceId: svc.id };
}
