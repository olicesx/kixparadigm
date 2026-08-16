// dsh-vision-bridge — 服务端半：为"UI 上传图片 → 自动转描述"提供 HTTP 端点。
//
// 机制：client（composer dock 插件）在用户附加图片后调用
//   POST /api/dsh-vision-bridge/describe
//   body: { provider, model, images: [{ mime, base64 }], question? }
// 服务端先解析会话当前模型能力（llm.resolveModelInfo）：
//   - 模型声明 image 输入 → { mode: "keep" }（client 保留图片原样发送）
//   - 模型无视觉（deepseek-v4-flash 等）→ 调智谱 GLM-4.6V（Coding Plan 订阅
//     端点 api/coding/paas/v4，key 复用 ~/.dsh/.credentials.yaml 的
//     ZAI_CODING_CN_API_KEY）→ { mode: "describe", text }
//
// 这是 kixparadigm 识图补足的 UI 无缝层：主模型全程纯文本，图片在 client
// 侧被转换为文本描述后再提交，绕开 host prompt gate（MODEL_DOES_NOT_SUPPORT_IMAGES）。

'use strict';

const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const ROUTE_PATH = '/api/dsh-vision-bridge/describe';
const DEFAULT_QUESTION = '请详细描述这张图片的内容，包括其中的文字（若有），用中文回答。';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 单张原始图上限 8MB（与 UI imageLimits 同量级防御）
const GLM_ENDPOINT = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';
const GLM_MODEL = 'glm-4.6v'; // 默认模型；请求 body 可传 visionModel 覆盖（A/B 测速用）
const GLM_TIMEOUT_MS = 90000;
const GLM_MODEL_RE = /^glm-4\.\d+v(?:-flash)?$/; // 允许的模型名白名单

/** 从 ~/.dsh/.credentials.yaml 读取指定 key（值可能带引号）。 */
function readCredential(name) {
  if (process.env[name]) return process.env[name];
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const file = join(dshHome, '.credentials.yaml');
  if (!existsSync(file)) return undefined;
  try {
    const text = readFileSync(file, 'utf8');
    const re = new RegExp(`^\\s*${name}\\s*:\\s*["']?([^"'\\r\\n]+)`, 'm');
    const m = text.match(re);
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

/** 收集请求 body（上限 64MB 防御）。 */
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

/**
 * 剥离模型偶尔返回的完整代码围栏包装。只匹配「以 ``` 开头且以 ``` 结尾」的
 * 整体包装；正文中间有代码块时原样保留（旧实现会从开头一路删到首个围栏）。
 */
function cleanModelText(text) {
  const value = String(text || '').trim()
  const m = /^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(value)
  return m ? m[1].trim() : value
}

/** 调 GLM 视觉模型识别图片，返回文本描述。images: [{mime, base64}]。 */
async function describeImages(apiKey, images, question, model = GLM_MODEL) {
  const content = images.map((img) => ({
    type: 'image_url',
    image_url: { url: `data:${img.mime || 'image/png'};base64,${img.base64}` }
  }));
  content.push({ type: 'text', text: question || DEFAULT_QUESTION });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GLM_TIMEOUT_MS);
  try {
    const res = await fetch(GLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        max_tokens: 2048
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`GLM ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    return cleanModelText(text); // 仅剥离完整代码围栏包装，不误删普通正文
  } finally {
    clearTimeout(timer);
  }
}

/** cordis 插件入口。 */
function apply(ctx) {
  // Loader 并发挂载条目时，webServer 服务（由 dsh-web-app bundle 提供）可能
  // 尚未就绪：实测 apply 先于服务挂载执行 → ctx.get('webServer') 为 null →
  // 路由不注册（GET /api/dsh-vision-bridge/describe 404），且时序不稳定
  // （同一环境不同实例有时成功有时失败）。这里轮询等待服务出现（200ms 间隔，
  // 上限 30s），不依赖脆弱的启动顺序。
  const registerRoute = (webServer) => {
    webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        try {
          const body = JSON.parse(await readBody(req));
          const { provider, model, images, question, visionModel } = body || {};
          if (visionModel !== undefined && !GLM_MODEL_RE.test(String(visionModel))) {
            sendJson(res, 400, { error: `unsupported visionModel: ${visionModel}` });
            return;
          }
          if (!Array.isArray(images) || images.length === 0) {
            sendJson(res, 400, { error: 'images required' });
            return;
          }
          if (images.some((img) => typeof img?.base64 !== 'string' || img.base64.length === 0)) {
            sendJson(res, 400, { error: 'each image needs base64' });
            return;
          }
          if (images.some((img) => img.base64.length > MAX_IMAGE_BYTES * 1.34)) {
            sendJson(res, 413, { error: 'image too large' });
            return;
          }

          // 当前模型支持图片 → 保留原样（client 不转换）
          if (provider && model) {
            const llm = ctx.get('llm');
            if (llm) {
              const info = await llm.resolveModelInfo(provider, model);
              if (info?.inputModalities?.includes('image')) {
                sendJson(res, 200, { mode: 'keep' });
                return;
              }
            }
          }

          // 无视觉模型 → GLM-4.6V 转描述
          const apiKey = readCredential('ZAI_CODING_CN_API_KEY');
          if (!apiKey) {
            sendJson(res, 500, { error: 'ZAI_CODING_CN_API_KEY not found' });
            return;
          }
          const text = await describeImages(apiKey, images, question, visionModel || GLM_MODEL);
          if (!text) {
            sendJson(res, 502, { error: 'GLM returned empty description' });
            return;
          }
          sendJson(res, 200, { mode: 'describe', text });
        } catch (error) {
          ctx.logger?.warn?.('dsh-vision-bridge: describe failed:', String(error));
          sendJson(res, 500, { error: String(error) });
        }
      }
    });
    ctx.logger?.info?.('dsh-vision-bridge: route registered at ' + ROUTE_PATH);
  };
  const waitForWebServer = (attempt = 0) => {
    const webServer = ctx.get('webServer');
    if (webServer) {
      registerRoute(webServer);
      return;
    }
    if (attempt >= 150) {
      ctx.logger?.warn?.('dsh-vision-bridge: webServer unavailable after 30s, route NOT registered');
      return;
    }
    setTimeout(() => waitForWebServer(attempt + 1), 200);
  };
  waitForWebServer();
}

module.exports = { name: 'dsh-vision-bridge', apply, ROUTE_PATH, describeImages, cleanModelText, readCredential };
