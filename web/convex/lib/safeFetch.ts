// Скачивание файла по внешней ссылке (запись звонка от АТС) без SSRF — аудит M-3.
// Сервер ходит только на публичные https-адреса со стандартным портом: никаких localhost, частных сетей,
// link-local и метаданных облака. Перенаправления — не больше трёх, и каждое проверяется заново;
// размер — с потолком (заголовок Content-Length и фактический счёт байт), время — с таймаутом.
// Ограничение: имя хоста, которое DNS разрешает во внутренний адрес, проверкой ссылки не ловится —
// от этого защищает только сеть рантайма; известные сервисы «имя → любой IP» отсекаем по списку.
import { ConvexError } from "convex/values";

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

const INTERNAL = "адрес во внутренней сети — скачивание запрещено";

/** Служебные имена: сам хост, метаданные облаков. Однословные имена («metadata», «intranet») — тоже внутренние. */
const INTERNAL_HOSTS = new Set(["localhost", "metadata.google.internal", "instance-data", "metadata"]);
const INTERNAL_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".intranet", ".home.arpa", ".lan", ".corp"];
/** Публичные DNS-сервисы, которые отдают любой IP по имени (127.0.0.1.nip.io → 127.0.0.1). */
const WILDCARD_DNS = ["nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me", "vcap.me", "traefik.me", "localhost.direct"];

/** Часть IPv4 в записи inet_aton: десятичная, 0x… (шестнадцатеричная) или 0… (восьмеричная). */
function v4Part(p: string): number | null {
  if (/^0x[0-9a-f]*$/i.test(p)) return p.length === 2 ? 0 : parseInt(p.slice(2), 16);
  if (/^0[0-7]+$/.test(p)) return parseInt(p.slice(1), 8);
  if (/^(0|[1-9]\d*)$/.test(p)) return Number(p);
  return null;
}

/**
 * IPv4 в любой записи: «127.0.0.1», «2130706433», «0x7f.1», «0177.0.0.1», «127.1».
 * По правилам URL хост, который кончается числом, — это IPv4 (или ошибка), а не имя.
 * null — хост не адрес; "invalid" — похож на адрес, но записан с ошибкой.
 */
export function parseIpv4(host: string): number[] | null | "invalid" {
  const labels = host.split(".");
  if (!/^(0x[0-9a-f]*|\d+)$/i.test(labels[labels.length - 1] ?? "")) return null;
  if (labels.length > 4) return "invalid";
  const nums = labels.map(v4Part);
  if (nums.some((n) => n === null || !Number.isFinite(n))) return "invalid";
  const parts = nums as number[];
  const last = parts[parts.length - 1]!;
  const head = parts.slice(0, -1);
  // Последнее число занимает все оставшиеся байты: «127.1» = 127.0.0.1, «2130706433» = 127.0.0.1.
  if (head.some((n) => n > 255) || last >= 256 ** (5 - parts.length)) return "invalid";
  const value = head.reduce((acc, n, i) => acc + n * 256 ** (3 - i), 0) + last;
  return [Math.floor(value / 16_777_216) % 256, Math.floor(value / 65_536) % 256, Math.floor(value / 256) % 256, value % 256];
}

/** Публичный ли IPv4: без «этой» сети, частных, loopback, CGNAT, link-local (метаданные 169.254.169.254), тестовых и multicast. */
function publicV4([a = 0, b = 0, c = 0]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // служебные IETF, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // ретранслятор 6to4
  if (a === 198 && (b === 18 || b === 19)) return false; // стенды 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return a < 224; // multicast, резерв и широковещательный
}

/** IPv6 из URL («[::1]») → 8 групп по 16 бит; поддерживает «::» и IPv4 в хвосте. */
function ipv6(host: string): number[] | null {
  if (!host.startsWith("[") || !host.endsWith("]")) return null;
  let s = host.slice(1, -1).toLowerCase();
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const v4 = parseIpv4(tail[1]!);
    if (!Array.isArray(v4)) return null;
    s = `${s.slice(0, -tail[1]!.length)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

const embeddedV4 = (h: number[], i: number): number[] => [h[i]! >> 8, h[i]! & 255, h[i + 1]! >> 8, h[i + 1]! & 255];

/** Публичный ли IPv6: без loopback, ULA, link/site-local, multicast, документации; вложенный IPv4 проверяется как IPv4. */
function publicV6(h: number[]): boolean {
  const [a = 0, b = 0] = h;
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return false; // ::
  if (zeros(0, 7) && h[7] === 1) return false; // ::1
  if (zeros(0, 5) && (h[5] === 0xffff || h[5] === 0)) return publicV4(embeddedV4(h, 6)); // ::ffff:a.b.c.d, ::a.b.c.d
  if (a === 0x64 && b === 0xff9b) return publicV4(embeddedV4(h, 6)); // NAT64
  if (a < 0x0100) return false; // остальной ::/8 — резерв IETF (в т.ч. ::ffff:0:a.b.c.d)
  if (a === 0x2002) return publicV4(embeddedV4(h, 1)); // 6to4
  if (a === 0x2001 && (b === 0 || b === 0x0db8)) return false; // Teredo (IPv4 внутри скрыт), документация
  if (a === 0x0100 && zeros(1, 4)) return false; // discard-префикс
  if ((a & 0xfe00) === 0xfc00) return false; // ULA fc00::/7 (метаданные AWS fd00:ec2::254)
  if ((a & 0xffc0) === 0xfe80 || (a & 0xffc0) === 0xfec0) return false; // link-local, site-local
  return (a & 0xff00) !== 0xff00; // multicast
}

function internalName(host: string): boolean {
  if (!host.includes(".") || INTERNAL_HOSTS.has(host)) return true;
  if (INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return true;
  return WILDCARD_DNS.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Хост из ссылки (как его отдаёт URL.hostname): публичное имя или публичный IP.
 * IPv4 в десятичной, восьмеричной и шестнадцатеричной записи разбираем сами — не полагаемся на то,
 * что URL рантайма приведёт его к обычному виду.
 */
export function isPublicHost(raw: string): boolean {
  const host = raw.toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (host.startsWith("[")) {
    const v6 = ipv6(host);
    return !!v6 && publicV6(v6);
  }
  const v4 = parseIpv4(host);
  if (v4 === "invalid") return false;
  if (v4) return publicV4(v4);
  return !internalName(host);
}

/** Можно ли серверу скачать файл по ссылке: https, без логина в адресе, порт 443, публичный хост. */
export function checkPublicUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "неверная ссылка" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "нужна ссылка https://" };
  if (url.username || url.password) return { ok: false, reason: "логин и пароль в ссылке не допускаются" };
  if (url.port && url.port !== "443") return { ok: false, reason: "нестандартный порт в ссылке" };
  if (!url.hostname) return { ok: false, reason: "неверная ссылка" };
  return isPublicHost(url.hostname) ? { ok: true, url } : { ok: false, reason: INTERNAL };
}

export interface FetchLimits {
  maxBytes: number;
  timeoutMs: number;
  /** Сколько перенаправлений пройти (каждое — с проверкой адреса). По умолчанию 3. */
  maxRedirects?: number;
}

const MB = 1024 * 1024;
const tooBig = (max: number) => new ConvexError(`файл больше ${max >= MB ? `${Math.round(max / MB)} МБ` : `${Math.ceil(max / 1024)} КБ`}`);

/**
 * Умеет ли рантайм отдавать перенаправление нам (redirect: "manual"), а не проходить его сам.
 * Если нет — рантайм пройдёт перенаправления сам, а мы проверим, куда в итоге пришли (res.url).
 */
function manualRedirects(): boolean {
  try {
    return new Request("https://example.com/", { redirect: "manual" }).redirect === "manual";
  } catch {
    return false;
  }
}

/** Тело ответа с потолком размера: считаем байты по мере чтения и обрываем, не дочитывая лишнего. */
async function readLimited(res: Response, max: number): Promise<Blob> {
  const type = res.headers.get("content-type") ?? "";
  if (!res.body) return new Blob([], { type });
  const reader = res.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw tooBig(max);
    }
    chunks.push(value);
  }
  return new Blob(chunks, { type });
}

/**
 * Скачать файл по внешней ссылке с защитой от SSRF. Ошибка — ConvexError с причиной по-русски
 * («адрес во внутренней сети…», «файл больше 50 МБ», «HTTP 404»); саму ссылку в тексты и логи не кладём —
 * в ссылках АТС бывают токены.
 */
export async function fetchPublicFile(raw: string, limits: FetchLimits): Promise<Blob> {
  const maxRedirects = limits.maxRedirects ?? 3;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), limits.timeoutMs);
  const init: RequestInit = manualRedirects() ? { redirect: "manual", signal: ctrl.signal } : { signal: ctrl.signal };
  try {
    let target = raw;
    for (let hop = 0; ; hop++) {
      const check = checkPublicUrl(target);
      if (!check.ok) throw new ConvexError(hop ? `перенаправление: ${check.reason}` : check.reason);
      const res = await fetch(check.url.toString(), init);
      if (res.type === "opaqueredirect") throw new ConvexError("перенаправление, которое нельзя проверить");
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!location) throw new ConvexError(`HTTP ${res.status} без адреса перенаправления`);
        if (hop >= maxRedirects) throw new ConvexError("слишком много перенаправлений");
        try {
          target = new URL(location, check.url).toString();
        } catch {
          throw new ConvexError("неверный адрес перенаправления");
        }
        continue;
      }
      // Рантайм, который всё же прошёл по перенаправлениям сам, — проверяем, куда в итоге пришли.
      if (res.redirected && res.url && !checkPublicUrl(res.url).ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new ConvexError(`перенаправление: ${INTERNAL}`);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new ConvexError(`HTTP ${res.status}`);
      }
      const declared = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > limits.maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw tooBig(limits.maxBytes);
      }
      const blob = await readLimited(res, limits.maxBytes);
      if (!blob.size) throw new ConvexError("пустой ответ");
      return blob;
    }
  } catch (e) {
    if (e instanceof ConvexError) throw e;
    throw new ConvexError(ctrl.signal.aborted ? "сервер не ответил вовремя" : "сервер недоступен");
  } finally {
    clearTimeout(timer);
    // Ошибка посреди чтения — соединение больше не нужно.
    ctrl.abort();
  }
}
