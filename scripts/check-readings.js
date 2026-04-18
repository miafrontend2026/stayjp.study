#!/usr/bin/env node
/**
 * check-readings.js
 *
 * 用 kuromoji 檢查每個單字 w 的期望讀音是否與 r 相符。
 *
 * 注意：
 * - kuromoji 是斷詞器不是全知辭典，可能對複合詞/慣用語回傳奇怪結果
 * - 多音字會產生合理誤判（例如「生」可讀 なま/せい/しょう/き）
 * - 只產出報告，不自動修改
 *
 * 使用：
 *   node scripts/check-readings.js
 *   node scripts/check-readings.js > reading-issues.txt
 */

const fs = require('fs');
const path = require('path');
const kuromoji = require('kuromoji');

const ROOT = path.join(__dirname, '..');
const DICT_PATH = path.join(ROOT, 'node_modules/kuromoji/dict');

// 把片假名轉平假名（kuromoji 回傳片假名，但資料用平假名）
function kataToHira(s) {
  return s.replace(/[\u30A1-\u30F6]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

// 讀取 vocab 檔，eval 取出 VOCAB_X 陣列
function loadVocab(file, varName) {
  const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const fn = new Function(content + `; return typeof ${varName} !== 'undefined' ? ${varName} : [];`);
  return fn();
}

function buildTokenizer() {
  return new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath: DICT_PATH }).build((err, tok) => {
      if (err) reject(err); else resolve(tok);
    });
  });
}

// 從 kuromoji tokens 組合期望讀音
function expectedReading(tokens) {
  return tokens.map(t => {
    const r = t.reading || t.surface_form;
    return kataToHira(r);
  }).join('');
}

// 把實際讀音做正規化比對（去空白/中點）
function norm(s) {
  return s.replace(/[\s・、]/g, '');
}

(async () => {
  console.log('Loading kuromoji dictionary...');
  const tok = await buildTokenizer();

  const files = [
    { file: 'vocab-n5.js', v: 'VOCAB_N5', level: 'N5' },
    { file: 'vocab-n4.js', v: 'VOCAB_N4', level: 'N4' },
    { file: 'vocab-n3.js', v: 'VOCAB_N3', level: 'N3' },
    { file: 'vocab-n2.js', v: 'VOCAB_N2', level: 'N2' },
    { file: 'vocab-n1.js', v: 'VOCAB_N1', level: 'N1' },
  ];

  let totalChecked = 0;
  let totalMismatches = 0;
  const report = [];

  for (const { file, v, level } of files) {
    const filePath = path.join(ROOT, file);
    if (!fs.existsSync(filePath)) continue;

    console.log(`\nChecking ${file} (${level})...`);
    const data = loadVocab(file, v);
    let mismatches = 0;

    data.forEach((entry, idx) => {
      if (!entry.w || !entry.r) return;
      totalChecked++;

      // 純假名詞跳過（w === r）
      if (entry.w === entry.r) return;
      // 含英數字的跳過（可能是外來語混合）
      if (/[A-Za-z0-9]/.test(entry.w)) return;

      const tokens = tok.tokenize(entry.w);
      const expected = expectedReading(tokens);
      const actual = norm(entry.r);

      if (expected && expected !== actual) {
        mismatches++;
        totalMismatches++;
        report.push({
          level, file, idx,
          w: entry.w, expected, actual, m: entry.m,
        });
      }
    });

    console.log(`  Checked: ${data.length}, Mismatches: ${mismatches}`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total checked: ${totalChecked}`);
  console.log(`Total mismatches: ${totalMismatches}`);
  console.log(`Mismatch rate: ${(totalMismatches/totalChecked*100).toFixed(1)}%`);

  // 輸出 CSV 報告
  const csvPath = path.join(ROOT, 'reading-issues.csv');
  const csvHeader = 'level,file,idx,word,actual_reading,kuromoji_expected,meaning\n';
  const csvBody = report.map(r =>
    `${r.level},${r.file},${r.idx},"${r.w}","${r.actual}","${r.expected}","${r.m}"`
  ).join('\n');
  fs.writeFileSync(csvPath, csvHeader + csvBody);
  console.log(`\nReport written to: reading-issues.csv`);
  console.log(`(多音字/慣用語可能誤判，需人工審查，並非全部都是真的錯)`);
})();
