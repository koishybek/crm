// HMAC через Web Crypto для чужих протоколов подписи (actions и HTTP-actions — там Web Crypto есть):
// Zadarma — base64 от hex HMAC-SHA1 (так считает PHP hash_hmac без raw), CloudPayments — base64 от HMAC-SHA256.

type Alg = "SHA-1" | "SHA-256";

async function hmacRaw(alg: Alg, key: string, message: string): Promise<Uint8Array> {
  const utf8 = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", utf8.encode(key), { name: "HMAC", hash: alg }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, utf8.encode(message)));
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** base64(hex(HMAC)) — подпись Zadarma: в их примерах base64_encode(hash_hmac('sha1', …)). */
export async function hmacHexBase64(alg: Alg, key: string, message: string): Promise<string> {
  return btoa(hex(await hmacRaw(alg, key, message)));
}

/** base64(HMAC) — подпись CloudPayments (Content-HMAC). */
export async function hmacBase64(alg: Alg, key: string, message: string): Promise<string> {
  return base64(await hmacRaw(alg, key, message));
}
