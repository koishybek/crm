// Типичные цены и доля исполнителя для справочника по умолчанию (аудит H-2). Только на сервере:
// в публичном бандле фронта (src/data/catalog.ts) у услуг по умолчанию денег нет — по доле и своей выплате
// мастер вычислил бы цену клиента и маржу. Владелец правит цены в «Настройках», дальше они живут в базе.
import type { Service } from "../../src/data/catalog";

export const DEFAULT_PRICES: Record<string, Pick<Service, "price" | "payoutPct">> = {
  "ac-install": { price: [30000, 45000], payoutPct: 70 },
  "ac-repair": { price: [20000, 35000], payoutPct: 70 },
  "ac-clean": { price: [10000, 16000], payoutPct: 65 },
  "ac-refill": { price: [13000, 20000], payoutPct: 65 },
  "wm-repair": { price: [12000, 32000], payoutPct: 70 },
  "fridge-repair": { price: [15000, 30000], payoutPct: 70 },
  "oven-repair": { price: [14000, 24000], payoutPct: 70 },
  "dw-repair": { price: [14000, 26000], payoutPct: 70 },
  "leak-fix": { price: [10000, 18000], payoutPct: 70 },
  plumbing: { price: [12000, 30000], payoutPct: 70 },
  faucet: { price: [8000, 12000], payoutPct: 70 },
  "el-diag": { price: [10000, 18000], payoutPct: 70 },
  "el-install": { price: [25000, 90000], payoutPct: 72 },
  "el-sockets": { price: [8000, 14000], payoutPct: 70 },
  boiler: { price: [18000, 28000], payoutPct: 70 },
  "boiler-service": { price: [18000, 30000], payoutPct: 68 },
  furniture: { price: [12000, 25000], payoutPct: 75 },
  cleaning: { price: [20000, 45000], payoutPct: 65 },
  "sofa-clean": { price: [12000, 20000], payoutPct: 65 },
  "pc-repair": { price: [8000, 20000], payoutPct: 70 },
  network: { price: [10000, 35000], payoutPct: 70 },
  "web-dev": { price: [350000, 450000], payoutPct: 62 },
  intercom: { price: [15000, 30000], payoutPct: 70 },
  cctv: { price: [40000, 120000], payoutPct: 70 },
  other: { price: [0, 0], payoutPct: 70 },
};

/** Услуги по умолчанию с ценами — для пустой базы, первого сохранения справочника и демо-данных. */
export const withDefaultPrices = (services: readonly Service[]): Service[] => services.map((s) => ({ ...s, ...(DEFAULT_PRICES[s.id] ?? {}) }));
