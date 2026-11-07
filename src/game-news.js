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

// Some generated JSON descriptions arrive with literal "\\n" text.
// Convert those sequences to real line breaks before placing them in Discord.
function normalizeDescription(value) {
  return clean(value, 3500)
    .replace(/\\\\+n/g, '\n')
    .replace(/\\r\\n/g, '\n')
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
    throw Object.assign(new Error(`Поле ${fieldName} должно быть корректной ссылкой.`), { statusCode: 400 });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw Object.assign(new Error(`Поле ${fieldName} должно начинаться с http:// или https://.`), { statusCode: 400 });
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
  const oldPrice = clean(raw.old_price, 80);
  const discount = clean(raw.discount, 40);
  const source = clean(raw.source, 80) || 'Игровые предложения';
  const imageUrl = validHttpUrl(raw.image_url, 'image_url');
  const sourceUrl = validHttpUrl(raw.source_url, 'source_url');
  const expiresAt = clean(raw.expires_at, 64);

  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) {
    throw Object.assign(new Error('Поле expires_at должно содержать дату ISO 8601.'), { statusCode: 400 });
  }

  const suppliedId = clean(raw.id, 160);
  const id = suppliedId || crypto.createHash('sha256').update(`${title}\n${url}`).digest('hex');

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

function buildGameNewsEmbed(raw) {
  const item = validateGameNewsPayload(raw);
  const embed = new EmbedBuilder()
    .setColor(getEmbedColor(item))
    .setAuthor({ name: `🎮 ${item.source}` })
    .setTitle(item.title)
    .setURL(item.url)
    .setTimestamp();

  if (item.description) embed.setDescription(item.description);

  const fields = [];
  if (item.price || item.oldPrice) {
    const priceParts = [];
    if (item.oldPrice) priceParts.push(`~~${item.oldPrice}~~`);
    if (item.price) priceParts.push(`**${item.price}**`);
    fields.push({ name: '💰 Цена', value: priceParts.join(' → ') || '—', inline: true });
  }
  if (item.discount) {
    fields.push({ name: '🏷️ Скидка', value: `**${item.discount}**`, inline: true });
  }
  if (item.expiresAt) {
    const timestamp = Math.floor(Date.parse(item.expiresAt) / 1000);
    fields.push({
      name: '⏳ Забрать до',
      value: `<t:${timestamp}:F>\n<t:${timestamp}:R>`,
      inline: true,
    });
  }
  if (fields.length) embed.addFields(fields);
  if (item.imageUrl) embed.setImage(item.imageUrl);
  embed.setFooter({ text: 'P3W  •  Игровые новости' });
  return embed;
}

function buildGameNewsComponents(raw) {
  const item = validateGameNewsPayload(raw);
  const isFree = /бесплатно|free/i.test(item.price) || /-100%/.test(item.discount);
  const storeName = item.source.replace(/\\s*[·|—-].*$/, '').trim();
  const actionLabel = isFree ? 'Забрать бесплатно' : `Открыть ${storeName}`.slice(0, 80);

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
        .setLabel('Источник')
        .setURL(item.sourceUrl),
    );
  }

  return [new ActionRowBuilder().addComponents(buttons)];
}

function buildGameNewsMessage(raw) {
  const item = validateGameNewsPayload(raw);
  return {
    embeds: [buildGameNewsEmbed(item)],
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
