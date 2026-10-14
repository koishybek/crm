// Приём заявки из внешнего канала — один путь для бота Telegram, формы сайта, публичного API и сообщений
// (WhatsApp, OLX): клиент по телефону (найти или создать) → заявка → история клиента → уведомление команде → журнал.
// Заявку из канала никто не ведёт, пока оператор не возьмёт её в работу (E12): на владельца её не записываем.
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { AiSummary, LeadOrigin, SourceId, Urgency } from "../../src/data/types";
import { CITIES } from "../../src/data/catalog";
import { normalizeCity } from "../../src/data/cities";
import { insertClient } from "../clients";
import { loadCatalog } from "../catalog";
import { env } from "../env";
import { audit, type AuditActor } from "./audit";
import { districtOrNone } from "./districts";
import { emitEvent } from "./webhookEvents";
import { campaignOf, type Utm } from "../../src/data/utm";
import { nextNumber, notify, nowIso, staffIds, TENANT } from "./domain";

/** Каналы, в которых клиенту удобно отвечать сообщением, — они становятся «предпочитаемым каналом» нового клиента. */
const MESSENGERS: SourceId[] = ["telegram", "whatsapp", "olx", "instagram"];

export interface IntakeInput {
  source: SourceId;
  /** Кто завёл: бот, сайт, API, WhatsApp, OLX. */
  origin: Exclude<LeadOrigin, "operator" | "ai">;
  /** Уже нормализованный номер «7XXXXXXXXXX». */
  phone: string;
  name?: string;
  /** Имя нового клиента, если он не представился: «Клиент из Telegram». */
  fallbackName: string;
  serviceId?: string;
  city?: string;
  address?: string;
  /** Район, если клиент назвал его явно (AI-разбор); не из справочника города — без района. */
  district?: string;
  /** Когда клиенту удобно — как он сказал (AI-разбор). */
  preferredTime?: string;
  /** Бюджет клиента, ₸ (AI-разбор) — только для сотрудников. */
  budget?: number;
  urgency?: Urgency;
  description: string;
  comment?: string;
  ai?: AiSummary;
  /** Сообщение клиента — в историю клиента рядом с заявкой. */
  message?: { title: string; text: string };
  actor: AuditActor;
  /** «из Telegram», «с сайта», «через API» — в уведомлении и журнале. */
  via: string;
  /** Метки рекламы (форма сайта, API) и кампания — явная или utm_campaign (ТЗ п.6.6). */
  utm?: Utm;
  campaign?: string;
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

/** Бюджет из AI-разбора: целые тенге в разумных пределах, иначе — не назван. */
const cleanBudget = (n: number | undefined) => (n !== undefined && Number.isFinite(n) && n > 0 && n < 100_000_000 ? Math.round(n) : undefined);

/**
 * Создать заявку. null — справочник услуг пуст (заявку не к чему отнести); в этом случае ничего не пишем.
 * Услуга не из справочника → «Другое — уточнить»: оператор уточнит. Город — в едином написании (E11).
 */
export async function intakeLead(ctx: MutationCtx, a: IntakeInput): Promise<IntakeResult | null> {
  const cat = await loadCatalog(ctx);
  const active = cat.services.filter((s) => s.active !== false);
  const svc = active.find((s) => s.id === a.serviceId) ?? active.find((s) => s.id === "other") ?? active[0] ?? cat.services[0];
  if (!svc) return null;
  const city = normalizeCity(a.city).slice(0, 60) || normalizeCity(env("COMPANY_CITY")) || CITIES[0];
  const address = a.address?.trim().slice(0, 300) || undefined;

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
      address: address?.slice(0, 200),
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
    origin: a.origin,
    createdAt: at,
    ai: a.ai,
    comment: a.comment?.trim().slice(0, 2000) || undefined,
    // Адрес — полем заявки, не в описании (описание уходит мастерам в ленту, аудит H-3): в заказ он перейдёт сам,
    // мастер увидит его только после подтверждения заказа.
    address,
    preferredTime: a.preferredTime?.trim().slice(0, 120) || undefined,
    budget: cleanBudget(a.budget),
    district: await districtOrNone(ctx, city, a.district),
    utm: a.utm,
    campaign: campaignOf(a.utm, a.campaign),
  });
  if (a.message) {
    await ctx.db.insert("interactions", { clientId: client._id, kind: "message", channel: a.source, title: a.message.title, text: a.message.text.slice(0, 1000), at });
  }
  await ctx.db.insert("interactions", { clientId: client._id, kind: "lead", channel: a.source, title: "Новая заявка", text: svc.label, at, leadId });
  await ctx.db.patch(client._id, { lastActivityAt: at });

  const what = svc.id === "other" ? "услугу уточнить" : svc.label;
  const title = `Новая заявка №${number} ${a.via}: ${what}`;
  // В письме — без имени клиента: письма хранит почтовый сервис за рубежом.
  await notify(ctx, await staffIds(ctx, svc.category), `${title} (${client.name})`, { link: `/leads?open=${leadId}`, tone: "info", email: { kind: "lead_new", text: title } });
  await audit(ctx, a.actor, "lead.created", `Заявка №${number} ${a.via}: ${svc.label}`, {
    entityId: leadId,
    meta: { source: a.source, origin: a.origin, serviceId: svc.id, newClient, ...a.auditMeta },
  });
  await emitEvent(ctx, "lead.created", { leadId });
  return { leadId, number, clientId: client._id, newClient, serviceId: svc.id };
}
