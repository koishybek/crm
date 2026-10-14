// Соединение SMTP поверх node:net / node:tls — только для рантайма Node (его зовёт emailSmtp.ts, "use node").
// Модули Node подгружаются по имени из переменной: их типы не попадают в общую программу TypeScript (её видит
// и фронт), а сборка Convex для рантайма V8 их не трогает. Сертификат сервера проверяется (rejectUnauthorized
// по умолчанию), TLS не ниже 1.2. Ошибки — только вид (связь, таймаут, TLS): текст ОС и сервера наружу не идёт.
import { ReplyReader, SmtpLinkError, type SmtpDialer, type SmtpLink, type SmtpReply } from "./smtp";

/** То, что нужно от сокета Node (net.Socket / tls.TLSSocket). */
interface NodeSocket {
  write(data: string, cb: (err?: Error | null) => void): boolean;
  setEncoding(enc: "utf8"): void;
  setTimeout(ms: number, cb?: () => void): void;
  on(event: string, cb: (arg: unknown) => void): unknown;
  once(event: string, cb: (arg: unknown) => void): unknown;
  removeAllListeners(event?: string): unknown;
  destroy(): void;
}
interface NetModule {
  connect(o: { host: string; port: number }): NodeSocket;
}
interface TlsModule {
  connect(o: { host?: string; port?: number; socket?: NodeSocket; servername: string; minVersion: "TLSv1.2" }): NodeSocket;
}

const load = (name: string): Promise<unknown> => import(/* @vite-ignore */ name);

/** Код ошибки Node → вид: сертификат и рукопожатие — TLS, таймаут — таймаут, остальное — связь. */
function failureOf(e: unknown): SmtpLinkError {
  const code = typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "";
  if (code === "ETIMEDOUT") return new SmtpLinkError("timeout");
  if (/^ERR_(SSL|TLS)|CERT|SELF_SIGNED|UNABLE_TO_|HOSTNAME|ALTNAME/.test(code)) return new SmtpLinkError("tls");
  return new SmtpLinkError("network");
}

/** Дождаться события установки соединения ("connect" / "secureConnect") или ошибки. */
function opened(sock: NodeSocket, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    sock.setTimeout(timeoutMs, () => {
      reject(new SmtpLinkError("timeout"));
      sock.destroy();
    });
    sock.once(event, () => resolve());
    sock.once("error", (e) => reject(failureOf(e)));
  });
}

export const nodeDialer: SmtpDialer = async ({ host, port, secure, timeoutMs }) => {
  const tls = (await load("node:tls")) as TlsModule;
  const net = (await load("node:net")) as NetModule;
  const reader = new ReplyReader();
  let sock = secure ? tls.connect({ host, port, servername: host, minVersion: "TLSv1.2" }) : net.connect({ host, port });

  const attach = (s: NodeSocket): void => {
    s.setEncoding("utf8");
    s.setTimeout(timeoutMs, () => {
      reader.fail(new SmtpLinkError("timeout"));
      s.destroy();
    });
    s.on("data", (chunk) => reader.push(String(chunk)));
    s.on("error", (e) => reader.fail(failureOf(e)));
    s.on("close", () => reader.fail(new SmtpLinkError("network")));
  };

  try {
    await opened(sock, secure ? "secureConnect" : "connect", timeoutMs);
  } catch (e) {
    sock.destroy();
    throw e;
  }
  attach(sock);

  const link: SmtpLink = {
    send: (data) =>
      new Promise<void>((resolve, reject) => {
        sock.write(data, (err) => (err ? reject(failureOf(err)) : resolve()));
      }),
    reply: (): Promise<SmtpReply> => reader.next(),
    async startTls() {
      // Ответ 220 на STARTTLS прочитан, буфер пуст: дальше тот же TCP-поток, но уже в TLS.
      sock.removeAllListeners("data");
      sock.removeAllListeners("error");
      sock.removeAllListeners("close");
      sock.setTimeout(0);
      const upgraded = tls.connect({ socket: sock, servername: host, minVersion: "TLSv1.2" });
      try {
        await opened(upgraded, "secureConnect", timeoutMs);
      } catch (e) {
        throw e instanceof SmtpLinkError && e.kind === "network" ? new SmtpLinkError("tls") : e;
      }
      sock = upgraded;
      attach(sock);
    },
    close: () => sock.destroy(),
  };
  return link;
};
