const { ActivityType } = require('discord.js');

const CHECKPOINT_MS = 60 * 1000;
const PRESENCE_REFRESH_MS = 60 * 1000;
const PRESENCE_ROTATE_MS = 60 * 60 * 1000;
const TOP_LIMIT = 10;
const MAX_HISTORY = 8;
const HOME_GUILD_ONLY_REPLY = 'Увы, я не на родном сервере, нечем не помогу';

const MEMORY_RELEVANT_NOTES_LIMIT = 6;
const MEMORY_SUMMARY_LIMIT = 900;
const MEMORY_NOTE_LIMIT = 220;
const MEMORY_EXTRACTION_MODEL_TEMPERATURE = 0.2;
const MEMORY_CHAT_TEMPERATURE = 0.72;
const MEMORY_MAX_OUTPUT_TOKENS = 1800;
const MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS = 900;

const PRESENCE_VERBS = [
  'Компиляцию', 'Сборку', 'Обработку', 'Дифракцию', 'Извержение', 'Почернение',
  'Проверку', 'Перезагрузку', 'Калибровку', 'Мемификацию', 'Рендеринг', 'Оптимизацию',
  'Патчинг', 'Загрузку', 'Разборку', 'Синхронизацию', 'Фильтрацию', 'Декодирование',
  'Свертку', 'Печать', 'Замес', 'Шейдинг', 'Лутинг', 'Фарминг', 'Переупаковку',
  'Тюнинг', 'Бустинг', 'Троттлинг', 'Стабилизацию'
];

const PRESENCE_NOUNS = [
  'яиц', 'костей', 'коммунизма', 'света', 'вулкана', 'мемов', 'вайба', 'кринжа',
  'пикселей', 'нулей', 'таблеток', 'пельменей', 'креветок', 'табуреток', 'пиццы',
  'ламп', 'обоев', 'ботинок', 'пылесоса', 'чайника', 'дверей', 'кошек', 'кактусов',
  'диванов', 'проводов', 'носков', 'тарелок', 'клавиатур', 'мониторов', 'бананов',
  'швабр', 'облаков', 'скрепок', 'проводков', 'сосисок', 'пауков', 'мышек', 'арбузов',
  'стульев', 'пружин', 'гигабайтов', 'лагов', 'фпсов', 'битов', 'нейронок', 'Azi', 'Никнэйма'
];

const SYSTEM_PROMPT = `
Ты — OwO (Овошка), дружелюбный и живой бот из Discord.
Ты не говоришь, что ты нейросеть или бот, если тебя об этом не спрашивают напрямую.
Отвечай естественно, иногда шутя, иногда серьёзно.

Правила:
- обычно отвечай коротко, но не сухо
- если тема сложная, отвечай развёрнуто и по делу
- если нужен нормальный диалог, допускается 2–5 предложений
- не добавляй лишней воды
- смайлики можно, но редко и к месту
- не объясняй свой стиль ответа
- если в памяти есть полезный контекст, используй его
- если в памяти есть устойчивые предпочтения, стиль или выводы, учитывай их
- если вопрос просит мнение, формируй явную позицию на основе памяти и фактов, а не нейтральную отписку
- если памяти нет или она не подходит, не выдумывай
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
