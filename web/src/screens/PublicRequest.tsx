// Публичная форма заявки (ТЗ п.6 «Сайт»): ссылка /zayavka для рекламы и соцсетей или iframe на сайте компании (?embed=1).
// Отправка — на тот же эндпоинт, что и формы на сайте компании (POST /public/lead). Защита от ботов: поле-ловушка
// и время заполнения (startedAt); лимиты и проверка номера — на сервере.
import { useQuery } from "convex/react";
import { CircleCheck, MapPin, UserRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { api } from "../../convex/_generated/api";
import { Logo } from "../components/icons";
import { Button, FormRow, Input, Select, Textarea } from "../components/ui";
import { APP_NAME, CITIES } from "../data/catalog";
import { submitPublicLead } from "../data/publicApi";
import { cn, digits } from "../lib/format";
import { PhoneInput } from "./drawers";

type Field = "name" | "phone" | "consent";
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

/** Казахстанский номер в маске: +7, затем 6 или 7 (мобильные 70x/747/77x, городские 7xx). */
const validPhone = (masked: string) => /^7[67]\d{9}$/.test(digits(masked));

export default function PublicRequest() {
  const [params] = useSearchParams();
  const embed = params.get("embed") === "1";
  const catalog = useQuery(api.catalog.publicList);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [name, setName] = useState("");
  const [ph, setPh] = useState("");
  const [serviceId, setServiceId] = useState(() => params.get("service") ?? "");
  const [city, setCity] = useState<string>(() => {
    const c = params.get("city");
    return c && (CITIES as readonly string[]).includes(c) ? c : CITIES[0];
  });
  const [description, setDescription] = useState("");
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState("");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<number | null>(null);

  useEffect(() => {
    const prev = document.title;
    document.title = `Заявка — ${APP_NAME}`;
    return () => {
      document.title = prev;
    };
  }, []);

  // Во встроенном виде — прозрачный фон и высота для родительской страницы (скрипт из «Настроек» подгоняет iframe).
  useEffect(() => {
    if (!embed) return;
    const prevBg = document.body.style.background;
    document.body.style.background = "transparent";
    if (window.parent === window) return () => void (document.body.style.background = prevBg);
    const post = () => window.parent.postMessage({ type: "hms:height", height: document.documentElement.scrollHeight }, "*");
    post();
    const ro = new ResizeObserver(post);
    ro.observe(document.body);
    return () => {
      ro.disconnect();
      document.body.style.background = prevBg;
    };
  }, [embed]);

  // Неизвестная услуга из ссылки (?service=…) — сбрасываем, когда справочник загрузится.
  useEffect(() => {
    if (catalog && serviceId && !catalog.services.some((s) => s.id === serviceId)) setServiceId("");
  }, [catalog, serviceId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Partial<Record<Field, string>> = {};
    if (name.trim().length < 2) next.name = "Как к вам обращаться?";
    if (!validPhone(ph)) next.phone = "Введите номер полностью: +7 7XX XXX XX XX";
    if (!consent) next.consent = "Без согласия мы не можем принять заявку";
    setErrors(next);
    setFormError("");
    if (Object.keys(next).length) return;
    setSending(true);
    const utm: Record<string, string> = {};
    for (const k of UTM_KEYS) {
      const val = params.get(k);
      if (val) utm[k] = val.slice(0, 100);
    }
    const r = await submitPublicLead({ name: name.trim(), phone: ph, serviceId: serviceId || undefined, city, description: description.trim(), consent, startedAt, website, utm });
    setSending(false);
    if (!r.ok) return setFormError(r.error);
    setDone(r.value.number);
    // На телефоне человек внизу длинной формы — показываем подтверждение сверху.
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const again = () => {
    setDone(null);
    setDescription("");
    setServiceId("");
    setStartedAt(Date.now());
  };

  return (
    <div className={cn("min-h-dvh", embed ? "" : "bg-page")}>
      {!embed && (
        <header className="mx-auto flex w-full max-w-[560px] items-center px-4 pt-6 pb-2">
          <Logo />
        </header>
      )}
      <main className={cn("mx-auto w-full max-w-[560px]", embed ? "p-1" : "px-4 pt-3 pb-10")}>
        <div className={cn("card", embed ? "p-5" : "p-5 sm:p-7")}>
          {done !== null ? (
            <div className="flex flex-col items-center py-6 text-center" role="status">
              <span className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-ok-bg text-ok">
                <CircleCheck size={34} aria-hidden />
              </span>
              <h1 className="mt-4 text-[22px] font-bold tracking-[-0.02em] text-ink">Заявка №{done} принята</h1>
              <p className="mt-1.5 max-w-sm text-[15px] text-ink-2">Перезвоним в рабочее время и подберём мастера. Номер заявки пригодится, если будете звонить сами.</p>
              <Button variant="secondary" className="mt-6" onClick={again}>
                Отправить ещё одну заявку
              </Button>
            </div>
          ) : (
            <form noValidate onSubmit={(e) => void submit(e)} className="relative flex flex-col gap-4">
              <div>
                <h1 className="text-[24px] leading-tight font-bold tracking-[-0.02em] text-ink sm:text-[26px]">Оставьте заявку</h1>
                <p className="mt-1 text-[15px] text-muted">Опишите задачу — перезвоним в рабочее время и подберём мастера.</p>
              </div>

              <FormRow label="Имя" required hint={errors.name && <span className="text-bad-ink">{errors.name}</span>}>
                {(id) => (
                  <Input id={id} icon={UserRound} autoComplete="name" maxLength={80} placeholder="Как к вам обращаться" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} />
                )}
              </FormRow>

              <FormRow label="Телефон" required hint={errors.phone && <span className="text-bad-ink">{errors.phone}</span>}>
                {(id) => <PhoneInput id={id} value={ph} onChange={setPh} />}
              </FormRow>

              <FormRow label="Услуга">
                {(id) => (
                  <Select id={id} value={serviceId} onChange={(e) => setServiceId(e.target.value)} disabled={!catalog}>
                    <option value="">{catalog ? "Не знаю / другое" : "Загружаем услуги…"}</option>
                    {catalog?.categories.map((c) => {
                      const items = catalog.services.filter((s) => s.category === c.id);
                      return items.length ? (
                        <optgroup key={c.id} label={c.label}>
                          {items.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.label}
                            </option>
                          ))}
                        </optgroup>
                      ) : null;
                    })}
                  </Select>
                )}
              </FormRow>

              <FormRow label="Город">
                {(id) => (
                  <Select id={id} icon={MapPin} value={city} onChange={(e) => setCity(e.target.value)}>
                    {CITIES.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </Select>
                )}
              </FormRow>

              <FormRow label="Что случилось">
                {(id) => (
                  <Textarea
                    id={id}
                    rows={4}
                    maxLength={2000}
                    placeholder="Например: не холодит кондиционер, 3 этаж, удобно завтра после 18:00"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                )}
              </FormRow>

              {/* Ловушка для ботов: людям не видна и недоступна с клавиатуры. */}
              <div aria-hidden="true" className="pointer-events-none absolute -left-[10000px] h-px w-px overflow-hidden">
                <label>
                  Сайт
                  <input type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
                </label>
              </div>

              <div>
                <label className="flex cursor-pointer items-start gap-3 text-[14px] text-ink-2">
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[#f2a900]" aria-invalid={!!errors.consent} />
                  <span>
                    Согласен(на) на сбор и обработку моих персональных данных для связи по заявке<span className="ml-0.5 text-bad">*</span>
                  </span>
                </label>
                {errors.consent && <div className="mt-1.5 text-[12.5px] text-bad-ink">{errors.consent}</div>}
              </div>

              {formError && (
                <div className="rounded-[10px] bg-bad-bg px-3.5 py-2.5 text-[14px] font-medium text-bad-ink" role="alert">
                  {formError}
                </div>
              )}

              <Button type="submit" size="lg" full disabled={sending}>
                {sending ? "Отправляем…" : "Отправить заявку"}
              </Button>
            </form>
          )}
        </div>
        {!embed && <p className="mt-4 text-center text-[12.5px] text-muted">{APP_NAME}</p>}
      </main>
    </div>
  );
}
