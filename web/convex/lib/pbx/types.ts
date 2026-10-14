// Общий вид адаптера облачной АТС: вебхук провайдера → события в форме calls._ingest (ringing/answered/ended/missed),
// звонок с внутреннего номера на номер клиента и ссылка на запись разговора по API провайдера.
import type { PbxProvider } from "../../../src/data/pbx";

/** Событие звонка — ровно аргументы calls._ingest. */
export interface CallEvent {
  event: "ringing" | "answered" | "ended" | "missed" | "recording";
  externalId: string;
  direction?: "in" | "out";
  from?: string;
  to?: string;
  /** Email сотрудника или его внутренний номер АТС. */
  operator?: string;
  duration?: number;
  at?: string;
}

/** Запись разговора: готовая ссылка или номер, по которому ссылку выдаёт API провайдера. */
export type RecordingRef = { kind: "url"; url: string } | { kind: "id"; id: string };

export interface WebhookInput {
  method: string;
  query: URLSearchParams;
  headers: Headers;
  body: string;
  contentType: string;
}

export interface WebhookReply {
  status: number;
  body: string;
  contentType: string;
}

export type WebhookResult =
  | { ok: true; events: CallEvent[]; recording?: { externalId: string; ref: RecordingRef }; reply: WebhookReply }
  | { ok: false; status: number; why: string };

/** Ключи подключения: поля из PBX_INFO[provider].fields. */
export type PbxCreds = Record<string, string>;

/** Сессия API (OnlinePBX выдаёт ключ на трое суток): адаптер возвращает новую, если пришлось войти заново. */
export interface PbxSession {
  value: string | null;
}

export interface PbxAdapter {
  provider: PbxProvider;
  /** Проверка подписи/принадлежности и разбор события. creds — null, если провайдер не подключён. */
  parseWebhook(input: WebhookInput, creds: PbxCreds): Promise<WebhookResult>;
  /** Позвонить: АТС звонит сотруднику на внутренний номер и соединяет с клиентом. */
  dial(creds: PbxCreds, session: PbxSession, extension: string, phone: string): Promise<{ externalId?: string }>;
  /** Временная ссылка на запись разговора. */
  recordingUrl(creds: PbxCreds, session: PbxSession, ref: RecordingRef): Promise<string>;
  /** Проверить ключи безобидным запросом. */
  check(creds: PbxCreds, session: PbxSession): Promise<string>;
}

export const textReply = (body = "ok"): WebhookReply => ({ status: 200, body, contentType: "text/plain; charset=utf-8" });
export const jsonReply = (body: unknown): WebhookReply => ({ status: 200, body: JSON.stringify(body), contentType: "application/json" });

/** Unix-время (секунды) → ISO; мусор — undefined. */
export function unixIso(raw: string | undefined): string | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 1e9 && n < 1e11 ? new Date(n * 1000).toISOString() : undefined;
}

/** Неотрицательное целое число секунд или undefined. */
export function seconds(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

/** Внутренний номер сотрудника (короткий) — в отличие от телефона клиента. */
export const isExtension = (s: string | undefined): s is string => !!s && /^\d{1,8}$/.test(s);
