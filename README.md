# P3W Discord Bot

Чистая версия бота:
- Gemini для чата
- Gemini для картинок через рабочие model IDs и fallback-список
- долгий контекст чата через сжатую память канала
- без системы "да / нет" для памяти
- voice times в Supabase
- команды `ping`, `say`, `image`, `time`, `user`, `top`, `life`, `msg`, `purge`, `jtm`

## Переменные окружения

Обязательные:
- `TOKEN`
- `CLIENT_ID`
- `GUILD_ID`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Для Gemini:
- `GEMINI_API_KEY`
- `GEMINI_MODEL` — модель чата, по умолчанию `gemini-2.5-flash-lite`
- `GEMINI_CHAT_MODELS` — список моделей чата через запятую
- `GEMINI_IMAGE_MODELS` — список моделей для картинок через запятую. Поддерживаются `gemini-3.1-flash-image`, `gemini-3-pro-image`, `gemini-2.5-flash-image`, а также корректные IDs Imagen 4 вроде `imagen-4.0-ultra-generate-001`.

Дополнительно:
- `BASE_PROMPT` или `BASE_STYLE_PROMPT`
- `PREFIX` — префикс команд, по умолчанию `!`
- `MEMORY_COMPACT_AFTER_TURNS` — через сколько сообщений сжимать память канала, по умолчанию `8`
- `SUPABASE_TABLE` — по умолчанию `bot_state`
- `SUPABASE_ROW_ID` — по умолчанию `main`

## База данных

Запусти `supabase_bot_state.sql` в Supabase SQL Editor.

## Локальный запуск

```bash
npm install
npm start
```

## Что хранится в памяти

Только контекст чата:
- тема разговора
- договорённости
- незакрытые вопросы
- общий тон и стиль канала

Не хранится отдельный профиль пользователя ради профиля.

## Что было исправлено после чистой сборки
- добавлен `!ping` как текстовый тест
- бот больше не молчит из-за жёсткой проверки одного guild для безопасных ответов
- если `GUILD_ID` пустой, он всё равно отвечает на mention/reply и команды

## Как полностью очистить память

Если нужно начать с чистого чата, удали или обнули значения в строке `bot_state` в Supabase:

```sql
UPDATE bot_state
SET ai_memory = '{}'::jsonb,
    voice_times = '{}'::jsonb,
    life_state = '{}'::jsonb
WHERE row_id = 'main';
```

Если хочешь оставить только память чата, но сбросить голосовую статистику, очисти только `voice_times`.


## Health check
Use `/health`, `/healthz`, `/healt`, or `/` for the anti-AFK ping.

## Resetting memory
To make the bot feel clean again, clear the `ai_memory`, `voice_times`, and `life_state` columns for the `main` row in `bot_state`.
