// Общее для публичных HTTP-эндпоинтов (форма сайта, REST API): JSON-ответы, чтение тела с лимитом, разбор полей.

export type HeaderMap = Record<string, string>;

/** JSON-ответ. Ошибки — всегда `{ error }`. */
export function json(status: number, body: unknown, headers: HeaderMap = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

export type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false; status: 400 | 413 | 415; error: string };

/** Тело запроса — JSON-объект не больше maxBytes. Большое тело отбрасываем до разбора. */
export async function readJson(request: Request, maxBytes: number): Promise<BodyResult> {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) return { ok: false, status: 415, error: "Нужен Content-Type: application/json" };
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413, error: "Слишком большой запрос" };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400, error: "Не удалось прочитать запрос" };
  }
  if (new TextEncoder().encode(text).length > maxBytes) return { ok: false, status: 413, error: "Слишком большой запрос" };
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, status: 400, error: "Ожидался JSON-объект" };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, error: "Неверный JSON" };
  }
}

/** Строковое поле: обрезаем пробелы, пустое → undefined; не строка или длиннее max → ошибка с названием поля. */
export function str(body: Record<string, unknown>, key: string, max: number, label: string): { ok: true; value?: string } | { ok: false; error: string } {
  const raw = body[key];
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "string") return { ok: false, error: `${label}: ожидалась строка` };
  const value = raw.replace(/\u0000/g, "").trim();
  if (value.length > max) return { ok: false, error: `${label}: не длиннее ${max} символов` };
  return { ok: true, value: value || undefined };
}
