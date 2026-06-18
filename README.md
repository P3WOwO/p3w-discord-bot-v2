# P3W Discord Bot

## Что это
Discord-бот с:
- командой времени в войсе
- топом по войсу
- жизнью бота
- админскими командами `msg`, `purge`, `jtm`
- AI-ответами через Gemini
- хранением состояния в Supabase

## Что нужно создать
1. Проект в Supabase
2. Таблицу из `supabase_bot_state.sql`
3. Web Service в Render

## Переменные окружения
Обязательные:
- `TOKEN`
- `CLIENT_ID`
- `GUILD_ID`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Для AI:
- `GEMINI_API_KEY`
- `GEMINI_MODEL` (необязательно, по умолчанию `gemini-2.5-flash-lite`)

Дополнительно:
- `SUPABASE_TABLE` (необязательно, по умолчанию `bot_state`)
- `SUPABASE_ROW_ID` (необязательно, по умолчанию `main`)

## Установка локально
```bash
npm install
npm start
```

## Деплой на Render
- Создай Web Service из GitHub-репозитория
- Build Command: `npm install`
- Start Command: `npm start`
- Добавь переменные окружения в Render Dashboard
- Задеплой

## Supabase
- Открой SQL Editor
- Вставь `supabase_bot_state.sql`
- Нажми Run


## Память ИИ
Система памяти теперь хранит:
- краткую общую сводку,
- память по пользователю и по каналу,
- отдельный профиль бота с устойчивой позицией и стилем,
- авто-удаление дублей и слабых/устаревших заметок.

Бот сам решает, что сохранить, а что выкинуть, чтобы контекст не разрастался.
