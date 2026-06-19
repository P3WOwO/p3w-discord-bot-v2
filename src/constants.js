const { ActivityType } = require('discord.js');

const CHECKPOINT_MS = 60 * 1000;
const PRESENCE_REFRESH_MS = 45 * 1000;
const PRESENCE_ROTATE_MS = 20 * 60 * 1000;
const TOP_LIMIT = 10;
const MAX_HISTORY = 20;

const HOME_GUILD_ONLY_REPLY = 'Увы, я не на родном сервере, тут я молчу :(';

const CHAT_TEMPERATURE = 0.72;
const CHAT_MAX_OUTPUT_TOKENS = 1600;
const MEMORY_TEMPERATURE = 0.25;
const MEMORY_MAX_OUTPUT_TOKENS = 700;
const IMAGE_PROMPT_TEMPERATURE = 0.35;
const IMAGE_PROMPT_MAX_OUTPUT_TOKENS = 300;

const SYSTEM_PROMPT = `
Ты — дружелюбный, весёлый и живой Discord-бот.
Твоя задача — поддерживать разговор, подстраиваться под стиль человека и отвечать естественно.
Ты не нудишь, не читаешь лекции без повода и не зацикливаешься на "личных границах бота".
Если тон пользователя шутливый — отвечай легко и с юмором.
Если тон серьёзный — становись спокойнее и полезнее.
Если можно ответить коротко — отвечай коротко.
Если тема сложная — отвечай нормально и по существу.

Правила поведения:
- Не выдумывай факты, если данных мало.
- Не спорь ради спора.
- Не делай вид, что у тебя есть устойчивая любовь или ненависть к людям.
- Учитывай только релевантный контекст чата.
- Не перегружай ответ лишними пояснениями о том, как ты устроен.
- Когда уместно, будь немного остроумным и тёплым.
- Если пользователь просит изображение, помоги с хорошим промптом и затем выполни генерацию.
`.trim();

const PRESENCE_PHRASES = [
  'Думаю над ответом',
  'Сжимаю контекст',
  'Чищу память',
  'Генерирую картинку',
  'Слежу за войсом',
  'Переупаковываю мысли',
];

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
  CHAT_TEMPERATURE,
  CHAT_MAX_OUTPUT_TOKENS,
  MEMORY_TEMPERATURE,
  MEMORY_MAX_OUTPUT_TOKENS,
  IMAGE_PROMPT_TEMPERATURE,
  IMAGE_PROMPT_MAX_OUTPUT_TOKENS,
  SYSTEM_PROMPT,
  PRESENCE_PHRASES,
  DEFAULT_LIFE_STATE,
};
