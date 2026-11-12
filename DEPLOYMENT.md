# Настройка своего экземпляра

Архитектура: Cloudflare Worker принимает Telegram webhook и запускает минутные
задачи, D1 хранит состояние, GitHub Actions обрабатывает изменившиеся PDF.
Локальный Node runtime — отдельный polling fallback. Не запускайте его с тем же
токеном одновременно с рабочим webhook.

## Конфигурация и секреты

1. Установите Node >=22.13.0 и выполните `npm ci`.
2. Для локального запуска скопируйте `.env.example` в `.env`, задайте свои
   BOT_TOKEN и ADMIN_USER_ID. Файл `.env` не должен попадать в Git.
3. Для Cloudflare скопируйте `wrangler.example.jsonc` в `wrangler.jsonc`.
   Укажите своё имя Worker, ADMIN_USER_ID, источник Drive, GitHub repository/ref
   и ID собственной D1. Настоящий `wrangler.jsonc` игнорируется Git.
4. Cloudflare secrets: BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, PARSER_SHARED_SECRET,
   GITHUB_ACTIONS_TOKEN. Добавляйте через штатное хранилище secrets, не через
   `vars` и не в исходный код.
5. GitHub Actions repository secrets: WORKER_BASE_URL и PARSER_SHARED_SECRET.
   Токен Telegram не нужен GitHub Actions. GitHub token для Worker ограничьте
   своим репозиторием и правом Actions: write для запуска parser workflow.

Имена переменных и пустые шаблоны допустимы в Git; реальные токены, приватные
ключи, базы, state snapshots и локальные отчёты — нет. `npm run check:privacy`
проверяет отслеживаемые файлы; CI повторяет эту проверку. Это дополнительный
барьер, а не гарантия отсутствия любого секрета во всей истории Git.

## Проверки и первичный запуск

```powershell
npm run check:privacy
npm test
npx --no-install wrangler deploy --dry-run
```

Для нового экземпляра отдельно создайте свою D1, примените `migrations/`,
добавьте secrets и разверните Worker. Подключайте webhook только после остановки
polling. Проверяйте `/healthz`, минутные задачи, доставку webhook и parser Actions.
Не выполняйте первичный state import или `/setup` повторно на работающем экземпляре
ради диагностики. Секрет webhook передавайте штатным secret header Telegram.

Пример команд для **нового** экземпляра после заполнения своего wrangler.jsonc:

```sh
npx wrangler login
npx wrangler d1 create your-schedule-bot
# Вставьте выданный database_id в свой wrangler.jsonc
npx wrangler d1 migrations apply your-schedule-bot --remote
npx wrangler secret put BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put PARSER_SHARED_SECRET
npx wrangler secret put GITHUB_ACTIONS_TOKEN
npx wrangler deploy
```

Команды `secret put` запрашивают значение интерактивно. Не вставляйте секреты
в командную строку или Git. Для регистрации нового webhook заполните локальный
`.env`, включая WORKER_BASE_URL и TELEGRAM_WEBHOOK_SECRET, затем выполните
`node --env-file=.env scripts/configure-telegram-webhook.js`.
После этого владелец подключает свою группу командой `/setup` в Telegram.
Не выполняйте этот порядок повторно для уже работающего чужого бота.

Личные расписания включаются отдельно по [PERSONAL.md](PERSONAL.md): отдельная
D1, второй Worker, общий PERSONAL_SHARED_SECRET и service bindings. Первый
запуск оставляйте закрытым; PERSONAL_PUBLIC=true открывает регистрацию всем.

## Что ещё привязано к исходному экземпляру

Это код действующего бота, а не полностью универсальный шаблон. Перед своим
деплоем проверьте `MAINTENANCE_ORIGIN` в `cloudflare/worker.js`: он должен указывать
на ваш Worker, иначе минутные запросы пойдут к исходному экземпляру.
Проверьте также разрешённые учительские аккаунты в `src/teachers.js`, owner preview
в `cloudflare/teachers.js`, права куратора в `src/attention.js` и названия группы
в parser workflow. Не копируйте чужие права доступа в свой экземпляр.

Maintenance lanes должны оставаться отдельными HTTP invocations с собственными
leases; тяжёлый PDF parsing выполняется в Actions. Сохраняйте существующие IDs
публикаций и закрепа при обновлениях и не повторяйте отправки со статусом uncertain.

## Перед переводом существующего репозитория в public

Удаление файла из текущего дерева не удаляет старые версии из Git-истории.
Проверьте историю, ветки, теги, Actions logs/artifacts, fixtures и настройки доступа.
При обнаружении секрета сначала отзовите/замените его, затем отдельно согласуйте
очистку истории. В коде пока остаются привязки к исходным аккаунтам и реальные
публичные учебные PDF; до открытия оцените их публикацию и обезличивание.
Этот шаг сам по себе не разрешает изменение видимости репозитория.

## Security configuration and release

Public liveness is GET /healthz with only {"alive":true}, without D1. GET /internal/health requires a separate HEALTH_READ_SECRET and returns 503 on stale/error. Its local diagnostic throttle is six requests/minute/isolate, not a global quota.

Set WORKER_PUBLIC_ORIGIN to the exact HTTPS origin of this Worker. Set MAINTENANCE_SIGNING_SECRET (at least 32 random characters), distinct from parser/webhook/health secrets. Maintenance uses origin/path/time/body-bound HMAC and durable minute admission; raw credentials are not transmitted. Redirects are rejected; workerd uses manual mode and rejects non-success statuses.

Set CURATOR_USER_ID explicitly or leave empty. OWNER_PREVIEW_ENABLED defaults false; enabling it reserves preview for ADMIN_USER_ID. TEACHER_USER_IDS is a JSON object mapping existing teacher identifiers to verified numeric IDs for NEW enrollment. Existing enrolled seats remain authoritative; username alone never enrolls. Do not rename teacher identifiers or recreate seats.

HTTP state import is removed. The old import helper refuses before reading state or networking. Never repeat setup as a migration mechanism.

Ingress bindings enforce 10/10 seconds and 30/minute per user, 120/minute per instance, plus durable admission. Rate binding counters are approximate per location. User limits do not apply to membership-change notifications. Personal budget uses conservative concurrent reservations within existing daily ceilings; stopped mode also stops manual actions. Queue and technical storage caps reject excess work without removing receipts.

Apply only the NEW migration 0009_security_limits.sql to the existing main database. Apply only personal migration 0002_security_limits.sql to the existing personal database. Never replay the initial personal schema. They add guards/timestamps and preserve publication IDs. Retention is read-only by default: retentionCandidates reports counts, does not delete. Protect all sends/uncertain receipts; review any later cleanup separately.

PDF downloads are capped at 20 MiB, catalog HTML at 2 MiB. Extraction runs in a credential-free child process with 256 MiB V8 heap and 60-second deadline, plus page/item/text/coordinate bounds. Heap is not a hard OS RSS limit. Rejected sources retain last good schedules.

Release: verify tests/privacy/dependencies and both dry-run bundles; record current versions/recovery point; add new secrets; apply additive migrations; deploy personal then main from the PRIVATE checkout; verify authenticated readiness and natural minute lanes. Public source must retain synthetic fixtures and empty privilege bindings. Code rollback must retain databases, receipts and message IDs; restoring the old maintenance protocol also requires restoring its matching configuration. Never claim liveness alone proves delivery health.
