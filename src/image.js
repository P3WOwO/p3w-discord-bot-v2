const VALID_ASPECT_RATIOS = new Set(['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9']);
const VALID_IMAGE_SIZES = new Set(['512', '1K', '2K', '4K']);

function normalizeAspectRatio(value, fallback = '16:9') {
  const text = String(value || '').trim();
  return VALID_ASPECT_RATIOS.has(text) ? text : fallback;
}

function normalizeImageSize(value, fallback = '2K') {
  const text = String(value || '').trim();
  return VALID_IMAGE_SIZES.has(text) ? text : fallback;
}

function supportsImageSize(model) {
  const name = String(model || '').toLowerCase();
  return name.includes('3.1-flash-image') || name.includes('3-pro-image') || name.includes('preview');
}

function buildImagePrompt(userText, styleHint = '') {
  const source = String(userText || '').trim();
  const style = String(styleHint || '').trim();
  return [
    'Create a high-quality image based on the request below.',
    'Make it visually clear, coherent, and detailed.',
    'No watermark, no UI, no extra labels unless requested.',
    style ? `Style guidance: ${style}` : '',
    `Request: ${source}`,
  ].filter(Boolean).join('\n');
}

function extractImagePart(data) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const inlineData = part?.inlineData || part?.inline_data;
      if (inlineData?.data) {
        return {
          mimeType: inlineData.mimeType || inlineData.mime_type || 'image/png',
          data: inlineData.data,
          text: part?.text || '',
        };
      }
    }
  }
  return null;
}

async function generateGeminiImage({
  apiKey,
  prompt,
  modelCandidates = [],
  aspectRatio = '16:9',
  imageSize = '2K',
  retries = 2,
}) {
  if (!apiKey) throw new Error('Нет GEMINI_API_KEY');

  const models = [...new Set(modelCandidates.map(v => String(v || '').trim()).filter(Boolean))];
  if (!models.length) throw new Error('Не задана модель для генерации изображения');

  const normalizedAspect = normalizeAspectRatio(aspectRatio);
  const normalizedSize = normalizeImageSize(imageSize);
  let lastError = null;

  for (const model of models) {
    const endpoint = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`;
    const canUseSize = supportsImageSize(model);

    const requestVariants = [
      {
        responseModalities: ['Image'],
        responseFormat: canUseSize
          ? { image: { aspectRatio: normalizedAspect, imageSize: normalizedSize } }
          : { image: { aspectRatio: normalizedAspect } },
      },
      {
        responseModalities: ['Image'],
      },
    ];

    for (const generationConfig of requestVariants) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey,
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig,
            }),
          });

          if (!res.ok) {
            const errText = await res.text();
            lastError = new Error(`Gemini ${res.status}: ${errText}`);
            if ((res.status === 429 || res.status === 503) && attempt < retries) {
              const delay = Math.pow(2, attempt) * 1200;
              await new Promise(r => setTimeout(r, delay));
              continue;
            }
            break;
          }

          const data = await res.json();
          const imagePart = extractImagePart(data);
          if (!imagePart?.data) {
            lastError = new Error('Gemini вернул ответ без изображения');
            break;
          }

          return {
            model,
            mimeType: imagePart.mimeType || 'image/png',
            buffer: Buffer.from(imagePart.data, 'base64'),
            text: imagePart.text || data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim() || '',
            raw: data,
          };
        } catch (err) {
          lastError = err;
          const message = String(err?.message || err);
          if (attempt < retries && (message.includes('429') || message.includes('503') || message.includes('fetch'))) {
            const delay = Math.pow(2, attempt) * 1200;
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          break;
        }
      }
    }
  }

  throw lastError || new Error('Gemini image generation failed');
}

module.exports = {
  buildImagePrompt,
  generateGeminiImage,
  normalizeAspectRatio,
  normalizeImageSize,
};
