# cloudFlare-Workers-AI-Chatbot

Cloudflare Workers AI を使ったチャットボットのサンプル。Node.js + Express の薄いバックエンドが AI Gateway 経由で Cloudflare Workers AI の REST API を呼び出し、フロントは単一HTMLのチャットUI。Docker（Docker Compose）でどこでもすぐ動く。

将来的に [Drift](https://drift.s-quad.com/) アプリへ組み込む前段のプロトタイプ。

## 構成

- `server.js` : Express サーバー
  - `GET /api/models` : Cloudflare側の「Text Generation」モデル一覧を取得（10分キャッシュ）
  - `POST /api/chat` : 選択されたモデルで `/accounts/{account_id}/ai/run`（`cf-aig-gateway-id` 必須） を呼び出し、会話履歴を渡して応答を返す
  - `GET /api/usage` : 消費Neuronsの集計（本日分・累計・モデル別）を返す
- `public/index.html` : チャットUI（バニラJS、ライト/ダーク対応、モデル切り替えドロップダウン、Neurons消費表示付き）
- `data/usage.db` : SQLite（better-sqlite3）。チャット応答のたびにCloudflareが返す `usage.neurons` をリクエスト単位で記録する。Dockerボリュームでホスト側 `./data/` に永続化
- Workers AI 自体はローカル実行ではなく、Cloudflare 側の推論エンドポイントを都度呼び出す方式（**インターネット接続必須**、モデルのダウンロードや自前GPUは不要）

## 必要なもの

- Docker / Docker Compose
- Cloudflareアカウント（無料アカウントでOK。詳細は[料金](#料金)を参照）

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
AI_GATEWAY_ID=hit-workers-ai-chatbot
MODEL=@cf/meta/llama-3.1-8b-instruct-fp8   # UIのデフォルト選択モデル
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

## 料金

Workers AI は **Neurons** という単位で従量課金される（[公式料金ページ](https://developers.cloudflare.com/workers-ai/platform/pricing/)）。

| プラン | 無料枠 | 超過分 |
|---|---|---|
| Workers Free | **10,000 Neurons / 日**（UTC 0時リセット） | 課金不可（Paidへのアップグレードが必要） |
| Workers Paid（月$5〜） | 10,000 Neurons / 日 | $0.011 / 1,000 Neurons |

モデルや入力・出力の長さによって消費量が変わります。無料枠だけで利用できる回数は一定ではありません。最新の料金とモデルごとの利用条件は[公式料金ページ](https://developers.cloudflare.com/workers-ai/platform/pricing/)を確認してください。

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

## AI Gateway による利用制限

このアプリは `AI_GATEWAY_ID` が未設定なら起動しません。推論は Universal REST API に `cf-aig-gateway-id` を付けて送信します。モデル一覧の取得は推論ではないため通常の管理 API を利用します。

2026-09-19 の専用 Gateway `hit-workers-ai-chatbot` 設定:

- Spend limits: 全モデル共通で $10 / 直近30日（スライディングウィンドウ）。暦月ごとのリセットではありません。
- レート制限: 毎分10リクエスト（固定ウィンドウ）。
- Workers AI 課金: 標準課金（postpaid）。既存の Workers 契約で請求。
- Gateway 認証: 有効。会話本文のログ収集・キャッシュ・自動リトライ: 無効。

予算は Cloudflare ダッシュボードの AI Gateway → 対象 Gateway → 設定で管理します。Gateway の推定費用と、無料枠控除後の請求額は同一とは限りません。処理完了後に費用を計上するため、一時的な超過の可能性があります。既存の Workers 基本料金や他の Gateway・直接呼び出しはこの制限の対象外です。

アプリ側は同時推論1件、会話40メッセージ・合計16,000文字、出力上限 `MAX_TOKENS`（既定1024、設定可能範囲1〜2048）に制限します。上限に達した会話はページを再読込して新しく開始してください。429や接続失敗時に直接 API へ迂回したり自動リトライしたりしません。Neurons表示はアプリが記録できた値で、請求額やアカウント全体の無料枠残量を示しません。

テスト: `node --test test/gateway.test.cjs`

公式仕様: https://developers.cloudflare.com/ai-gateway/features/spend-limits/

## 変更履歴

### 2026-09-19 — AI Gateway 経由への移行と利用制限

- Workers AI の直接呼び出しを、専用 Gateway `hit-workers-ai-chatbot` 経由の Universal REST API に変更。`AI_GATEWAY_ID` を必須化し、未設定時は起動を停止。
- Cloudflare 側に、全モデル合計で直近30日間 $10 の予算制限と毎分10リクエストの回数制限を設定。これらはクラウド側の設定であり、リポジトリの取得・起動だけでは自動作成されない。
- アプリ側に同時生成1件、会話40件・合計16,000文字、出力上限の検証を追加。上限エラー時に直接 API へ迂回・自動再試行しない。
- 廃止された既定モデルを、利用可能な `@cf/meta/llama-3.1-8b-instruct-fp8` に変更。
- 画面に Gateway 名を表示し、Neurons 表示が請求額・無料枠残量ではないことを明記。送信中の重複送信を抑止。
- Gateway 必須、送信先・ヘッダー、429時の停止、入力制限、同時実行制限を検証するテスト5件を追加。
- Docker コンテナを再ビルドして反映。実際のチャット応答と Gateway 側の受信実績を確認。

予算は推定利用額に対して適用され、処理中リクエストによる超過の可能性がある。既存の Workers 基本料金・他アプリの利用料金は別。
