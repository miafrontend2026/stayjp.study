#!/usr/bin/env node
// Generate 用法 (usage) questions for each vocab word via Gemini.
// Resumable: 已存在於 data/usage/<level>.json 的詞會跳過。
//
// Usage:
//   GEMINI_API_KEY=xxx node scripts/usage/generate.mjs --level n5
//   GEMINI_API_KEY=xxx node scripts/usage/generate.mjs --level n5 --limit 5
//   GEMINI_API_KEY=xxx node scripts/usage/generate.mjs --level n5 --batch 10 --dry-run

import path from 'node:path';
import fs from 'node:fs';
import {
  ROOT, loadLevelData, saveLevelData, generateBatch, validateUsageEntry,
} from './_lib.mjs';

const args = process.argv.slice(2);
function arg(k, def) {
  const i = args.indexOf(k);
  if (i < 0) return def;
  return args[i + 1];
}
function flag(k) { return args.includes(k); }

const level = arg('--level', 'n5');
const limit = parseInt(arg('--limit', '0'), 10) || 0;
const batchSize = parseInt(arg('--batch', '8'), 10);
const dryRun = flag('--dry-run');
const force = flag('--force');

// 讀 vocab-<level>.js（這些檔案是裸 JS 陣列 const，用 Function 求值）
function loadVocab(lv) {
  const file = path.join(ROOT, `vocab-${lv}.js`);
  if (!fs.existsSync(file)) {
    console.error(`找不到 ${file}`); process.exit(1);
  }
  const code = fs.readFileSync(file, 'utf8');
  const varName = `VOCAB_${lv.toUpperCase()}`;
  return new Function(code + `; return typeof ${varName} !== 'undefined' ? ${varName} : null;`)();
}

const vocab = loadVocab(level);
if (!Array.isArray(vocab) || !vocab.length) {
  console.error('vocab 載入失敗'); process.exit(1);
}

const existing = loadLevelData(level);
const todo = force ? vocab.slice() : vocab.filter(v => !existing[v.w]);
const target = limit > 0 ? todo.slice(0, limit) : todo;

console.log(`Level: ${level}`);
console.log(`Vocab total: ${vocab.length}`);
console.log(`Already done: ${Object.keys(existing).length}`);
console.log(`Pending: ${todo.length}`);
console.log(`This run: ${target.length} (batch ${batchSize}${limit ? `, --limit ${limit}` : ''})`);
console.log(`Mode: ${dryRun ? 'DRY RUN — 不打 API' : 'LIVE'}\n`);

if (!target.length) { console.log('沒有需要處理的詞，結束。'); process.exit(0); }
if (dryRun) {
  console.log('--- 首個 batch 預覽 ---');
  console.log(target.slice(0, batchSize).map(v => `${v.w} (${v.r}) ${v.m}`).join('\n'));
  process.exit(0);
}

let madeOk = 0, madeBad = 0, failedCalls = 0;
const startMs = Date.now();

for (let i = 0; i < target.length; i += batchSize) {
  const batch = target.slice(i, i + batchSize);
  process.stdout.write(`[${i + 1}-${i + batch.length}/${target.length}] `);
  try {
    const result = await generateBatch(batch, level);
    // 對照輸入詞表寫入 existing
    for (const word of batch) {
      const entry = result.find(r => r.w === word.w);
      if (!entry) { madeBad++; console.log(`  ⚠ ${word.w} 沒回傳`); continue; }
      const err = validateUsageEntry(entry);
      if (err) { madeBad++; console.log(`  ⚠ ${word.w}: ${err}`); continue; }
      existing[word.w] = {
        r: word.r, m: word.m, c: word.c,
        correct: entry.correct,
        wrong: entry.wrong,
      };
      madeOk++;
    }
    saveLevelData(level, existing);  // 每 batch 都存檔，可隨時中斷
    const elapsed = (Date.now() - startMs) / 1000;
    const rate = (i + batch.length) / elapsed;
    const eta = ((target.length - i - batch.length) / rate / 60).toFixed(1);
    console.log(`ok=${madeOk} bad=${madeBad} (${rate.toFixed(1)}/s, ETA ${eta}m)`);
  } catch (e) {
    failedCalls++;
    console.log(`❌ ${e.message}`);
    if (failedCalls >= 3) { console.error('連續 3 次失敗，中止'); break; }
    await new Promise(r => setTimeout(r, 5000));  // backoff
  }
  // 輕微 rate limit：每 batch 間隔 600ms
  await new Promise(r => setTimeout(r, 600));
}

console.log(`\nDone. ok=${madeOk} bad=${madeBad} api_fail=${failedCalls}`);
console.log(`Output: data/usage/${level}.json`);
