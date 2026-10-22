import { useCallback, useEffect, useRef, useState } from 'react'
import { api, getToken, setToken } from './api'

import { AuthCtx, useAuth } from './auth-context'
const PUBLIC = { role: 'public', name: 'anonymous' }

export function AuthProvider({ children }) {
  const [config, setConfig] = useState(null)
  const [configError, setConfigError] = useState(null)
  const [user, setUser] = useState(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)
  const revision = useRef(0)

  const loadConfig = useCallback(async () => {
    try { setConfig(await api('/auth/config', { auth: false })); setConfigError(null) }
    catch (error) { setConfigError(error.message) }
  }, [])

  const resolve = useCallback(async (signingIn = false) => {
    const version = ++revision.current
    const token = getToken()
    try {
      const next = await (token ? api('/me') : Promise.resolve(PUBLIC))
      if (version !== revision.current) return
      if (next.role === 'public' && token) {
        setToken('')
        setNotice(signingIn ? 'Sign-in could not be verified. Please try again.' : 'Your session has expired. Sign in again to continue.')
      }
      setUser(next)
    } catch (error) {
      if (version !== revision.current) return
      setNotice(error.message)
      setUser(PUBLIC)
    } finally {
      if (version === revision.current) { setReady(true); setBusy(false) }
    }
  }, [])

  const signOut = useCallback((expired = false) => {
    ++revision.current
    setToken('')
    window.google?.accounts?.id?.disableAutoSelect?.()
    setUser(PUBLIC); setBusy(false); setReady(true)
    setNotice(expired ? 'Your session has expired. Sign in again to continue.' : null)
  }, [])

  const cancelPending = useCallback(() => { ++revision.current }, [])

  useEffect(() => {
    // Both functions update state after awaited reads, never synchronously.
    // oxlint-disable-next-line react/set-state-in-effect
    loadConfig(); resolve()
    const expired = () => signOut(true)
    const recheck = () => { if (!document.hidden && getToken()) resolve() }
    const id = setInterval(recheck, 60000)
    window.addEventListener('biosentinel:session-expired', expired)
    window.addEventListener('focus', recheck)
    return () => {
      cancelPending()
      clearInterval(id)
      window.removeEventListener('biosentinel:session-expired', expired)
      window.removeEventListener('focus', recheck)
    }
  }, [loadConfig, resolve, signOut, cancelPending])

  const signIn = useCallback(async (token) => {
    if (!token || typeof token !== 'string') {
      setNotice('Google did not return a sign-in credential. Please try again.')
      return
    }
    setBusy(true); setNotice(null); setToken(token.trim())
    await resolve(true)
  }, [resolve])
  const onCredential = useCallback((response) => signIn(response?.credential), [signIn])
  const devSignIn = useCallback((token) => {
    if (config?.dev_login_enabled) return signIn(token)
  }, [config, signIn])

  const loginWithPassword = useCallback(async (email, password) => {
    setBusy(true); setNotice(null)
    try {
      const { token } = await api('/auth/login', { method: 'POST', auth: false, body: { email, password } })
      await signIn(token)
    } catch (error) {
      setBusy(false); setNotice(error.message); throw error
    }
  }, [signIn])

  const register = useCallback(async ({ name, email, password, phone, alt_phone }) => {
    setBusy(true); setNotice(null)
    try {
      const { token } = await api('/auth/register', { method: 'POST', auth: false, body: { name, email, password, phone, alt_phone } })
      await signIn(token)
    } catch (error) {
      setBusy(false); setNotice(error.message); throw error
    }
  }, [signIn])

  const staffLogin = useCallback(async (role, email, password, code) => {
    setBusy(true); setNotice(null)
    try {
      const { token } = await api('/auth/staff-login', { method: 'POST', auth: false, body: { role, email, password, code } })
      await signIn(token)
    } catch (error) {
      setBusy(false); setNotice(error.message); throw error
    }
  }, [signIn])

  const clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID || '').trim() || config?.google_client_id || ''

  return <AuthCtx.Provider value={{
    clientId, devEnabled: config?.dev_login_enabled === true,
    passwordEnabled: config?.password_login_enabled === true,
    registrationEnabled: config?.registration_enabled === true,
    staffEnabled: config?.staff_login_enabled === true,
    configLoading: !config && !configError, configError, loadConfig,
    user, ready, busy, notice, onCredential, devSignIn, loginWithPassword, register, staffLogin, signOut,
  }}>{children}</AuthCtx.Provider>
}

let googleScript
function loadGoogle() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id)
  if (googleScript) return googleScript
  googleScript = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    const fail = () => {
      clearTimeout(timeout)
      script.remove()
      reject(new Error('Google sign-in could not load. Check your connection or browser blocking settings, then retry.'))
    }
    const timeout = setTimeout(fail, 12000)
    script.onerror = fail
    script.onload = () => {
      clearTimeout(timeout)
      if (window.google?.accounts?.id) resolve(window.google.accounts.id)
      else fail()
    }
    document.head.append(script)
  }).catch((error) => { googleScript = null; throw error })
  return googleScript
}

export function GoogleButton() {
  const { clientId, onCredential, busy } = useAuth()
  const host = useRef(null)
  const [error, setError] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    if (!clientId) {
      setLoaded(false)
      return
    }
    loadGoogle().then((gsi) => {
      if (cancelled || !host.current) return
      gsi.initialize({ client_id: clientId, callback: onCredential, auto_select: false })
      host.current.replaceChildren()
      gsi.renderButton(host.current, {
        theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular',
        width: Math.min(320, host.current.clientWidth),
      })
      setLoaded(true)
    }).catch((err) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [clientId, onCredential, attempt])
  return <div className="google-signin" aria-busy={busy}>
    {!clientId && <p role="status" className="muted">Google sign-in client ID not configured.</p>}
    {clientId && !loaded && !error && <p role="status" className="muted">Loading Google sign-in…</p>}
    <div ref={host} className="gsi-host" inert={busy} />
    {error && <div className="signin-error"><p role="alert">{error}</p>
      <button type="button" className="btn-secondary" onClick={() => { setError(null); setLoaded(false); setAttempt((n) => n + 1) }}>Retry Google sign-in</button>
    </div>}
  </div>
}
