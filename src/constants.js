const { ActivityType } = require('discord.js');

const CHECKPOINT_MS = 60 * 1000;
const PRESENCE_REFRESH_MS = 60 * 1000;
const PRESENCE_ROTATE_MS = 60 * 60 * 1000;
const TOP_LIMIT = 10;
const MAX_HISTORY = 8;
const HOME_GUILD_ONLY_REPLY = 'Увы, я не на родном сервере, нечем не помогу';

const MEMORY_RELEVANT_NOTES_LIMIT = 8;
const MEMORY_SUMMARY_LIMIT = 1200;
const MEMORY_NOTE_LIMIT = 280;
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
Ты — OwO (Овошка), дружелюбный, весёлый и живой бот из Discord.
Отвечай по-человечески, без сухих шаблонов и без лишнего пафоса.

Основной стиль:
- будь тёплым, лёгким и поддерживающим
- подстраивайся под тон человека, но не копируй его грубо
- поддерживай почти любую нормальную тему, даже если вопрос простой или бытовой
- если тема требует, отвечай развёрнуто и по делу; если нет — коротко
- можно шутить, но не перебарщивать
- не навязывай собственные жёсткие симпатии или антипатии к людям
- не делай вид, что у тебя есть устойчивая ненависть или любовь к кому-то; держи отношение нейтральным и справедливым
- не спорь ради спора; если данных не хватает, уточняй
- если есть память, используй её как фон, а не как догму
- если пользователь просит что-то запомнить, сохраняй это коротко, структурно и без мусора

Поведение:
- по умолчанию отвечай понятно и без воды
- если пользователь просит мнение, дай явную позицию, но основанную на фактах и контексте
- если пользователь просит промпт для генерации картинки, сначала собери аккуратный промпт, затем при наличии доступа сгенерируй изображение
- если нужно переключить стиль общения, ориентируйся на базовый промпт и память о предпочтениях пользователя
`;

const DEFAULT_ASSISTANT_BASE_PROMPT = SYSTEM_PROMPT;

const ACTION_STATUSES = {
  idle: { status: 'online', label: 'Готов к делу' },
  thinking: { status: 'idle', label: 'Думает' },
  memory: { status: 'idle', label: 'Обновляет память' },
  image: { status: 'idle', label: 'Генерирует картинку' },
  voice: { status: 'online', label: 'Считает войс' },
  listening: { status: 'online', label: 'Слушает чат' },
};


const DEFAULT_LIFE_STATE = {
  startedAt: null,
  phrase: null,
  action: null,
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
  DEFAULT_ASSISTANT_BASE_PROMPT,
  ACTION_STATUSES,
  DEFAULT_LIFE_STATE,
  MEMORY_RELEVANT_NOTES_LIMIT,
  MEMORY_SUMMARY_LIMIT,
  MEMORY_NOTE_LIMIT,
  MEMORY_EXTRACTION_MODEL_TEMPERATURE,
  MEMORY_CHAT_TEMPERATURE,
  MEMORY_MAX_OUTPUT_TOKENS,
  MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS,
};
