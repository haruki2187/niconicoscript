'use strict'

const HISTORY_MAX_COUNT = 50
const HISTORY_WINDOW_MS = 60 * 60 * 1000
const PENDING_KEY = 'PENDING'
const SCOPE_ALL = 'ALL'
/** カウンタ行用の予約 commentId（通常コメントと衝突しない値）。 */
const META_COMMENT_ID = 0

const TABLE_NAME = process.env.COMMENTS_TABLE_NAME || ''
const useDynamoDb = TABLE_NAME.length > 0

/** @type {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient | null} */
let docClient = null

/**
 * DynamoDB 利用時のみ AWS SDK を読み込む（ローカル in-memory では Node 14 でも起動可能にする）。
 *
 * @returns {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient}
 */
const getDocClient = () => {
  if (!useDynamoDb) {
    throw new Error('DynamoDB is not configured')
  }
  if (!docClient) {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')
    const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb')
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))
  }
  return docClient
}

/**
 * @typedef {{ id: number, text: string, color: string, createdAt: number }} CommentRecord
 */

/**
 * インメモリ用コメント（ローカル開発フォールバック）。
 * @type {{ id: number, text: string, color: string, createdAt: number, delivered: boolean }[]}
 */
const memoryComments = []

/** @type {number} */
let memoryNextId = 1

/**
 * 履歴 API 用に、直近ウィンドウと件数上限の交差を返す。
 *
 * @param {CommentRecord[]} items 新しい順に並んだ候補。
 * @returns {CommentRecord[]}
 */
const applyHistoryLimits = (items) => {
  const cutoff = Date.now() - HISTORY_WINDOW_MS
  return items
    .filter((item) => item.createdAt >= cutoff)
    .slice(0, HISTORY_MAX_COUNT)
}

/**
 * DynamoDB のカウンタ行を初期化する（初回のみ）。
 *
 * @returns {Promise<void>}
 */
const ensureMetaRow = async () => {
  const client = getDocClient()
  const { PutCommand } = require('@aws-sdk/lib-dynamodb')
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { commentId: META_COMMENT_ID, nextId: 0 },
        ConditionExpression: 'attribute_not_exists(commentId)',
      }),
    )
  } catch (error) {
    if (error && typeof error === 'object' && error.name !== 'ConditionalCheckFailedException') {
      throw error
    }
  }
}

/**
 * DynamoDB で単調増加 ID を採番する。
 *
 * @returns {Promise<number>}
 */
const allocateCommentId = async () => {
  const client = getDocClient()
  const { UpdateCommand } = require('@aws-sdk/lib-dynamodb')
  await ensureMetaRow()
  const result = await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { commentId: META_COMMENT_ID },
      UpdateExpression: 'ADD nextId :inc',
      ExpressionAttributeValues: { ':inc': 1 },
      ReturnValues: 'UPDATED_NEW',
    }),
  )
  const nextId = result.Attributes?.nextId
  if (typeof nextId !== 'number') {
    throw new Error('failed to allocate comment id')
  }
  return nextId
}

/**
 * コメントを保存する。
 *
 * @param {string} text 本文（トリム済み想定）。
 * @param {string} color 文字色 HEX。
 * @returns {Promise<{ id: number }>}
 */
const addComment = async (text, color) => {
  const createdAt = Date.now()

  if (!useDynamoDb) {
    const entry = {
      id: memoryNextId++,
      text,
      color,
      createdAt,
      delivered: false,
    }
    memoryComments.push(entry)
    return { id: entry.id }
  }

  const { PutCommand } = require('@aws-sdk/lib-dynamodb')
  const commentId = await allocateCommentId()
  await getDocClient().send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        commentId,
        text,
        color,
        createdAt,
        scope: SCOPE_ALL,
        pendingKey: PENDING_KEY,
      },
    }),
  )
  return { id: commentId }
}

/**
 * after より大きい未配信コメントを返し、配信済みにする。
 *
 * @param {number} after この id 以下は対象外。
 * @returns {Promise<CommentRecord[]>}
 */
const takePendingAfter = async (after) => {
  if (!useDynamoDb) {
    const batch = memoryComments.filter((c) => c.id > after && !c.delivered)
    for (const item of batch) {
      item.delivered = true
    }
    return batch.map(({ id, text, color, createdAt }) => ({ id, text, color, createdAt }))
  }

  const { QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb')
  const client = getDocClient()

  const queryResult = await client.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'PendingComments',
      KeyConditionExpression: 'pendingKey = :pending AND commentId > :after',
      ExpressionAttributeValues: {
        ':pending': PENDING_KEY,
        ':after': after,
      },
    }),
  )

  const items = queryResult.Items || []
  const batch = items
    .filter((item) => typeof item.commentId === 'number' && item.commentId > META_COMMENT_ID)
    .map((item) => ({
      id: item.commentId,
      text: String(item.text || ''),
      color: String(item.color || '#ffffff'),
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
    }))
    .sort((a, b) => a.id - b.id)

  await Promise.all(
    batch.map((item) =>
      client.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { commentId: item.id },
          UpdateExpression: 'REMOVE pendingKey',
        }),
      ),
    ),
  )

  return batch
}

/**
 * 過去1時間・最大50件（交差）のコメント履歴を新しい順で返す。
 *
 * @returns {Promise<CommentRecord[]>}
 */
const listHistory = async () => {
  const cutoff = Date.now() - HISTORY_WINDOW_MS

  if (!useDynamoDb) {
    const sorted = [...memoryComments].sort((a, b) => b.createdAt - a.createdAt)
    return applyHistoryLimits(
      sorted.map(({ id, text, color, createdAt }) => ({ id, text, color, createdAt })),
    )
  }

  const { QueryCommand } = require('@aws-sdk/lib-dynamodb')
  const queryResult = await getDocClient().send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'ByCreatedAt',
      KeyConditionExpression: '#scope = :scope AND createdAt >= :cutoff',
      ExpressionAttributeNames: { '#scope': 'scope' },
      ExpressionAttributeValues: {
        ':scope': SCOPE_ALL,
        ':cutoff': cutoff,
      },
      ScanIndexForward: false,
      Limit: HISTORY_MAX_COUNT,
    }),
  )

  const items = (queryResult.Items || [])
    .filter((item) => typeof item.commentId === 'number' && item.commentId > META_COMMENT_ID)
    .map((item) => ({
      id: item.commentId,
      text: String(item.text || ''),
      color: String(item.color || '#ffffff'),
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
    }))

  return applyHistoryLimits(items)
}

/**
 * 全コメント履歴を新しい順で返す（件数・時間の上限なし）。
 *
 * @returns {Promise<CommentRecord[]>}
 */
const listAllHistory = async () => {
  if (!useDynamoDb) {
    return [...memoryComments]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ id, text, color, createdAt }) => ({ id, text, color, createdAt }))
  }

  const { QueryCommand } = require('@aws-sdk/lib-dynamodb')
  const client = getDocClient()
  const items = []
  let lastKey = undefined

  do {
    const queryResult = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'ByCreatedAt',
        KeyConditionExpression: '#scope = :scope',
        ExpressionAttributeNames: { '#scope': 'scope' },
        ExpressionAttributeValues: {
          ':scope': SCOPE_ALL,
        },
        ScanIndexForward: false,
        ExclusiveStartKey: lastKey,
      }),
    )

    for (const item of queryResult.Items || []) {
      if (typeof item.commentId !== 'number' || item.commentId <= META_COMMENT_ID) {
        continue
      }
      items.push({
        id: item.commentId,
        text: String(item.text || ''),
        color: String(item.color || '#ffffff'),
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
      })
    }

    lastKey = queryResult.LastEvaluatedKey
  } while (lastKey)

  return items
}

/**
 * ストアが DynamoDB バックエンドかどうか。
 *
 * @returns {boolean}
 */
const isDynamoDbEnabled = () => useDynamoDb

module.exports = {
  addComment,
  takePendingAfter,
  listHistory,
  listAllHistory,
  isDynamoDbEnabled,
  HISTORY_MAX_COUNT,
  HISTORY_WINDOW_MS,
}
