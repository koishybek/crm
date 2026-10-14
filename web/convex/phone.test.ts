/// <reference types="vite/client" />
// Иностранные номера клиентов (ТЗ п.7.1, E26): E.164 для клиентов и входящих звонков, Казахстан и Россия —
// по-прежнему «7XXXXXXXXXX», поиск дублей по нормализованному номеру, маска ввода — KZ по умолчанию и «+код страны».
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { clientPhone, contactPhone, isClientPhone, pbxPhone } from "./lib/phone";
import { parseOrderQuery } from "./lib/orderArchive";
import { formatPhone, isPhone, normalizePhone, phoneMask } from "../src/data/phone";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);
const T = "t-komfort";

describe("нормализация номера (src/data/phone.ts)", () => {
  test("Казахстан и Россия — как раньше: «7XXXXXXXXXX» из любых привычных записей", () => {
    for (const raw of ["+7 (701) 123-45-67", "8 701 123 45 67", "87011234567", "77011234567", "7011234567", "+77011234567", "007 701 123 4567"]) {
      expect(normalizePhone(raw)).toBe("77011234567");
    }
    expect(normalizePhone("+7 495 123 45 67")).toBe("74951234567");
    expect(normalizePhone("+7 (701) 123-45")).toBeNull();
    expect(normalizePhone("+7 701 123 45 678")).toBeNull();
  });

  test("другие страны — E.164 цифрами без «+»: с «+», с «00» или длинный номер из АТС", () => {
    expect(normalizePhone("+996 555 123 456")).toBe("996555123456");
    expect(normalizePhone("00996555123456")).toBe("996555123456");
    expect(normalizePhone("996555123456")).toBe("996555123456");
    expect(normalizePhone("+998 90 123 45 67")).toBe("998901234567");
    expect(normalizePhone("+1 (212) 555-01-23")).toBe("12125550123");
    expect(normalizePhone("+49 30 1234567")).toBe("49301234567");
    expect(normalizePhone("+84 912 345 678")).toBe("84912345678");
  });

  test("мусор и неполные номера — null", () => {
    for (const raw of ["", "+", "12345", "+123", "+0 555 1234567", "+1234567890123456", "abc 77011234567", "555 1234", "0012"]) {
      expect(normalizePhone(raw)).toBeNull();
    }
  });

  test("номер из базы нормализуется сам в себя; isPhone — только вид для базы", () => {
    for (const p of ["77011234567", "996555123456", "12125550123"]) {
      expect(normalizePhone(p)).toBe(p);
      expect(isPhone(p)).toBe(true);
    }
    expect(isPhone("87011234567")).toBe(false);
    expect(isPhone("+996555123456")).toBe(false);
    expect(isClientPhone("996555123456")).toBe(true);
  });

  test("показ: «+7 701 123 45 67», «+996 555 123 456», «+1 212 555 0123»; непонятное — как есть", () => {
    expect(formatPhone("77011234567")).toBe("+7 701 123 45 67");
    expect(formatPhone("87011234567")).toBe("+7 701 123 45 67");
    expect(formatPhone("996555123456")).toBe("+996 555 123 456");
    expect(formatPhone("12125550123")).toBe("+1 212 555 0123");
    expect(formatPhone("998901234567")).toBe("+998 901 234 567");
    expect(formatPhone("101")).toBe("101");
  });

  test("маска ввода: по умолчанию Казахстан, «+» и другой код — международный номер", () => {
    expect(phoneMask("701")).toBe("+7 (701)");
    expect(phoneMask("7011234567")).toBe("+7 (701) 123-45-67");
    expect(phoneMask("8 701 123 45 67")).toBe("+7 (701) 123-45-67");
    expect(phoneMask("+7 (701) 123-45-678")).toBe("+7 (701) 123-45-67");
    expect(phoneMask("+")).toBe("+");
    expect(phoneMask("+7")).toBe("+7");
    expect(phoneMask("+99655")).toBe("+996 55");
    expect(phoneMask("+996555123456")).toBe("+996 555 123 456");
    expect(phoneMask("996555123456")).toBe("+996 555 123 456");
    expect(phoneMask("+9965551234567890123")).toBe("+996 555 123 456 789");
    expect(normalizePhone(phoneMask("+996555123456"))).toBe("996555123456");
    expect(normalizePhone(phoneMask("7011234567"))).toBe("77011234567");
  });

  test("каналы и АТС: номер с кодом страны без «+», внутренний номер — как есть; форма — понятная ошибка", () => {
    expect(contactPhone("77011234567")).toBe("77011234567");
    expect(contactPhone("+996555123456")).toBe("996555123456");
    expect(contactPhone("84912345678")).toBe("84912345678");
    expect(contactPhone("123")).toBeUndefined();
    expect(pbxPhone("+7 (701) 123-45-67")).toBe("77011234567");
    expect(pbxPhone("996555123456")).toBe("996555123456");
    expect(pbxPhone("101")).toBe("101");
    expect(() => clientPhone("555")).toThrow("номер другой страны с «+» и кодом");
    expect(parseOrderQuery("+996 555 123 456")).toEqual({ kind: "phone", phone: "996555123456" });
    expect(parseOrderQuery("8 701 123 45 67")).toEqual({ kind: "phone", phone: "77011234567" });
  });
});

describe("иностранный клиент в базе (E26)", () => {
  async function setup() {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const operator = await ctx.db.insert("users", { name: "Мадина Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
      return { operator };
    });
    const op = t.withIdentity({ subject: `${ids.operator}|s` });
    return { t, ids, op };
  }

  test("клиента с номером +996 можно сохранить; дубль в другой записи номера — отказ; поиск находит", async () => {
    const { t, op } = await setup();
    const { id } = await op.mutation(api.clients.create, { name: "Айбек Бишкек", phone: "+996 555 123 456", city: "Алматы", source: "whatsapp" });
    expect((await t.run((ctx) => ctx.db.get(id)))!.phone).toBe("996555123456");
    await expect(op.mutation(api.clients.create, { name: "Повтор", phone: "00996555123456", city: "Алматы", source: "olx" })).rejects.toThrow("уже есть");
    await expect(op.mutation(api.clients.create, { name: "Обрывок", phone: "+996 555", city: "Алматы", source: "olx" })).rejects.toThrow("Укажите телефон полностью");
    expect((await op.query(api.clients.byPhone, { phone: "+996 555 123 456" }))?.id).toBe(id);
    expect((await op.query(api.clients.list, { q: "+996 555 123 456" })).map((c) => c.id)).toEqual([id]);
    expect((await op.query(api.search.global, { q: "+996555123456" })).map((h) => h.key)).toEqual([id]);
    // Казахстанский номер — как раньше.
    const kz = await op.mutation(api.clients.create, { name: "Алия", phone: "8 (701) 123-45-67", city: "Алматы", source: "olx" });
    expect((await t.run((ctx) => ctx.db.get(kz.id)))!.phone).toBe("77011234567");
  });

  test("заявка с иностранным номером находит того же клиента, а не заводит второго", async () => {
    const { t, op } = await setup();
    const { id } = await op.mutation(api.clients.create, { name: "Айбек Бишкек", phone: "+996555123456", city: "Алматы", source: "whatsapp" });
    await op.mutation(api.leads.create, { clientName: "Айбек", phone: "+996 (555) 123-456", source: "whatsapp", serviceId: "ac-repair", city: "Алматы", description: "Не холодит", urgency: "normal" });
    const leads = await t.run((ctx) => ctx.db.query("leads").collect());
    expect(leads.map((l) => [l.clientId, l.clientPhone])).toEqual([[id, "996555123456"]]);
    expect(await t.run((ctx) => ctx.db.query("clients").collect())).toHaveLength(1);
  });

  test("входящий звонок с иностранного номера привязывается к клиенту", async () => {
    const { t, op } = await setup();
    const { id } = await op.mutation(api.clients.create, { name: "Айбек Бишкек", phone: "+996555123456", city: "Алматы", source: "phone" });
    const callId: Id<"calls"> = await t.mutation(internal.calls._ingest, { event: "ringing", externalId: "c-1", direction: "in", from: "+996 555 123 456", to: "101" });
    const call = (await t.run((ctx) => ctx.db.get(callId)))!;
    expect([call.from, call.to, call.clientId]).toEqual(["996555123456", "101", id]);
    const unknown: Id<"calls"> = await t.mutation(internal.calls._ingest, { event: "ringing", externalId: "c-2", direction: "in", from: "998901234567", to: "101" });
    const other = (await t.run((ctx) => ctx.db.get(unknown)))!;
    expect([other.from, other.clientId]).toEqual(["998901234567", undefined]);
  });
});
