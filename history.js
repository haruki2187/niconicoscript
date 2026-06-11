'use strict'

const statusEl = document.getElementById('status')
const listEl = document.getElementById('comment-list')
const refreshBtn = document.getElementById('btn-refresh')

/**
 * ステータス表示を更新する。
 *
 * @param {string} message 表示文言。
 */
const setStatus = (message) => {
  if (statusEl) {
    statusEl.textContent = message
  }
}

/**
 * epoch ms をローカル時刻文字列に変換する。
 *
 * @param {number} createdAt 投稿時刻（epoch ms）。
 * @returns {string}
 */
const formatTime = (createdAt) => {
  if (typeof createdAt !== 'number' || Number.isNaN(createdAt)) {
    return '--:--:--'
  }
  return new Date(createdAt).toLocaleString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    month: '2-digit',
    day: '2-digit',
  })
}

/**
 * コメント 1 件の DOM を生成する。
 *
 * @param {{ id?: number, text?: string, color?: string, createdAt?: number }} comment コメント。
 * @returns {HTMLLIElement}
 */
const renderCommentItem = (comment) => {
  const item = document.createElement('li')
  item.className = 'comment-item'

  const timeEl = document.createElement('div')
  timeEl.className = 'comment-time'
  timeEl.textContent = formatTime(comment.createdAt)

  const swatch = document.createElement('div')
  swatch.className = 'color-swatch'
  swatch.style.backgroundColor =
    typeof comment.color === 'string' && comment.color.trim() !== '' ? comment.color : '#ffffff'
  swatch.title = swatch.style.backgroundColor

  const textEl = document.createElement('p')
  textEl.className = 'comment-text'
  textEl.textContent = typeof comment.text === 'string' ? comment.text : ''
  textEl.style.color = swatch.style.backgroundColor

  item.append(timeEl, swatch, textEl)
  return item
}

/**
 * 一覧を描画する。
 *
 * @param {Array<{ id?: number, text?: string, color?: string, createdAt?: number }>} comments コメント配列。
 */
const renderComments = (comments) => {
  if (!listEl) {
    return
  }
  listEl.replaceChildren()
  if (!Array.isArray(comments) || comments.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'empty'
    empty.textContent = '表示できるコメントはありません'
    listEl.append(empty)
    setStatus('0 件')
    return
  }
  for (const comment of comments) {
    listEl.append(renderCommentItem(comment))
  }
  setStatus(`${comments.length} 件`)
}

/**
 * 履歴 API からコメント一覧を取得して描画する。
 *
 * @returns {Promise<void>}
 */
const loadHistory = async () => {
  if (refreshBtn) {
    refreshBtn.disabled = true
  }
  setStatus('読み込み中…')
  try {
    const res = await fetch('/api/comments/history')
    let data = {}
    try {
      data = await res.json()
    } catch {
      /* 空ボディ等 */
    }
    if (!res.ok) {
      setStatus(typeof data.error === 'string' ? data.error : `エラー (${res.status})`)
      return
    }
    const comments = Array.isArray(data.comments) ? data.comments : []
    renderComments(comments)
  } catch (error) {
    setStatus('読み込みに失敗しました')
    console.error('loadHistory failed', error)
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false
    }
  }
}

if (refreshBtn) {
  refreshBtn.addEventListener('click', () => {
    void loadHistory()
  })
}

void loadHistory()
