import { Download, Ellipsis, Filter, ListFilter, MapPin, Pencil, Plus, Search, UserRound, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { CITIES, SOURCES, SOURCE_IDS } from "../data/catalog";
import { useNow, useUi } from "../data/hooks";
import { clientState } from "../data/logic";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Source } from "../components/icons";
import { Avatar, Badge, Button, EmptyState, Input, Loading, Menu, MenuItem, MobileFilters, PageHeader, Pagination, Select } from "../components/ui";
import { date, phone } from "../lib/format";
import { exportCsv, stamp } from "../lib/csv";

const PER_PAGE = 10;
const STATES = ["В работе", "Активный", "Новый", "Неактивен", "Потенциальный"];

export default function Clients() {
  const now = useNow();
  const nav = useNavigate();
  const ui = useUi();
  const [q, setQ] = useState("");
  const [city, setCity] = useState("");
  const [source, setSource] = useState("");
  const [state, setState] = useState("");
  const [page, setPage] = useState(1);
  const [dq, setDq] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  // Поиск — на сервере (имя через поисковый индекс, телефон — точно), фильтры — здесь.
  const list = useQuery(api.clients.list, { q: dq || undefined });

  const rows = useMemo(
    () =>
      (list ?? [])
        .map((c) => ({ c, count: c.ordersCount ?? 0, last: c.lastOrderAt, st: clientState(c, now) }))
        .filter(({ c, st }) => (!city || c.city === city) && (!source || c.source === source) && (!state || st.label === state)),
    [list, city, source, state, now],
  );

  useEffect(() => setPage(1), [q, city, source, state]);
  const filtered = q || city || source || state;

  return (
    <>
      <PageHeader
        title="Клиенты"
        subtitle="Все ваши клиенты, их контакты и история заказов"
        actions={
          <Button
            variant="secondary"
            icon={Download}
            className="h-[46px]"
            disabled={!rows.length}
            onClick={() =>
              exportCsv(
                [
                  ["Клиент", "Тип", "Телефон", "Email", "Город", "Адрес", "Источник", "Заказов", "Последний заказ", "Статус", "Теги"],
                  ...rows.map(({ c, count, last, st }) => [c.name, c.kind === "company" ? "Компания" : "Частное лицо", phone(c.phone), c.email, c.city, c.address, SOURCES[c.source].label, count, last ? date(last) : "", st.label, c.tags.join(", ")]),
                ],
                `klienty-${stamp()}.csv`,
              )
            }
          >
            Экспорт
          </Button>
        }
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[1.6fr_1fr_1fr_1fr_auto]">
        <Input icon={Search} placeholder="Поиск по имени, телефону или компании..." value={q} onChange={(e) => setQ(e.target.value)} className="[&_input]:h-[48px] [&_input]:border-line" />
        <MobileFilters active={!!(city || source || state)}>
        <Select icon={MapPin} value={city} onChange={(e) => setCity(e.target.value)} className="[&_select]:h-[48px] [&_select]:border-line">
          <option value="">Все города</option>
          {CITIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
        <Select icon={Filter} value={source} onChange={(e) => setSource(e.target.value)} className="[&_select]:h-[48px] [&_select]:border-line">
          <option value="">Все источники</option>
          {SOURCE_IDS.map((s) => (
            <option key={s} value={s}>
              {SOURCES[s].label}
            </option>
          ))}
        </Select>
        <Select icon={ListFilter} value={state} onChange={(e) => setState(e.target.value)} className="[&_select]:h-[48px] [&_select]:border-line">
          <option value="">Все статусы</option>
          {STATES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </Select>
        <Button
          variant="soft"
          icon={Filter}
          className="h-[48px]"
          disabled={!filtered}
          onClick={() => {
            setQ("");
            setCity("");
            setSource("");
            setState("");
          }}
        >
          Сбросить
        </Button>
        </MobileFilters>
      </div>

      <div className="card mt-4 p-3 sm:p-4">
        {list === undefined ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState icon={Users} title="Клиентов не нашли" text="Измените запрос или добавьте нового клиента." action={<Button icon={Plus} onClick={() => ui.openClient()}>Новый клиент</Button>} />
        ) : (
          <>
            <div className="scroll-x">
              <table className="tbl min-w-[960px]">
                <thead>
                  <tr>
                    <th>Клиент</th>
                    <th>Телефон</th>
                    <th>Город</th>
                    <th>Источник</th>
                    <th>Последний заказ</th>
                    <th className="text-center">Заказы</th>
                    <th>Статус</th>
                    <th className="text-right">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice((page - 1) * PER_PAGE, page * PER_PAGE).map(({ c, count, last, st }) => (
                    <tr key={c.id} className="row-link" onClick={() => nav(`/clients/${c.id}`)}>
                      <td className="py-3.5">
                        <span className="flex items-center gap-3.5">
                          <Avatar name={c.name} size={46} />
                          <span className="min-w-0 leading-tight">
                            <span className="block max-w-[220px] truncate text-[15px] font-semibold text-ink">{c.name}</span>
                            <span className="text-[13px] text-muted">{c.kind === "company" ? "Бизнес-клиент" : "Частное лицо"}</span>
                          </span>
                        </span>
                      </td>
                      <td className="whitespace-nowrap text-ink-2 tabular-nums">{phone(c.phone)}</td>
                      <td className="text-ink-2">{c.city}</td>
                      <td>
                        <Source source={c.source} className="text-ink-2" />
                      </td>
                      <td className="whitespace-nowrap text-ink-2">{last ? date(last) : <span className="text-muted">—</span>}</td>
                      <td className="text-center font-medium text-ink tabular-nums">{count}</td>
                      <td>
                        <Badge tone={st.tone}>{st.label}</Badge>
                      </td>
                      <td onClick={(e) => e.stopPropagation()} className="text-right">
                        <Menu
                          width={220}
                          trigger={(toggle) => (
                            <button onClick={toggle} aria-label="Действия" className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] text-ink-2 hover:bg-[#f4f2ec]">
                              <Ellipsis size={18} className="rotate-90" />
                            </button>
                          )}
                        >
                          {(close) => (
                            <>
                              <MenuItem icon={UserRound} onClick={() => (close(), nav(`/clients/${c.id}`))}>
                                Открыть карточку
                              </MenuItem>
                              <MenuItem icon={Plus} onClick={() => (close(), ui.openLead({ clientId: c.id }))}>
                                Новая заявка
                              </MenuItem>
                              <MenuItem icon={Pencil} onClick={() => (close(), ui.openClient(c.id))}>
                                Редактировать
                              </MenuItem>
                            </>
                          )}
                        </Menu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} total={rows.length} perPage={PER_PAGE} onChange={setPage} noun="клиентов" />
          </>
        )}
      </div>
    </>
  );
}
