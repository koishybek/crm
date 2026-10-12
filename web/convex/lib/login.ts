/** Логин — email или телефон. Телефон приводим к «77011234567», email — к нижнему регистру. */
export function normalizeLogin(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s.includes("@")) return s;
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `7${d}`;
  if (d.length === 11 && d.startsWith("8")) return `7${d.slice(1)}`;
  return d || s;
}
