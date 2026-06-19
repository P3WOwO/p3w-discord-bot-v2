# P3W Discord Bot

Чистая версия бота:
- Gemini для чата
- Gemini для картинок
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
- `GEMINI_IMAGE_MODELS` — список моделей для картинок через запятую

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