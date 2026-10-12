// Telegram-бот @…: уведомления команде, работа мастеров с заказами из чата, заявки от клиентов.
// Нет TELEGRAM_BOT_TOKEN — всё тихо выключено.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction, internalMutation, mutation, query, type ActionCtx } from "./_generated/server";
import { currentUser } from "./lib/access";
import { cardHtml, esc, workerButtons, type CardData, type TgButton } from "./lib/tg";
import { canExtract, canTranscribe, extract, toSummary, transcribe, type CatalogHint } from "./ai";
import { env } from "./env";
import { APP_NAME } from "../src/data/catalog";

type Markup = { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] } | { keyboard: unknown[][]; resize_keyboard?: boolean; one_time_keyboard?: boolean } | { remove_keyboard: true };

async function tg(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string } | null> {
  const token = env("TELEGRAM_BOT_TOKEN");
  if (!token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!json.ok) console.warn(`telegram ${method}: ${json.description}`);
    return json;
  } catch (e) {
    console.warn(`telegram ${method} failed`, e instanceof Error ? e.message : e);
    return null;
  }
}

const inline = (rows: TgButton[][]): Markup | undefined => {
  const kb = rows.filter((r) => r.length).map((r) => r.map((b) => (b.data ? { text: b.text, callback_data: b.data } : { text: b.text, url: b.url! })));
  return kb.length ? { inline_keyboard: kb } : undefined;
};

const sendHtml = (chatId: string, html: string, markup?: Markup) => tg("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });

const appUrl = () => env("APP_URL")?.replace(/\/$/, "");

const buttonRow = v.array(v.object({ text: v.string(), data: v.optional(v.string()), url: v.optional(v.string()) }));

/** Отправка из планировщика (notify, сводки). html — уже экранированный, иначе text экранируем. */
export const send = internalAction({
  args: { chatId: v.string(), text: v.string(), html: v.optional(v.string()), link: v.optional(v.string()), buttons: v.optional(v.array(buttonRow)) },
  handler: async (_ctx, { chatId, text, html, link, buttons }) => {
    const rows: TgButton[][] = [...(buttons ?? [])];
    const app = appUrl();
    const hasUrl = rows.some((r) => r.some((b) => b.url));
    if (app && link && !hasUrl) rows.push([{ text: "Открыть", url: `${app}${link}` }]);
    await sendHtml(chatId, html ?? esc(text), inline(rows));
  },
});

/** Статус подключения для профиля. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const me = await currentUser(ctx);
    if (!me) return null;
    return { enabled: !!env("TELEGRAM_BOT_TOKEN") && !!env("TELEGRAM_BOT_USERNAME"), linked: !!me.telegramChatId, bot: env("TELEGRAM_BOT_USERNAME") ?? null };
  },
});

/** Одноразовая ссылка t.me/<бот>?start=<код> для привязки аккаунта. */
export const linkUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await currentUser(ctx);
    if (!me) throw new ConvexError("Нужно войти");
    const bot = env("TELEGRAM_BOT_USERNAME");
    if (!bot || !env("TELEGRAM_BOT_TOKEN")) throw new ConvexError("Бот ещё не подключён");
    const code = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
    await ctx.db.patch(me._id, { telegramLinkCode: code });
    return `https://t.me/${bot.replace(/^@/, "")}?start=${code}`;
  },
});

export const unlink = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await currentUser(ctx);
    if (!me) throw new ConvexError("Нужно войти");
    await ctx.db.patch(me._id, { telegramChatId: undefined, telegramLinkCode: undefined });
  },
});

export const linkChat = internalMutation({
  args: { code: v.string(), chatId: v.string() },
  handler: async (ctx, { code, chatId }): Promise<{ name: string; role: string } | null> => {
    if (!/^[0-9a-f]{24}$/.test(code)) return null;
    const u = await ctx.db.query("users").withIndex("by_telegram_code", (q) => q.eq("telegramLinkCode", code)).first();
    if (!u) return null;
    // Один чат — один аккаунт.
    for (const other of await ctx.db.query("users").withIndex("by_telegram_chat", (q) => q.eq("telegramChatId", chatId)).collect()) {
      if (other._id !== u._id) await ctx.db.patch(other._id, { telegramChatId: undefined });
    }
    await ctx.db.patch(u._id, { telegramChatId: chatId, telegramLinkCode: undefined });
    return { name: u.name ?? "", role: u.role ?? "" };
  },
});

// ── Входящие обновления ──────────────────────────────────────────────────────

type TgUser = { id: number; first_name?: string; last_name?: string };
type TgMessage = {
  message_id: number;
  chat: { id: number; type?: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  contact?: { phone_number: string; first_name?: string; last_name?: string; user_id?: number };
  voice?: { file_id: string; duration?: number };
  audio?: { file_id: string; duration?: number };
  photo?: unknown[];
};
type TgUpdate = { message?: TgMessage; callback_query?: { id: string; data?: string; from: TgUser; message?: TgMessage } };

const HELP_EXECUTOR =
  "Я присылаю новые заказы по вашей специализации — их можно взять кнопкой «Взять заказ».\n\n/feed — свободные заказы\n/orders — мои заказы с кнопками: начать, завершить\n\nАдрес и телефон клиента появляются, как только заказ ваш.";
const HELP_STAFF = "Я присылаю новые заявки, события по заказам и утреннюю сводку в 9:00.\n\n/orders — сводка прямо сейчас";
const HELP_CLIENT = `Здравствуйте! 👋 Это ${APP_NAME}. Опишите, что случилось и где вы находитесь — можно текстом или голосовым. Затем поделитесь номером, и оператор перезвонит.`;

const fullName = (u?: { first_name?: string; last_name?: string }) => [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim() || undefined;

async function linkedUser(ctx: ActionCtx, chatId: string): Promise<{ role: string | null; name: string }> {
  const r = await ctx.runQuery(internal.worker._forChat, { chatId, what: "orders" });
  return { role: r.role, name: r.name };
}

async function sendCards(chatId: string, cards: CardData[], header: (c: CardData) => string) {
  const app = appUrl();
  for (const c of cards) await sendHtml(chatId, cardHtml(c, header(c)), inline(workerButtons(c.status, c.id, app)));
}

/** Скачать файл из Telegram (голосовое клиента). */
async function download(fileId: string): Promise<Blob | null> {
  const token = env("TELEGRAM_BOT_TOKEN");
  const f = await tg("getFile", { file_id: fileId });
  const path = (f?.result as { file_path?: string } | undefined)?.file_path;
  if (!token || !path) return null;
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
  return res.ok ? await res.blob() : null;
}

async function clientMessage(ctx: ActionCtx, chatId: string, msg: TgMessage) {
  let text = (msg.text ?? msg.caption ?? "").trim();
  if (msg.voice || msg.audio) {
    if (!canTranscribe()) {
      await sendHtml(chatId, "Голосовые пока не разбираю — напишите, пожалуйста, текстом 🙏");
      return;
    }
    const blob = await download((msg.voice ?? msg.audio)!.file_id);
    try {
      text = blob ? (await transcribe(blob)).text : "";
    } catch (e) {
      console.warn(`telegram: голосовое не расшифровано: ${e instanceof Error ? e.message : "ошибка"}`);
      text = "";
    }
    if (!text) {
      await sendHtml(chatId, "Не получилось разобрать голосовое — напишите, пожалуйста, текстом.");
      return;
    }
  }
  if (msg.photo && !text) text = "[клиент отправил фото]";
  if (!text) return;

  const st = await ctx.runQuery(internal.bot._state, { chatId });
  if (st.openLead && st.state === "idle") {
    await ctx.runMutation(internal.bot._toOpenLead, { chatId, leadId: st.openLead.id, text });
    await sendHtml(chatId, `Передали оператору по заявке №${st.openLead.number} ✅`);
    return;
  }
  await ctx.runMutation(internal.bot._addDraft, { chatId, text, name: fullName(msg.from) });
  await sendHtml(chatId, msg.voice ? `Записал: «${esc(text.slice(0, 300))}»\n\nОстался номер телефона — нажмите кнопку ниже 👇` : "Принято! Чтобы оператор перезвонил, поделитесь номером — кнопка ниже 👇", {
    keyboard: [[{ text: "📱 Отправить мой номер", request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  });
}

async function clientContact(ctx: ActionCtx, chatId: string, msg: TgMessage) {
  const st = await ctx.runQuery(internal.bot._state, { chatId });
  let parsed: { ai?: ReturnType<typeof toSummary>["ai"]; draft?: ReturnType<typeof toSummary>["draft"] } = {};
  if (st.draft && canExtract()) {
    try {
      const hint: CatalogHint = await ctx.runQuery(internal.catalog._hint, {});
      const x = await extract(st.draft, hint, "message");
      parsed = toSummary(x, (id) => hint.services.find((s) => s.id === id)?.label ?? id);
    } catch {
      /* без AI — заявка всё равно создаётся с текстом клиента */
    }
  }
  const name = parsed.draft?.clientName ?? fullName(msg.contact) ?? fullName(msg.from);
  const res = await ctx.runMutation(internal.bot._createLead, {
    chatId,
    phone: msg.contact!.phone_number,
    name,
    ai: parsed.ai,
    serviceId: parsed.draft?.serviceId,
    city: parsed.draft?.city,
    address: parsed.draft?.address,
    urgency: parsed.draft?.urgency,
    description: parsed.draft?.description,
  });
  if (!res) {
    await sendHtml(chatId, "Не получилось принять номер — пришлите, пожалуйста, ещё раз или напишите его текстом.", { remove_keyboard: true });
    return;
  }
  await sendHtml(
    chatId,
    `Спасибо${name ? `, ${esc(name.split(" ")[0]!)}` : ""}! Заявка <b>№${res.number}</b> принята 🙌\nОператор свяжется с вами в ближайшее время. Если вспомните детали — просто напишите сюда.`,
    { remove_keyboard: true },
  );
}

async function callback(ctx: ActionCtx, cb: NonNullable<TgUpdate["callback_query"]>) {
  const chatId = String(cb.message?.chat.id ?? cb.from.id);
  const data = cb.data ?? "";
  let res: { ok: true; card: CardData } | { ok: false; error: string } | null = null;
  let header = "";
  if (data.startsWith("take:")) {
    res = await ctx.runMutation(internal.worker.takeFromTelegram, { chatId, orderId: data.slice(5) });
    header = "✅ Заказ ваш";
  } else if (data.startsWith("act:")) {
    const [, action, orderId] = data.split(":");
    if (action && orderId && ["accept", "decline", "start", "wait", "resume", "done"].includes(action)) {
      res = await ctx.runMutation(internal.worker.actFromTelegram, { chatId, orderId, action: action as "accept" });
      header = { accept: "✅ Заказ подтверждён", decline: "Вы отказались — заказ вернулся в ленту", start: "▶️ В работе", wait: "⏸ Ждём клиента", resume: "▶️ Снова в работе", done: "✅ Работа сдана — спасибо!" }[action]!;
    }
  }
  if (!res) {
    await tg("answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }
  if (!res.ok) {
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: res.error, show_alert: true });
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: cb.id, text: header });
  if (cb.message) {
    const isDeclined = res.card.status === "awaiting_executor";
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: cardHtml(res.card, `${header} · №${res.card.number}`),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: isDeclined ? { inline_keyboard: [] } : (inline(workerButtons(res.card.status, res.card.id, appUrl())) ?? { inline_keyboard: [] }),
    });
  }
}

/** Входящее обновление от Telegram (вызывается из http.ts после проверки секрета). */
export const handleUpdate = internalAction({
  args: { update: v.any() },
  handler: async (ctx, { update }) => {
    const u = update as TgUpdate;
    if (u.callback_query) return void (await callback(ctx, u.callback_query));
    const msg = u.message;
    if (!msg || msg.chat.type && msg.chat.type !== "private") return;
    const chatId = String(msg.chat.id);
    const text = (msg.text ?? "").trim();

    // Привязка аккаунта сотрудника/мастера по одноразовой ссылке из кабинета.
    const m = /^\/start\s+([0-9a-f]{24})$/.exec(text);
    if (m) {
      const linked = await ctx.runMutation(internal.telegram.linkChat, { code: m[1]!, chatId });
      if (!linked) return void (await sendHtml(chatId, `Ссылка устарела. Откройте ${APP_NAME} → меню профиля → «Подключить Telegram» ещё раз.`));
      const first = linked.name.split(" ")[0];
      await sendHtml(chatId, `Готово${first ? `, ${esc(first)}` : ""}! 🎉 Telegram подключён к ${APP_NAME}.\n\n${esc(linked.role === "executor" ? HELP_EXECUTOR : HELP_STAFF)}`);
      return;
    }

    const who = await linkedUser(ctx, chatId);
    if (who.role) {
      // Сотрудник или мастер.
      if (text === "/feed" || text === "/orders") {
        if (who.role !== "executor") {
          const snap = await ctx.runQuery(internal.digest._staffSnapshot, { chatId });
          const app = appUrl();
          return void (await sendHtml(chatId, snap ?? HELP_STAFF, app ? inline([[{ text: "Открыть кабинет", url: app }]]) : undefined));
        }
        const r = await ctx.runQuery(internal.worker._forChat, { chatId, what: text === "/feed" ? "feed" : "orders" });
        if (text === "/feed" && r.available === false) return void (await sendHtml(chatId, "Вы на выходном — новые заказы не приходят. Включите приём заказов в кабинете, и лента откроется."));
        if (!r.cards.length) return void (await sendHtml(chatId, text === "/feed" ? "Свободных заказов по вашей специализации сейчас нет. Пришлю, как только появятся 👌" : "Активных заказов нет. Свободные — /feed"));
        await sendHtml(chatId, text === "/feed" ? `<b>Свободные заказы: ${r.cards.length}</b>` : `<b>Ваши заказы: ${r.cards.length}</b>`);
        await sendCards(chatId, r.cards, (c) => (text === "/feed" ? `🆕 Заказ №${c.number}` : `Заказ №${c.number}`));
        return;
      }
      return void (await sendHtml(chatId, esc(who.role === "executor" ? HELP_EXECUTOR : HELP_STAFF)));
    }

    // Клиент.
    if (msg.contact) return void (await clientContact(ctx, chatId, msg));
    if (text === "/start" || text === "/help" || text.startsWith("/")) return void (await sendHtml(chatId, esc(HELP_CLIENT), { remove_keyboard: true }));
    await clientMessage(ctx, chatId, msg);
  },
});

/** Владелец переподключает вебхук (после смены токена). */
export const setupWebhook = action({
  args: {},
  handler: async (ctx): Promise<string> => {
    if ((await ctx.runQuery(internal.users._viewerRole, {})) !== "owner") throw new ConvexError("Нет доступа");
    const site = env("CONVEX_SITE_URL");
    const secret = env("TELEGRAM_WEBHOOK_SECRET");
    if (!site || !secret || !env("TELEGRAM_BOT_TOKEN")) throw new ConvexError("Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_WEBHOOK_SECRET");
    const res = await tg("setWebhook", { url: `${site}/telegram`, secret_token: secret, allowed_updates: ["message", "callback_query"] });
    if (!res?.ok) throw new ConvexError(`Telegram: ${res?.description ?? "нет ответа"}`);
    return "ok";
  },
});
