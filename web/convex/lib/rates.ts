// Ставки исполнителя в заказе (ТЗ п.13, п.14.5). Правило «сколько получит мастер» одно — termsFor/payoutFor
// в src/data/logic.ts; здесь — когда его применять. Заказ получает условия мастера в момент назначения или взятия
// (снимок acceptedPayout фиксирует сумму), а уходя от мастера обратно в ленту — снова свои условия (payoutBase).
import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { cleanMoney } from "./limits";
import { payout, termsFor } from "../../src/data/logic";
import type { ExecutorRates, RateOverride } from "../../src/data/types";
import { money } from "../../src/lib/format";

type Terms = Pick<Doc<"orders">, "payoutMode" | "payoutValue">;
type TermsPatch = Partial<Pick<Doc<"orders">, "payoutMode" | "payoutValue" | "payoutBase">>;

const same = (a: Terms, b: Terms) => a.payoutMode === b.payoutMode && a.payoutValue === b.payoutValue;

/**
 * Условия выплаты заказа для мастера ex: по его ставке, база запоминается в payoutBase (чтобы вернуть её, если заказ
 * уйдёт от мастера). Ставка мастера больше цены клиента — отказ: маржа ушла бы в минус молча.
 */
export function rateTerms(o: Doc<"orders">, ex: Doc<"executors">, who: "staff" | "executor"): TermsPatch {
  const base: Terms = o.payoutBase ?? { payoutMode: o.payoutMode, payoutValue: o.payoutValue };
  const terms = termsFor(ex.rates, o);
  const sum = payout({ clientPrice: o.clientPrice, ...terms });
  if (sum > o.clientPrice) {
    throw new ConvexError(
      who === "staff"
        ? `По ставке исполнителя выплата ${money(sum)} больше цены клиента ${money(o.clientPrice)} — поправьте цену или выплату в заказе вручную`
        : "Сумма по вашей ставке больше цены заказа — свяжитесь с оператором",
    );
  }
  if (same(terms, base)) return { payoutMode: base.payoutMode, payoutValue: base.payoutValue, payoutBase: undefined };
  return { ...terms, payoutBase: base };
}

/** Заказ уходит от мастера (отказ, снятие, отмена): условия — снова заказа, а не ставки ушедшего мастера. */
export const baseTerms = (o: Doc<"orders">): TermsPatch => (o.payoutBase ? { ...o.payoutBase, payoutBase: undefined } : {});

// ── Ставки мастера: проверка и текст для журнала ────────────────────────────

/** Ставок на отдельные услуги у одного мастера — не больше. */
export const MAX_SERVICE_RATES = 200;

function percentOf(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0 || value > 100) throw new ConvexError(`${label}: процент от 0 до 100`);
  return Math.round(value * 10) / 10;
}

function fixedOf(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) throw new ConvexError(`${label}: сумма больше нуля`);
  return cleanMoney(value, label);
}

/** Ставки от владельца: режим с заданным значением, ставки только на услуги справочника, пустые убираются. */
export function cleanRates(input: ExecutorRates, serviceLabel: (id: string) => string | null): ExecutorRates | undefined {
  const percent = percentOf(input.percent, "Свой процент");
  const fixed = fixedOf(input.fixed, "Своя сумма");
  if (input.mode === "percent" && percent === undefined) throw new ConvexError("Укажите процент мастера");
  if (input.mode === "fixed" && fixed === undefined) throw new ConvexError("Укажите сумму мастера за заказ");
  const entries = Object.entries(input.perService ?? {});
  if (entries.length > MAX_SERVICE_RATES) throw new ConvexError(`Ставок по услугам — не больше ${MAX_SERVICE_RATES}`);
  const perService: Record<string, RateOverride> = {};
  for (const [id, r] of entries) {
    const label = serviceLabel(id);
    if (!label) throw new ConvexError("Такой услуги нет в справочнике");
    const p = percentOf(r.percent, label);
    const f = fixedOf(r.fixed, label);
    if (p === undefined && f === undefined) continue;
    perService[id] = f !== undefined ? { fixed: f } : { percent: p };
  }
  const hasServices = Object.keys(perService).length > 0;
  if (input.mode === "service" && !hasServices) return undefined;
  return {
    mode: input.mode,
    ...(input.mode === "percent" ? { percent } : {}),
    ...(input.mode === "fixed" ? { fixed } : {}),
    ...(hasServices ? { perService } : {}),
  };
}

const overrideText = (r: RateOverride) => (r.fixed !== undefined ? money(r.fixed) : `${r.percent}%`);

/** «свой процент 45%; Ремонт кондиционера — 15 000 ₸» — ставки одной строкой для журнала и карточки. */
export function ratesText(r: ExecutorRates | undefined, serviceLabel: (id: string) => string): string {
  if (!r) return "ставка услуги";
  const head = r.mode === "percent" ? `свой процент ${r.percent}%` : r.mode === "fixed" ? `своя сумма ${money(r.fixed ?? 0)}` : "ставка услуги";
  const services = Object.entries(r.perService ?? {}).map(([id, x]) => `${serviceLabel(id)} — ${overrideText(x)}`);
  return [head, ...services].join("; ");
}
