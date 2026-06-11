#!/usr/bin/env bash
# niconicoscript を AWS（Lambda + DynamoDB）へデプロイする（AWS SSO 専用）。
# 初回は --init、以降のコード更新は引数なしで実行する。

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly CF_TEMPLATE="${SCRIPT_DIR}/infra/cloudformation.yaml"
readonly DOCKER_IMAGE_LOCAL="niconicoscript"
# Lambda（CF の Architectures: x86_64）向け。Buildx の attestation も無効化する
readonly LAMBDA_DOCKER_PLATFORM="linux/amd64"
readonly LAMBDA_MANIFEST_MEDIA_TYPE="application/vnd.docker.distribution.manifest.v2+json"

STACK_NAME="${STACK_NAME:-niconicoscript}"
AWS_REGION="${AWS_REGION:-ap-northeast-1}"
AWS_PROFILE="${AWS_PROFILE:-}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

INIT_MODE=false

usage() {
  cat <<'EOF'
Usage: ./deploy.sh [OPTIONS]

AWS SSO プロファイルを使って niconicoscript をデプロイします。

Options:
  --init            初回デプロイ（CloudFormation スタック作成を含む）
  --profile PROFILE AWS SSO プロファイル（必須。環境変数 AWS_PROFILE でも指定可）
  --region REGION   AWS リージョン（既定: ap-northeast-1、環境変数 AWS_REGION でも指定可）
  --stack NAME      CloudFormation スタック名（既定: niconicoscript）
  -h, --help        このヘルプを表示

環境変数:
  AWS_PROFILE       AWS SSO プロファイル（必須）
  STACK_NAME        スタック名
  AWS_REGION        リージョン
  IMAGE_TAG         ECR イメージタグ（既定: latest）

例:
  ./deploy.sh --init --profile {YOUR_PROFILE}
  ./deploy.sh --profile {YOUR_PROFILE}
  AWS_PROFILE={YOUR_PROFILE} ./deploy.sh --init
EOF
}

log() {
  # コマンド置換 $(...) で戻り値だけを取れるよう、ログは stderr へ出す
  printf '==> %s\n' "$*" >&2
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  local command_name="$1"
  command -v "${command_name}" >/dev/null 2>&1 || die "${command_name} が見つかりません。インストールして PATH を通してください。"
}

require_sso_profile() {
  [[ -n "${AWS_PROFILE}" ]] || die "--profile または AWS_PROFILE で SSO プロファイルを指定してください。"
  export AWS_PROFILE
  log "AWS SSO プロファイル: ${AWS_PROFILE}"
}

sso_session_active() {
  aws sts get-caller-identity --region "${AWS_REGION}" >/dev/null 2>&1
}

ensure_sso_session() {
  if sso_session_active; then
    return 0
  fi

  log "SSO セッションがありません。aws sso login を実行します"
  aws sso login --profile "${AWS_PROFILE}"

  sso_session_active || die "SSO ログイン後も認証に失敗しました。プロファイル ${AWS_PROFILE} を確認してください。"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --init)
        INIT_MODE=true
        shift
        ;;
      --region)
        [[ $# -ge 2 ]] || die "--region には値が必要です"
        AWS_REGION="$2"
        shift 2
        ;;
      --stack)
        [[ $# -ge 2 ]] || die "--stack には値が必要です"
        STACK_NAME="$2"
        shift 2
        ;;
      --profile)
        [[ $# -ge 2 ]] || die "--profile には値が必要です"
        AWS_PROFILE="$2"
        shift 2
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        die "不明な引数: $1（--help で使い方を確認）"
        ;;
    esac
  done
}

get_stack_status() {
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${AWS_REGION}" \
    --output text \
    --query "Stacks[0].StackStatus" 2>/dev/null || printf 'NOT_FOUND'
}

stack_exists() {
  [[ "$(get_stack_status)" != "NOT_FOUND" ]]
}

delete_failed_stack() {
  local stack_status
  stack_status="$(get_stack_status)"
  if [[ "${stack_status}" != "ROLLBACK_COMPLETE" && "${stack_status}" != "ROLLBACK_FAILED" ]]; then
    return 0
  fi

  log "失敗したスタック（${stack_status}）を削除します"
  aws cloudformation delete-stack \
    --stack-name "${STACK_NAME}" \
    --region "${AWS_REGION}"
  aws cloudformation wait stack-delete-complete \
    --stack-name "${STACK_NAME}" \
    --region "${AWS_REGION}"
}

get_stack_output() {
  local output_key="$1"
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${AWS_REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='${output_key}'].OutputValue" \
    --output text
}

print_cloudformation_failures() {
  log "CloudFormation の失敗イベント:"
  aws cloudformation describe-stack-events \
    --stack-name "${STACK_NAME}" \
    --region "${AWS_REGION}" \
    --max-items 10 \
    --query 'StackEvents[?ResourceStatus==`CREATE_FAILED` || ResourceStatus==`UPDATE_FAILED`].[LogicalResourceId,ResourceStatusReason]' \
    --output table >&2 || true
}

run_cloudformation_deploy() {
  if ! aws cloudformation deploy \
    --template-file "${CF_TEMPLATE}" \
    --stack-name "${STACK_NAME}" \
    --capabilities CAPABILITY_NAMED_IAM \
    --region "${AWS_REGION}" \
    "$@"; then
    print_cloudformation_failures
    die "CloudFormation デプロイに失敗しました"
  fi
}

deploy_bootstrap_stack() {
  log "CloudFormation をデプロイします（ECR / DynamoDB / IAM のみ）"
  run_cloudformation_deploy --parameter-overrides BootstrapOnly=true
}

deploy_application_stack() {
  local image_uri="$1"
  [[ "${image_uri}" == *".amazonaws.com/"* ]] \
    || die "イメージ URI が不正です: ${image_uri}"
  log "CloudFormation をデプロイします（Lambda 更新: ImageUri=${image_uri}）"
  run_cloudformation_deploy \
    --parameter-overrides "BootstrapOnly=false" "ImageUri=${image_uri}"
}

lambda_function_exists() {
  aws lambda get-function \
    --function-name "${STACK_NAME}" \
    --region "${AWS_REGION}" \
    --output text \
    --query "Configuration.FunctionName" >/dev/null 2>&1
}

update_lambda_function_code() {
  local image_uri="$1"
  if ! lambda_function_exists; then
    return 0
  fi

  # 同一タグ (:latest) のまま digest だけ変わった場合、CF は変更なしになるため Lambda を直接更新する
  log "Lambda イメージを更新します（${image_uri}）"
  aws lambda update-function-code \
    --function-name "${STACK_NAME}" \
    --region "${AWS_REGION}" \
    --image-uri "${image_uri}" >/dev/null
  aws lambda wait function-updated \
    --function-name "${STACK_NAME}" \
    --region "${AWS_REGION}"
}

ecr_login() {
  local ecr_repository_uri="$1"
  local registry_host
  registry_host="$(echo "${ecr_repository_uri}" | cut -d/ -f1)"
  log "ECR にログインします（${registry_host}）"
  aws ecr get-login-password --region "${AWS_REGION}" \
    | docker login --username AWS --password-stdin "${registry_host}"
}

build_image_uri() {
  local ecr_repository_uri="$1"
  printf '%s:%s' "${ecr_repository_uri}" "${IMAGE_TAG}"
}

ecr_repository_name_from_image_uri() {
  local image_uri="$1"
  basename "${image_uri%%:*}"
}

verify_ecr_image_for_lambda() {
  local image_uri="$1"
  local repository_name
  repository_name="$(ecr_repository_name_from_image_uri "${image_uri}")"

  log "ECR イメージ形式を検証します（${repository_name}:${IMAGE_TAG}）"

  local manifest_json
  manifest_json="$(aws ecr batch-get-image \
    --repository-name "${repository_name}" \
    --region "${AWS_REGION}" \
    --image-ids "imageTag=${IMAGE_TAG}" \
    --query 'images[0].imageManifest' \
    --output text)"

  [[ -n "${manifest_json}" && "${manifest_json}" != "None" ]] \
    || die "ECR からイメージマニフェストを取得できませんでした: ${image_uri}"

  local media_type
  media_type="$(MANIFEST_JSON="${manifest_json}" python3 -c "
import json, os
manifest = json.loads(os.environ['MANIFEST_JSON'])
print(manifest.get('mediaType', ''))
")"

  if [[ "${media_type}" != "${LAMBDA_MANIFEST_MEDIA_TYPE}" ]]; then
    die "ECR イメージが Lambda 非対応形式です (mediaType=${media_type})。deploy.sh の docker build オプションを確認してください。"
  fi

  log "ECR イメージ形式 OK (${LAMBDA_MANIFEST_MEDIA_TYPE})"
}

build_and_push_image() {
  local image_uri="$1"

  log "Docker イメージをビルドします（platform=${LAMBDA_DOCKER_PLATFORM}）"
  docker build \
    --platform "${LAMBDA_DOCKER_PLATFORM}" \
    --provenance=false \
    --sbom=false \
    -t "${DOCKER_IMAGE_LOCAL}" \
    "${SCRIPT_DIR}" >&2

  log "イメージを ECR に push します（${image_uri}）"
  docker tag "${DOCKER_IMAGE_LOCAL}:latest" "${image_uri}"
  docker push "${image_uri}" >&2

  verify_ecr_image_for_lambda "${image_uri}"
}

normalize_base_url() {
  local base_url="$1"
  if [[ "${base_url}" != */ ]]; then
    base_url="${base_url}/"
  fi
  printf '%s' "${base_url}"
}

print_outputs() {
  local api_url
  api_url="$(normalize_base_url "$(get_stack_output ApiUrl)")"
  local ecr_uri
  ecr_uri="$(get_stack_output EcrRepositoryUri)"

  log "デプロイ完了"
  printf '\n'
  printf '  API URL : %s\n' "${api_url}"
  printf '  ECR URI : %s\n' "${ecr_uri}"
  printf '\n'
  printf '  投稿   : %s\n' "${api_url}"
  printf '  表示   : %sview\n' "${api_url}"
  printf '  履歴   : %shistory\n' "${api_url}"
  printf '\n'
}

main() {
  parse_args "$@"

  require_command aws
  require_command docker
  require_sso_profile
  ensure_sso_session

  delete_failed_stack

  if [[ "${INIT_MODE}" == true ]]; then
    if ! stack_exists; then
      log "初回デプロイ: インフラ（ECR / DynamoDB / IAM）を作成します"
      deploy_bootstrap_stack
    else
      log "スタック ${STACK_NAME} は既に存在します。イメージのビルドと Lambda 更新を行います。"
    fi
  elif ! stack_exists; then
    die "スタック ${STACK_NAME} が見つかりません。初回は ./deploy.sh --init --profile ${AWS_PROFILE} を実行してください。"
  fi

  local ecr_repository_uri
  ecr_repository_uri="$(get_stack_output EcrRepositoryUri)"
  [[ -n "${ecr_repository_uri}" && "${ecr_repository_uri}" != "None" ]] \
    || die "ECR リポジトリ URI を取得できませんでした。スタックの Outputs を確認してください。"

  ecr_login "${ecr_repository_uri}"

  local image_uri
  image_uri="$(build_image_uri "${ecr_repository_uri}")"
  build_and_push_image "${image_uri}"

  deploy_application_stack "${image_uri}"
  update_lambda_function_code "${image_uri}"
  print_outputs
}

main "$@"
