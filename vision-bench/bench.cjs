// vision-bench：GLM 视觉模型 A/B 测速 — 同一张复杂图，对比 glm-4.6v vs glm-4.6v-flash。
// 用法: node bench.mjs [图片路径] [轮次=2]
// 输出: 每个模型每轮的耗时(ms) + 描述文本(截断) + 汇总。

'use strict';
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const ENDPOINT = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';
const QUESTION = '请详细描述这张图片的内容：包括标题、表格数据（尽量逐行读出）、图表信息、状态标签、代码片段等所有可见文字与元素，用中文回答。';

function readCredential(name) {
  if (process.env[name]) return process.env[name];
  const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml');
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  const re = new RegExp(`^\\s*${name}\\s*:\\s*["']?([^"'\\r\\n]+)`, 'm');
  const m = text.match(re);
  return m ? m[1].trim() : undefined;
}

async function callOnce(apiKey, model, base64, mime) {
  const content = [{ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }, { type: 'text', text: QUESTION }];
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: 2048 })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const ms = Date.now() - t0;
  const text = data?.choices?.[0]?.message?.content ?? '';
  return { ms, text };
}

async function main() {
  const imgPath = process.argv[2] || join(__dirname, 'complex-page.png');
  const rounds = Number(process.argv[3] || 2);
  const apiKey = readCredential('ZAI_CODING_CN_API_KEY');
  if (!apiKey) { console.error('ZAI_CODING_CN_API_KEY not found'); process.exit(1); }
  const buf = readFileSync(imgPath);
  const mime = imgPath.toLowerCase().endsWith('.jpg') || imgPath.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
  const base64 = buf.toString('base64');
  console.log(`图片: ${imgPath} (${(buf.length / 1024).toFixed(1)} KB)  轮次: ${rounds}\n`);

  const models = ['glm-4.6v', 'glm-4.6v-flash'];
  const results = {};
  for (const model of models) {
    results[model] = [];
    for (let i = 1; i <= rounds; i++) {
      const t0 = Date.now();
      try {
        const r = await callOnce(apiKey, model, base64, mime);
        results[model].push(r);
        const len = r.text.length;
        console.log(`[${model}] 轮${i}: ${r.ms}ms  输出 ${len} 字`);
        console.log(`    首150字: ${r.text.replace(/\n/g, ' ').slice(0, 150)}`);
      } catch (e) {
        const ms = Date.now() - t0;
        results[model].push({ ms, error: String(e) });
        console.log(`[${model}] 轮${i}: ${ms}ms  FAIL: ${e}`);
      }
    }
  }
  console.log('\n===== 汇总 =====');
  for (const model of models) {
    const ok = results[model].filter((r) => !r.error);
    if (ok.length === 0) { console.log(`${model}: 全部失败`); continue; }
    const msList = ok.map((r) => r.ms).sort((a, b) => a - b);
    const min = msList[0], med = msList[Math.floor(msList.length / 2)];
    const lens = ok.map((r) => r.text.length);
    console.log(`${model}: 最慢 ${Math.max(...msList)}ms / 中位 ${med}ms / 最快 ${min}ms | 输出长度 ${Math.min(...lens)}~${Math.max(...lens)} 字`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
