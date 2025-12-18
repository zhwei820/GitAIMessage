# Git AI Message

ステージ済み（`git add` 済み）の差分をもとに OpenAI API（Responses API）へ問い合わせ、コミットメッセージを生成して VS Code のコミット入力欄に自動入力する拡張です。

English README: `README.md`

## 特徴

- 対象は **ステージ済みの変更のみ**（`git diff --cached`）
- コミット入力欄に **そのまま貼り付け**（コミット自体は行いません）
- 生成言語は VS Code の表示言語に追従（`vscode.env.language` が `ja` で始まる場合は日本語、それ以外は英語）。ただし出力形式指定で言語が明示されている場合はそちらが優先されます
- 出力フォーマットを自由に指定可能（例: Conventional Commits / 箇条書きのみ など）
- 生成後通知でトークン数／料金目安を表示（任意）

## 必須要件

- VS Code（拡張の対応バージョン: `^1.107.0`）
- 組み込み Git 拡張（`vscode.git`）が有効
- OpenAI API Key（未設定だと生成できません）

## インストール

- Marketplace から（公開されている場合）: 拡張機能ビューで「Git AI Message」を検索してインストール
- VSIX から: 拡張機能ビュー → 右上の `...` → 「VSIX からインストール…」

## クイックスタート

1. コマンドパレットで `Git AI Message: OpenAI API Key を設定` を実行して API Key を登録します（Secret Storage に保存）。
2. 変更をステージします（`git add ...`）。
3. 次のいずれかで生成します。
   - コマンドパレット: `Git AI Message: ステージ差分からコミットメッセージ生成`
   - ソース管理ビュー上部（タイトル）の✨ボタン
4. コミット入力欄に入ったメッセージを確認・必要なら編集してコミットします。

ステージ済みの変更が無い場合は警告が表示されます（`git diff --cached` が空）。

## コマンド一覧

| コマンド | 説明 |
| --- | --- |
| `Git AI Message: ステージ差分からコミットメッセージ生成` | ステージ済み差分からコミットメッセージを生成し、コミット入力欄に反映 |
| `Git AI Message: OpenAI API Key を設定` | API Key を登録（Secret Storage） |
| `Git AI Message: OpenAI API Key を削除` | 登録済み API Key を削除 |

## 設定

VS Code の Settings で `gitAIMessage.*` を編集します。

| 設定キー | 役割 | 既定値 |
| --- | --- | --- |
| `gitAIMessage.apiBaseUrl` | OpenAI API Base URL | `https://api.openai.com/v1` |
| `gitAIMessage.model` | 使用するモデル名 | `gpt-5.1` |
| `gitAIMessage.additionalInstructions` | 追加指示（プロンプトに追記） | （ローカライズ既定） |
| `gitAIMessage.formatInstruction` | 出力形式指定（最優先） | （ローカライズ既定） |
| `gitAIMessage.maxDiffChars` | 解析する差分の最大文字数 | `12000` |
| `gitAIMessage.temperature` | 生成のランダム性（0〜2） | `0.2` |
| `gitAIMessage.maxOutputTokens` | 出力トークン上限 | `200` |
| `gitAIMessage.showUsageInNotification` | 生成後通知にトークン数/料金目安を表示 | `true` |
| `gitAIMessage.currency` | 料金表示の通貨（表示用） | `USD` |
| `gitAIMessage.priceInputPer1M` / `gitAIMessage.priceOutputPer1M` | 単価（1M tokens あたり、料金目安表示用） | `0` |

### 出力形式（`gitAIMessage.formatInstruction`）

ここを設定すると、拡張は「指定された形式を最優先で厳密に守る」ようにモデルへ指示します。
未設定（空）の場合は、既定で「1行のサブジェクトのみ（本文なし）」を生成するように指示します。

例:

- `1行目は type(scope): subject（72文字以内）。2行目は空行。3行目以降は "- " で箇条書き。`
- `日本語で、1行目は「要約: ...」形式。本文は作らない（1行のみ）。`

## セキュリティ / プライバシー

- 送信内容: ステージ済み差分（`git diff --cached`）とサマリ（`git diff --cached --stat`）を OpenAI API に送信します。機密情報が含まれるリポジトリでは注意してください。
- API: OpenAI の Responses API（`POST {apiBaseUrl}/responses`）を利用します。
- `store: false` を指定してリクエストします（ただし、保存有無はアカウント/組織側設定等の影響も受けます）。
- `gitAIMessage.maxDiffChars` を超える差分は切り捨てられ、末尾に切り捨て通知（`[...truncated to N chars...]`）が付与されます。
- API Key は VS Code の Secret Storage に保存されます。

## トラブルシューティング

- 「ステージ済みの変更が見つかりません」: `git add` でステージしてから実行してください。
- 「コミット入力欄に反映できません」: 組み込み Git 拡張（`vscode.git`）が無効化されていないか確認してください。
- 「OpenAI API エラー」: API Key / `gitAIMessage.apiBaseUrl` / モデル名 / ネットワーク環境を確認してください。

## 開発

- `pnpm install`
- `pnpm run compile`（型チェック + lint + build）
- `pnpm run package`（本番ビルド）

## ライセンス

GPL-3.0-only（GPLv3）。詳細は `LICENSE` を参照してください。
