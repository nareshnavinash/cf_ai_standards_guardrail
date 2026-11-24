'use strict'
// All diff, model and user text is rendered via textContent (DOM text nodes) only; no HTML string injection.

const POLL_MS = 1500
const POLL_MAX_MS = 3 * 60 * 1000

const $ = (id) => document.getElementById(id)

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 3) | 8).toString(16)
  })
}
const visitorId = (() => {
  try {
    let v = localStorage.getItem('visitorId')
    if (!v) {
      v = uuid()
      localStorage.setItem('visitorId', v)
    }
    return v
  } catch {
    return uuid()
  }
})()

function h(tag, props, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (v === true) e.setAttribute(k, '')
    else if (v !== false && v != null) e.setAttribute(k, v)
  }
  for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)))
  return e
}
const clear = (el) => el.replaceChildren()

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-visitor-id': visitorId, ...(opts.headers || {}) },
  })
  let body = null
  if (res.status !== 204) {
    try {
      body = await res.json()
    } catch {
      body = null
    }
  }
  return { ok: res.ok, status: res.status, body }
}
const errText = (r) => (r.body && typeof r.body.error === 'string' ? r.body.error : 'Something went wrong. Please try again.')

const state = { reviewId: null, running: false, chatLocked: false, lastBody: null, rules: [], timer: null, tick: null, result: null }

function setBusy(busy) {
  state.running = busy
  $('review-btn').disabled = busy
  $('rerun-btn').disabled = busy
  document.querySelectorAll('.chip').forEach((b) => (b.disabled = busy))
}
function setStatus(text) {
  $('status').textContent = text
}
function showFormError(msg) {
  const el = $('form-error')
  el.textContent = msg || ''
  el.hidden = !msg
}
function setChatEnabled(on) {
  const enabled = on && !state.chatLocked
  $('chat-input').disabled = !enabled
  $('chat-btn').disabled = !enabled
}
function lockChat(message) {
  state.chatLocked = true
  setChatEnabled(false)
  $('chat-error').textContent = message
  $('chat-error').hidden = false
}

function stopPolling() {
  clearTimeout(state.timer)
  clearInterval(state.tick)
  state.timer = null
  state.tick = null
}

async function startReview(body) {
  if (state.running) return
  showFormError('')
  setBusy(true)
  state.chatLocked = false
  $('chat-error').hidden = true
  setChatEnabled(false)
  stopPolling()
  state.lastBody = body
  state.result = null
  clear($('findings'))
  clear($('banners'))
  $('suppressed-wrap').hidden = true
  $('skipped-wrap').hidden = true
  $('rerun-wrap').hidden = true
  clear($('chat-log'))
  setStatus('Starting review…')
  let r
  try {
    r = await api('/api/reviews', { method: 'POST', body: JSON.stringify(body) })
  } catch {
    setBusy(false)
    setStatus('')
    showFormError('Could not reach the server. Check your connection and try again.')
    return
  }
  if (r.status !== 202) {
    setBusy(false)
    setStatus('')
    showFormError(errText(r))
    return
  }
  state.reviewId = r.body.reviewId
  poll(Date.now(), 0)
}

function poll(startedAt, misses) {
  const secs = () => Math.round((Date.now() - startedAt) / 1000)
  setStatus(`Running… ${secs()}s`)
  clearInterval(state.tick)
  state.tick = setInterval(() => setStatus(`Running… ${secs()}s`), 1000)
  const step = async () => {
    if (Date.now() - startedAt > POLL_MAX_MS) return finishFailed('Taking longer than expected — try again')
    let r
    try {
      r = await api(`/api/reviews/${encodeURIComponent(state.reviewId)}`)
    } catch {
      r = { status: 0, body: null }
    }
    if (r.status === 404) {
      if (misses + 1 >= 3) return finishFailed('This review could not be found. Please run it again.')
      misses++
    } else if (r.status === 200 && r.body && r.body.status === 'complete') {
      stopPolling()
      return renderResult(r.body.result)
    } else if (r.status === 200 && r.body && r.body.status === 'failed') {
      return finishFailed(r.body.error || 'The review could not be completed. Please try again.')
    }
    state.timer = setTimeout(step, POLL_MS)
  }
  state.timer = setTimeout(step, POLL_MS)
}

function finishFailed(msg) {
  stopPolling()
  setBusy(false)
  setStatus(msg)
  $('rerun-wrap').hidden = !state.lastBody
}

function banner(text, info) {
  return h('div', { class: 'banner' + (info ? ' info' : '') }, text)
}

function dirGlob(path) {
  const i = path.lastIndexOf('/')
  return i > 0 ? path.slice(0, i) + '/**' : path
}

function findingCard(f) {
  const rule = state.rules.find((r) => r.id === f.ruleId)
  const card = h(
    'article',
    { class: 'finding' },
    h(
      'div',
      { class: 'finding-head' },
      h('span', { class: 'badge ' + (rule ? rule.severity : 'warning') }, `${f.ruleId} ${rule ? rule.severity : ''}`.trim()),
      h('span', { class: 'loc' }, f.line ? `${f.path}:${f.line}` : f.path),
      h('span', { class: 'badge src' }, f.source === 'llm' ? 'LLM' : 'static'),
    ),
    rule ? h('p', { class: 'muted' }, rule.title) : null,
    h('p', {}, f.message),
    f.suggestion ? h('p', { class: 'suggestion' }, 'Suggestion: ' + f.suggestion) : null,
  )
  const slot = h('div', {})
  const open = h('button', { type: 'button', class: 'link' }, 'Add exception…')
  open.addEventListener('click', () => {
    open.hidden = true
    slot.append(exceptionForm(f, () => ((open.hidden = false), clear(slot))))
  })
  card.append(open, slot)
  return card
}

function exceptionForm(f, onCancel) {
  const select = h('select', { 'aria-label': 'Rule' }, state.rules.map((r) => h('option', { value: r.id }, `${r.id} ${r.title}`)))
  select.value = f.ruleId
  const glob = h('input', { type: 'text', value: dirGlob(f.path), 'aria-label': 'Path glob', maxlength: '200' })
  const reason = h('input', { type: 'text', placeholder: 'Why is this acceptable here?', 'aria-label': 'Reason', maxlength: '500' })
  const err = h('p', { class: 'error', role: 'alert', hidden: true })
  const save = h('button', { type: 'submit', class: 'primary' }, 'Save exception')
  const cancel = h('button', { type: 'button' }, 'Cancel')
  cancel.addEventListener('click', onCancel)
  const form = h('form', { class: 'exc-form', autocomplete: 'off' }, select, glob, reason, err, h('div', { class: 'actions' }, save, cancel))
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    save.disabled = true
    err.hidden = true
    const r = await api(`/api/reviews/${encodeURIComponent(state.reviewId)}/exceptions`, {
      method: 'POST',
      body: JSON.stringify({ ruleId: select.value, pathGlob: glob.value, reason: reason.value }),
    }).catch(() => ({ ok: false, body: null }))
    save.disabled = false
    if (!r.ok) {
      err.textContent = errText(r)
      err.hidden = false
      return
    }
    onCancel()
    await loadExceptions()
    $('rerun-wrap').hidden = false
    setStatus('Exception saved. Re-run the review to apply it.')
  })
  return form
}

function renderResult(res) {
  state.result = res
  setBusy(false)
  setStatus(
    res.findings.length
      ? `${res.findings.length} finding${res.findings.length === 1 ? '' : 's'} in ${res.filesReviewed} file${res.filesReviewed === 1 ? '' : 's'} — ${res.title}${res.prNumber ? ' (#' + res.prNumber + ')' : ''}`
      : `No findings in ${res.filesReviewed} file${res.filesReviewed === 1 ? '' : 's'} — ${res.title}`,
  )
  const banners = $('banners')
  clear(banners)
  if (res.cached) banners.append(banner('Served from cache: this exact diff was reviewed before.', true))
  if (res.mode === 'static-only') banners.append(banner('Static-only mode: the daily LLM budget is used up, so only the deterministic checks ran (STD-001 to STD-004).'))
  if (res.truncated) banners.append(banner('This PR was truncated to stay within limits (10 files, 300 added lines per file).'))
  if (res.degradedFiles.length) {
    banners.append(banner(`LLM check unavailable for ${res.degradedFiles.length} file${res.degradedFiles.length === 1 ? '' : 's'}: ${res.degradedFiles.join(', ')}. Static results are still shown.`))
  }
  const list = $('findings')
  clear(list)
  for (const f of res.findings) list.append(findingCard(f))

  const sw = $('suppressed-wrap')
  sw.hidden = res.suppressed.length === 0
  $('suppressed-title').textContent = `Suppressed by exceptions (${res.suppressed.length})`
  const sup = $('suppressed')
  clear(sup)
  for (const f of res.suppressed) {
    sup.append(h('div', { class: 'finding' }, h('div', { class: 'finding-head' }, h('span', { class: 'badge src' }, f.ruleId), h('span', { class: 'loc' }, f.line ? `${f.path}:${f.line}` : f.path)), h('p', {}, f.message)))
  }
  const kw = $('skipped-wrap')
  kw.hidden = res.skippedFiles.length === 0
  $('skipped-title').textContent = `Skipped files (${res.skippedFiles.length})`
  const sk = $('skipped')
  clear(sk)
  for (const p of res.skippedFiles) sk.append(h('li', { class: 'loc' }, p))

  $('rerun-wrap').hidden = false
  if (res.mode === 'static-only') lockChat('Chat is unavailable for static-only reviews (the daily AI budget was used up).')
  setChatEnabled(true)
  loadExceptions()
}

async function loadExceptions() {
  const ul = $('exceptions')
  if (!state.reviewId) return
  const r = await api(`/api/reviews/${encodeURIComponent(state.reviewId)}/exceptions`).catch(() => null)
  clear(ul)
  if (!r || !r.ok || !Array.isArray(r.body) || r.body.length === 0) {
    ul.append(h('li', { class: 'muted' }, 'None yet.'))
    return
  }
  for (const e of r.body) {
    const del = h('button', { type: 'button', 'aria-label': `Remove exception for ${e.ruleId} on ${e.pathGlob}` }, '✕')
    del.addEventListener('click', async () => {
      del.disabled = true
      await api(`/api/reviews/${encodeURIComponent(state.reviewId)}/exceptions/${encodeURIComponent(e.id)}`, { method: 'DELETE' }).catch(() => null)
      loadExceptions()
    })
    ul.append(h('li', {}, h('span', {}, h('strong', {}, e.ruleId), ' ', h('span', { class: 'loc' }, e.pathGlob), h('br'), h('span', { class: 'muted' }, e.reason)), del))
  }
}

function addMsg(role, text) {
  const log = $('chat-log')
  log.append(h('div', { class: 'msg ' + role }, text))
  log.scrollTop = log.scrollHeight
}

async function sendChat(ev) {
  ev.preventDefault()
  const input = $('chat-input')
  const message = input.value.trim()
  if (!message || !state.result) return
  $('chat-error').hidden = true
  addMsg('user', message)
  input.value = ''
  setChatEnabled(false)
  const r = await api(`/api/reviews/${encodeURIComponent(state.reviewId)}/chat`, { method: 'POST', body: JSON.stringify({ message }) }).catch(() => ({ ok: false, body: null }))
  setChatEnabled(true)
  if (!r.ok) {
    const msg = errText(r)
    if (r.status === 429 && /resumes tomorrow|for this review/.test(msg)) return lockChat(msg)
    $('chat-error').textContent = msg
    $('chat-error').hidden = false
    return
  }
  addMsg('assistant', r.body.reply)
}

async function init() {
  $('pr-form').addEventListener('submit', (ev) => {
    ev.preventDefault()
    const url = $('pr-url').value.trim()
    if (!url) return showFormError('Paste a link like https://github.com/owner/repo/pull/123')
    startReview({ prUrl: url })
  })
  $('rerun-btn').addEventListener('click', () => state.lastBody && startReview(state.lastBody))
  $('chat-form').addEventListener('submit', sendChat)
  try {
    const [rules, samples] = await Promise.all([api('/api/rules'), api('/api/samples')])
    state.rules = Array.isArray(rules.body) ? rules.body : []
    const chips = $('samples')
    for (const s of Array.isArray(samples.body) ? samples.body : []) {
      chips.append(h('button', { type: 'button', class: 'chip', title: s.description, onclick: () => startReview({ sampleId: s.id }) }, s.title))
    }
  } catch {
    showFormError('Could not load the sample list. You can still paste a PR link.')
  }
}
init()
