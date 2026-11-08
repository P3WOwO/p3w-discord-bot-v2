const crypto = require('crypto');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} = require('discord.js');
const { isIP } = require('node:net');

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
  const regionalPricesInput = readField(raw, 'regional_prices', 'regionalPrices');
  if (regionalPricesInput != null && !Array.isArray(regionalPricesInput)) {
    throw Object.assign(new Error('Поле regional_prices должно быть массивом цен.'), { statusCode: 400 });
  }
  const regionalPrices = (regionalPricesInput || []).slice(0, 8).map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw Object.assign(new Error('Некорректная цена в regional_prices, позиция ' + (index + 1) + '.'), { statusCode: 400 });
    }
    const region = clean(entry.region, 48);
    const currency = clean(entry.currency, 3).toUpperCase();
    const regionalPrice = clean(entry.price, 48);
    const regionalOldPrice = clean(readField(entry, 'old_price', 'oldPrice'), 48);
    const regionalDiscount = clean(entry.discount, 24);
    if (!region || !/^[A-Z]{3}$/.test(currency) || !regionalPrice) {
      throw Object.assign(new Error('Для каждой региональной цены нужны region, ISO-код валюты и price.'), { statusCode: 400 });
    }
    return { region, currency, price: regionalPrice, oldPrice: regionalOldPrice, discount: regionalDiscount };
  });

  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) {
    throw Object.assign(new Error('Поле expires_at должно содержать дату ISO 8601.'), { statusCode: 400 });
  }

  const suppliedId = clean(raw.id, 160);
  const id = suppliedId || crypto.createHash('sha256').update(title + '\n' + url).digest('hex');

  return { id, title, url, description, price, oldPrice, discount, source, imageUrl, sourceUrl, expiresAt, regionalPrices };
}


const NEWS_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

function getImageExtension(contentType) {
  const extensions = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  return extensions[String(contentType || '').split(';')[0].trim().toLowerCase()] || null;
}

function hasValidImageSignature(buffer, extension) {
  if (extension === 'png') {
    return buffer.length >= 8
      && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (extension === 'jpg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (extension === 'webp') {
    return buffer.length >= 12
      && buffer.toString('ascii', 0, 4) === 'RIFF'
      && buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  if (extension === 'gif') {
    const signature = buffer.toString('ascii', 0, 6);
    return signature === 'GIF87a' || signature === 'GIF89a';
  }
  return false;
}

async function downloadNewsImage(imageUrl) {
  if (!imageUrl) return null;

  const imageAddress = new URL(imageUrl);
  const hostname = imageAddress.hostname.toLowerCase();

  // News images must be public HTTPS files. Reject local and IP-literal
  // destinations rather than allowing the bot to fetch internal services.
  if (
    imageAddress.protocol !== 'https:'
    || !hostname
    || isIP(hostname.replace(/^\[|\]$/g, ''))
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
  ) {
    throw Object.assign(new Error('Для изображения нужна публичная HTTPS-ссылка на файл.'), { statusCode: 422 });
  }

  let response;
  try {
    response = await fetch(imageAddress, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
      headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' },
    });
  } catch (error) {
    throw Object.assign(
      new Error('Не удалось скачать изображение новости: ' + (error?.message || 'ошибка сети')),
      { statusCode: 502 },
    );
  }

  if (!response.ok) {
    throw Object.assign(new Error('Сайт изображения вернул HTTP ' + response.status + '.'), { statusCode: 502 });
  }

  const extension = getImageExtension(response.headers.get('content-type'));
  if (!extension) {
    throw Object.assign(new Error('Ссылка image_url вернула не PNG, JPG, WEBP или GIF.'), { statusCode: 422 });
  }

  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > NEWS_IMAGE_MAX_BYTES) {
    throw Object.assign(new Error('Изображение новости больше допустимых 8 МБ.'), { statusCode: 413 });
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw Object.assign(new Error('Сайт изображения не вернул файл.'), { statusCode: 502 });
  }

  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > NEWS_IMAGE_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error('Изображение новости больше допустимых 8 МБ.'), { statusCode: 413 });
    }
    chunks.push(Buffer.from(result.value));
  }

  const buffer = Buffer.concat(chunks, totalBytes);
  if (!hasValidImageSignature(buffer, extension)) {
    throw Object.assign(new Error('Файл image_url не прошёл проверку формата изображения.'), { statusCode: 422 });
  }

  const filename = 'p3w-news-image.' + extension;
  return {
    attachment: new AttachmentBuilder(buffer, {
      name: filename,
      description: 'Изображение к игровой новости P3W',
    }),
    filename,
  };
}

function getEmbedColor(item) {
  const source = item.source.toLowerCase();
  if (source.includes('epic')) return 0x8b5cf6;
  if (source.includes('steam')) return 0x1b75bc;
  if (source.includes('gog')) return 0x86328a;
  if (source.includes('prime')) return 0x00a8e0;
  if (source.includes('xbox')) return 0x107c10;
  if (/бесплатно|free/i.test(item.price) || /-100%/.test(item.discount)
    || item.regionalPrices.some(entry => /-100%/.test(entry.discount))) return 0x2ecc71;
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

  if (item.regionalPrices.length) {
    const currencySymbols = {
      USD: '$', UAH: '₴', KZT: '₸', RUB: '₽', EUR: '€',
      BYN: 'Br ', GBP: '£', PLN: 'zł ', TRY: '₺',
    };
    const formatMoney = (amount, currency) => {
      const symbol = currencySymbols[currency];
      return symbol ? symbol + amount : amount + ' ' + currency;
    };
    const lines = item.regionalPrices.map(entry => {
      const previous = entry.oldPrice ? '~~' + formatMoney(entry.oldPrice, entry.currency) + '~~ → ' : '';
      const current = '**' + formatMoney(entry.price, entry.currency) + '**';
      const discountLabel = entry.discount ? ' · ' + entry.discount : '';
      return entry.region + ' — ' + previous + current + discountLabel;
    });
    fields.push({ name: '🌍 ЦЕНЫ ПО РЕГИОНАМ', value: lines.join('\\n').slice(0, 1024), inline: false });
  } else {
    if (item.price || item.oldPrice) {
      const priceParts = [];
      if (item.oldPrice) priceParts.push('~~' + item.oldPrice + '~~');
      if (item.price) priceParts.push('**' + item.price + '**');
      fields.push({ name: '💰 ЦЕНА', value: priceParts.join(' → ') || '—', inline: true });
    }
    if (item.discount) {
      fields.push({ name: '🏷️ СКИДКА', value: '**' + item.discount + '**', inline: true });
    }
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
  const isFree = /бесплатно|free/i.test(item.price) || /-100%/.test(item.discount)
    || item.regionalPrices.some(entry => /-100%/.test(entry.discount));
  const isOffer = Boolean(item.price || item.oldPrice || item.discount || item.expiresAt || item.regionalPrices.length);
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

async function buildGameNewsMessage(raw) {
  const item = validateGameNewsPayload(raw);
  const embeds = [];
  const files = [];

  // Upload artwork with the message and use attachment:// so Discord receives
  // the actual image bytes instead of having to fetch a remote URL itself.
  if (item.imageUrl) {
    const image = await downloadNewsImage(item.imageUrl);
    files.push(image.attachment);
    embeds.push(
      new EmbedBuilder()
        .setColor(getEmbedColor(item))
        .setImage('attachment://' + image.filename)
    );
  }

  embeds.push(buildGameNewsEmbed(item));

  return {
    embeds,
    ...(files.length ? { files } : {}),
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
