// Тексты сообщений единого чата: подписи вложений и «есть ли в сообщении суть обращения».
// Отдельный модуль без зависимостей — его используют и каналы (telegram.ts), и сам чат (inbox.ts).

/** Подписи вложений без текста. В черновик заявки и AI не попадают. */
export const PLACEHOLDER = {
  image: "Фото",
  video: "Видео",
  file: "Файл",
  voice: "Голосовое сообщение",
  voiceFailed: "Голосовое сообщение — не удалось расшифровать",
  location: "Геопозиция",
  attachment: "Вложение",
} as const;

const PLACEHOLDERS = new Set<string>(Object.values(PLACEHOLDER));

/** Почему нельзя ответить в канал — общие тексты для сервера (lib/outbound.ts) и интерфейса. */
export const REPLY_BLOCK = {
  notConnected: "Канал не подключён",
  callClient: "Ответьте клиенту по телефону",
  windowClosed: "Прошло 24 часа — WhatsApp разрешает писать только шаблоном. Позвоните клиенту или дождитесь его сообщения.",
} as const;

/** WhatsApp: свободный текст — только в течение 24 часов после последнего сообщения клиента. Клиент ещё не писал — окна нет. */
export const whatsappWindowClosed = (replyUntil: string | undefined, now: number): boolean => !replyUntil || Date.parse(replyUntil) <= now;

/** Подпись вложения или стикер — не текст клиента. */
export const isPlaceholder = (text: string): boolean => PLACEHOLDERS.has(text) || /^Стикер(\s\S{1,8})?$/u.test(text);

const SMALL_TALK = new Set(
  (
    "привет приветствую здравствуйте здравствуй здрасте добрый доброе доброго день утро вечер салем сәлем салам ассаламуалейкум " +
    "спасибо большое огромное рахмет хорошо ок окей ok да нет ага угу понял поняла понятно ясно жду ждём ждем давайте договорились " +
    "отлично супер hi hello thanks thank you и а мне вам вас тоже"
  ).split(" "),
);

/** Есть ли в сообщении суть обращения — а не «Здравствуйте», «Спасибо», «Ок» или вложение без подписи. */
export function isMeaningful(text: string): boolean {
  if (isPlaceholder(text)) return false;
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => /\p{L}/u.test(w));
  const letters = words.join("").replace(/[^\p{L}]/gu, "").length;
  if (words.length < 2 || letters < 8) return false;
  return words.some((w) => !SMALL_TALK.has(w));
}
