/// <reference types="vite/client" />
// Внешнее хранилище копий (ТЗ п.20.10, п.26.5): подпись SigV4 на официальных векторах AWS, выгрузка копии в S3,
// 30 последних, опись файлов в копии, инкрементальное копирование файлов по настройке владельца, «не подключено».
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { KEEP_OFFSITE } from "./offsite";
import { signingKey, signV4, sha256Hex } from "./lib/sigv4";
import { parseEndpoint } from "./lib/s3";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("SigV4 — официальные тест-векторы AWS", () => {
  test("ключ подписи из документации AWS (iam, 20120215)", async () => {
    expect(hex(await signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam"))).toBe("f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
  });
  test("aws-sig-v4-test-suite: get-vanilla", async () => {
    const s = await signV4(
      { method: "GET", url: new URL("https://example.amazonaws.com/"), headers: {}, payloadHash: await sha256Hex("") },
      { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "service" },
      new Date("2015-08-30T12:36:00Z"),
    );
    expect(s.headers.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
    expect(s.headers["x-amz-date"]).toBe("20150830T123600Z");
  });
  const s3 = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "s3" };
  test("S3: GET Object (пример из документации S3)", async () => {
    const s = await signV4({ method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), headers: { Range: "bytes=0-9", "x-amz-content-sha256": EMPTY }, payloadHash: EMPTY }, s3, new Date("2013-05-24T00:00:00Z"));
    expect(s.signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });
  test("S3: GET Bucket с параметрами (ListObjects из документации S3)", async () => {
    const s = await signV4({ method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J"), headers: { "x-amz-content-sha256": EMPTY }, payloadHash: EMPTY }, s3, new Date("2013-05-24T00:00:00Z"));
    expect(s.signature).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });
  test("адрес хранилища — только https без пути и логина", () => {
    expect(parseEndpoint("https://abc.r2.cloudflarestorage.com/")?.host).toBe("abc.r2.cloudflarestorage.com");
    expect(parseEndpoint("http://abc.r2.cloudflarestorage.com")).toBeNull();
    expect(parseEndpoint("https://user:pw@s3.test")).toBeNull();
    expect(parseEndpoint("https://s3.test/bucket")).toBeNull();
  });
});

// ── Хранилище-заглушка: PUT / DELETE / ListObjectsV2 по path-style адресам ────

const T = "t-test";
const at = new Date().toISOString();
type Req = { method: string; url: URL; headers: Headers };
let bucket: Map<string, number>;
let requests: Req[];
let failPut: number | null;

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function stubS3() {
  bucket = new Map();
  requests = [];
  failPut = null;
  vi.stubEnv("BACKUP_S3_ENDPOINT", "https://s3.test");
  vi.stubEnv("BACKUP_S3_BUCKET", "hms-backups");
  vi.stubEnv("BACKUP_S3_ACCESS_KEY_ID", "AKIDTEST");
  vi.stubEnv("BACKUP_S3_SECRET_ACCESS_KEY", "secret-key-TEST");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({ method, url, headers: new Headers(init?.headers) });
      if (url.host !== "s3.test" || !url.pathname.startsWith("/hms-backups")) return new Response("нет", { status: 404 });
      const key = decodeURIComponent(url.pathname.slice("/hms-backups/".length));
      if (method === "PUT") {
        if (failPut) return new Response("<Error><Code>AccessDenied</Code><Message>key AKIDTEST denied</Message></Error>", { status: failPut });
        const body = init?.body;
        bucket.set(key, body instanceof Blob ? body.size : 0);
        return new Response("", { status: 200 });
      }
      if (method === "DELETE") {
        bucket.delete(key);
        return new Response(null, { status: 204 });
      }
      const prefix = url.searchParams.get("prefix") ?? "";
      const items = [...bucket].filter(([k]) => k.startsWith(prefix));
      const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${items.map(([k, size]) => `<Contents><Key>${xmlEsc(k)}</Key><Size>${size}</Size></Contents>`).join("")}</ListBucketResult>`;
      return new Response(xml, { status: 200, headers: { "Content-Type": "application/xml" } });
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Айгуль", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 1, activeCount: 0, lastActivityAt: at });
    const photo = await ctx.storage.store(new Blob(["jpeg-bytes"], { type: "image/jpeg" }));
    const gone = await ctx.storage.store(new Blob(["x"], { type: "image/jpeg" }));
    await ctx.storage.delete(gone);
    const recording = await ctx.storage.store(new Blob(["mp3-bytes-long"], { type: "audio/mpeg" }));
    await ctx.db.insert("orders", {
      tenantId: T,
      number: 1001,
      clientId: client,
      clientName: "Айгуль",
      clientPhone: "77071234567",
      source: "olx",
      serviceId: "ac-repair",
      category: "ac",
      description: "Не холодит",
      city: "Алматы",
      address: "ул. Абая, 1",
      deadline: at,
      priority: "normal",
      status: "done",
      clientPrice: 30000,
      payoutMode: "fixed",
      payoutValue: 21000,
      payments: [],
      payoutPaid: false,
      createdAt: at,
      createdBy: owner,
      files: [
        { id: "f1", name: "фото.jpg", kind: "image", storageId: photo },
        { id: "f2", name: "старое.jpg", kind: "image", storageId: gone },
      ],
    });
    const call = await ctx.db.insert("calls", { tenantId: T, direction: "in", from: "77071234567", to: "77273450000", status: "completed", startedAt: at, recordingId: recording });
    return { owner, operator, photo, gone, recording, call };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  return { t, ids, as };
}

type Snapshot = { version: number; files: { storageId: string; table: string; about: string; size?: number; missing?: true }[] };

async function latest(t: Awaited<ReturnType<typeof setup>>["t"]) {
  return t.run(async (ctx) => {
    const row = (await ctx.db.query("backups").withIndex("by_at").order("desc").first())!;
    return { row, json: JSON.parse(await (await ctx.storage.get(row.fileId))!.text()) as Snapshot };
  });
}

describe("опись файлов в копии", () => {
  test("каждый файл — с размером и тем, к чему относится; удалённый помечен", async () => {
    const { t, ids } = await setup();
    await t.action(internal.backup.run, {});
    const { json } = await latest(t);
    expect(json.version).toBe(2);
    const photo = json.files.find((f) => f.storageId === ids.photo);
    expect(photo).toMatchObject({ table: "orders", about: "Файл заказа №1001: фото.jpg", size: 10 });
    expect(json.files.find((f) => f.storageId === ids.recording)).toMatchObject({ table: "calls", docId: ids.call, about: "Запись звонка", size: 14 });
    expect(json.files.find((f) => f.storageId === ids.gone)).toMatchObject({ missing: true });
  });
});

describe("внешнее хранилище", () => {
  test("без переменных — копия не уходит, карточка «не подключено» с именами переменных", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { t, ids, as } = await setup();
    await t.action(internal.backup.run, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchSpy).not.toHaveBeenCalled();
    const s = await as(ids.owner).query(api.offsite.status, {});
    expect(s.configured).toBe(false);
    expect(s.missing).toEqual(["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY"]);
    const o = await as(ids.owner).query(api.health.overview, {});
    expect(o.subsystems.find((x) => x.key === "offsite")).toMatchObject({ configured: false });
    await expect(as(ids.operator).query(api.offsite.status, {})).rejects.toThrow("Нет доступа");
  });

  test("после ночной копии — тот же файл в бакете, с подписью SigV4 и регионом auto; отметка в списке копий", async () => {
    stubS3();
    const { t, ids, as } = await setup();
    await t.action(internal.backup.run, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const { row } = await latest(t);
    const keys = [...bucket.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^backups\/homemax-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    expect(bucket.get(keys[0]!)).toBe(row.size);
    const put = requests.find((r) => r.method === "PUT")!;
    expect(put.url.pathname.startsWith("/hms-backups/backups/")).toBe(true);
    expect(put.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(put.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
    // Секрет ключа в запрос не попадает.
    for (const r of requests) expect([...r.headers.values()].join(" ")).not.toContain("secret-key-TEST");
    // Файлы без настройки владельца не копируются.
    expect(keys.some((k) => k.startsWith("files/"))).toBe(false);

    const list = await as(ids.owner).query(api.backup.list, {});
    expect(list.items[0]?.offsite).toBe(true);
    const status = await as(ids.owner).query(api.offsite.status, {});
    expect(status).toMatchObject({ configured: true, host: "s3.test", bucket: "hms-backups", region: "auto", keep: KEEP_OFFSITE, copyFiles: false });
    expect(status.health?.okAt).toBeDefined();
  });

  test(`там храним ${KEEP_OFFSITE} последних; чужие объекты бакета не трогаем`, async () => {
    stubS3();
    for (let d = 1; d <= KEEP_OFFSITE + 2; d++) bucket.set(`backups/homemax-backup-2026-01-${String(d).padStart(2, "0")}-0200.json`, 1);
    bucket.set("backups/чужой-файл.json", 1);
    const { t } = await setup();
    await t.action(internal.backup.run, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const ours = [...bucket.keys()].filter((k) => k.startsWith("backups/homemax-backup-"));
    expect(ours).toHaveLength(KEEP_OFFSITE);
    // Удалены самые старые: 1-е, 2-е и 3-е января (новая копия сегодняшняя).
    for (const d of ["01", "02", "03"]) expect(bucket.has(`backups/homemax-backup-2026-01-${d}-0200.json`)).toBe(false);
    expect(bucket.has("backups/чужой-файл.json")).toBe(true);
  });

  test("ошибка хранилища — сбой «Внешнее хранилище копий», понятный текст без ключа, владельцу оповещение", async () => {
    stubS3();
    failPut = 403;
    const { t, ids, as } = await setup();
    await t.action(internal.backup.run, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const s = await as(ids.owner).query(api.offsite.status, {});
    expect(s.health?.error).toBe("Копия не выгружена: Файл не загрузился во внешнее хранилище: HTTP 403 AccessDenied — проверьте ключи доступа и права на бакет");
    expect(s.health?.error).not.toContain("AKIDTEST");
    const bell = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(bell.filter((n) => n.userId === ids.owner).map((n) => n.text)).toContainEqual(expect.stringContaining("Внешнее хранилище копий. Сбой: Копия не выгружена"));
    // Локальная копия при этом создана.
    expect((await as(ids.owner).query(api.backup.list, {})).items[0]?.offsite).toBe(false);
  });

  test("файлы — по настройке владельца: копируются один раз, удалённые у нас удаляются и там", async () => {
    stubS3();
    const { t, ids, as } = await setup();
    await expect(as(ids.operator).mutation(api.offsite.setCopyFiles, { on: true })).rejects.toThrow("Нет доступа");
    await as(ids.owner).mutation(api.offsite.setCopyFiles, { on: true });
    await t.action(internal.backup.run, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const files = () => [...bucket.keys()].filter((k) => k.startsWith("files/")).sort();
    expect(files()).toEqual([`files/${ids.photo}`, `files/${ids.recording}`].sort());
    const puts = requests.filter((r) => r.method === "PUT").length;

    // Вторая ночь: файлы уже там — повторно не грузятся.
    await t.action(internal.backup.run, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(requests.filter((r) => r.method === "PUT").length).toBe(puts + 1);

    // Запись звонка удалили (срок хранения) — следующей ночью удаляется и во внешнем хранилище.
    await t.run(async (ctx) => {
      await ctx.storage.delete(ids.recording);
      await ctx.db.patch(ids.call, { recordingId: undefined });
    });
    await t.action(internal.backup.run, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(files()).toEqual([`files/${ids.photo}`]);
    expect(await t.run((ctx) => ctx.db.query("offsiteFiles").collect())).toHaveLength(1);
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.map((a) => a.action)).toContain("settings.offsiteFiles");
  });
});
