/// <reference types="vite/client" />
// WhatsApp Cloud API: вебхук (подпись, разбор, повторы), входящие в «Сообщения», статусы доставки, ответы оператора.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import inboundText from "../test/fixtures/whatsapp/wa-inbound-text.json?raw";
import inboundVoice from "../test/fixtures/whatsapp/wa-inbound-voice-bsuid-only.json?raw";
import statusesBatch from "../test/fixtures/whatsapp/wa-statuses-batch.json?raw";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { isSystemicWaError, parseWebhook, UNSUPPORTED_TEXT, verifySignature, waErrorText } from "./lib/whatsapp";
import schema from "./schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-komfort";
const SECRET = "test_app_secret";
const VERIFY = "verify-me-please-0123456789";
const PHONE_ID = "987654321098765";
const TOKEN = "EAAtest";
const GRAPH = "https://graph.facebook.com/v26.0";
const SEND_URL = `${GRAPH}/${PHONE_ID}/messages`;
const IN_WAMID = "wamid.HBgLNzcwMTEyMzQ1NjcVAgASGBQzQTZGMDg1MDY1QkRDOTFFMTI0RgA=";
const VOICE_MEDIA = "1784205519832661";
const FIXTURE_OUT = "wamid.HBgLNzcwMTEyMzQ1NjcVAgARGBI5QTNDQTVCM0Q0Q0Q2RTY3RTcA";
const FIXTURE_FAILED = "wamid.HBgLNzcwNTk4NzY1NDMVAgARGBJCMjE4RkE3QzlEMEU1RjYwQjMA";
const AIGERIM_BSUID = "KZ.1349120865530274191";
/** Час спустя после сообщения из фикстуры (09:00 UTC): окно ответа открыто до 09:00 следующего дня. */
const NOW = new Date("2026-10-12T10:00:00Z");
const WINDOW_TEXT = "Прошло 24 часа — WhatsApp разрешает писать только шаблоном. Позвоните клиенту или дождитесь его сообщения.";

type Call = { url: string; method: string; body: Record<string, unknown> | null; auth: string | null };
let calls: Call[] = [];
let wamidSeq = 0;
/** Ответ Graph API на отправку — меняется в тестах ошибок. */
let sendReply: () => Response;
/** Файлы клиента у Meta: id → тип и байты. */
const MEDIA: Record<string, { mime: string; bytes: number[] }> = {
  [VOICE_MEDIA]: { mime: "audio/ogg; codecs=opus", bytes: [79, 103, 103, 83, 0, 2, 0, 0, 0, 0, 0] },
  IMG1: { mime: "image/jpeg", bytes: [255, 216, 255, 224, 0, 16] },
  DOC1: { mime: "application/pdf", bytes: [37, 80, 68, 70, 45] },
};

const graphOk = () => Response.json({ messaging_product: "whatsapp", contacts: [{ input: "+77011234567", wa_id: "77011234567" }], messages: [{ id: `wamid.OUT${++wamidSeq}` }] });
const graphError = (code: number) => () => Response.json({ error: { message: `(#${code}) error`, type: "OAuthException", code, fbtrace_id: "AbC" } }, { status: 400 });

beforeEach(() => {
  calls = [];
  wamidSeq = 0;
  sendReply = graphOk;
  vi.stubEnv("WHATSAPP_TOKEN", TOKEN);
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", PHONE_ID);
  vi.stubEnv("WHATSAPP_APP_SECRET", SECRET);
  vi.stubEnv("WHATSAPP_VERIFY_TOKEN", VERIFY);
  vi.stubEnv("CONVEX_SITE_URL", "https://demo-123.convex.site");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ url, method: init?.method ?? "GET", body, auth: new Headers(init?.headers).get("authorization") });
      if (url === SEND_URL) return sendReply();
      const info = /^https:\/\/graph\.facebook\.com\/v26\.0\/(\w+)\?phone_number_id=987654321098765$/.exec(url);
      const infoFile = info ? MEDIA[info[1]!] : undefined;
      if (info && infoFile) {
        return Response.json({ messaging_product: "whatsapp", url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${info[1]}`, mime_type: infoFile.mime, file_size: String(infoFile.bytes.length), id: info[1] });
      }
      const download = /^https:\/\/lookaside\.fbsbx\.com\/whatsapp_business\/attachments\/\?mid=(\w+)$/.exec(url);
      const file = download ? MEDIA[download[1]!] : undefined;
      if (file) return new Response(new Uint8Array(file.bytes), { headers: { "Content-Type": file.mime } });
      if (url === "https://ai.test/v1/transcribe") return Response.json({ text: "Кондиционер течёт, приезжайте завтра после обеда", language: "ru", seconds: 6 });
      return new Response("not found", { status: 404 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type TestEnv = ReturnType<typeof convexTest>;

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => ({
    owner: await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true }),
    operator: await ctx.db.insert("users", { name: "Оператор Мадина", email: "op@test.kz", role: "operator", tenantId: T, active: true }),
  }));
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  return { t, ids, as, op: as(ids.operator) };
}

async function sign(body: string, secret = SECRET): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** POST от «Meta»: подпись по точным байтам тела; null — без подписи. */
async function post(t: TestEnv, body: string, signature?: string | null): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const sig = signature === undefined ? await sign(body) : signature;
  if (sig) headers["X-Hub-Signature-256"] = sig;
  return t.fetch("/whatsapp/webhook", { method: "POST", body, headers });
}

const drain = (t: TestEnv) => t.finishAllScheduledFunctions(vi.runAllTimers);

const dump = (t: TestEnv) =>
  t.run(async (ctx) => ({
    convs: await ctx.db.query("conversations").collect(),
    msgs: await ctx.db.query("conversationMessages").collect(),
    leads: await ctx.db.query("leads").collect(),
  }));

const healthOf = (t: TestEnv) => t.run(async (ctx) => (await ctx.db.query("systemStatus").collect()).find((x) => x.key === "whatsapp"));

/** Тип файла, с которым он лежит в хранилище (null — файла нет). */
const storedType = (t: TestEnv, id: Id<"_storage"> | undefined) => t.run(async (ctx) => (id ? ((await ctx.storage.get(id))?.type ?? null) : null));

function webhook(field: string, value: Record<string, unknown>): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "1234567890123456", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { display_phone_number: "77273000000", phone_number_id: PHONE_ID }, ...value } }] }],
  });
}

const AIGERIM = { profile: { name: "Айгерим" }, wa_id: "77011234567", user_id: AIGERIM_BSUID };
let seq = 0;
/** Сообщение Айгерим нужного типа — в формате вебхука Meta, как фикстура. */
function message(fields: Record<string, unknown>, contact: Record<string, unknown> | null = AIGERIM): { body: string; wamid: string } {
  const wamid = `wamid.T${++seq}`;
  const m = { from: "77011234567", from_user_id: AIGERIM_BSUID, id: wamid, timestamp: "1791795700", ...fields };
  return { wamid, body: webhook("messages", { ...(contact ? { contacts: [contact] } : {}), messages: [m] }) };
}

describe("подпись, разбор, коды ошибок", () => {
  test("подпись Meta: эталонные векторы по сырым байтам, смена App Secret, чужой формат заголовка", async () => {
    const raw = (s: string) => new TextEncoder().encode(s).buffer;
    const empty = '{"object":"whatsapp_business_account","entry":[]}';
    const utf8 = '{"t":"Привет"}';
    const escaped = '{"t":"\\u041f\\u0440\\u0438\\u0432\\u0435\\u0442"}';
    const sigEmpty = "sha256=dec6a680679a968e7e0319355b23599cbfc54502c0784668e9618baa0c633756";
    expect(await verifySignature(raw(empty), sigEmpty, [SECRET])).toBe(true);
    expect(await verifySignature(raw(utf8), "sha256=36faacb650453b7dd16d15149c7332d0cbfc44511e9532aa470e1d2166577cea", [SECRET])).toBe(true);
    expect(await verifySignature(raw(escaped), "sha256=cba3263be126b02860b201ec72e3962004639f3e39b1df750ad91b04a0bf6c9a", [SECRET])).toBe(true);
    // После разбора JSON тот же, но байты другие — и подпись другая.
    expect(await verifySignature(raw(utf8), "sha256=cba3263be126b02860b201ec72e3962004639f3e39b1df750ad91b04a0bf6c9a", [SECRET])).toBe(false);
    expect(await verifySignature(raw(empty), sigEmpty.toUpperCase().replace("SHA256=", "sha256="), [SECRET])).toBe(true);
    expect(await verifySignature(raw(empty), sigEmpty, ["new_secret", SECRET])).toBe(true);
    expect(await verifySignature(raw(empty), sigEmpty, ["new_secret"])).toBe(false);
    expect(await verifySignature(raw(empty), "sha1=dec6a680679a968e7e0319355b23599cbfc54502", [SECRET])).toBe(false);
    expect(await verifySignature(raw(empty), null, [SECRET])).toBe(false);
  });

  test("коды ошибок Meta → текст для оператора; сбой канала отличается от проблемы с одним клиентом", () => {
    expect(waErrorText(131047)).toBe(WINDOW_TEXT);
    expect(waErrorText(131026)).toContain("не доставлено");
    expect(waErrorText(130429)).toContain("не писать так часто");
    expect(waErrorText(131056)).toBe(waErrorText(130429));
    expect(waErrorText(190)).toContain("Токен WhatsApp");
    expect(waErrorText(131042)).toContain("оплат");
    expect(waErrorText(250)).toContain("нет прав");
    expect(waErrorText(424242)).toBe("WhatsApp не принял сообщение (код 424242)");
    for (const code of [0, 3, 190, 250, 368, 131000, 131042, 131045]) expect(isSystemicWaError(code)).toBe(true);
    for (const code of [100, 130429, 131026, 131047, 131050, 131056, 424242]) expect(isSystemicWaError(code)).toBe(false);
  });

  test("разбор: только наш номер; статусы, смена BSUID и ошибки платформы; мусор не роняет", () => {
    expect(parseWebhook(JSON.parse(inboundText), "111111111111111")).toMatchObject({ events: [], skipped: 1 });
    expect(parseWebhook("не объект", PHONE_ID)).toMatchObject({ events: [], skipped: 1 });
    expect(parseWebhook(JSON.parse(webhook("account_alerts", {})), PHONE_ID)).toMatchObject({ events: [], skipped: 1 });
    const batch = parseWebhook(JSON.parse(statusesBatch), PHONE_ID);
    expect(batch.businessPhone).toBe("77273000000");
    expect(batch.events).toEqual([
      { kind: "status", wamid: FIXTURE_OUT, status: "read" },
      { kind: "status", wamid: FIXTURE_OUT, status: "delivered" },
      { kind: "status", wamid: FIXTURE_FAILED, status: "failed", errors: [{ code: 131047 }] },
    ]);
    const renamed = webhook("user_id_update", { user_id_update: [{ wa_id: "77011234567", detail: "changed", user_id: { previous: AIGERIM_BSUID, current: "KZ.555" }, timestamp: "1791797000" }] });
    expect(parseWebhook(JSON.parse(renamed), PHONE_ID).events).toEqual([{ kind: "identity", previous: AIGERIM_BSUID, current: "KZ.555" }]);
    expect(parseWebhook(JSON.parse(webhook("messages", { errors: [{ code: 130429, title: "Rate limit hit" }] })), PHONE_ID).events).toEqual([{ kind: "platform_error", errors: [{ code: 130429 }] }]);
  });
});

describe("вебхук", () => {
  test("GET: challenge как есть только при верном verify token; не настроен — 503", async () => {
    const t = convexTest(schema, modules);
    const ok = await t.fetch(`/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("1158201444");
    expect(ok.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await t.fetch("/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1")).status).toBe(403);
    expect((await t.fetch(`/whatsapp/webhook?hub.mode=unsubscribe&hub.verify_token=${VERIFY}&hub.challenge=1`)).status).toBe(403);
    expect((await t.fetch(`/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}`)).status).toBe(403);
    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", "");
    expect((await t.fetch(`/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1`)).status).toBe(503);
  });

  test("POST: без подписи, с чужой подписью или по пересобранному JSON — 403 и ничего не пишем; слишком большой — 413", async () => {
    const { t } = await setup();
    expect((await post(t, inboundText, null)).status).toBe(403);
    expect((await post(t, inboundText, await sign(inboundText, "wrong_secret"))).status).toBe(403);
    expect((await post(t, JSON.stringify(JSON.parse(inboundText)), await sign(inboundText))).status).toBe(403);
    expect((await post(t, inboundText, "sha256=not-a-signature")).status).toBe(403);
    expect((await post(t, inboundText + " ".repeat(5 * 1024 * 1024))).status).toBe(413);
    await drain(t);
    const s = await dump(t);
    expect(s.convs).toHaveLength(0);
    expect(s.msgs).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("integrations").collect())).toHaveLength(0);
    vi.stubEnv("WHATSAPP_APP_SECRET", "");
    expect((await post(t, inboundText)).status).toBe(503);
  });

  test("входящий текст: диалог по номеру и BSUID, окно 24 ч от времени сообщения, уведомление и заявка; повтор доставки не дублирует", async () => {
    const { t } = await setup();
    expect((await post(t, inboundText)).status).toBe(200);
    expect((await post(t, inboundText)).status).toBe(200); // Meta повторила, пока первое ещё не обработано
    await drain(t);
    expect((await post(t, inboundText)).status).toBe(200); // и ещё раз — после
    await drain(t);
    const s = await dump(t);
    expect(s.convs).toHaveLength(1);
    expect(s.convs[0]).toMatchObject({
      channel: "whatsapp",
      externalId: "77011234567",
      waUserId: AIGERIM_BSUID,
      contactName: "Айгерим",
      contactPhone: "77011234567",
      unread: 1,
      replyUntil: "2026-10-13T09:00:00.000Z",
    });
    expect(s.msgs).toHaveLength(1);
    expect(s.msgs[0]).toMatchObject({
      direction: "in",
      kind: "text",
      externalId: `whatsapp:${IN_WAMID}`,
      at: "2026-10-12T09:00:00.000Z",
      text: "Здравствуйте! Кондиционер не холодит, Алматы, мкр Самал-2. Можно мастера сегодня?",
    });
    // Номер известен — заявка по общим правилам «Сообщений» (без AI — с текстом клиента).
    expect(s.leads).toHaveLength(1);
    expect(s.leads[0]).toMatchObject({ source: "whatsapp", clientPhone: "77011234567", clientName: "Айгерим" });
    expect(s.convs[0]!.leadId).toBe(s.leads[0]!._id);
    const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notes.some((n) => n.text.startsWith("Новое сообщение в WhatsApp от Айгерим"))).toBe(true);
    // Первый вебхук: WhatsApp подключён — для карточки владельца, мониторинга и журнала.
    expect(await t.run((ctx) => ctx.db.query("integrations").collect())).toEqual([expect.objectContaining({ provider: "whatsapp", status: "connected", accountName: "77273000000" })]);
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.find((x) => x.action === "integration.connected")).toMatchObject({ actorName: "WhatsApp" });
    expect((await healthOf(t))?.okAt).toBeDefined();
  });

  test("голосовое от клиента без номера (только BSUID): файл в хранилище, расшифровка «🎤 …», ответ — по BSUID, заявки нет", async () => {
    vi.stubEnv("AI_URL", "https://ai.test");
    vi.stubEnv("AI_SECRET", "ai-secret");
    const { t, op } = await setup();
    await post(t, inboundVoice);
    await drain(t);
    await post(t, inboundVoice); // повтор Meta: файл заново не качаем и не расшифровываем
    await drain(t);
    expect(calls.filter((c) => c.url.startsWith(`${GRAPH}/${VOICE_MEDIA}?`))).toHaveLength(1);
    expect(calls.filter((c) => c.url === "https://ai.test/v1/transcribe")).toHaveLength(1);

    const s = await dump(t);
    expect(s.convs).toHaveLength(1);
    expect(s.convs[0]).toMatchObject({ externalId: "KZ.8812004571923311045", waUserId: "KZ.8812004571923311045", contactName: "Ерлан", meta: { username: "erlan.almaty" } });
    expect(s.convs[0]!.contactPhone).toBeUndefined();
    expect(s.msgs).toHaveLength(1);
    expect(s.msgs[0]).toMatchObject({ kind: "audio", text: "🎤 Кондиционер течёт, приезжайте завтра после обеда", fileName: "voice.ogg" });
    const files = await t.run((ctx) => ctx.db.system.query("_storage").collect());
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ _id: s.msgs[0]!.fileId, size: 11 });
    expect(await storedType(t, s.msgs[0]!.fileId)).toBe("audio/ogg");
    // Ссылку на файл берём у Meta с токеном, скачиваем тоже с токеном — только с хоста Meta.
    expect(calls.find((c) => c.url.startsWith(`${GRAPH}/${VOICE_MEDIA}?`))?.auth).toBe(`Bearer ${TOKEN}`);
    expect(calls.find((c) => c.url.startsWith("https://lookaside.fbsbx.com/"))?.auth).toBe(`Bearer ${TOKEN}`);
    expect(calls.find((c) => c.url === "https://ai.test/v1/transcribe")?.auth).toBe("Bearer ai-secret");
    expect(s.leads).toHaveLength(0);

    await op.mutation(api.inbox.reply, { conversationId: s.convs[0]!._id, text: "Здравствуйте! Во сколько удобно?" });
    await drain(t);
    const out = calls.find((c) => c.url === SEND_URL)!;
    expect(out.body).toMatchObject({ recipient: "KZ.8812004571923311045", type: "text" });
    expect(out.body).not.toHaveProperty("to");
  });

  test("ответ оператора уходит в Graph API, wamid сохраняется; статусы: «прочитано» раньше «доставлено», failed 131047 закрывает окно; повтор не меняет", async () => {
    const { t, op } = await setup();
    await post(t, inboundText);
    await drain(t);
    const conversationId = (await dump(t)).convs[0]!._id;
    const { messageId: m1 } = await op.mutation(api.inbox.reply, { conversationId, text: "Здравствуйте! Мастер приедет сегодня с 15:00 до 17:00." });
    await drain(t);
    const sent = calls.filter((c) => c.url === SEND_URL);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "POST", auth: `Bearer ${TOKEN}` });
    expect(sent[0]!.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+77011234567",
      type: "text",
      text: { preview_url: false, body: "Здравствуйте! Мастер приедет сегодня с 15:00 до 17:00." },
    });
    expect(await t.run((ctx) => ctx.db.get(m1))).toMatchObject({ status: "sent", externalId: "whatsapp:wamid.OUT1" });
    expect((await healthOf(t))?.okNote).toBe("Ответ клиенту доставлен");

    const { messageId: m2 } = await op.mutation(api.inbox.reply, { conversationId, text: "Подскажите, какой этаж?" });
    await drain(t);
    const statuses = statusesBatch.replaceAll(FIXTURE_OUT, "wamid.OUT1").replaceAll(FIXTURE_FAILED, "wamid.OUT2");
    expect((await post(t, statuses)).status).toBe(200);
    await drain(t);
    expect((await post(t, statuses)).status).toBe(200);
    await drain(t);
    expect(await t.run((ctx) => ctx.db.get(m1))).toMatchObject({ status: "read" });
    expect(await t.run((ctx) => ctx.db.get(m2))).toMatchObject({ status: "failed", error: WINDOW_TEXT });
    // Meta сказала «прошло 24 часа» — поле ответа выключено, новый ответ не уходит.
    expect((await op.query(api.inbox.get, { id: conversationId }))!.replyBlock).toBe(WINDOW_TEXT);
    await expect(op.mutation(api.inbox.reply, { conversationId, text: "Алло?" })).rejects.toThrow(WINDOW_TEXT);
    expect((await healthOf(t))?.error).toBeUndefined();
  });

  test("ответ после конца 24-часового окна — без запроса к Meta, «не отправлено» с понятной причиной", async () => {
    const { t, op } = await setup();
    await post(t, inboundText);
    await drain(t);
    const conversationId = (await dump(t)).convs[0]!._id;
    const { messageId } = await op.mutation(api.inbox.reply, { conversationId, text: "Добрый день! Удобно завтра?" });
    // Ответ ещё в очереди, а окно уже закрылось: клиент писал вчера в 09:00.
    vi.setSystemTime(new Date("2026-10-13T09:00:01Z"));
    await drain(t);
    expect(await t.run((ctx) => ctx.db.get(messageId))).toMatchObject({ status: "failed", error: WINDOW_TEXT });
    expect(calls.filter((c) => c.url === SEND_URL)).toHaveLength(0);
    expect((await healthOf(t))?.error).toBeUndefined(); // это не сбой канала
    await expect(op.mutation(api.inbox.reply, { conversationId, text: "Алло?" })).rejects.toThrow(WINDOW_TEXT);
    await expect(op.mutation(api.inbox.resend, { messageId })).rejects.toThrow(WINDOW_TEXT);
  });

  test("ошибки Graph API → понятная причина; сломанный токен — тревога в мониторинге; 131047 закрывает окно", async () => {
    const cases: { name: string; reply: () => Response; error: string; systemic: boolean; closes: boolean }[] = [
      { name: "номер без WhatsApp", reply: graphError(131026), error: waErrorText(131026), systemic: false, closes: false },
      { name: "лимит частоты", reply: graphError(130429), error: waErrorText(130429), systemic: false, closes: false },
      { name: "токен истёк", reply: graphError(190), error: waErrorText(190), systemic: true, closes: false },
      { name: "окно закрыто по данным Meta", reply: graphError(131047), error: WINDOW_TEXT, systemic: false, closes: true },
      {
        name: "нет связи",
        reply: () => {
          throw new TypeError("fetch failed");
        },
        error: "Нет связи с WhatsApp — попробуйте ещё раз",
        systemic: true,
        closes: false,
      },
    ];
    for (const c of cases) {
      const { t, op } = await setup();
      await post(t, inboundText);
      await drain(t);
      const conversationId = (await dump(t)).convs[0]!._id;
      sendReply = c.reply;
      const { messageId } = await op.mutation(api.inbox.reply, { conversationId, text: "Добрый день" });
      await drain(t);
      expect(await t.run((ctx) => ctx.db.get(messageId)), c.name).toMatchObject({ status: "failed", error: c.error });
      expect((await healthOf(t))?.error !== undefined, c.name).toBe(c.systemic);
      expect((await op.query(api.inbox.get, { id: conversationId }))!.replyBlock, c.name).toBe(c.closes ? WINDOW_TEXT : undefined);
    }
  });

  test("фото, документ, геопозиция, кнопки, реакция и неподдерживаемое — в ленте; служебные отметки окно не продлевают; группа и чужой номер — пропуск", async () => {
    const { t } = await setup();
    const later = "1791799999"; // реакция и «не поддерживается» — позже остальных
    const sent = {
      image: message({ type: "image", image: { id: "IMG1", mime_type: "image/jpeg", sha256: "x", caption: "Вот так течёт" } }),
      document: message({ type: "document", document: { id: "DOC1", mime_type: "application/pdf", filename: "../смета.pdf" } }),
      location: message({ type: "location", location: { latitude: 43.238949, longitude: 76.889709, name: "Самал-2", address: "ул. Жолдасбекова, 97" } }),
      interactive: message({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "slot-1", title: "Завтра утром" } }, context: { from: "77273000000", id: "wamid.OUR" } }),
      button: message({ type: "button", button: { payload: "Подтверждаю", text: "Подтверждаю" } }),
      reaction: message({ type: "reaction", timestamp: later, reaction: { message_id: "wamid.OUR", emoji: "👍" } }),
      unsupported: message({ type: "unsupported", timestamp: later, unsupported: { type: "poll_creation" }, errors: [{ code: 131051, title: "Message type unknown" }] }),
      group: message({ type: "text", text: { body: "Всем привет" }, group_id: "Y2FwaV9ncm91cDox" }),
    };
    // По одному, как обычно шлёт Meta (convex-test не умеет сохранять файлы из параллельных фоновых задач).
    for (const m of Object.values(sent)) {
      expect((await post(t, m.body)).status).toBe(200);
      await drain(t);
    }
    expect((await post(t, inboundText.replace(PHONE_ID, "111111111111111"))).status).toBe(200);
    await drain(t);
    const s = await dump(t);
    const msg = (m: { wamid: string }) => s.msgs.find((x) => x.externalId === `whatsapp:${m.wamid}`);
    expect(s.convs).toHaveLength(1);
    expect(s.msgs).toHaveLength(7);
    expect(msg(sent.image)).toMatchObject({ kind: "image", text: "Вот так течёт", fileName: "photo.jpg" });
    expect(msg(sent.document)).toMatchObject({ kind: "file", text: "Файл", fileName: ".._смета.pdf" });
    expect(await storedType(t, msg(sent.document)!.fileId)).toBe("application/pdf");
    expect(await storedType(t, msg(sent.image)!.fileId)).toBe("image/jpeg");
    expect(msg(sent.location)).toMatchObject({
      kind: "location",
      text: "📍 Самал-2, ул. Жолдасбекова, 97\n43.238949, 76.889709\nhttps://www.google.com/maps/search/?api=1&query=43.238949,76.889709",
    });
    expect(msg(sent.interactive)).toMatchObject({ kind: "text", text: "Завтра утром" });
    expect(msg(sent.button)).toMatchObject({ kind: "text", text: "Подтверждаю" });
    expect(msg(sent.reaction)).toMatchObject({ kind: "system", text: "Клиент отреагировал 👍" });
    expect(msg(sent.unsupported)).toMatchObject({ kind: "system", text: `${UNSUPPORTED_TEXT}. ${waErrorText(131051)}` });
    expect(msg(sent.group)).toBeUndefined();
    // Окно — от последнего сообщения клиента (09:01:40), а не от реакции.
    expect(s.convs[0]!.replyUntil).toBe("2026-10-13T09:01:40.000Z");
  });

  test("номер скрылся — тот же диалог по BSUID; смена BSUID и номера переносят адрес ответа, история остаётся", async () => {
    const { t, op } = await setup();
    await post(t, inboundText);
    await drain(t);
    // Клиент с username пишет без номера — только BSUID.
    const hidden = message({ from: undefined, type: "text", text: { body: "Это снова я, кондиционер опять шумит" } }, { profile: { name: "Айгерим", username: "aigerim.kz" }, user_id: AIGERIM_BSUID });
    await post(t, hidden.body);
    await drain(t);
    let s = await dump(t);
    expect(s.convs).toHaveLength(1);
    expect(s.msgs).toHaveLength(2);

    // BSUID сменился (вебхук user_id_update), затем — системное «сменил номер».
    const NEW_BSUID = "KZ.7770001112223334445";
    await post(t, webhook("user_id_update", { user_id_update: [{ wa_id: "77011234567", detail: "changed", user_id: { previous: AIGERIM_BSUID, current: NEW_BSUID }, timestamp: "1791797000" }] }));
    await drain(t);
    expect((await dump(t)).convs[0]).toMatchObject({ waUserId: NEW_BSUID, externalId: "77011234567" });
    const moved = message({ from_user_id: NEW_BSUID, type: "system", system: { body: "User Айгерим changed from 77011234567 to 77779998877", wa_id: "77779998877", type: "user_changed_number" } }, null);
    await post(t, moved.body);
    await drain(t);
    s = await dump(t);
    expect(s.convs).toHaveLength(1);
    expect(s.convs[0]).toMatchObject({ externalId: "77779998877", contactPhone: "77779998877", waUserId: NEW_BSUID });
    expect(s.msgs.find((m) => m.externalId === `whatsapp:${moved.wamid}`)).toMatchObject({ kind: "system", text: "Клиент сменил номер WhatsApp на +7 777 999 88 77" });
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.find((x) => x.action === "conversation.whatsappNumber")).toMatchObject({ actorName: "WhatsApp", entityId: s.convs[0]!._id });

    await op.mutation(api.inbox.reply, { conversationId: s.convs[0]!._id, text: "Записали новый номер, спасибо!" });
    await drain(t);
    expect(calls.find((c) => c.url === SEND_URL)?.body).toMatchObject({ to: "+77779998877" });
  });

  test("статус пришёл раньше, чем записан ответ Meta на отправку, — применяется при повторной проверке", async () => {
    const { t } = await setup();
    await post(t, inboundText);
    await drain(t);
    const conversationId = (await dump(t)).convs[0]!._id;
    // Сообщение «в полёте»: Meta его уже приняла, а wamid ещё не записан.
    const id = await t.run((ctx) => ctx.db.insert("conversationMessages", { conversationId, direction: "out", kind: "text", text: "Будем в 15:00", at: new Date().toISOString(), status: "sending" }));
    await post(t, webhook("messages", { statuses: [{ id: "wamid.LATE", status: "delivered", timestamp: "1791799300", recipient_id: "77011234567" }] }));
    vi.advanceTimersToNextTimer();
    await t.finishInProgressScheduledFunctions();
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "sending" });
    await t.run((ctx) => ctx.db.patch(id, { status: "sent", externalId: "whatsapp:wamid.LATE" })); // ответ Meta записан
    await drain(t);
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "delivered" });
  });
});

describe("карточка владельца", () => {
  test("что настроено, адрес вебхука, последний вебхук и номер; без токена отвечать нельзя; оператору — нет доступа", async () => {
    const { t, ids, as } = await setup();
    const owner = as(ids.owner);
    const before = await owner.query(api.channels.whatsapp.settings, {});
    expect(before).toMatchObject({ configured: true, missing: [], webhookUrl: "https://demo-123.convex.site/whatsapp/webhook", verifyToken: { state: "ok", end: "6789" }, graphVersion: "v26.0" });
    expect(before.lastWebhookAt).toBeUndefined();
    await post(t, inboundText);
    await drain(t);
    expect(await owner.query(api.channels.whatsapp.settings, {})).toMatchObject({ businessPhone: "77273000000", lastWebhookAt: NOW.toISOString() });
    await expect(as(ids.operator).query(api.channels.whatsapp.settings, {})).rejects.toThrow("Нет доступа");

    vi.stubEnv("WHATSAPP_TOKEN", "");
    vi.stubEnv("WHATSAPP_APP_SECRET", "");
    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", "short");
    vi.stubEnv("WHATSAPP_GRAPH_VERSION", "latest");
    expect(await owner.query(api.channels.whatsapp.settings, {})).toMatchObject({ configured: false, missing: ["WHATSAPP_TOKEN", "WHATSAPP_APP_SECRET"], verifyToken: { state: "short" }, graphVersion: "v26.0" });
    const conversationId = (await dump(t)).convs[0]!._id;
    expect((await as(ids.operator).query(api.inbox.get, { id: conversationId }))!.replyBlock).toBe("Канал не подключён");
    // Токен под именем из исследования интеграции тоже подходит.
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", TOKEN);
    expect((await owner.query(api.channels.whatsapp.settings, {})).missing).toEqual(["WHATSAPP_APP_SECRET"]);
    expect((await as(ids.operator).query(api.inbox.get, { id: conversationId }))!.replyBlock).toBeUndefined();
  });
});
