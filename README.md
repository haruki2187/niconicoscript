# niconicoscript

nicoJS を使ったコメント投稿・ライブ表示アプリです。
ローカルではインメモリ、AWS では Lambda Web Adapter + DynamoDB で動作します。

## 必要なもの

### ローカル開発

- Node.js 18 以上（推奨: 20 以上）
- npm

### AWS デプロイ

- [AWS CLI](https://aws.amazon.com/cli/)（SSO プロファイルが `~/.aws/config` に設定済みであること）
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
| http://127.0.0.1:3000/history | コメント一覧（過去1時間・最大50件） |

`COMMENTS_TABLE_NAME` を設定しない場合、コメントは**インメモリ**に保存されます。サーバーを止めるとデータは消えます。

### （任意）ローカルから DynamoDB に接続する

AWS 上の DynamoDB テーブル、または DynamoDB Local に接続して試す場合:

```bash
export COMMENTS_TABLE_NAME=niconicoscript-comments
export AWS_REGION=ap-northeast-1
export AWS_PROFILE={YOUR_PROFILE}   # SSO プロファイル
aws sso login --profile "${AWS_PROFILE}"
npm start
```

---

## AWS デプロイ手順

アプリは **Lambda（コンテナ）+ Lambda Web Adapter + API Gateway HTTP API + DynamoDB** で動きます。
インフラ定義は [`infra/cloudformation.yaml`](infra/cloudformation.yaml) です。

### deploy.sh を使う（推奨）

[`deploy.sh`](deploy.sh) が SSO 認証・CloudFormation の作成・イメージの build/push・Lambda 更新までをまとめて行います。
**AWS SSO 専用**です。`--profile`（または `AWS_PROFILE`）の指定が必須です。

```bash
chmod +x deploy.sh   # 初回のみ

./deploy.sh --init --profile {YOUR_PROFILE}   # 初回デプロイ（スタック作成を含む）
./deploy.sh --profile {YOUR_PROFILE}          # コード更新後の再デプロイ
```

SSO セッションが切れている場合、スクリプトが `aws sso login` を自動実行します。

オプションと環境変数:

| 指定方法 | 意味 | 既定値 |
|----------|------|--------|
| `--profile` / `AWS_PROFILE` | AWS SSO プロファイル | **必須** |
| `--region` / `AWS_REGION` | デプロイ先リージョン | `ap-northeast-1` |
| `--stack` / `STACK_NAME` | CloudFormation スタック名 | `niconicoscript` |
| `IMAGE_TAG` | ECR イメージタグ | `latest` |

完了時に API Gateway の URL と各画面の URL が表示されます。

#### Mac（Colima / Docker Desktop）でのビルドについて

Apple Silicon 上の Docker は既定で **arm64 + OCI image index（provenance attestation）** のイメージを作り、Lambda（x86_64）が受け付けません。`deploy.sh` は次のオプションでビルドします。

- `--platform linux/amd64` … CloudFormation の `Architectures: x86_64` と一致
- `--provenance=false --sbom=false` … Lambda 非対応のマニフェストリストを防ぐ

手動で `docker build` する場合も同様のオプションが必要です。初回の amd64 ビルドはエミュレーションのため時間がかかることがあります。

### 手動でデプロイする場合

以下のプレースホルダを置き換えてください。

- `<profile>` … SSO プロファイル（例: `{YOUR_PROFILE}`）
- `<region>` … デプロイ先リージョン（例: `ap-northeast-1`）

```bash
aws sso login --profile <profile>
export AWS_PROFILE=<profile>
```

#### 1. CloudFormation でインフラを初回作成

初回は ECR / DynamoDB / IAM のみ作成します（Lambda はイメージ push 後にデプロイ）。

```bash
aws cloudformation deploy \
  --profile <profile> \
  --template-file infra/cloudformation.yaml \
  --stack-name niconicoscript \
  --capabilities CAPABILITY_NAMED_IAM \
  --region <region> \
  --parameter-overrides BootstrapOnly=true
```

#### 2. ECR リポジトリ URI を確認

```bash
aws cloudformation describe-stacks \
  --profile <profile> \
  --stack-name niconicoscript \
  --region <region> \
  --query "Stacks[0].Outputs[?OutputKey=='EcrRepositoryUri'].OutputValue" \
  --output text
```

表示例: `123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/niconicoscript`

- `<EcrRepositoryUri>` … 上記の値（タグなし）
- `<EcrRegistry>` … `/` より前のホスト部分（例: `123456789012.dkr.ecr.ap-northeast-1.amazonaws.com`）

#### 3. Docker イメージをビルドして ECR に push

`docker login` にはリポジトリ URI ではなく **レジストリホスト**（`<EcrRegistry>`）を指定します。

```bash
aws ecr get-login-password --profile <profile> --region <region> | \
  docker login --username AWS --password-stdin <EcrRegistry>

docker build --platform linux/amd64 --provenance=false --sbom=false -t niconicoscript .
docker tag niconicoscript:latest <EcrRepositoryUri>:latest
docker push <EcrRepositoryUri>:latest
```

#### 4. Lambda と API Gateway をデプロイ

```bash
aws cloudformation deploy \
  --profile <profile> \
  --template-file infra/cloudformation.yaml \
  --stack-name niconicoscript \
  --capabilities CAPABILITY_NAMED_IAM \
  --region <region> \
  --parameter-overrides BootstrapOnly=false ImageUri=<EcrRepositoryUri>:latest
```

#### 5. API URL を確認

```bash
aws cloudformation describe-stacks \
  --profile <profile> \
  --stack-name niconicoscript \
  --region <region> \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
  --output text
```

表示された URL がアプリのベース URL です（例: `https://xxxxxxxx.execute-api.ap-northeast-1.amazonaws.com`）。

### コード更新後の再デプロイ

`./deploy.sh` を再実行するか、手動の場合は上記の手順 3（build & push）と 4（CloudFormation deploy）を繰り返してください。

### 本番運用の注意

- DynamoDB テーブルは CloudFormation テンプレート内で `DeletionPolicy: Retain` の付与を検討してください（スタック削除時にデータを残すため）。
- API Gateway HTTP API は認証なしで公開されます。必要に応じて IAM 認証や Cognito 等を追加してください。

---

## デプロイ後の利用方法

API Gateway の URL を `<BASE_URL>` とします（例: `https://xxxxxxxx.execute-api.ap-northeast-1.amazonaws.com`）。

### 画面

| URL | 用途 |
|-----|------|
| `<BASE_URL>/` | コメント投稿フォーム |
| `<BASE_URL>/view` | ライブ表示。投稿されたコメントが nicoJS で流れます |
| `<BASE_URL>/history` | コメント一覧。過去1時間かつ最大50件を新しい順に表示 |

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
ブラウザ → API Gateway HTTP API → Lambda Web Adapter → server.js (port 3000) → DynamoDB
```

- **Lambda Web Adapter**: コンテナ内の HTTP サーバー（`server.js`）へリクエストを転送
- **DynamoDB**: コメントの永続化。ライブ配信（未配信キュー）と履歴を分けて管理
