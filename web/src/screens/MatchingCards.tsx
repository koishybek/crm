// Карточки владельца в «Настройках» для подбора исполнителя: справочник районов городов (ТЗ п.12.3) и AI-подбор
// (п.12.7, п.23.1) — по умолчанию выключен: включая его, владелец соглашается передавать в LLM обезличенные данные
// заказа и мастеров (услуга, город и район, срок, навыки, показатели — без клиента и имён).
import { useQuery } from "convex/react";
import { MapPinned, Plus, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import { CITIES } from "../data/catalog";
import { DISTRICT_LIMITS, districtKey, type DistrictMap } from "../data/cities";
import { useMe } from "../data/hooks";
import { saveAiMatch, saveDistricts, useDistricts } from "../data/matchActions";
import { report } from "../data/store";
import { Badge, Button, Card, Input, Loading, Select, Toggle } from "../components/ui";

/** Только владелец: остальным карточки не показываем (и сервер не даст их менять). */
export function MatchingCards() {
  const me = useMe();
  if (me?.role !== "owner") return null;
  return (
    <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.3fr_1fr]">
      <DistrictsCard />
      <AiMatchCard />
    </div>
  );
}

function AiMatchCard() {
  const s = useQuery(api.aiMatch.settings);
  const [busy, setBusy] = useState(false);
  if (s === undefined) {
    return (
      <Card icon={Sparkles} title="AI-подбор исполнителя">
        <Loading className="py-6" />
      </Card>
    );
  }
  const toggle = async (on: boolean) => {
    setBusy(true);
    report(await saveAiMatch(on), on ? "AI-подбор включён" : "AI-подбор выключен");
    setBusy(false);
  };
  return (
    <Card
      icon={Sparkles}
      title="AI-подбор исполнителя"
      titleExtra={
        !s.connected ? (
          <Badge tone="gray" size="sm">
            AI не подключён
          </Badge>
        ) : undefined
      }
    >
      <p className="text-[13.5px] text-muted">
        В окне «Назначить исполнителя» кнопка «Спросить AI»: AI расставит до 5 подходящих по правилам мастеров и коротко объяснит выбор. Назначает всегда человек; автоподбор работает только по правилам.
      </p>
      <div className="mt-3">
        <Toggle checked={s.enabled} onChange={(on) => !busy && void toggle(on)} label={s.enabled ? "Включено" : "Выключено"} />
      </div>
      <ul className="mt-3 space-y-1.5 text-[13px] text-ink-2">
        <li>В AI уходит: услуга, город и район, срок, срочность, нужные навыки и показатели мастеров без имён (рейтинг, загрузка, сдача вовремя, отказы).</li>
        <li>Не уходит: имя, телефон и адрес клиента, описание заказа, цены, имена мастеров.</li>
        <li>Выключено, AI не подключён или не ответил — показываем рекомендацию по правилам с объяснением.</li>
      </ul>
      {!s.connected && <p className="mt-2 text-[12.5px] text-warn-ink">Для AI-подбора нужен основной LLM: переменные LLM_API_KEY (и при необходимости LLM_BASE_URL, LLM_MODEL) на сервере.</p>}
    </Card>
  );
}

function DistrictsCard() {
  const saved = useDistricts();
  const [draft, setDraft] = useState<DistrictMap | null>(null);
  const [adding, setAdding] = useState<Record<string, string>>({});
  const [newCity, setNewCity] = useState("");
  const [busy, setBusy] = useState(false);
  const map = draft ?? saved;
  useEffect(() => setAdding({}), [saved]);
  const cities = Object.keys(map);
  const freeCities = CITIES.filter((c) => !cities.includes(c));

  const change = (city: string, list: string[]) => setDraft({ ...map, [city]: list });
  const add = (city: string) => {
    const name = (adding[city] ?? "").replace(/\s+/g, " ").trim().slice(0, DISTRICT_LIMITS.name);
    const list = map[city] ?? [];
    if (!name || list.some((d) => districtKey(d) === districtKey(name))) return;
    change(city, [...list, name]);
    setAdding((a) => ({ ...a, [city]: "" }));
  };
  const save = async (next: DistrictMap | null) => {
    setBusy(true);
    const ok = report(await saveDistricts(next), next ? "Справочник районов сохранён" : "Вернули районы по умолчанию");
    setBusy(false);
    if (ok) setDraft(null);
  };

  return (
    <Card icon={MapPinned} title="Районы городов">
      <p className="text-[13.5px] text-muted">
        Район указывают в заявке и заказе, у мастера — районы, где он работает (пусто — весь город). Мастер с районами видит заказы только своих районов и заказы без района.
      </p>
      <div className="mt-3 flex flex-col gap-3">
        {cities.map((city) => (
          <div key={city} className="rounded-[12px] border border-line p-3">
            <div className="text-[14px] font-semibold text-ink">{city}</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(map[city] ?? []).map((d) => (
                <span key={d} className="inline-flex items-center gap-1 rounded-[8px] bg-[#f4f2ec] py-1 pr-1 pl-2.5 text-[13px] text-ink">
                  {d}
                  <button type="button" aria-label={`Убрать район ${d}`} className="hit relative rounded-[6px] p-0.5 text-muted hover:bg-white hover:text-bad" onClick={() => change(city, (map[city] ?? []).filter((x) => x !== d))}>
                    <X size={14} aria-hidden />
                  </button>
                </span>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <Input
                aria-label={`Новый район, ${city}`}
                placeholder="Новый район"
                className="flex-1"
                value={adding[city] ?? ""}
                maxLength={DISTRICT_LIMITS.name}
                onChange={(e) => setAdding((a) => ({ ...a, [city]: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && add(city)}
              />
              <Button size="sm" variant="secondary" icon={Plus} className="bg-white" onClick={() => add(city)}>
                Добавить
              </Button>
            </div>
          </div>
        ))}
        {freeCities.length > 0 && (
          <div className="flex gap-2">
            <Select aria-label="Город" className="flex-1" value={newCity} onChange={(e) => setNewCity(e.target.value)}>
              <option value="">Добавить город…</option>
              {freeCities.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="secondary"
              className="bg-white"
              disabled={!newCity}
              onClick={() => {
                change(newCity, []);
                setNewCity("");
              }}
            >
              Добавить
            </Button>
          </div>
        )}
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void save(null)}>
          Районы по умолчанию
        </Button>
        {draft && (
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            Отменить
          </Button>
        )}
        <Button size="sm" disabled={busy || !draft} onClick={() => draft && void save(draft)}>
          Сохранить
        </Button>
      </div>
    </Card>
  );
}
