const crypto = require('crypto');
const { EmbedBuilder } = require('discord.js');

function clean(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
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
  const description = clean(raw.description, 3500);
  const price = clean(raw.price, 80);
  const oldPrice = clean(raw.old_price, 80);
  const discount = clean(raw.discount, 40);
  const source = clean(raw.source, 80) || 'Игровые предложения';
  const imageUrl = validHttpUrl(raw.image_url, 'image_url');
  const expiresAt = clean(raw.expires_at, 64);

  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) {
    throw Object.assign(new Error('Поле expires_at должно содержать дату ISO 8601.'), { statusCode: 400 });
  }

  const suppliedId = clean(raw.id, 160);
  const id = suppliedId || crypto.createHash('sha256').update(`${title}\n${url}`).digest('hex');

  return { id, title, url, description, price, oldPrice, discount, source, imageUrl, expiresAt };
}

function buildGameNewsEmbed(raw) {
  const item = validateGameNewsPayload(raw);
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setAuthor({ name: `🎮 ${item.source}` })
    .setTitle(item.title)
    .setURL(item.url)
    .setTimestamp();

  if (item.description) embed.setDescription(item.description);
  const fields = [];
  if (item.price) fields.push({ name: 'Цена сейчас', value: item.price, inline: true });
  if (item.oldPrice) fields.push({ name: 'Обычная цена', value: item.oldPrice, inline: true });
  if (item.discount) fields.push({ name: 'Скидка', value: item.discount, inline: true });
  if (item.expiresAt) {
    const timestamp = Math.floor(Date.parse(item.expiresAt) / 1000);
    fields.push({ name: 'До окончания', value: `<t:${timestamp}:R>`, inline: true });
  }
  if (fields.length) embed.addFields(fields);
  if (item.imageUrl) embed.setImage(item.imageUrl);
  embed.setFooter({ text: 'P3W · Игровые новости' });
  return embed;
}

module.exports = { validateGameNewsPayload, buildGameNewsEmbed };
