# P3W Discord Bot v5

ИИ-чат (Gemini) + базовая модерация + статистика войса. RPG-модуль удалён.

## Переменные окружения

Обязательные: `TOKEN`, `CLIENT_ID`, `GUILD_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

ИИ:
- `GEMINI_API_KEY`, `GEMINI_MODEL` (по умолч. `gemini-2.5-flash-lite`), `GEMINI_CHAT_MODELS` (fallback-список), `GEMINI_IMAGE_MODELS`
- `BASE_PROMPT` — доп. стиль общения; `PREFIX` — префикс команд (`!`)
- `CONTEXT_MAX_TURNS` (25), `CONTEXT_SUMMARY_EVERY` (30)
- `AI_USER_COOLDOWN_MS` (4000), `IMAGE_USER_COOLDOWN_MS` (20000) — антиспам на пользователя

## База данных

Схема таблицы не менялась, ничего перезапускать в Supabase не нужно.

## Команды

ИИ: `/say`, `/image`, `!say`, `!image`, упоминание бота или реплай на него. `/forget` (админ) чистит память канала.

Админ: `/clear` (с фильтром по пользователю), `/msg`, `/forget`, `/jtm`.

Статистика: `/time`, `/user`, `/top`, `/life`, статус раз в час. Прочее: `/ping`.


## Игровые новости в Discord

После обновления бота администратор сервера может выбрать канал публикации:

- `/news channel` — выбрать текстовый канал или канал объявлений;
- `/news status` — проверить выбранный канал и состояние;
- `/news test` — отправить тестовый embed;
- `/news disable` — приостановить публикацию.

Выбор и история отправленных уведомлений сохраняются в существующем поле `bot_state.ai_memory`; отдельная таблица или SQL-миграция не нужны. Настройка хранится отдельно для каждого сервера.

### Приём публикаций от внешнего сборщика

Добавь в переменные окружения Render секрет `GAME_NEWS_API_KEY` (длинный случайный токен). Не публикуй его в репозитории и не отправляй в Discord.

Endpoint: `POST /api/game-news`

Заголовок: `Authorization: Bearer <GAME_NEWS_API_KEY>`

Пример JSON:

```json
{
  "id": "steam-app-12345-uk",
  "title": "Название игры",
  "description": "Краткое описание акции",
  "source": "Steam",
  "url": "https://store.steampowered.com/",
  "price": "₴199",
  "old_price": "₴999",
  "discount": "-80%",
  "expires_at": "2026-11-10T20:00:00+02:00",
  "image_url": "https://example.com/game-cover.jpg"
}
```

`id` должен быть стабильным идентификатором предложения для защиты от повторной отправки. Поле `guild_id` необязательно, если в Render задан `GUILD_ID`; для нескольких серверов его можно передавать отдельно. Endpoint принимает JSON до 32 KB и публикует только в канал, выбранный через `/news channel`.

Этот endpoint — приёмник готовых предложений. Сам ежедневный сбор скидок/раздач и их проверка подключаются отдельным сборщиком.

## Запуск

```bash
npm install
npm start
```
