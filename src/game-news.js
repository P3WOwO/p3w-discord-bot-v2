const crypto = require('crypto');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

function clean(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

// Accept both original JSON keys and normalized camelCase keys.
// publishGameNews() validates first, then passes that result to the message
// builder, which validates again. Supporting both shapes prevents image_url
// (and source_url / old_price / expires_at) from being silently discarded.
function readField(raw, snakeCase, camelCase) {
  return raw?.[snakeCase] ?? raw?.[camelCase];
}

// Some generated JSON descriptions arrive with literal "\\n" text.
// Convert those sequences to real line breaks before placing them in Discord.
function normalizeDescription(value) {
  return clean(value, 3500)
    .replace(/\\+r\\+n/gi, '\n')
    .replace(/\\+n/g, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function validHttpUrl(value, fieldName, required = false) {
  const input = clean(value, 2048);
  if (!input && !required) return null;
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw Object.assign(new Error('Поле ' + fieldName + ' должно быть корректной ссылкой.'), { statusCode: 400 });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw Object.assign(new Error('Поле ' + fieldName + ' должно начинаться с http:// или https://.'), { statusCode: 400 });
  }
  return parsed.toString();
}

function validateGameNewsPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error('Ожидался JSON-объект.'), { statusCode: 400 });
  }

  const title = clean(raw.title, 256);
  if (!title) throw Object.assign(new Error('Не указано название игры или акции.'), { statusCode: 400 });

  const url = validHttpUrl(raw.url, 'url', true);
  const description = normalizeDescription(raw.description);
  const price = clean(raw.price, 80);
  const oldPrice = clean(readField(raw, 'old_price', 'oldPrice'), 80);
  const discount = clean(raw.discount, 40);
  const source = clean(raw.source, 80) || 'Игровые предложения';
  const imageUrl = validHttpUrl(readField(raw, 'image_url', 'imageUrl'), 'image_url');
  const sourceUrl = validHttpUrl(readField(raw, 'source_url', 'sourceUrl'), 'source_url');
  const expiresAt = clean(readField(raw, 'expires_at', 'expiresAt'), 64);

  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) {
    throw Object.assign(new Error('Поле expires_at должно содержать дату ISO 8601.'), { statusCode: 400 });
  }

  const suppliedId = clean(raw.id, 160);
  const id = suppliedId || crypto.createHash('sha256').update(title + '\n' + url).digest('hex');

  return { id, title, url, description, price, oldPrice, discount, source, imageUrl, sourceUrl, expiresAt };
}

function getEmbedColor(item) {
  const source = item.source.toLowerCase();
  if (source.includes('epic')) return 0x8b5cf6;
  if (source.includes('steam')) return 0x1b75bc;
  if (source.includes('gog')) return 0x86328a;
  if (source.includes('prime')) return 0x00a8e0;
  if (source.includes('xbox')) return 0x107c10;
  if (/бесплатно|free/i.test(item.price) || /-100%/.test(item.discount)) return 0x2ecc71;
  return 0x5865f2;
}

function parseDescription(value) {
  const paragraphs = normalizeDescription(value)
    .split(/\n\s*\n/)
    .map(part => part.trim())
    .filter(Boolean);

  const lead = [];
  const sections = [];

  for (const paragraph of paragraphs) {
    const match = paragraph.match(/^\*\*([^*]{1,48}):\*\*\s*([\s\S]+)$/);
    if (match) {
      sections.push({
        label: match[1].trim(),
        value: match[2].trim(),
      });
    } else {
      lead.push(paragraph);
    }
  }

  return {
    lead: clean(lead.join('\n\n'), 1100),
    sections,
  };
}

function formatSectionName(label) {
  const normalized = String(label || '').toLowerCase().replace(/ё/g, 'е');

  if (/что происходит|что произошло|что известно|главное|суть/.test(normalized)) return '📰 ЧТО ПРОИЗОШЛО';
  if (/почему важно|почему это важно|значение/.test(normalized)) return '💡 ПОЧЕМУ ЭТО ВАЖНО';
  if (/статус|подтверждение/.test(normalized)) return '📍 СТАТУС';
  if (/как получить|как забрать|получение/.test(normalized)) return '🎁 КАК ПОЛУЧИТЬ';
  if (/срок|действует до|забрать до/.test(normalized)) return '⏳ СРОК';
  if (/условия|ограничения/.test(normalized)) return 'ℹ️ УСЛОВИЯ';

  return '✦ ' + clean(label, 48).toUpperCase();
}

function buildGameNewsEmbed(raw) {
  const item = validateGameNewsPayload(raw);
  const parsed = parseDescription(item.description);
  const embed = new EmbedBuilder()
    .setColor(getEmbedColor(item))
    .setAuthor({ name: 'P3W  /  ' + item.source.toUpperCase() })
    .setTitle(item.title)
    .setURL(item.url)
    .setTimestamp();

  if (parsed.lead) {
    embed.setDescription(parsed.lead);
  } else if (item.description && !parsed.sections.length) {
    embed.setDescription(clean(item.description, 1100));
  }

  const fields = [];
  for (const section of parsed.sections) {
    fields.push({
      name: formatSectionName(section.label),
      value: clean(section.value, 1024) || 'Подробности по ссылке.',
      inline: false,
    });
  }

  if (item.price || item.oldPrice) {
    const priceParts = [];
    if (item.oldPrice) priceParts.push('~~' + item.oldPrice + '~~');
    if (item.price) priceParts.push('**' + item.price + '**');
    fields.push({ name: '💰 ЦЕНА', value: priceParts.join(' → ') || '—', inline: true });
  }
  if (item.discount) {
    fields.push({ name: '🏷️ СКИДКА', value: '**' + item.discount + '**', inline: true });
  }
  if (item.expiresAt) {
    const timestamp = Math.floor(Date.parse(item.expiresAt) / 1000);
    fields.push({
      name: '⏳ ЗАБРАТЬ ДО',
      value: '<t:' + timestamp + ':D>\n<t:' + timestamp + ':R>',
      inline: true,
    });
  }

  if (fields.length) embed.addFields(fields);
  embed.setFooter({ text: 'P3W  •  ИГРОВЫЕ НОВОСТИ' });
  return embed;
}

function buildGameNewsComponents(raw) {
  const item = validateGameNewsPayload(raw);
  const isFree = /бесплатно|free/i.test(item.price) || /-100%/.test(item.discount);
  const isOffer = Boolean(item.price || item.oldPrice || item.discount || item.expiresAt);
  const actionLabel = isFree
    ? 'Забрать бесплатно'
    : (isOffer ? 'Открыть предложение' : 'Читать новость');

  const buttons = [
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(actionLabel)
      .setURL(item.url),
  ];

  if (item.sourceUrl && item.sourceUrl !== item.url) {
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Официальный источник')
        .setURL(item.sourceUrl),
    );
  }

  return [new ActionRowBuilder().addComponents(buttons)];
}

function buildGameNewsMessage(raw) {
  const item = validateGameNewsPayload(raw);
  const embeds = [];

  // The hero image is a separate first embed so it appears before the news card.
  // imageUrl survives the second validation because both key styles are accepted.
  if (item.imageUrl) {
    embeds.push(
      new EmbedBuilder()
        .setColor(getEmbedColor(item))
        .setImage(item.imageUrl)
    );
  }

  embeds.push(buildGameNewsEmbed(item));

  return {
    embeds,
    components: buildGameNewsComponents(item),
    allowedMentions: { parse: [] },
  };
}

module.exports = {
  validateGameNewsPayload,
  buildGameNewsEmbed,
  buildGameNewsComponents,
  buildGameNewsMessage,
  normalizeDescription,
};
