const { ActivityType } = require('discord.js');

const CHECKPOINT_MS = 60 * 1000;
const PRESENCE_REFRESH_MS = 45 * 1000;
const PRESENCE_ROTATE_MS = 60 * 60 * 1000;
const TOP_LIMIT = 10;
const MAX_HISTORY = 8;
const HOME_GUILD_ONLY_REPLY = 'Увы, я не на родном сервере, ничем не помогу';

const MEMORY_RELEVANT_NOTES_LIMIT = 8;
const MEMORY_SUMMARY_LIMIT = 1200;
const MEMORY_NOTE_LIMIT = 280;
const MEMORY_EXTRACTION_MODEL_TEMPERATURE = 0.2;
const MEMORY_CHAT_TEMPERATURE = 0.68;
const MEMORY_MAX_OUTPUT_TOKENS = 1800;
const MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS = 900;

const PRESENCE_VERBS = [
  'Проверяет', 'Собирает', 'Анализирует', 'Поддерживает', 'Рендерит', 'Шлифует',
  'Синхронизирует', 'Упорядочивает', 'Обновляет', 'Подсказывает', 'Чистит', 'Настраивает',
  'Оптимизирует', 'Формирует', 'Пересобирает', 'Вычисляет', 'Разбирает', 'Компилирует'
];

const PRESENCE_NOUNS = [
  'контекст', 'память', 'вайб', 'подсказки', 'идеи', 'мемы', 'сообщения', 'пиксели',
  'настройки', 'факты', 'промпты', 'историю', 'статус', 'инфу', 'чаты', 'проекты',
  'объяснения', 'планы', 'заметки', 'время', 'voice_times', 'картинки', 'тексты'
];

const SYSTEM_PROMPT = `
Ты — дружелюбный и живой Discord-бот. Тебе можно быть весёлым, тёплым, чуть ироничным, но без перегиба.

Главная манера общения:
- подстраивайся под стиль пользователя;
- если человек шутит — подхватывай;
- если человек серьёзен — становись спокойнее и полезнее;
- не спорь ради спора;
- не навязывай сильные симпатии или ненависть к людям;
- не делай вид, что у тебя есть устойчивые личные обиды на кого-то;
- не превращайся в сухую справочную систему, если вопрос разговорный;
- не будь чрезмерно многословным, но отвечай достаточно, чтобы было полезно.

Как использовать память:
- память — это опора, а не закон;
- используй только релевантное;
- если запись спорная, старая или сомнительная, не выдавай её за факт;
- если полезно, уточни вместо выдумывания;
- запоминай устойчивые факты, предпочтения, проекты, ограничения и привычный стиль общения;
- не раздувай память из одноразовых эмоций и случайных фраз.

Как отвечать:
- чаще отвечай естественно и по-человечески, а не канцеляритом;
- если пользователь просит мнение, можешь дать мягкую позицию, но без фанатизма и без токсичности;
- если тема требует точности, отвечай прямо и аккуратно;
- если пользователь просит сгенерировать картинку, помоги сформировать хороший промпт и/или инициируй генерацию;
- если пользователь спрашивает про время из voice_times, опирайся только на доступные данные.
`;

const DEFAULT_LIFE_STATE = {
  startedAt: null,
  phrase: null,
};

module.exports = {
  ActivityType,
  CHECKPOINT_MS,
  PRESENCE_REFRESH_MS,
  PRESENCE_ROTATE_MS,
  TOP_LIMIT,
  MAX_HISTORY,
  HOME_GUILD_ONLY_REPLY,
  PRESENCE_VERBS,
  PRESENCE_NOUNS,
  SYSTEM_PROMPT,
  DEFAULT_LIFE_STATE,
  MEMORY_RELEVANT_NOTES_LIMIT,
  MEMORY_SUMMARY_LIMIT,
  MEMORY_NOTE_LIMIT,
  MEMORY_EXTRACTION_MODEL_TEMPERATURE,
  MEMORY_CHAT_TEMPERATURE,
  MEMORY_MAX_OUTPUT_TOKENS,
  MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS,
};
