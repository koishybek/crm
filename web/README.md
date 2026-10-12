# Home Max Service — CRM для сервисного бизнеса

По ТЗ `../CRM_AI_Service_Platform_TZ.docx`.
Этап 1 (MVP): заявки → заказы → лента исполнителей → выполнение → оплата → аналитика.
Этап 2: Telegram-бот (команда и клиенты), AI-разбор звонков и обращений, телефония (АТС), раздел «Звонки».

- **Фронт:** React 19 + Vite + Tailwind 4, статикой на Cloudflare Workers (`wrangler.jsonc`).
- **Бэкенд:** Convex (база, функции, файлы, кроны, вебхук Telegram), проект `servicepro` в команде `koishybek-o`.
- **Вход:** Convex Auth, логин (email или телефон) + пароль. Регистрации нет — аккаунты создаёт владелец.
- **AI:** `../ai-service` — Worker на Cloudflare Workers AI (Whisper large v3 turbo + Llama 3.3 70B), `https://servicepro-ai.koishybek-o.workers.dev`.
- **Название** — константа `APP_NAME` в `src/data/catalog.ts`; профиль бота — `node scripts/setup-telegram.mjs --profile`.
- **Бот:** @oolx_crm_bot («Home Max Service»), вебхук → `https://fleet-weasel-433.convex.site/telegram`.

| | Адрес |
|---|---|
| Рабочий стенд (демо-данные; руководитель — erlan@homemax.kz) | https://servicepro-app.koishybek-o.workers.dev |
| Convex prod | `fleet-weasel-433` |
| Convex dev | `dependable-sheep-588` (адрес в `.env.local`) |
| Старый кликабельный прототип (без сервера) | https://servicepro-demo.koishybek-o.workers.dev |

## Запуск для разработки

```bash
npm install
npm run convex      # выкатывает функции на dev-деплоймент (и следит за изменениями без флага --once)
npm run dev         # http://localhost:5190
npm run typecheck   # фронт + convex
npm test            # серверные тесты (convex-test)
```

Демо-данные (90 дней истории от «сегодня»): `SEED_SECRET=… npm run seed -- --wipe`. На деплойменте должны стоять `SEED_SECRET` и `ALLOW_SEED=1`.
Заливка добавляет звонки: к заявкам «с телефона», пропущенные сегодня и две записи разговоров (`scripts/demo-calls/*.mp3`), которые проходят настоящий AI — через минуту из них появляются заявки. Привязки Telegram при перезаливке сохраняются, ключ АТС не трогается.
Пароль демо-аккаунтов — `Demo-2026`; кнопки быстрого входа видны, только если сборка сделана с `VITE_DEMO_PASSWORD`.

## Выкладка

```bash
npm run deploy:convex                                   # функции → prod
VITE_CONVEX_URL=https://fleet-weasel-433.convex.cloud \
VITE_CONVEX_SITE_URL=https://fleet-weasel-433.convex.site \
npm run deploy                                          # фронт → servicepro-app (wrangler)
```

Переменные Convex (`npx convex env set [--prod] …`, ключи — `node scripts/setup-auth-env.mjs [--prod] SITE_URL=…`):

| Переменная | Зачем |
|---|---|
| `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL` | сессии Convex Auth |
| `APP_URL` | ссылки «Открыть» в Telegram |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` | бот: `node scripts/setup-telegram.mjs [--prod]` берёт токен из `.env.local`, ставит переменные, вебхук и команды |
| `AI_URL`, `AI_SECRET` | AI-сервис (`../ai-service`, секрет — `wrangler secret put AI_SECRET`) |
| `AI_PROVIDER=openai`, `AI_API_KEY` [, `AI_BASE_URL`, `AI_STT_MODEL`, `AI_LLM_MODEL`] | вместо нашего сервиса — любой OpenAI-совместимый API |
| `SEED_SECRET`, `ALLOW_SEED=1` | заливка демо-данных; на боевой базе заказчика `ALLOW_SEED` убрать |

## Боевой запуск у заказчика

1. Очистить prod: `CONVEX_URL=… SEED_SECRET=… npm run seed -- --wipe` и прервать после очистки — или отдельный деплоймент.
2. Создать владельца: `npx convex run --prod seed:bootstrapOwner '{"secret":"…","name":"…","login":"…","password":"…"}'`.
3. Убрать `ALLOW_SEED`, собрать фронт **без** `VITE_DEMO_PASSWORD`.
4. Владелец: «Настройки» → операторы; импорт исполнителей и клиентов из Excel; бот Telegram.
5. Телефония: «Настройки → Телефония» → «Создать ключ подключения»; адрес и ключ — в настройки вебхука облачной АТС.
6. Свой домен для фронта и AI-сервиса: адреса `*.workers.dev` из Казахстана открываются не у всех провайдеров.

## Этап 2: Telegram, AI, телефония

- **Бот для команды** (`convex/telegram.ts`, `convex/worker.ts`): сотрудник или мастер жмёт «Подключить Telegram» в меню профиля. Мастерам новые заказы приходят карточкой с кнопкой «Взять»; дальше заказ ведётся кнопками (подтвердить → начать → выполнено) — те же мутации, что в кабинете. `/orders`, `/feed`. В 9:00 по Алматы — сводка (`convex/digest.ts`): владельцу с деньгами, мастерам — заказы на сегодня.
- **Бот для клиентов** (`convex/bot.ts`): клиент пишет текстом, голосом (расшифровывает AI) или присылает фото → кнопка «Отправить мой номер» → заявка в CRM с источником Telegram и AI-разбором. Следующие сообщения в течение 3 дней дописываются к этой заявке.
- **AI** (`convex/ai.ts`): расшифровка записи → разбор в черновик заявки (услуга только из справочника, город, адрес, когда, бюджет, срочность, имя, вопросы оператору). Фантомные фразы Whisper на тишине вырезаются. Если услуга понятна, звонок сам становится заявкой. В форме новой заявки — «Заполнить с AI»: вставить переписку или загрузить запись.
- **Телефония** (`convex/calls.ts`, `convex/http.ts`): `POST /pbx/events` с ключом в `X-PBX-Secret` или `?secret=`. Пример:

  ```json
  {"event": "ringing",  "callId": "abc-123", "direction": "in", "from": "+77011234567", "to": "+77273450000"}
  {"event": "answered", "callId": "abc-123", "operator": "madina@homemax.kz"}
  {"event": "ended",    "callId": "abc-123", "duration": 184, "recordingUrl": "https://pbx.example/rec/abc-123.mp3"}
  ```

  Понимаются и другие названия полей (`caller`, `callee`, `call_id`, `billsec`, `record_url`, …) и form-data. Входящий звонок всплывает карточкой у владельца и операторов (клиент, заказы, «Новая заявка»), пропущенный — уведомление. Запись по ссылке CRM скачивает в своё хранилище и отдаёт AI.
- Диагностика AI с сервера: `npx convex run aiCheck:run '{"text":"…"}'` (или `storageId` записи).

## Устройство

- `convex/schema.ts` — таблицы; даты — ISO-строки UTC. На заявках и заказах копии имени/телефона клиента, на клиенте — счётчики заказов (`refreshClient`).
- Роли: владелец, оператор, руководитель направления (`categories` на пользователе — видит только эти направления, без клиентской базы), исполнитель.
- Справочник направлений и услуг — таблицы `categories`/`services` (`convex/catalog.ts`), правит владелец в «Настройках»; пока база пуста — значения по умолчанию из `src/data/catalog.ts`. Фронт подменяет справочник после входа (`setCatalog`).
- Экспорт в Excel (CSV) — «Заказы», «Клиенты», «Аналитика».
- `convex/lib/access.ts` — роли (`requireRole`, `scopeOf`/`assertScope` для руководителя); `convex/lib/dto.ts` — наружу только DTO. Исполнитель получает `WorkerOrder`: без цены клиента и маржи, адрес и телефон — после подтверждения.
- «Взять заказ» (`worker.takeFor`) — мутация Convex = сериализуемая транзакция: из двух одновременных побеждает одна.
- Уведомления: `lib/domain.notify` пишет в колокольчик и через планировщик шлёт в Telegram (после коммита). Напоминания о сроке — `crons.ts` раз в 15 минут.
- Формулы метрик — `src/data/metrics.ts` (общие для «Главной» и «Аналитики»), сервер отдаёт срез за период.
