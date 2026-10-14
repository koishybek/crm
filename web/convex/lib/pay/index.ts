// Провайдеры онлайн-оплаты с API. Kaspi — без API: ссылка магазина по шаблону (src/data/payIntents.ts → kaspiLink).
import type { OnlineProvider } from "../../../src/data/payIntents";
import { cloudpayments } from "./cloudpayments";
import { freedompay } from "./freedompay";
import type { PayAdapter } from "./types";

export const PAY_ADAPTERS: Record<OnlineProvider, PayAdapter> = { freedompay, cloudpayments };
