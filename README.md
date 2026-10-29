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

## Запуск

```bash
npm install
npm start
```
