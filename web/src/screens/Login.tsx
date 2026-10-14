import { ArrowRight, Briefcase, ChartNoAxesColumn, Clock, Eye, EyeOff, FileText, Headset, House, Lock, Mail, ShieldCheck, UserRound, Users } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useQuery } from "convex/react";
import { Link } from "react-router";
import { api } from "../../convex/_generated/api";
import { APP_NAME, ROLE_LABEL } from "../data/catalog";
import { toast } from "../data/store";
import { errorText } from "../data/convex";
import { useAuthActions } from "@convex-dev/auth/react";
import { BRAND_HEAD, Logo, LogoMark } from "../components/icons";
import { Avatar, Button, IconTile } from "../components/ui";
import { cn } from "../lib/format";

/** Быстрый вход — только на демо-стенде, где в сборке задан VITE_DEMO_PASSWORD. */
const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD as string | undefined;
const DEMO: { login: string; name: string; role: "owner" | "operator" | "manager" | "executor" }[] = [
  { login: "alikhan@homemax.kz", name: "Алихан Сейтказы", role: "owner" },
  { login: "madina@homemax.kz", name: "Мадина Ергалиева", role: "operator" },
  { login: "erlan@homemax.kz", name: "Ерлан Касымов", role: "manager" },
  { login: "77784445678", name: "Нурлан Жумабаев", role: "executor" },
  { login: "77011234567", name: "Азамат Нуралиев", role: "executor" },
];

function HeroMock() {
  return (
    <div className="pointer-events-none relative mt-14 h-[330px] select-none" aria-hidden>
      <div className="absolute -top-6 right-6 h-64 w-64 rotate-12 rounded-[48px] bg-[linear-gradient(135deg,#ffe9b0,#fff6df)] opacity-80" />
      <div className="absolute top-24 -right-10 h-72 w-72 rotate-[28deg] rounded-[56px] bg-[linear-gradient(135deg,#ffe3a0,#fffaf0)] opacity-70" />
      <div
        className="absolute top-6 left-0 w-[560px] rounded-[22px] border border-white/80 bg-white/75 p-4 shadow-[0_40px_80px_-30px_rgba(16,60,140,0.35)] backdrop-blur-xl"
        style={{ transform: "perspective(1400px) rotateX(20deg) rotateY(-16deg) rotateZ(7deg)", transformOrigin: "left top" }}
      >
        <div className="flex gap-4">
          <div className="flex w-[86px] flex-col gap-3 rounded-[14px] bg-white/70 p-3">
            <div className="flex items-center gap-1.5">
              <LogoMark size={18} />
              <span className="text-[10px] font-bold whitespace-nowrap text-ink">{BRAND_HEAD}</span>
            </div>
            {[House, FileText, Briefcase, Users, ChartNoAxesColumn].map((I, i) => (
              <div key={i} className="flex items-center gap-2">
                <I size={14} className={i === 0 ? "text-brand-ink" : "text-faint"} />
                <span className={cn("h-2 rounded-full", i === 0 ? "w-10 bg-brand/40" : "w-8 bg-line-strong")} />
              </div>
            ))}
          </div>
          <div className="flex-1">
            <div className="grid grid-cols-3 gap-3">
              {[
                { I: FileText, v: "12", t: "+33%", c: "bg-brand-soft text-brand-ink" },
                { I: Briefcase, v: "28", t: "+12%", c: "bg-ok-bg text-ok" },
                { I: Clock, v: "4", t: "+2%", c: "bg-bad-bg text-bad" },
              ].map((k, i) => (
                <div key={i} className="rounded-[14px] bg-white p-3 shadow-[0_6px_18px_-10px_rgba(16,60,140,0.3)]">
                  <span className={cn("inline-flex h-8 w-8 items-center justify-center rounded-[9px]", k.c)}>
                    <k.I size={16} />
                  </span>
                  <div className="mt-1.5 text-[20px] font-bold text-ink">{k.v}</div>
                  <div className={cn("text-[10px] font-semibold", i === 2 ? "text-bad" : "text-ok")}>↗ {k.t}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 space-y-2.5 rounded-[14px] bg-white p-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-2.5">
                  <span className="h-6 w-6 rounded-full bg-[#ece6d8]" />
                  <span className="h-2 w-24 rounded-full bg-line-strong" />
                  <span className={cn("ml-auto h-3.5 w-12 rounded-full", ["bg-ok-bg", "bg-warn-bg", "bg-brand-soft"][i])} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Login() {
  const { signIn } = useAuthActions();
  const signup = useQuery(api.tenants.signupStatus);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // После входа LoginRoute сам перекинет в кабинет по роли.
  const enter = async (login: string, pass: string) => {
    setError("");
    if (!login.trim() || !pass) return setError("Введите логин и пароль");
    setBusy(true);
    try {
      await signIn("password", { email: login.trim(), password: pass, flow: "signIn" });
    } catch (e) {
      const text = errorText(e);
      setError(/InvalidSecret|InvalidAccountId|Invalid/i.test(String(e)) || text.startsWith("Что-то") ? "Неверный логин или пароль" : text);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void enter(email, password);
  };

  const features = [
    { I: FileText, tone: "yellow" as const, t: "Все заявки под контролем", s: "От обращения до закрытия" },
    { I: Users, tone: "green" as const, t: "Удобная работа команды", s: "Клиенты, заказы, исполнители" },
    { I: ChartNoAxesColumn, tone: "violet" as const, t: "Рост и аналитика", s: "Понятные отчёты и показатели" },
  ];

  return (
    <div className="grid min-h-dvh bg-[#fbfaf6] lg:grid-cols-[1.04fr_1fr]">
      <section className="relative hidden overflow-hidden bg-[linear-gradient(160deg,#fffaf0_0%,#fff3d6_55%,#f6faff_100%)] px-14 pt-12 xl:px-24 lg:block">
        <Logo />
        <div className="mt-16 text-[13px] font-semibold tracking-[0.32em] text-muted">ЗАЯВКИ · ЗАКАЗЫ · МАСТЕРА</div>
        <h1 className="mt-4 max-w-[620px] text-[46px] leading-[1.08] font-bold tracking-[-0.035em] text-ink xl:text-[52px]">Больше довольных клиентов. Больше роста.</h1>
        <p className="mt-5 max-w-[480px] text-[18px] leading-relaxed text-muted">{APP_NAME} — заявки, клиенты, выездные мастера и деньги в одном месте.</p>
        <div className="mt-9 space-y-6">
          {features.map((f) => (
            <div key={f.t} className="flex items-center gap-4">
              <IconTile icon={f.I} tone={f.tone} size={54} />
              <div>
                <div className="text-[16.5px] font-semibold text-ink">{f.t}</div>
                <div className="text-[14.5px] text-muted">{f.s}</div>
              </div>
            </div>
          ))}
        </div>
        <HeroMock />
      </section>

      <section className="flex flex-col px-4 py-8 sm:px-8">
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-[500px]">
            <form onSubmit={submit} className="card px-6 py-9 shadow-[0_24px_60px_-28px_rgba(16,60,140,0.28)] sm:px-12">
              <div className="flex justify-center">
                <Logo />
              </div>
              <h2 className="mt-6 text-center text-[30px] font-bold tracking-[-0.025em] text-ink sm:text-[34px]">Вход в систему</h2>
              <p className="mx-auto mt-2 max-w-[360px] text-center text-[15.5px] leading-snug text-balance text-muted">Войдите, чтобы продолжить работу в {APP_NAME}.</p>

              <label className="mt-8 mb-2 block text-[15px] font-medium text-ink" htmlFor="email">
                Email или телефон
              </label>
              <div className="relative">
                <Mail size={19} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-muted" />
                <input id="email" type="text" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.kz или 7701…" className="field h-[50px] pl-12 text-[15px]" />
              </div>
              <label className="mt-5 mb-2 block text-[15px] font-medium text-ink" htmlFor="password">
                Пароль
              </label>
              <div className="relative">
                <Lock size={19} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-muted" />
                <input
                  id="password"
                  type={show ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Введите пароль"
                  className="field h-[50px] pr-12 pl-12 text-[15px]"
                />
                <button type="button" onClick={() => setShow((v) => !v)} className="hit absolute top-1/2 right-3.5 -translate-y-1/2 text-muted hover:text-ink" aria-label={show ? "Скрыть пароль" : "Показать пароль"}>
                  {show ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>

              <div className="mt-5 flex items-center justify-end">
                <button type="button" onClick={() => toast("Попросите администратора компании сбросить пароль", "info")} className="text-[15px] font-medium text-brand-ink hover:text-brand-deep">
                  Забыли пароль?
                </button>
              </div>

              {error && <div className="mt-4 rounded-[10px] bg-bad-bg px-3.5 py-2.5 text-[14px] font-medium text-bad-ink">{error}</div>}

              <Button type="submit" size="lg" full iconRight={ArrowRight} className="mt-6" disabled={busy}>
                Войти
              </Button>

              <div className="mt-7 border-t border-line pt-5 text-center text-[13.5px] leading-snug text-muted">
                <ShieldCheck size={17} className="mr-1.5 inline -translate-y-px" />
                Если у вас нет доступа к системе,
                <br />
                обратитесь к администратору вашей компании.
                {signup?.open && (
                  <>
                    <br />
                    <Link to="/register" className="mt-2 inline-block font-medium text-brand-ink hover:text-brand-deep">
                      Зарегистрировать компанию
                    </Link>
                  </>
                )}
              </div>
            </form>

            {DEMO_PASSWORD && (
            <div className="mt-5 rounded-[16px] border border-dashed border-brand-line bg-white/70 p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-[13.5px] font-semibold text-ink">Демо-доступ</span>
                <span className="text-[12.5px] text-muted">вход в один клик</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {DEMO.map((u) => {
                  return (
                    <button key={u.login} disabled={busy} onClick={() => void enter(u.login, DEMO_PASSWORD)} className="flex items-center gap-2.5 rounded-[11px] border border-line bg-white px-2.5 py-2 text-left transition-colors hover:border-brand-line hover:bg-[#fffbf0] disabled:opacity-60">
                      <Avatar name={u.name} size={34} variant="person" />
                      <span className="min-w-0">
                        <span className="block truncate text-[13.5px] font-semibold text-ink">{u.name.split(" ")[0]}</span>
                        <span className="block truncate text-[12px] text-muted">{u.role === "manager" ? "Руководитель: климат" : ROLE_LABEL[u.role]}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-3 text-[12px] leading-snug text-muted">
                <UserRound size={13} className="mr-1 inline -translate-y-px" />
                Откройте Нурлана и Азамата в двух вкладках: один и тот же заказ достанется только тому, кто первым нажмёт «Взять заказ».
              </p>
            </div>
            )}
          </div>
        </div>
        <footer className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[13.5px] text-muted lg:justify-between lg:px-10">
          <span className="inline-flex items-center gap-2">
            <Lock size={15} /> Безопасный доступ к вашим данным
          </span>
          <span className="inline-flex items-center gap-4">
            <span className="inline-flex items-center gap-1.5">
              <Headset size={15} /> Поддержка
            </span>
            <span className="text-line-strong">|</span>
            <span>Помощь</span>
            <span className="text-line-strong">|</span>
            <span>
              {APP_NAME} © {new Date().getFullYear()}
            </span>
          </span>
        </footer>
      </section>
    </div>
  );
}
