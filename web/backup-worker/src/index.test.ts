// Worker внешнего хранилища: чистая функция handle с поддельным Workers KV — ключ доступа, имена, размер, список.
import { beforeEach, describe, expect, test } from "vitest";
import { handle, MAX_BYTES, sameSecret, type Env, type KvLike, type ObjectMeta } from "./index";

const SECRET = "s3cr3t-0123456789-abcdefghijklmnopqrstuv";

/** Workers KV в памяти: значение, метаданные, список по префиксу страницами с курсором. */
export function fakeKv(): KvLike & { data: Map<string, { value: ArrayBuffer; metadata: ObjectMeta }> } {
  const data = new Map<string, { value: ArrayBuffer; metadata: ObjectMeta }>();
  return {
    data,
    async getWithMetadata<M>(key: string) {
      const row = data.get(key);
      return row ? { value: new Blob([row.value]).stream(), metadata: row.metadata as M } : { value: null, metadata: null };
    },
    async put(key, value, { metadata }) {
      data.set(key, { value, metadata });
    },
    async delete(key) {
      data.delete(key);
    },
    async list<M>({ prefix, cursor, limit = 1000 }: { prefix: string; cursor?: string; limit?: number }) {
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit).map((name) => ({ name, metadata: data.get(name)!.metadata as M }));
      const done = start + limit >= keys.length;
      return done ? { keys: page, list_complete: true } : { keys: page, list_complete: false, cursor: String(start + limit) };
    },
  };
}

let kv: ReturnType<typeof fakeKv>;
let env: Env;
const req = (method: string, path: string, init: { body?: BodyInit; auth?: string | null; headers?: Record<string, string> } = {}) =>
  new Request(`https://homemax-backup.test${path}`, {
    method,
    body: init.body,
    headers: { ...(init.auth === null ? {} : { Authorization: init.auth ?? `Bearer ${SECRET}` }), ...init.headers },
  });

beforeEach(() => {
  kv = fakeKv();
  env = { BACKUPS: kv, BACKUP_SECRET: SECRET };
});

describe("ключ доступа", () => {
  test("без заголовка, с чужим секретом, не Bearer — 401 и ничего не записано", async () => {
    for (const auth of [null, `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, `Basic ${SECRET}`, "Bearer "]) {
      const res = await handle(req("PUT", "/o/backups/a.json", { body: "x", auth }), env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(kv.data.size).toBe(0);
  });
  test("секрет в Worker не задан или короткий — 500 not_configured для всех", async () => {
    for (const secret of [undefined, "short"]) {
      const res = await handle(req("GET", "/list?prefix=backups/", { auth: `Bearer ${secret}` }), { BACKUPS: kv, BACKUP_SECRET: secret });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "not_configured" });
    }
  });
  test("сравнение секрета — по хэшам одинаковой длины", async () => {
    expect(await sameSecret(SECRET, SECRET)).toBe(true);
    expect(await sameSecret("", SECRET)).toBe(false);
    expect(await sameSecret(`${SECRET}${SECRET}`, SECRET)).toBe(false);
  });
});

describe("объекты", () => {
  test("PUT → GET → DELETE; метаданные { size, at }; удаление отсутствующего — тоже 204", async () => {
    const put = await handle(req("PUT", "/o/backups/homemax-backup-2026-10-14-0200.json", { body: '{"version":2}' }), env);
    expect(put.status).toBe(201);
    expect(await put.json()).toEqual({ ok: true, size: 13 });
    const meta = kv.data.get("backups/homemax-backup-2026-10-14-0200.json")!.metadata;
    expect(meta.size).toBe(13);
    expect(Date.parse(meta.at)).not.toBeNaN();

    const get = await handle(req("GET", "/o/backups/homemax-backup-2026-10-14-0200.json"), env);
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Length")).toBe("13");
    expect(await get.text()).toBe('{"version":2}');

    expect((await handle(req("DELETE", "/o/backups/homemax-backup-2026-10-14-0200.json"), env)).status).toBe(204);
    expect((await handle(req("DELETE", "/o/backups/homemax-backup-2026-10-14-0200.json"), env)).status).toBe(204);
    expect((await handle(req("GET", "/o/backups/homemax-backup-2026-10-14-0200.json"), env)).status).toBe(404);
  });

  test("папка компании t/<компания>/ и файлы files/<id>", async () => {
    expect((await handle(req("PUT", "/o/t/firma-2/backups/homemax-backup-2026-10-14-0200.json", { body: "{}" }), env)).status).toBe(201);
    expect((await handle(req("PUT", "/o/files/kg2abc123def", { body: "jpeg" }), env)).status).toBe(201);
    expect([...kv.data.keys()].sort()).toEqual(["files/kg2abc123def", "t/firma-2/backups/homemax-backup-2026-10-14-0200.json"]);
  });

  test("недопустимые имена — 400 bad_key: чужие разделы, обход пути, пробелы, кириллица, пустое имя", async () => {
    for (const path of ["/o/secrets/x", "/o/backups/", "/o/backups/../x", "/o/backups/%2e%2e", "/o/t/Firma/backups/x", "/o/t/firma/../backups/x", "/o/backups/a%20b", "/o/backups/%D0%BA", "/o/backups/%E0%A4%A", "/o/backups/a/b"]) {
      const res = await handle(req("PUT", path, { body: "x" }), env);
      expect(res.status, path).toBe(400);
    }
    expect(kv.data.size).toBe(0);
  });

  test("больше 25 МиБ — 413: и по заявленной длине, и по факту", async () => {
    const declared = await handle(req("PUT", "/o/files/big", { body: "x", headers: { "Content-Length": String(MAX_BYTES + 1) } }), env);
    expect(declared.status).toBe(413);
    const actual = await handle(req("PUT", "/o/files/big", { body: new Uint8Array(MAX_BYTES + 1) }), env);
    expect(actual.status).toBe(413);
    expect(await actual.json()).toEqual({ error: "too_large" });
    expect(kv.data.size).toBe(0);
  });

  test("чужие методы и пути — 405 и 404", async () => {
    expect((await handle(req("POST", "/o/files/a", { body: "x" }), env)).status).toBe(405);
    expect((await handle(req("DELETE", "/list?prefix=backups/"), env)).status).toBe(405);
    expect((await handle(req("GET", "/"), env)).status).toBe(404);
  });
});

describe("список", () => {
  test("по префиксу, с размерами; страницы по 1000 с курсором", async () => {
    for (let i = 0; i < 1001; i++) await handle(req("PUT", `/o/files/f${String(i).padStart(4, "0")}`, { body: "ab" }), env);
    await handle(req("PUT", "/o/backups/homemax-backup-2026-10-14-0200.json", { body: "{}" }), env);
    const first = await handle(req("GET", "/list?prefix=files/"), env);
    const p1 = (await first.json()) as { objects: { key: string; size: number }[]; cursor: string | null };
    expect(p1.objects).toHaveLength(1000);
    expect(p1.objects[0]).toMatchObject({ key: "files/f0000", size: 2 });
    expect(p1.cursor).toBe("1000");
    const p2 = (await (await handle(req("GET", `/list?prefix=files/&cursor=${p1.cursor}`), env)).json()) as { objects: { key: string }[]; cursor: string | null };
    expect(p2.objects.map((o) => o.key)).toEqual(["files/f1000"]);
    expect(p2.cursor).toBeNull();
    const backups = (await (await handle(req("GET", "/list?prefix=backups/homemax-backup-"), env)).json()) as { objects: { key: string }[] };
    expect(backups.objects.map((o) => o.key)).toEqual(["backups/homemax-backup-2026-10-14-0200.json"]);
  });

  test("префикс — только наш раздел: пустой и чужой — 400", async () => {
    for (const q of ["", "?prefix=", "?prefix=secrets/", "?prefix=t/", "?prefix=backups/&cursor=%3Cx%3E"]) {
      expect((await handle(req("GET", `/list${q}`), env)).status, q).toBe(400);
    }
  });
});
