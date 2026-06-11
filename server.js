'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')
const commentStore = require('./lib/comment-store')

const PORT = Number.parseInt(process.env.PORT || '3000', 10)
const ROOT = __dirname
const MAX_BODY_BYTES = 65536
const DEFAULT_COMMENT_COLOR = '#ffffff'

/** @type {Record<string, string>} */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

/**
 * リクエストボディを文字列として読み取る。
 *
 * @param {http.IncomingMessage} req Node の HTTP リクエスト。
 * @returns {Promise<string>} 生のボディ文字列。
 */
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = ''
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('payload too large'))
        return
      }
      raw += chunk.toString('utf8')
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })

/**
 * API Gateway プロキシ統合の event.body も解釈できる JSON パース。
 *
 * @param {string} rawBody HTTP ボディ文字列。
 * @returns {object|null} 正規化したオブジェクト。不正なら null。
 */
const normalizePayload = (rawBody) => {
  let obj
  try {
    obj = JSON.parse(rawBody && rawBody.length > 0 ? rawBody : '{}')
  } catch {
    return null
  }
  if (obj && typeof obj.body === 'string') {
    try {
      obj = JSON.parse(obj.body)
    } catch {
      return null
    }
  }
  return obj && typeof obj === 'object' ? obj : null
}

/**
 * 投稿ペイロードを検証しストアへ保存する。
 *
 * @param {object} obj 入力オブジェクト。text は必須。
 * @returns {Promise<{ ok: true, id: number } | { ok: false, error: string }>}
 */
const addCommentFromPayload = async (obj) => {
  if (!obj || typeof obj.text !== 'string' || !obj.text.trim()) {
    return { ok: false, error: 'text is required (non-empty string)' }
  }
  const color =
    typeof obj.color === 'string' && obj.color.trim() !== ''
      ? obj.color.trim()
      : DEFAULT_COMMENT_COLOR
  const { id } = await commentStore.addComment(obj.text.trim(), color)
  return { ok: true, id }
}

/**
 * @param {string|undefined|null} raw after クエリの生値。
 * @returns {number}
 */
const parseAfterQuery = (raw) => Number.parseInt(raw || '0', 10) || 0

/**
 * JSON レスポンスを書き込む。
 *
 * @param {http.ServerResponse} res HTTP レスポンス。
 * @param {number} status HTTP ステータス。
 * @param {object} body JSON にシリアライズするオブジェクト。
 */
const json = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
  })
  res.end(JSON.stringify(body))
}

/**
 * プレーンテキストレスポンスを書き込む。
 *
 * @param {http.ServerResponse} res HTTP レスポンス。
 * @param {number} status HTTP ステータス。
 * @param {string} message 本文。
 */
const sendPlain = (res, status, message) => {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(message)
}

/**
 * パストラバーサル対策付きで静的ファイルを解決する。
 *
 * @param {string} pathname URL の pathname（先頭の / を含む）。
 * @returns {string|null} 読み込み可能な絶対パス。不可なら null。
 */
const resolveStaticPath = (pathname) => {
  const map = new Map([
    ['/', path.join(ROOT, 'post.html')],
    ['/post.html', path.join(ROOT, 'post.html')],
    ['/post.js', path.join(ROOT, 'post.js')],
    ['/view', path.join(ROOT, 'index.html')],
    ['/history', path.join(ROOT, 'history.html')],
    ['/history.js', path.join(ROOT, 'history.js')],
    ['/niconico.js', path.join(ROOT, 'niconico.js')],
    ['/node_modules/nicojs/lib/nico.js', path.join(ROOT, 'node_modules', 'nicojs', 'lib', 'nico.js')],
  ])
  const abs = map.get(pathname)
  if (!abs) {
    return null
  }
  const normalized = path.normalize(abs)
  const rootPrefix = path.normalize(ROOT + path.sep)
  if (!normalized.startsWith(rootPrefix)) {
    return null
  }
  return normalized
}

/**
 * 静的 GET の Content-Type を返す（実ファイルの拡張子で判定する）。
 *
 * @param {string} filePath 解決済みのファイル絶対パス。
 * @returns {string} MIME タイプ。
 */
const staticContentType = (filePath) => {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.html') {
    return 'text/html; charset=utf-8'
  }
  if (ext === '.js') {
    return 'text/javascript; charset=utf-8'
  }
  return 'application/octet-stream'
}

/**
 * @param {http.IncomingMessage} req
 * @returns {URL}
 */
const requestUrl = (req) => {
  const host = req.headers.host || `127.0.0.1:${PORT}`
  return new URL(req.url || '/', `http://${host}`)
}

/**
 * @param {http.ServerResponse} res
 * @param {URL} u
 * @returns {Promise<void>}
 */
const handleGetComments = async (res, u) => {
  try {
    const batch = await commentStore.takePendingAfter(parseAfterQuery(u.searchParams.get('after')))
    json(res, 200, { comments: batch })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    json(res, 500, { error: message })
  }
}

/**
 * @param {http.ServerResponse} res
 * @returns {Promise<void>}
 */
const handleGetCommentHistory = async (res) => {
  try {
    const comments = await commentStore.listHistory()
    json(res, 200, { comments })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    json(res, 500, { error: message })
  }
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {Promise<void>}
 */
const handlePostComment = async (req, res) => {
  try {
    const raw = await readBody(req)
    const obj = normalizePayload(raw)
    if (!obj) {
      json(res, 400, { error: 'invalid JSON' })
      return
    }
    const result = await addCommentFromPayload(obj)
    if (!result.ok) {
      json(res, 400, { error: result.error })
      return
    }
    json(res, 200, { id: result.id, received: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const status = message === 'payload too large' ? 413 : 500
    json(res, status, { error: message })
  }
}

/**
 * @param {http.ServerResponse} res
 * @param {string} pathname
 */
const handleStaticGet = (res, pathname) => {
  const filePath = resolveStaticPath(pathname)
  if (!filePath || !fs.existsSync(filePath)) {
    sendPlain(res, 404, 'Not Found')
    return
  }
  res.writeHead(200, { 'Content-Type': staticContentType(filePath) })
  fs.createReadStream(filePath).pipe(res)
}

const server = http.createServer(async (req, res) => {
  const u = requestUrl(req)
  const { pathname } = u
  const method = req.method || 'GET'

  if (method === 'OPTIONS' && pathname.startsWith('/api/')) {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }

  if (method === 'GET' && pathname === '/api/comments') {
    await handleGetComments(res, u)
    return
  }

  if (method === 'GET' && pathname === '/api/comments/history') {
    await handleGetCommentHistory(res)
    return
  }

  if (method === 'POST' && pathname === '/api/comment') {
    await handlePostComment(req, res)
    return
  }

  if (method === 'GET') {
    handleStaticGet(res, pathname)
    return
  }

  sendPlain(res, 405, 'Method Not Allowed')
})

server.listen(PORT, () => {
  const backend = commentStore.isDynamoDbEnabled() ? 'DynamoDB' : 'in-memory'
  console.log(`Comment post http://127.0.0.1:${PORT}/`)
  console.log(`Viewer http://127.0.0.1:${PORT}/view`)
  console.log(`History http://127.0.0.1:${PORT}/history`)
  console.log(`Storage backend: ${backend}`)
  console.log('POST JSON to /api/comment — example: {"text":"hello","color":"#ff8800"}')
})
