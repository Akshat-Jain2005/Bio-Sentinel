import { useCallback, useEffect, useRef, useState } from 'react'

const TOKEN_KEY = 'bs_operator_token'
let memoryToken = ''
// Retire the old persistent token. Sessions last for this browser tab only.
try { localStorage.removeItem(TOKEN_KEY) } catch { /* Storage may be blocked. */ }
export const getToken = () => {
  try { return sessionStorage.getItem(TOKEN_KEY) || memoryToken } catch { return memoryToken }
}
export const setToken = (token) => {
  memoryToken = token
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch { /* In-memory sign-in remains available. */ }
}

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail || `Request failed (${status})`)
    this.status = status
  }
}

export async function api(path, { method = 'GET', body, auth = true, signal } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const token = getToken()
  if (auth && token) headers.Authorization = `Bearer ${token}`
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const timeout = setTimeout(abort, 15000)
  try {
    const res = await fetch(path, {
      method, headers, signal: controller.signal, cache: 'no-store',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (res.status === 401 && auth && token && token === getToken()) {
      window.dispatchEvent(new Event('biosentinel:session-expired'))
    }
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch {
      throw new ApiError(res.status, text && text.length < 200 ? text : 'The service returned an unreadable response. Try again.')
    }
    if (!res.ok) {
      const detail = Array.isArray(data?.detail)
        ? data.detail.map((item) => item.msg).join('; ')
        : data?.detail
      throw new ApiError(res.status, typeof detail === 'string' ? detail : res.statusText)
    }
    return data
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof ApiError) throw error
    throw new ApiError(0, controller.signal.aborted
      ? 'The service took too long to respond. Try again.'
      : 'Cannot reach the service. Check your connection and try again.')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

// Abort superseded reads, ignore late responses, and pause in background tabs.
export function usePoll(path, intervalMs = 5000, { enabled = true } = {}) {
  const [snapshot, setSnapshot] = useState({ path: null, data: null, error: null, loading: true })
  const active = useRef(null)
  const mounted = useRef(false)
  const load = useCallback(async () => {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    try {
      const next = await api(path, { signal: controller.signal })
      if (mounted.current && !controller.signal.aborted) setSnapshot({ path, data: next, error: null, loading: false })
    } catch (err) {
      if (mounted.current && !controller.signal.aborted) setSnapshot((previous) => ({
        path, data: previous.path === path ? previous.data : null, error: err, loading: false,
      }))
    } finally {
      if (active.current === controller) active.current = null
    }
  }, [path])

  useEffect(() => {
    mounted.current = true
    // This async read updates state only after awaiting the response.
    // oxlint-disable-next-line react/set-state-in-effect
    if (enabled) load()
    const visible = () => { if (enabled && !document.hidden && !active.current) load() }
    const id = enabled ? setInterval(visible, intervalMs) : null
    document.addEventListener('visibilitychange', visible)
    return () => {
      mounted.current = false
      clearInterval(id)
      active.current?.abort()
      document.removeEventListener('visibilitychange', visible)
    }
  }, [enabled, intervalMs, load])
  const current = snapshot.path === path ? snapshot : { data: null, error: null, loading: enabled }
  return { ...current, refresh: load }
}
