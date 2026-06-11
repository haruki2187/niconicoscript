# niconicoscript

nicoJS を使ったコメント投稿・ライブ表示アプリです。
ローカルではインメモリ、AWS では Lambda Web Adapter + DynamoDB で動作します。

## 必要なもの

### ローカル開発

- Node.js 18 以上（推奨: 20 以上）
- npm

### AWS デプロイ

- [AWS CLI](https://aws.amazon.com/cli/)（認証情報が設定済みであること）
- Docker
- デプロイ先リージョンの利用権限（CloudFormation / ECR / Lambda / DynamoDB / IAM）

---

## ローカル起動手順

### 1. 依存関係をインストール

```bash
npm install
```

### 2. サーバーを起動

```bash
npm start
```

既定ではポート `3000` で起動します。別ポートにする場合:

```bash
PORT=8080 npm start
```

### 3. ブラウザで開く

| URL | 用途 |
|-----|------|
| http://127.0.0.1:3000/ | コメント投稿 |
| http://127.0.0.1:3000/view | ライブ表示（nicoJS） |
| http://127.0.0.1:3000/history | コメント一覧（過去30分・最大100件） |

`COMMENTS_TABLE_NAME` を設定しない場合、コメントは**インメモリ**に保存されます。サーバーを止めるとデータは消えます。

### （任意）ローカルから DynamoDB に接続する

AWS 上の DynamoDB テーブル、または DynamoDB Local に接続して試す場合:

```bash
export COMMENTS_TABLE_NAME=niconicoscript-comments
export AWS_REGION=ap-northeast-1
# AWS 認証情報（aws configure 等）も必要
npm start
```

---

## AWS デプロイ手順

アプリは **Lambda（コンテナ）+ Lambda Web Adapter + DynamoDB + Function URL** で動きます。
インフラ定義は [`infra/cloudformation.yaml`](infra/cloudformation.yaml) です。

以下の `<region>` はデプロイ先リージョン（例: `ap-northeast-1`）に置き換えてください。

### 1. CloudFormation でスタックを初回作成

初回はプレースホルダのイメージで Lambda の骨格だけ作ります。

```bash
aws cloudformation deploy \
  --template-file infra/cloudformation.yaml \
  --stack-name niconicoscript \
  --capabilities CAPABILITY_NAMED_IAM \
  --region <region> \
  --parameter-overrides ImageUri=public.ecr.aws/lambda/nodejs:22
```

### 2. ECR リポジトリ URI を確認

```bash
aws cloudformation describe-stacks \
  --stack-name niconicoscript \
  --region <region> \
  --query "Stacks[0].Outputs[?OutputKey=='EcrRepositoryUri'].OutputValue" \
  --output text
```

表示された URI を `<EcrRepositoryUri>` として以降のコマンドで使います。

### 3. Docker イメージをビルドして ECR に push

```bash
aws ecr get-login-password --region <region> | \
  docker login --username AWS --password-stdin <EcrRepositoryUri>

docker build -t niconicoscript .
docker tag niconicoscript:latest <EcrRepositoryUri>:latest
docker push <EcrRepositoryUri>:latest
```

### 4. Lambda のイメージを更新

```bash
aws cloudformation deploy \
  --template-file infra/cloudformation.yaml \
  --stack-name niconicoscript \
  --capabilities CAPABILITY_NAMED_IAM \
  --region <region> \
  --parameter-overrides ImageUri=<EcrRepositoryUri>:latest
```

### 5. Function URL を確認

```bash
aws cloudformation describe-stacks \
  --stack-name niconicoscript \
  --region <region> \
  --query "Stacks[0].Outputs[?OutputKey=='FunctionUrl'].OutputValue" \
  --output text
```

表示された URL（末尾に `/` が付く場合があります）がアプリのベース URL です。

### コード更新後の再デプロイ

アプリを変更したら、手順 3（build & push）と 4（CloudFormation deploy）を繰り返してください。

### 本番運用の注意

- DynamoDB テーブルは CloudFormation テンプレート内で `DeletionPolicy: Retain` の付与を検討してください（スタック削除時にデータを残すため）。
- Function URL は認証なし（`AuthType: NONE`）です。公開 URL として扱ってください。

---

## デプロイ後の利用方法

Function URL を `<BASE_URL>` とします（例: `https://xxxxxxxx.lambda-url.ap-northeast-1.on.aws`）。

### 画面

| URL | 用途 |
|-----|------|
| `<BASE_URL>/` | コメント投稿フォーム |
| `<BASE_URL>/view` | ライブ表示。投稿されたコメントが nicoJS で流れます |
| `<BASE_URL>/history` | コメント一覧。過去30分かつ最大100件を新しい順に表示 |

### 基本的な使い方

1. **投稿**: `<BASE_URL>/` を開き、コメントと文字色を入力して「送信」
2. **ライブ表示**: 別タブや別端末で `<BASE_URL>/view` を開いておくと、新着コメントが自動で流れます
3. **履歴確認**: `<BASE_URL>/history` で直近のコメント一覧を確認できます

コメントは DynamoDB に保存されるため、Lambda が再起動してもデータは残ります。

### API（curl 例）

**コメント投稿**

```bash
curl -X POST "<BASE_URL>/api/comment" \
  -H "Content-Type: application/json" \
  -d '{"text":"こんにちは","color":"#ff8800"}'
```

**ライブ配信用（未配信コメント取得）**

```bash
curl "<BASE_URL>/api/comments?after=0"
```

`after` には前回取得した最大 `id` を指定します。一度返したコメントは再送されません。

**履歴取得**

```bash
curl "<BASE_URL>/api/comments/history"
```

レスポンス例:

```json
{
  "comments": [
    {
      "id": 1,
      "text": "こんにちは",
      "color": "#ff8800",
      "createdAt": 1718000000000
    }
  ]
}
```

---

## 構成の概要

```
ブラウザ → Lambda Function URL → Lambda Web Adapter → server.js (port 3000) → DynamoDB
```

- **Lambda Web Adapter**: コンテナ内の HTTP サーバー（`server.js`）へリクエストを転送
- **DynamoDB**: コメントの永続化。ライブ配信（未配信キュー）と履歴を分けて管理
