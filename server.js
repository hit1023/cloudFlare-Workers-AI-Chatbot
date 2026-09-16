import dotenv from "dotenv";
import fs from "node:fs";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  PORT = 3000,
} = process.env;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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
    .map((m) => m.name)
    .filter((name) => name && !name.includes("-lora") && !name.includes("guard"))
    .sort();

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
      }),
    });

    const data = await cfRes.json();

    if (!cfRes.ok || data.success === false) {
      const detail = data.errors?.map((e) => e.message).join(", ") || cfRes.statusText;
      return res.status(cfRes.status || 502).json({ error: `Workers AI エラー: ${detail}` });
    }

    // モデルによって legacy 形式(result.response)とOpenAI互換形式(result.choices[].message.content)が混在する
    const reply = data.result?.response ?? data.result?.choices?.[0]?.message?.content ?? "";
    res.json({ reply });
  } catch (err) {
    res.status(502).json({ error: `Cloudflare APIへの接続に失敗しました: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`hit-workers-ai-chatbot listening on :${PORT} (model=${MODEL})`);
});
