import dotenv from "dotenv";
import fs from "node:fs";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ファイル名を".env"にすると、Docker Composeがcompose.yml自身の変数展開用に
// 自動読み込みしてしまい、値に含まれる$を誤って解釈することがあるため
// "app.env"という名前にして明示的にdotenvで読み込む。
const envPath = path.join(__dirname, "app.env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const {
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN,
  MODEL = "@cf/meta/llama-3.1-8b-instruct",
  SYSTEM_PROMPT = "あなたは親切で簡潔に答えるアシスタントです。",
  MAX_TOKENS = "1024",
  PORT = 3000,
} = process.env;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "usage.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    neurons REAL
  )
`);
const insertUsage = db.prepare(`
  INSERT INTO usage_log (created_at, model, prompt_tokens, completion_tokens, total_tokens, neurons)
  VALUES (@created_at, @model, @prompt_tokens, @completion_tokens, @total_tokens, @neurons)
`);

// モデル一覧はCloudflare側で頻繁に増減するため、都度取得せず短時間キャッシュする
let modelsCache = { list: [], fetchedAt: 0 };
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchTextGenerationModels() {
  if (Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS && modelsCache.list.length > 0) {
    return modelsCache.list;
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/models/search?task=Text%20Generation&per_page=100`;
  const cfRes = await fetch(url, {
    headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
  });
  const data = await cfRes.json();
  if (!cfRes.ok || data.success === false) {
    throw new Error(data.errors?.map((e) => e.message).join(", ") || cfRes.statusText);
  }

  const list = (data.result || [])
    .filter((m) => m.name && !m.name.includes("-lora") && !m.name.includes("guard"))
    .map((m) => ({
      id: m.name,
      requiresPaid: m.properties?.some((p) => p.property_id === "require_workers_paid" && p.value === "true") ?? false,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  modelsCache = { list, fetchedAt: Date.now() };
  return list;
}

app.get("/api/config", (req, res) => {
  res.json({ model: MODEL, configured: Boolean(CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN) });
});

app.get("/api/models", async (req, res) => {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    return res.status(500).json({ error: "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN が未設定です。" });
  }
  try {
    const list = await fetchTextGenerationModels();
    res.json({ models: list, default: MODEL });
  } catch (err) {
    res.status(502).json({ error: `モデル一覧の取得に失敗しました: ${err.message}` });
  }
});

app.get("/api/usage", (req, res) => {
  // Cloudflareの無料枠リセットはUTC 0時
  const todayStartUtc = new Date();
  todayStartUtc.setUTCHours(0, 0, 0, 0);

  const today = db
    .prepare(`SELECT COALESCE(SUM(neurons), 0) AS neurons, COUNT(*) AS requests FROM usage_log WHERE created_at >= ?`)
    .get(todayStartUtc.toISOString());
  const lifetime = db
    .prepare(`SELECT COALESCE(SUM(neurons), 0) AS neurons, COUNT(*) AS requests FROM usage_log`)
    .get();
  const byModel = db
    .prepare(
      `SELECT model, COALESCE(SUM(neurons), 0) AS neurons, COUNT(*) AS requests
       FROM usage_log GROUP BY model ORDER BY neurons DESC LIMIT 20`
    )
    .all();

  res.json({ today, lifetime, byModel, freeDailyNeurons: 10000 });
});

app.post("/api/chat", async (req, res) => {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    return res.status(500).json({
      error:
        "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN が未設定です。app.env を確認してください。",
    });
  }

  const { messages, model } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages が空です。" });
  }

  const useModel = typeof model === "string" && model.startsWith("@cf/") ? model : MODEL;
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${useModel}`;

  try {
    const cfRes = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        max_tokens: Number(MAX_TOKENS),
      }),
    });

    const data = await cfRes.json();

    if (!cfRes.ok || data.success === false) {
      const detail = data.errors?.map((e) => e.message).join(", ") || cfRes.statusText;
      const message = detail.includes("Workers Free plan")
        ? `${useModel} はWorkers Paidプラン限定のモデルです。Freeプランでは利用できません。`
        : `Workers AI エラー: ${detail}`;
      return res.status(cfRes.status || 502).json({ error: message });
    }

    // モデルによって legacy 形式(result.response)とOpenAI互換形式(result.choices[].message.content)が混在する
    const reply = data.result?.response ?? data.result?.choices?.[0]?.message?.content ?? "";

    const usage = data.result?.usage;
    if (usage) {
      insertUsage.run({
        created_at: new Date().toISOString(),
        model: useModel,
        prompt_tokens: usage.prompt_tokens ?? null,
        completion_tokens: usage.completion_tokens ?? null,
        total_tokens: usage.total_tokens ?? null,
        neurons: usage.neurons ?? null,
      });
    }

    res.json({ reply, neurons: usage?.neurons ?? null });
  } catch (err) {
    res.status(502).json({ error: `Cloudflare APIへの接続に失敗しました: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`hit-workers-ai-chatbot listening on :${PORT} (model=${MODEL})`);
});
