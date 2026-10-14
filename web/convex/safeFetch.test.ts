/// <reference types="vite/client" />
// Защита от SSRF при скачивании записи звонка по ссылке от АТС (аудит M-3): проверка адреса, перенаправления,
// потолок размера и таймаут — и то же самое в фоновом разборе звонка (ai.processCall).
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { checkPublicUrl, fetchPublicFile, isPublicHost, parseIpv4 } from "./lib/safeFetch";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const MB = 1024 * 1024;
const LIMITS = { maxBytes: 50 * MB, timeoutMs: 5_000 };
const AUDIO = () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/mpeg" } });
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

/** Ошибка из fetchPublicFile — текст ConvexError. */
async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error && "data" in e ? String((e as Error & { data: unknown }).data) : String(e);
  }
  throw new Error("ожидалась ошибка");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("адрес записи: только публичный https", () => {
  test.each([
    "localhost",
    "foo.localhost",
    "metadata.google.internal",
    "intranet",
    "127.0.0.1.nip.io",
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.10",
    "100.64.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    // Числовые записи IPv4, если рантайм не привёл их к обычному виду.
    "2130706433",
    "0x7f.1",
    "0x7f000001",
    "0177.0.0.1",
    "127.1",
    "0xa9.0xfe.0xa9.0xfe",
    // Похожие на адрес, но записанные с ошибкой — тоже отказ.
    "08.1.1.1",
    "999.1.1.1",
    "1.2.3.4.5",
    "[::1]",
    "[::]",
    "[fc00::1]",
    "[fd00:ec2::254]",
    "[fe80::1]",
    "[::ffff:127.0.0.1]",
    "[::ffff:7f00:1]",
    "[::ffff:0:7f00:1]",
    "[::ffff:a9fe:a9fe]",
    "[64:ff9b::a9fe:a9fe]",
    "[2002:a9fe:a9fe::1]",
    "[ff02::1]",
  ])("внутренний хост %s — отказ", (host) => {
    expect(isPublicHost(host)).toBe(false);
  });

  test.each(["records.example.com", "8.8.8.8", "93.184.216.34", "[2a00:1450:4001::1]", "[2001:4860:4860::8888]"])("публичный хост %s — можно", (host) => {
    expect(isPublicHost(host)).toBe(true);
  });

  test("IPv4 в записи inet_aton разбирается в обычный адрес", () => {
    expect(parseIpv4("2130706433")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("0x7f.1")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("0177.0.0.01")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("records.example.com")).toBeNull();
    // Кончается числом — это адрес, а не имя; «08» — неверная восьмеричная запись.
    expect(parseIpv4("1.2.3.08")).toBe("invalid");
    expect(parseIpv4("1.2.3.0x1g")).toBeNull();
  });

  test("ссылка: протокол, порт, логин и числовые адреса", () => {
    expect(checkPublicUrl("https://records.example.com/rec/1.mp3").ok).toBe(true);
    expect(checkPublicUrl("https://records.example.com:443/rec/1.mp3").ok).toBe(true);
    const reason = (u: string) => {
      const r = checkPublicUrl(u);
      return r.ok ? "ok" : r.reason;
    };
    expect(reason("http://records.example.com/1.mp3")).toBe("нужна ссылка https://");
    expect(reason("ftp://records.example.com/1.mp3")).toBe("нужна ссылка https://");
    expect(reason("https://records.example.com:8443/1.mp3")).toBe("нестандартный порт в ссылке");
    expect(reason("https://user:pass@records.example.com/1.mp3")).toBe("логин и пароль в ссылке не допускаются");
    expect(reason("не ссылка")).toBe("неверная ссылка");
    for (const u of ["https://2130706433/", "https://0x7f.0.0.1/", "https://[::ffff:169.254.169.254]/", "https://LOCALHOST./x", "https://169.254.169.254/latest/meta-data/"]) {
      expect(reason(u)).toContain("внутренней сети");
    }
  });
});

describe("скачивание файла", () => {
  test("внутренний адрес — запроса нет вовсе", async () => {
    const fetchMock = vi.fn(async () => AUDIO());
    vi.stubGlobal("fetch", fetchMock);
    expect(await failure(fetchPublicFile("https://169.254.169.254/latest/meta-data/", LIMITS))).toContain("внутренней сети");
    expect(await failure(fetchPublicFile("http://records.example.com/1.mp3", LIMITS))).toBe("нужна ссылка https://");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("перенаправление во внутреннюю сеть — отказ, туда не ходим", async () => {
    const fetchMock = vi.fn(async (url: string) => (url.startsWith("https://records.example.com/") ? redirect("https://169.254.169.254/latest/meta-data/") : AUDIO()));
    vi.stubGlobal("fetch", fetchMock);
    expect(await failure(fetchPublicFile("https://records.example.com/1.mp3", LIMITS))).toBe("перенаправление: адрес во внутренней сети — скачивание запрещено");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe("manual");
  });

  test("перенаправление на http и на чужой порт — отказ", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => redirect("http://cdn.example.com/1.mp3")),
    );
    expect(await failure(fetchPublicFile("https://records.example.com/1.mp3", LIMITS))).toBe("перенаправление: нужна ссылка https://");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => redirect("https://cdn.example.com:8080/1.mp3", 307)),
    );
    expect(await failure(fetchPublicFile("https://records.example.com/1.mp3", LIMITS))).toBe("перенаправление: нестандартный порт в ссылке");
  });

  test("до трёх перенаправлений по публичным адресам — файл скачан; четвёртое — отказ", async () => {
    const hops = (n: number) =>
      vi.fn(async (url: string) => {
        const i = Number(new URL(url).searchParams.get("hop") ?? "0");
        // Относительный адрес перенаправления разбирается от текущего.
        return i < n ? redirect(`/next.mp3?hop=${i + 1}`) : AUDIO();
      });
    const three = hops(3);
    vi.stubGlobal("fetch", three);
    const blob = await fetchPublicFile("https://records.example.com/1.mp3", LIMITS);
    expect(blob.size).toBe(4);
    expect(three).toHaveBeenCalledTimes(4);
    expect(three.mock.calls[3]![0]).toBe("https://records.example.com/next.mp3?hop=3");

    const four = hops(4);
    vi.stubGlobal("fetch", four);
    expect(await failure(fetchPublicFile("https://records.example.com/1.mp3", LIMITS))).toBe("слишком много перенаправлений");
    expect(four).toHaveBeenCalledTimes(4);
  });

  test("рантайм сам прошёл перенаправление во внутреннюю сеть — ответ не берём", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const res = AUDIO();
        Object.defineProperty(res, "redirected", { value: true });
        Object.defineProperty(res, "url", { value: "https://10.0.0.5/secret" });
        return res;
      }),
    );
    expect(await failure(fetchPublicFile("https://records.example.com/1.mp3", LIMITS))).toBe("перенаправление: адрес во внутренней сети — скачивание запрещено");
  });

  test("больше 50 МБ по заголовку — отказ без чтения тела", async () => {
    // Тело, которое никогда не придёт: если бы его начали читать, сработал бы таймаут, а не отказ по размеру.
    const body = new ReadableStream<Uint8Array>({ start: () => undefined });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "audio/mpeg", "content-length": String(60 * MB) } })),
    );
    expect(await failure(fetchPublicFile("https://records.example.com/1.mp3", LIMITS))).toBe("файл больше 50 МБ");
  });

  test("больше потолка по факту (без Content-Length) — чтение обрывается", async () => {
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: (ctrl) => {
        sent++;
        ctrl.enqueue(new Uint8Array(400));
        if (sent > 100) ctrl.close();
      },
      cancel: () => {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "audio/mpeg" } })),
    );
    expect(await failure(fetchPublicFile("https://records.example.com/1.mp3", { maxBytes: 1000, timeoutMs: 5_000 }))).toBe("файл больше 1 КБ");
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(10);
  });

  test("ошибка HTTP, пустой ответ и таймаут — понятная причина", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("нет", { status: 404 })),
    );
    expect(await failure(fetchPublicFile("https://records.example.com/1.mp3", LIMITS))).toBe("HTTP 404");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(0), { status: 200 })),
    );
    expect(await failure(fetchPublicFile("https://records.example.com/1.mp3", LIMITS))).toBe("пустой ответ");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      ),
    );
    expect(await failure(fetchPublicFile("https://records.example.com/1.mp3", { maxBytes: MB, timeoutMs: 30 }))).toBe("сервер не ответил вовремя");
  });
});

describe("разбор звонка: запись по ссылке от АТС", () => {
  const T = "t-komfort";
  let fetched: string[] = [];

  beforeEach(() => {
    fetched = [];
    vi.stubEnv("AI_URL", "https://ai.test");
    vi.stubEnv("AI_SECRET", "secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
        if (url.startsWith("https://ai.test/v1/transcribe")) return Response.json({ text: "Не холодит кондиционер", language: "ru", seconds: 30 });
        if (url.startsWith("https://ai.test/v1/extract"))
          return Response.json({ summary: "Не холодит кондиционер", serviceId: "ac-repair", city: "Алматы", address: null, when: null, budget: null, urgency: "normal", clientName: null, questions: [] });
        if (url === "https://records.example.com/page.html") return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
        if (url.startsWith("https://records.example.com/")) return AUDIO();
        return new Response("внутренний сервис", { status: 200 });
      }),
    );
  });

  async function callWith(recordingUrl: string) {
    const t = convexTest(schema, modules);
    const id: Id<"calls"> = await t.run((ctx) =>
      ctx.db.insert("calls", { tenantId: T, direction: "in", from: "77015550000", to: "77270000000", status: "completed", startedAt: new Date().toISOString(), recordingUrl, aiStatus: "pending" }),
    );
    await t.action(internal.ai.processCall, { callId: id, autoLead: false });
    const call = (await t.run((ctx) => ctx.db.get(id)))!;
    const ai = await t.run((ctx) => ctx.db.query("systemStatus").withIndex("by_key", (q) => q.eq("key", "ai")).unique());
    return { call, ai };
  }

  test("ссылка на метаданные облака — запись не скачана, запроса туда нет", async () => {
    const { call } = await callWith("https://169.254.169.254/latest/meta-data/");
    expect(call.aiStatus).toBe("failed");
    expect(call.aiError).toBe("Запись не скачана: адрес во внутренней сети — скачивание запрещено");
    expect(call.recordingId).toBeUndefined();
    expect(fetched).toEqual([]);
  });

  test("ссылка http:// — запись не скачана", async () => {
    const { call } = await callWith("http://records.example.com/1.mp3");
    expect(call.aiError).toBe("Запись не скачана: нужна ссылка https://");
    expect(fetched).toEqual([]);
  });

  test("страница вместо аудио — отказ", async () => {
    const { call } = await callWith("https://records.example.com/page.html");
    expect(call.aiError).toBe("Запись не скачана: по ссылке не аудиофайл");
    expect(call.recordingId).toBeUndefined();
  });

  test("публичная https-ссылка — запись в хранилище, расшифровка и отметка «AI работает»", async () => {
    const { call, ai } = await callWith("https://records.example.com/rec/1.mp3");
    expect(call.aiStatus).toBe("done");
    expect(call.recordingId).toBeDefined();
    expect(call.transcript).toBe("Не холодит кондиционер");
    expect(ai?.okAt).toBeDefined();
    expect(ai?.okNote).toBe("Звонок разобран");
  });
});
