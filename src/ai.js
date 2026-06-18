
const { SYSTEM_PROMPT } = require('./constants');

async function askGemini({ apiKey, model, prompt, retries = 3 }) {
  if (!apiKey) throw new Error('Нет GEMINI_API_KEY');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 770,
            temperature: 0.87,
            topP: 0.92,
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 503 && attempt < retries) {
          const delay = Math.pow(2, attempt) * 2000;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw new Error(`Gemini ${res.status}: ${errText}`);
      }

      const data = await res.json();
      return data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim() || 'Пустой ответ.';
    } catch (err) {
      const message = String(err?.message || err);
      if (attempt < retries && (message.includes('503') || message.includes('fetch'))) {
        const delay = Math.pow(2, attempt) * 2000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

function buildPrompt({ channelHistory = [], recentMessages = [], userName, text }) {
  const recentBlock = recentMessages.length
    ? ['', 'Последние сообщения:', ...recentMessages.map(m => `${m.name}: ${m.text}`)]
    : [];

  return [
    SYSTEM_PROMPT,
    '',
    'История:',
    ...channelHistory.map(m => `${m.name}: ${m.text}`),
    ...recentBlock,
    '',
    `${userName}: ${text}`,
  ].join('\n');
}

module.exports = {
  askGemini,
  buildPrompt,
};
