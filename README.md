# cloudFlare-Workers-AI-Chatbot

Cloudflare Workers AI を使ったチャットボットのサンプル。Node.js + Express の薄いバックエンドが Cloudflare Workers AI の REST API を呼び出し、フロントは単一HTMLのチャットUI。Docker（Docker Compose）でどこでもすぐ動く。

将来的に [Drift](https://drift.s-quad.com/) アプリへ組み込む前段のプロトタイプ。

## 構成

- `server.js` : Express サーバー
  - `GET /api/models` : Cloudflare側の「Text Generation」モデル一覧を取得（10分キャッシュ）
  - `POST /api/chat` : 選択されたモデルで `/accounts/{account_id}/ai/run/{model}` を呼び出し、会話履歴を渡して応答を返す
  - `GET /api/usage` : 消費Neuronsの集計（本日分・累計・モデル別）を返す
- `public/index.html` : チャットUI（バニラJS、ライト/ダーク対応、モデル切り替えドロップダウン、Neurons消費表示付き）
- `data/usage.db` : SQLite（better-sqlite3）。チャット応答のたびにCloudflareが返す `usage.neurons` をリクエスト単位で記録する。Dockerボリュームでホスト側 `./data/` に永続化
- Workers AI 自体はローカル実行ではなく、Cloudflare 側の推論エンドポイントを都度呼び出す方式（**インターネット接続必須**、モデルのダウンロードや自前GPUは不要）

## 必要なもの

- Docker / Docker Compose
- Cloudflareアカウント（無料アカウントでOK。詳細は[料金](#料金ほぼ無料で試せる)を参照）

## 1. Cloudflare Account ID と API Token を取得する

### Account ID

1. https://dash.cloudflare.com にログイン
2. 右サイドバー（アカウントホーム）に表示されている **Account ID** をコピー

### API Token

1. 右上のプロフィールアイコン → **My Profile** → **API Tokens** タブ → **Create Token**
2. 用意されているテンプレートに「Workers AI」専用のものが無ければ、**「最初から作成」**（カスタムトークン）を選ぶ
3. 権限を設定:
   - **Account** → **Workers AI** → **Read**（これで `ai/run` と `ai/models/search` の両方が呼べる。うまく通らない場合は `Edit` に変更）
4. アカウントリソースは対象アカウント1つに絞る（ゾーン権限は不要）
5. 有効期限はお好みで（テスト用途なら短めにして、確認後に失効させるのが安全）
6. 「概要に進む」→ 内容確認 → **トークンを作成**
7. 表示されたトークン文字列をコピー（**この画面を閉じると二度と表示されない**ので注意）

> **セキュリティに関する注意**
> - API Token は `app.env` にのみ保存し、絶対にGitにコミットしない（`.gitignore` で除外済み）
> - トークンを誤ってどこかに貼ってしまった場合は、ダッシュボードから即座に失効・再発行すること
> - Tokenのスコープは必要最小限（該当アカウントの Workers AI のみ）にする

## 2. セットアップ

```bash
git clone git@github.com:hit1023/cloudFlare-Workers-AI-Chatbot.git
cd cloudFlare-Workers-AI-Chatbot
cp app.env.example app.env
# app.env を編集して CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN を設定
```

`app.env` の内容:

```bash
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
MODEL=@cf/meta/llama-3.1-8b-instruct   # UIのデフォルト選択モデル
SYSTEM_PROMPT=あなたは親切で簡潔に答えるアシスタントです。
MAX_TOKENS=1024   # 応答の最大トークン数。Cloudflare側のデフォルト(256)だと長い応答が途中で切れるため明示的に指定
```

> なぜファイル名が `.env` ではなく `app.env` なのか: Docker Composeはプロジェクト直下の `.env` という名前のファイルを、`docker-compose.yml` 側で参照していなくても自動的に読み込み、`docker-compose.yml` 内の変数展開対象にしてしまう。トークンなどの値に `$` が含まれていると誤って変数参照と解釈され値が壊れることがあるため、あえて別名にして `dotenv` で明示的に読み込んでいる。

## 3. 起動

```bash
docker compose up -d --build
```

http://localhost:3300 を開く。

ヘッダーのプルダウンから、Cloudflareで現在利用可能なモデル（gpt-oss-120b、llama-4-scout、glm-5.3、kimi-k2.7-codeなど）をリアルタイムに切り替えられる。

## ログ確認

```bash
docker compose logs -f
```

## 停止

```bash
docker compose down
```

## 料金（ほぼ無料で試せる）

Workers AI は **Neurons** という単位で従量課金される（[公式料金ページ](https://developers.cloudflare.com/workers-ai/platform/pricing/)）。

| プラン | 無料枠 | 超過分 |
|---|---|---|
| Workers Free | **10,000 Neurons / 日**（UTC 0時リセット） | 課金不可（Paidへのアップグレードが必要） |
| Workers Paid（月$5〜） | 10,000 Neurons / 日 | $0.011 / 1,000 Neurons |

参考: `@cf/meta/llama-3.1-8b-instruct` の場合、入力 25,608 neurons/100万トークン、出力 75,147 neurons/100万トークン。仮に1往復あたり入力100トークン・出力200トークン程度の雑談だとすると、1メッセージ当たり約18 neurons ほど。**無料枠の10,000 neurons/日だけで1日500往復以上**試せる計算になり、個人の検証・プロトタイプ用途では実質無料で使い切れないレベル。

ただし、大きめのモデル（70Bクラスなど）は出力側の消費量が数倍になり、Kimi・GLM・DeepSeekなど一部の先端モデルは無料枠の対象外でPaidプラン必須の場合がある。正確な数値・最新情報は必ず[公式ページ](https://developers.cloudflare.com/workers-ai/platform/pricing/)で確認すること（料金体系は変更される可能性がある）。

### 消費量の記録・確認

チャット1往復ごとにCloudflareのレスポンスに含まれる実測Neurons数を `data/usage.db`（SQLite）へ記録している。UIのヘッダーに本日分（UTC基準、無料枠のリセットに合わせている）と累計が表示される。

直接クエリしたい場合:

```bash
docker compose exec chatbot node -e "
const db = require('better-sqlite3')('/app/data/usage.db');
console.log(db.prepare('SELECT * FROM usage_log ORDER BY id DESC LIMIT 20').all());
"
```

または `GET /api/usage` で `{ today, lifetime, byModel }` をJSONで取得できる。

## 今後の展望

- [Drift](https://drift.s-quad.com/) アプリへの組み込み（FastAPI側からWorkers AIを呼ぶか、Cloudflare Worker自体として書き直すかは検討中）
- ストリーミング応答（現状は非ストリーミング）
