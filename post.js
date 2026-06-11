'use strict'

const textInput = document.getElementById('text')
const colorInput = document.getElementById('comment-color')
const colorHexEl = document.getElementById('comment-color-hex')
const submitBtn = document.getElementById('btn-send')
const statusEl = document.getElementById('status')

/**
 * カラーピッカーの値を HEX 表示に反映する。
 */
const syncColorUi = () => {
  if (!colorInput || !colorHexEl) {
    return
  }
  colorHexEl.textContent = colorInput.value
}

if (colorInput) {
  colorInput.addEventListener('input', syncColorUi)
  colorInput.addEventListener('change', syncColorUi)
  syncColorUi()
}

/**
 * ステータス表示を更新する。
 *
 * @param {string} message 表示文言。
 */
const setStatus = (message) => {
  statusEl.textContent = message
}

/**
 * 入力内容を API に POST する。
 *
 * @returns {Promise<void>}
 */
const postComment = async () => {
  const text = textInput.value.trim()
  if (!text) {
    setStatus('コメントを入力してください')
    return
  }
  if (submitBtn) {
    submitBtn.disabled = true
  }
  setStatus('送信中…')
  try {
    const color =
      colorInput && typeof colorInput.value === 'string'
        ? colorInput.value
        : '#ffffff'
    const res = await fetch('/api/comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, color }),
    })
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
    textInput.value = ''
    const successMsg = `送信しました：${text}`
    setStatus(successMsg)
    setTimeout(() => {
      if (statusEl.textContent === successMsg) {
        setStatus('')
      }
    }, 3000)
  } catch (err) {
    setStatus('送信に失敗しました')
    console.error('postComment failed', err)
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false
    }
    textInput.focus()
  }
}

if (submitBtn) {
  submitBtn.addEventListener('click', () => {
    void postComment()
  })
} else {
  setStatus('送信ボタンの初期化に失敗しました')
}

textInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) {
    return
  }
  // IME 確定の Enter と区別するため、修飾キー付きのみ送信する
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    void postComment()
  }
})

textInput.focus()
