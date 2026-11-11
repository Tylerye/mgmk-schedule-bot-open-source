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
