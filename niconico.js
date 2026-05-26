const NicoJS = typeof nicoJS !== 'undefined' ? nicoJS : null
if (!NicoJS) {
  throw new Error('nicoJS が読み込まれていません。/view から開くか、先に nico.js を読み込んでください。')
}

const NICO_OPTIONS = {
  app: document.getElementById('app'),
  width: 1920,
  height: 1080,
  font_size: 60,
  color: '#fff',
}

/** コメント文字の 1px 輪郭（nicoJS 既定のぼかし影を上書き）。 */
const COMMENT_OUTLINE_SHADOW =
  '1px 0 0 #000, -1px 0 0 #000, 0 1px 0 #000, 0 -1px 0 #000'

const POLL_MS = 500

/**
 * send 直後に最後のコメント要素へ輪郭用 textShadow を付与する。
 *
 * @param {object} nico nicoJS インスタンス。
 */
const patchSendWithOutline = (nico) => {
  const sendOriginal = nico.send.bind(nico)
  nico.send = (text, color) => {
    sendOriginal(text, color)
    const last = nico.comments[nico.comments.length - 1]
    if (last?.ele) {
      last.ele.style.textShadow = COMMENT_OUTLINE_SHADOW
    }
  }
}

const nico = new NicoJS(NICO_OPTIONS)
patchSendWithOutline(nico)
nico.listen()

/** Lambda 相当のキューから未配信分を取得し nicoJS で流す（サーバは返却後に破棄）。 */
let lastCommentId = 0
/** 前回の fetch が終わる前に次を走らせない（重複 GET で取りこぼしやすい）。 */
let pollInFlight = false

/**
 * API 1件を nicoJS に流す。
 *
 * @param {{ id?: number, text?: string, color?: string }} c コメント。
 * @param {number} maxSeen これまでに見た最大 id。
 * @returns {number} 更新後の maxSeen。
 */
const playComment = (c, maxSeen) => {
  if (typeof c.id === 'number') {
    maxSeen = Math.max(maxSeen, c.id)
  }
  const text = typeof c.text === 'string' ? c.text : ''
  if (!text) {
    return maxSeen
  }
  const color = typeof c.color === 'string' ? c.color : undefined
  try {
    nico.send(text, color)
  } catch (sendErr) {
    console.error('nico.send failed', sendErr)
  }
  return maxSeen
}

/**
 * 未配信コメントを取得し nicoJS で送信する（同一コメントの再取得はサーバ側で抑止）。
 *
 * @returns {Promise<void>}
 */
const pollComments = async () => {
  if (pollInFlight) {
    return
  }
  pollInFlight = true
  try {
    const res = await fetch(`/api/comments?after=${lastCommentId}`)
    if (!res.ok) {
      return
    }
    const data = await res.json()
    const list = Array.isArray(data.comments) ? data.comments : []
    let maxSeen = lastCommentId
    for (const c of list) {
      maxSeen = playComment(c, maxSeen)
    }
    lastCommentId = Math.max(lastCommentId, maxSeen)
  } catch (err) {
    console.error('pollComments failed', err)
  } finally {
    pollInFlight = false
  }
}

setInterval(pollComments, POLL_MS)
pollComments()
