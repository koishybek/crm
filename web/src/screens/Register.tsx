// Регистрация компании (ТЗ §23.7): /register, без входа. Открыта, если на сервере SAAS_SIGNUP=1, иначе — «по приглашению».
// Защита от ботов: поле-ловушка и время заполнения; лимиты и проверка логина — на сервере (convex/tenants.ts register).
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { Building2, Eye, EyeOff, Lock, Mail, UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../../convex/_generated/api";
import { Logo } from "../components/icons";
import { Button, FormRow, Input, Loading, Select } from "../components/ui";
import { CITIES } from "../data/catalog";
import { errorText } from "../data/convex";
import { passwordMin } from "../data/passwordRules";
import { registerCompany } from "../data/tenant";

export default function Register() {
  const status = useQuery(api.tenants.signupStatus);
  const { signIn } = useAuthActions();
  const nav = useNavigate();
  const [startedAt] = useState(() => Date.now());
  const [company, setCompany] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [city, setCity] = useState<string>(CITIES[0]);
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (company.trim().length < 2) return setError("Укажите название компании");
    if (ownerName.trim().length < 2) return setError("Укажите ваше имя");
    if (!login.trim()) return setError("Укажите email или телефон для входа");
    if (password.length < passwordMin("owner")) return setError(`Пароль — не короче ${passwordMin("owner")} символов`);
    if (!consent) return setError("Нужно согласие на обработку персональных данных");
    setBusy(true);
    const r = await registerCompany({ company, ownerName, login, password, city, consent, website, startedAt });
    if (!r.ok) {
      setBusy(false);
      return setError(r.error);
    }
    try {
      // Компания создана — сразу входим тем же паролем; на «Главной» владельца ждёт «С чего начать».
      await signIn("password", { email: r.value.login, password, flow: "signIn" });
      nav("/", { replace: true });
    } catch (err) {
      setError(`Компания зарегистрирована, но войти не удалось: ${errorText(err)}. Войдите на странице входа.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh bg-page px-4 py-8">
      <main className="mx-auto w-full max-w-[520px]">
        <div className="flex justify-center">
          <Logo />
        </div>
        <div className="card mt-6 p-5 sm:p-8">
          {status === undefined ? (
            <Loading />
          ) : !status.open ? (
            <div className="py-4 text-center">
              <h1 className="text-[24px] font-bold tracking-[-0.02em] text-ink">Регистрация по приглашению</h1>
              <p className="mt-2 text-[15px] text-muted">Чтобы подключить компанию, напишите администратору платформы.</p>
              <Link to="/login" className="mt-5 inline-block text-[15px] font-medium text-brand-ink hover:text-brand-deep">
                Войти
              </Link>
            </div>
          ) : (
            <form noValidate onSubmit={(e) => void submit(e)} className="relative flex flex-col gap-4">
              <div>
                <h1 className="text-[24px] leading-tight font-bold tracking-[-0.02em] text-ink">Регистрация компании</h1>
                <p className="mt-1 text-[15px] text-muted">Заявки, заказы, мастера и деньги — в одном месте. Начните с бесплатного тарифа.</p>
              </div>
              <FormRow label="Название компании" required>
                {(id) => <Input id={id} icon={Building2} maxLength={80} autoComplete="organization" value={company} onChange={(e) => setCompany(e.target.value)} />}
              </FormRow>
              <FormRow label="Ваше имя" required>
                {(id) => <Input id={id} icon={UserRound} maxLength={80} autoComplete="name" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />}
              </FormRow>
              <FormRow label="Логин — email или телефон" required>
                {(id) => <Input id={id} icon={Mail} maxLength={120} autoComplete="username" placeholder="name@company.kz или 7701…" value={login} onChange={(e) => setLogin(e.target.value)} />}
              </FormRow>
              <FormRow label="Пароль" required hint={`Не короче ${passwordMin("owner")} символов`}>
                {(id) => (
                  <div className="relative">
                    <Input id={id} icon={Lock} type={show ? "text" : "password"} autoComplete="new-password" maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
                    <button type="button" onClick={() => setShow((v) => !v)} className="absolute top-1/2 right-3.5 -translate-y-1/2 text-muted hover:text-ink" aria-label={show ? "Скрыть пароль" : "Показать пароль"}>
                      {show ? <EyeOff size={19} /> : <Eye size={19} />}
                    </button>
                  </div>
                )}
              </FormRow>
              <FormRow label="Город">
                {(id) => (
                  <Select id={id} value={city} onChange={(e) => setCity(e.target.value)}>
                    {CITIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                )}
              </FormRow>
              {/* Поле-ловушка: людям не видно, боты заполняют. */}
              <input type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} className="absolute -left-[9999px] h-px w-px opacity-0" aria-hidden />
              <label className="flex items-start gap-2.5 text-[14px] text-ink-2">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#b07200]" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>Согласен на обработку персональных данных</span>
              </label>
              {error && (
                <p className="text-[14px] text-bad-ink" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" size="lg" full disabled={busy}>
                {busy ? "Создаём компанию…" : "Зарегистрировать компанию"}
              </Button>
              <p className="text-center text-[14px] text-muted">
                Уже есть доступ?{" "}
                <Link to="/login" className="font-medium text-brand-ink hover:text-brand-deep">
                  Войти
                </Link>
              </p>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
