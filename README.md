# ストック（stash）

保存した記事・SNS投稿・スクショ・論文を「あとで使える形」にするアプリと、好きなサイトを無限キャンバスに並べて見張るアプリをひとつにしたもの。

- **ストック**：URL・SNS・写真・PDF・メモを保存すると、AI（Claude）が要約とタグをつける。意味で検索したり、保存したものに質問したりできる
- **キャンバス**：サイトのスクショを自由に並べる。1日1回（朝6時ごろ）自動で撮り直し、文字が変わったサイトは赤枠になり、変わった行を表示する

## しくみ

- 画面：GitHub Pages（`index.html` / `app.js`）
- データ：Supabase「quruquruyuki's Project」
  - テーブル `stash_items`（保存したもの）、`stash_tiles`（キャンバス）、`stash_tokens`（ショートカット用キー）
  - ファイルは Storage の `stash` バケット（本人のフォルダだけ読み書きできる）
- Edge Function `stash`（`supabase/functions/stash/`）
  - 要約・タグ・質問への回答：Claude（モデルは共通設定 `app_settings` の `stash/summary_model`・`answer_model`）
  - 意味検索：OpenAI の埋め込み（`stash/embed_model`）＋ pgvector
  - スクショ：microlink の無料枠（1日50回まで）
  - 自動撮影：pg_cron のジョブ `stash-daily-shoot`（毎日 21:07 UTC ＝ 6:07 JST）
- Secrets（他アプリと共用）：`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`ALLOWED_EMAIL`

## iPhone の共有ボタンから保存する

アプリの設定でショートカット用のキーを作り、ショートカットで Edge Function に `POST` する。

- URL：`https://oqtyorwlrnrcyjxiassg.supabase.co/functions/v1/stash`
- ヘッダ：`x-stash-token: <作ったキー>`
- 本文（JSON）：`{"text": "<ショートカットの入力>"}`、写真なら `{"image": "<Base64>"}`

ショートカットなしでも `https://quruquruyuki.github.io/stash/?add=<URL>` を開けば保存される。

`config.js` には公開用の publishable キーだけを置く。secret キーや APIキーは絶対に入れない。
