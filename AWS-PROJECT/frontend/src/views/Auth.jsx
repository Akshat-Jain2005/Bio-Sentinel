import { useState, useRef, useEffect } from 'react'
import { api } from '../api'
import { GoogleButton } from '../auth'
import { useAuth } from '../auth-context'
import river from '../assets/river-hero.jpg'
import logoMark from '../assets/logo-mark.png'

const ROLES = [
  { id: 'operator', label: 'Operator' },
  { id: 'reporter', label: 'Verified reporter' },
  { id: 'citizen', label: 'Citizen' },
]

export default function Auth({ initialRole = 'operator', initialMode = 'signin', onBack }) {
  const {
    user, clientId, devEnabled, loginWithPassword, register, staffLogin, devSignIn,
    busy, notice, onCredential, configLoading, configError, loadConfig,
  } = useAuth()

  // Redirect to main page as soon as user is authenticated
  useEffect(() => {
    if (user && user.role && user.role !== 'public') {
      if (onBack) onBack()
    }
  }, [user, onBack])

  // Active role/tab: 'operator' | 'reporter' | 'citizen'
  const [role, setRole] = useState(ROLES.some((r) => r.id === initialRole) ? initialRole : 'operator')
  // For Citizen: 'signin' | 'register'
  const [mode, setMode] = useState(initialMode === 'register' ? 'register' : 'signin')
  const [activeStep, setActiveStep] = useState('personal') // 'personal' | 'team' for registration

  // Operator / Reporter fields
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [showPw, setShowPw] = useState(false)

  // Registration fields
  const [name, setName] = useState('')
  const [regPhone, setRegPhone] = useState('')
  const [regAltPhone, setRegAltPhone] = useState('')
  const [regEmail, setRegEmail] = useState('')
  const [regPassword, setRegPassword] = useState('')
  const [regConfirm, setRegConfirm] = useState('')
  const [showRegPw, setShowRegPw] = useState(false)
  const [showRegConfirm, setShowRegConfirm] = useState(false)

  // Email OTP Verification states
  const [otpCode, setOtpCode] = useState('')
  const [otpSending, setOtpSending] = useState(false)
  const [otpSent, setOtpSent] = useState(false)
  const [otpVerifying, setOtpVerifying] = useState(false)
  const [emailVerified, setEmailVerified] = useState(false)
  const [otpCountdown, setOtpCountdown] = useState(0)
  const [otpNotice, setOtpNotice] = useState(null)
  const [otpError, setOtpError] = useState(null)

  // Staff Email OTP Verification states (Operator & Reporter)
  const [staffOtpSending, setStaffOtpSending] = useState(false)
  const [staffOtpSent, setStaffOtpSent] = useState(false)
  const [staffOtpCountdown, setStaffOtpCountdown] = useState(0)
  const [staffOtpNotice, setStaffOtpNotice] = useState(null)
  const [staffOtpError, setStaffOtpError] = useState(null)

  // Countdown timers for resending OTPs
  useEffect(() => {
    if (otpCountdown <= 0) return
    const timer = setInterval(() => {
      setOtpCountdown((prev) => (prev > 0 ? prev - 1 : 0))
    }, 1000)
    return () => clearInterval(timer)
  }, [otpCountdown])

  useEffect(() => {
    if (staffOtpCountdown <= 0) return
    const timer = setInterval(() => {
      setStaffOtpCountdown((prev) => (prev > 0 ? prev - 1 : 0))
    }, 1000)
    return () => clearInterval(timer)
  }, [staffOtpCountdown])

  // Team Info fields (Optional registration step)
  const [teamOrg, setTeamOrg] = useState('')
  const [teamRole, setTeamRole] = useState('Citizen Observer')
  const [stationUnit, setStationUnit] = useState('Panipat - Wazirabad Corridor')


  // Error & Status feedback
  const [formError, setFormError] = useState(null)
  const [formSuccess, setFormSuccess] = useState(null)

  const isStaff = role === 'operator' || role === 'reporter'
  const isCitizen = role === 'citizen'
  const isRegister = isCitizen && mode === 'register'

  const heading = isStaff
    ? `${role === 'operator' ? 'Operator' : 'Verified reporter'} sign-in`
    : isRegister
      ? 'Create an account'
      : 'Citizen sign-in'

  const switchRole = (next) => {
    setRole(next)
    setFormError(null)
    setFormSuccess(null)
    setCode('')
  }

  // Handle staff OTP dispatch (Operator & Verified reporter)
  const handleSendStaffOtp = async () => {
    setStaffOtpError(null)
    setStaffOtpNotice(null)
    setFormError(null)
    if (!email.trim() || !email.includes('@')) {
      setStaffOtpError('Please enter a valid work email address first.')
      return
    }

    setStaffOtpSending(true)
    try {
      const res = await api('/auth/send-otp', {
        method: 'POST',
        auth: false,
        body: { email: email.trim(), role: role },
      })
      setStaffOtpSent(true)
      setStaffOtpCountdown(60)
      setStaffOtpNotice(res?.message || `Verification code sent to ${email.trim()}! Please check your email inbox.`)
    } catch (err) {
      if (err.status === 403 || err.message?.includes('No valid operator') || err.message?.includes('No valid reporter')) {
        setStaffOtpError(err.message || `No valid ${role} email. This email is not registered as an authorized ${role}.`)
      } else if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError') || err.message?.includes('Bad Gateway')) {
        setStaffOtpError('Backend server is offline (localhost:8000). Please ensure server is running.')
      } else {
        setStaffOtpError(err.message || 'Failed to send verification code. Please check your email address.')
      }
    } finally {
      setStaffOtpSending(false)
    }
  }

  // Handle staff login
  const handleStaffSubmit = async (e) => {
    e.preventDefault()
    setFormError(null)
    setFormSuccess(null)
    if (busy) return

    if (!email.trim() || !password) {
      setFormError('Please enter your work email and password.')
      return
    }
    if (!code.trim()) {
      setFormError('Enter your 6-digit authenticator code.')
      return
    }

    try {
      await staffLogin(role, email.trim(), password, code.trim())
      if (onBack) onBack()
    } catch (err) {
      if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError') || err.message?.includes('Bad Gateway')) {
        setFormError('Backend server is offline (localhost:8000). Please ensure server is running.')
      } else {
        setFormError(err.message || 'Incorrect email, password, or authenticator code.')
      }
    }
  }

  // Handle citizen login
  const handleCitizenSubmit = async (e) => {
    e.preventDefault()
    setFormError(null)
    setFormSuccess(null)
    if (busy) return

    if (!email.trim() || !password) {
      setFormError('Please enter your email and password.')
      return
    }

    try {
      await loginWithPassword(email.trim(), password)
      if (onBack) onBack()
    } catch (err) {
      if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError') || err.message?.includes('Bad Gateway')) {
        setFormError('Backend server is offline (localhost:8000). Please ensure server is running.')
      } else {
        setFormError(err.message || 'Incorrect email or password.')
      }
    }
  }

  // Send OTP handler
  const handleSendOtp = async () => {
    setOtpError(null)
    setOtpNotice(null)
    if (!regEmail.trim() || !regEmail.includes('@')) {
      setOtpError('Please enter a valid email address first.')
      return
    }

    setOtpSending(true)
    try {
      const res = await api('/auth/send-otp', {
        method: 'POST',
        auth: false,
        body: { email: regEmail.trim() },
      })
      setOtpSent(true)
      setEmailVerified(false)
      setOtpCountdown(60)
      setOtpNotice(res?.message || `Verification code sent to ${regEmail.trim()}! Check your inbox.`)
    } catch (err) {
      if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError') || err.message?.includes('Bad Gateway')) {
        setOtpError('Backend server is offline (localhost:8000). Start python backend to send real emails.')
      } else {
        setOtpError(err.message || 'Failed to send verification code. Please try again.')
      }
    } finally {
      setOtpSending(false)
    }
  }

  // Verify OTP handler
  const handleVerifyOtp = async () => {
    setOtpError(null)
    setOtpNotice(null)
    if (!otpCode.trim() || otpCode.trim().length < 4) {
      setOtpError('Please enter the 6-digit verification code.')
      return
    }

    setOtpVerifying(true)
    try {
      const res = await api('/auth/verify-otp', {
        method: 'POST',
        auth: false,
        body: { email: regEmail.trim(), code: otpCode.trim() },
      })
      if (res?.verified) {
        setEmailVerified(true)
        setOtpNotice('✓ Email verified successfully!')
      }
    } catch (err) {
      setOtpError(err.message || 'Invalid or expired verification code.')
    } finally {
      setOtpVerifying(false)
    }
  }

  // Handle new user creation / registration
  const handleRegisterSubmit = async (e) => {
    e.preventDefault()
    setFormError(null)
    setFormSuccess(null)
    if (busy) return

    if (!name.trim()) {
      setFormError('Please enter your full name.')
      return
    }
    if (!regPhone.trim()) {
      setFormError('Please enter your phone number.')
      return
    }
    if (!regEmail.trim() || !regEmail.includes('@')) {
      setFormError('Please enter a valid email address.')
      return
    }
    if (!emailVerified) {
      setFormError('Please verify your email address using the verification button before registering.')
      return
    }
    if (regPassword.length < 6) {
      setFormError('Password must be at least 6 characters.')
      return
    }
    if (regPassword !== regConfirm) {
      setFormError('Passwords do not match.')
      return
    }

    try {
      await register({
        name: name.trim(),
        email: regEmail.trim(),
        password: regPassword,
        phone: regPhone.trim(),
        alt_phone: regAltPhone.trim() || undefined,
      })
      setFormSuccess('User created successfully! Signing you in…')
      if (onBack) onBack()
    } catch (err) {
      if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError') || err.message?.includes('Bad Gateway')) {
        setFormError('Backend server is offline (localhost:8000). Start python server.py to persist accounts.')
      } else {
        setFormError(err.message || 'Registration could not be completed. Please try again.')
      }
    }
  }

  return (
    <div className="site site-auth-screen">
      <div className="site-auth">
        {/* Left Side: Branded River Panel with persistent image & overlay */}
        <div className="site-auth-media">
          <img
            src={river}
            alt="Bio-Sentinel River Monitoring Grid"
            className="site-auth-bg-img"
          />
          <div className="site-auth-media-inner">
            <img src={logoMark} alt="Bio-Sentinel Logo" className="site-auth-logo" />
            <h2>Bio-Sentinel</h2>
            <p>
              Operator access for the Yamuna command center. Sign in to monitor stations,
              review field reports, control gates, and send alerts.
            </p>
          </div>
        </div>

        {/* Right Side: Form Panel in Bio-Sentinel Theme */}
        <div className="site-auth-form">
          <h2>{heading}</h2>

          {/* Role Segmented Tabs (Operator, Verified Reporter, Citizen, Create New User) */}
          <div className="site-seg" role="tablist" aria-label="Sign-in role">
            {ROLES.map((r) => (
              <button
                key={r.id}
                type="button"
                role="tab"
                aria-selected={role === r.id}
                className={`site-seg-btn ${role === r.id ? 'is-active' : ''}`}
                onClick={() => switchRole(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* ========================================================================= */}
          {/* OPTION 1: OPERATOR & VERIFIED REPORTER SIGN-IN                            */}
          {/* ========================================================================= */}
          {isStaff && (
            <form onSubmit={handleStaffSubmit} noValidate>
              <div className="site-field">
                <div className="theme-field-header-row">
                  <span>Work email *</span>
                  {staffOtpSent && (
                    <span className="theme-verified-chip" style={{ background: '#e0f2fe', borderColor: '#7dd3fc', color: '#0369a1' }}>
                      Code dispatched ✉
                    </span>
                  )}
                </div>
                <div className="theme-email-verify-wrap">
                  <input
                    type="email"
                    autoComplete="email"
                    value={email}
                    placeholder={role === 'operator' ? 'operator@djb.example' : 'reporter@djb.example'}
                    onChange={(e) => {
                      setEmail(e.target.value)
                      setStaffOtpSent(false)
                      setStaffOtpNotice(null)
                      setStaffOtpError(null)
                      setFormError(null)
                    }}
                  />
                  <button
                    type="button"
                    className="theme-otp-action-btn"
                    disabled={staffOtpSending || (staffOtpCountdown > 0) || !email.trim()}
                    onClick={handleSendStaffOtp}
                    title={`Verify ${role} email and receive 6-digit code`}
                  >
                    {staffOtpSending
                      ? 'Checking…'
                      : staffOtpCountdown > 0
                        ? `Resend (${staffOtpCountdown}s)`
                        : staffOtpSent
                          ? 'Resend OTP'
                          : 'Verify'}
                  </button>
                </div>
                {staffOtpNotice && <p className="theme-otp-notice-msg" role="status">{staffOtpNotice}</p>}
                {staffOtpError && <p className="site-error" role="alert">{staffOtpError}</p>}
              </div>

              <label className="site-field">
                <span>Password</span>
                <div className="site-input-wrap">
                  <input
                    type={showPw ? 'text' : 'password'}
                    value={password}
                    placeholder="Enter password"
                    autoComplete="current-password"
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    className="site-reveal"
                    onClick={() => setShowPw((v) => !v)}
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                  >
                    {showPw ? 'Hide' : 'Show'}
                  </button>
                </div>
              </label>

              <label className="site-field">
                <span>6-digit verification code / authenticator</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  placeholder="123456"
                  maxLength={7}
                  onChange={(e) => setCode(e.target.value)}
                />
                <p className="site-hint">
                  {staffOtpSent
                    ? 'Enter the 6-digit OTP code sent to your email, or your authenticator code.'
                    : 'Click Verify above to send a code to your registered email, or enter your authenticator code.'}
                </p>
              </label>

              {formError && <p className="site-error" role="alert">{formError}</p>}
              {notice && <p className="site-error" role="alert">{notice}</p>}

              <div className="site-form-foot">
                <span className="site-hint">{busy ? 'Verifying…' : ''}</span>
                <button type="submit" className="site-ticket" disabled={busy}>
                  Sign in
                </button>
              </div>

              <p className="site-auth-note">
                Access is invite-only. Citizens don't need an account —{' '}
                <button type="button" className="site-linkbtn" onClick={onBack}>
                  use the public dashboard
                </button>.
              </p>
            </form>
          )}

          {/* ========================================================================= */}
          {/* OPTION 2: CITIZEN SIGN-IN                                                 */}
          {/* ========================================================================= */}
          {isCitizen && !isRegister && (
            <form onSubmit={handleCitizenSubmit} noValidate>
              <label className="site-field">
                <span>Email ID</span>
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  placeholder="you@example.com"
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>

              <label className="site-field">
                <span>Password</span>
                <div className="site-input-wrap">
                  <input
                    type={showPw ? 'text' : 'password'}
                    value={password}
                    placeholder="Enter password"
                    autoComplete="current-password"
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    className="site-reveal"
                    onClick={() => setShowPw((v) => !v)}
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                  >
                    {showPw ? 'Hide' : 'Show'}
                  </button>
                </div>
              </label>

              {formError && <p className="site-error" role="alert">{formError}</p>}
              {notice && <p className="site-error" role="alert">{notice}</p>}

              <div className="site-form-foot">
                <span className="site-hint">{busy ? 'Verifying…' : ''}</span>
                <button type="submit" className="site-ticket" disabled={busy}>
                  Sign in
                </button>
              </div>

              {/* Toggle to create new user */}
              <p className="site-auth-switch">
                If you don't have an account?{' '}
                <button type="button" onClick={() => { setMode('register'); setFormError(null) }}>
                  Create an account
                </button>
              </p>

              {/* Google Sign-in */}
              <p className="site-or">or</p>
              <div className="site-google">
                <GoogleButton />
              </div>
            </form>
          )}

          {/* ========================================================================= */}
          {/* OPTION 3: CREATE NEW USER (REGISTRATION FORM)                             */}
          {/* ========================================================================= */}
          {isRegister && (
            <div>
              <form onSubmit={handleRegisterSubmit} noValidate>
                  <label className="site-field">
                    <span>Full Name *</span>
                    <input
                      type="text"
                      autoComplete="name"
                      value={name}
                      placeholder="Enter your full name"
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>

                  <div className="theme-phone-field">
                    <span className="theme-field-span">Phone Number *</span>
                    <div className="theme-phone-wrap">
                      <span className="theme-country-code">+91</span>
                      <input
                        type="tel"
                        autoComplete="tel"
                        value={regPhone}
                        placeholder="Enter your phone number"
                        onChange={(e) => setRegPhone(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="theme-phone-field">
                    <span className="theme-field-span">Alternative Phone Number</span>
                    <div className="theme-phone-wrap">
                      <span className="theme-country-code">+91</span>
                      <input
                        type="tel"
                        autoComplete="tel"
                        value={regAltPhone}
                        placeholder="Enter alternative phone number"
                        onChange={(e) => setRegAltPhone(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="site-field">
                    <div className="theme-field-header-row">
                      <span>Email ID *</span>
                      {emailVerified && (
                        <span className="theme-verified-chip" title="Email verified via OTP">
                          ✓ Verified
                        </span>
                      )}
                    </div>
                    <div className="theme-email-verify-wrap">
                      <input
                        type="email"
                        autoComplete="email"
                        value={regEmail}
                        disabled={emailVerified}
                        placeholder="Enter your email"
                        onChange={(e) => {
                          setRegEmail(e.target.value)
                          if (emailVerified) setEmailVerified(false)
                          if (otpSent) setOtpSent(false)
                          setOtpNotice(null)
                          setOtpError(null)
                        }}
                      />
                      <button
                        type="button"
                        className={`theme-otp-action-btn ${emailVerified ? 'is-verified' : ''}`}
                        disabled={otpSending || (otpCountdown > 0 && !emailVerified) || !regEmail.trim() || emailVerified}
                        onClick={handleSendOtp}
                        title={emailVerified ? 'Email verified' : 'Send verification OTP to email'}
                      >
                        {emailVerified
                          ? '✓ Verified'
                          : otpSending
                            ? 'Sending…'
                            : otpCountdown > 0
                              ? `Resend (${otpCountdown}s)`
                              : otpSent
                                ? 'Resend OTP'
                                : 'Verify'}
                      </button>
                    </div>

                    {/* OTP Input Field (Revealed after clicking Verify) */}
                    {otpSent && !emailVerified && (
                      <div className="theme-otp-entry-box">
                        <span className="theme-otp-entry-label">
                          Enter 6-digit code sent to {regEmail}
                        </span>
                        <div className="theme-otp-input-group">
                          <input
                            type="text"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                            value={otpCode}
                            placeholder="123456"
                            className="theme-otp-code-input"
                            onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                          />
                          <button
                            type="button"
                            className="theme-confirm-otp-btn"
                            disabled={otpVerifying || otpCode.trim().length < 4}
                            onClick={handleVerifyOtp}
                          >
                            {otpVerifying ? 'Checking…' : 'Verify OTP'}
                          </button>
                        </div>
                      </div>
                    )}

                    {otpNotice && <p className="theme-otp-notice-msg" role="status">{otpNotice}</p>}
                    {otpError && <p className="site-error" role="alert">{otpError}</p>}
                  </div>

                  <label className="site-field">
                    <span>Set Password *</span>
                    <div className="site-input-wrap">
                      <input
                        type={showRegPw ? 'text' : 'password'}
                        value={regPassword}
                        placeholder="Create a Password"
                        autoComplete="new-password"
                        onChange={(e) => setRegPassword(e.target.value)}
                      />
                      <button
                        type="button"
                        className="site-reveal"
                        onClick={() => setShowRegPw((v) => !v)}
                        aria-label={showRegPw ? 'Hide password' : 'Show password'}
                      >
                        {showRegPw ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <p className="site-hint">Must be at least 6 characters.</p>
                  </label>

                  <label className="site-field">
                    <span>Confirm Password *</span>
                    <div className="site-input-wrap">
                      <input
                        type={showRegConfirm ? 'text' : 'password'}
                        value={regConfirm}
                        placeholder="Re-enter Password"
                        autoComplete="new-password"
                        onChange={(e) => setRegConfirm(e.target.value)}
                      />
                      <button
                        type="button"
                        className="site-reveal"
                        onClick={() => setShowRegConfirm((v) => !v)}
                        aria-label={showRegConfirm ? 'Hide password' : 'Show password'}
                      >
                        {showRegConfirm ? 'Hide' : 'Show'}
                      </button>
                    </div>
                  </label>

                  <p className="theme-mandatory-note">All fields are mandatory*</p>

                  {formError && <p className="site-error" role="alert">{formError}</p>}
                  {notice && <p className="site-error" role="alert">{notice}</p>}
                  {formSuccess && <p className="theme-success-alert" role="status">{formSuccess}</p>}

                  <div className="site-form-foot">
                    <button
                      type="button"
                      className="site-linkbtn"
                      onClick={() => { setMode('signin'); setFormError(null) }}
                    >
                      ← Already have an account? Sign in
                    </button>
                    <button type="submit" className="site-ticket theme-confirm-btn" disabled={busy}>
                      {busy ? 'Creating…' : 'Confirm'}
                    </button>
                  </div>

                  <p className="site-or">or</p>
                  <div className="site-google">
                    <GoogleButton />
                  </div>
                </form>
            </div>
          )}

          {/* Return to overview */}
          {onBack && (
            <button type="button" className="site-auth-back" onClick={onBack}>
              ← Back to overview
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
