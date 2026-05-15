// Gemini API helper for 用法 question generation.
// 用 fetch 直接打 v1beta API，不用 SDK 省一個依賴。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
export const DATA_DIR = path.join(ROOT, 'data/usage');

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

if (!API_KEY) {
  console.error('❌ 缺 GEMINI_API_KEY 環境變數。設定方式：');
  console.error('   export GEMINI_API_KEY=your_key');
  process.exit(1);
}

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

export function levelDataFile(level) {
  return path.join(DATA_DIR, `${level}.json`);
}

export function loadLevelData(level) {
  const f = levelDataFile(level);
  if (!fs.existsSync(f)) return {};
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

export function saveLevelData(level, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(levelDataFile(level), JSON.stringify(data, null, 2), 'utf8');
}

function buildPrompt(batch, level) {
  return `你是 JLPT ${level.toUpperCase()} 出題老師。以下每個日文詞，生成 4 個句子供「用法」題使用。

要求：
- 每組：1 個用法「正確」+ 3 個用法「錯誤」
- 錯誤句必須是合乎日語語法的句子，但用法不自然（詞性誤用、助詞誤搭、語境不合、固定搭配錯）
- 句子難度貼近 ${level.toUpperCase()}，避免過長
- 目標詞請保留原形（不要改漢字 / 假名表記）
- 目標詞請用 <u>...</u> 包起來
- 每個錯誤句要寫出簡短中文「錯在哪」

詞表（JSON）：
${JSON.stringify(batch.map(w => ({ w: w.w, r: w.r, m: w.m, c: w.c })), null, 2)}

請輸出純 JSON 陣列，順序與輸入一致，格式：
[
  {
    "w": "目標詞",
    "correct": "正確用法句子（含 <u>...</u>）",
    "wrong": [
      { "text": "錯誤句", "reason": "簡短中文錯誤原因" },
      { "text": "錯誤句", "reason": "..." },
      { "text": "錯誤句", "reason": "..." }
    ]
  },
  ...
]

只輸出 JSON 陣列，不要 markdown code fence、不要前言後語。`;
}

export async function generateBatch(batch, level) {
  const prompt = buildPrompt(batch, level);
  const res = await fetch(`${ENDPOINT}?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');
  // 模型有時還是會 wrap markdown
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) { throw new Error('Bad JSON: ' + cleaned.slice(0, 200)); }
  if (!Array.isArray(parsed)) throw new Error('Expected JSON array');
  return parsed;
}

export function validateUsageEntry(entry) {
  if (!entry || typeof entry !== 'object') return 'not object';
  if (!entry.w || typeof entry.w !== 'string') return 'missing w';
  if (!entry.correct || typeof entry.correct !== 'string') return 'missing correct';
  if (!Array.isArray(entry.wrong) || entry.wrong.length !== 3) return 'wrong should be array of 3';
  for (const w of entry.wrong) {
    if (!w.text) return 'wrong.text missing';
  }
  // 檢查目標詞是否在 correct 句子裡（容錯：不要求 <u>，但要有原詞）
  if (!entry.correct.includes(entry.w)) return 'correct sentence missing target word';
  return null;
}
