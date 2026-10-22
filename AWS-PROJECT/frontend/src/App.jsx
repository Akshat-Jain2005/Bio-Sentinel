import { useState } from 'react'
import { AuthProvider } from './auth'
import { useAuth } from './auth-context'
import Auth from './views/Auth'
import Home from './views/Home'
import LiveDashboard from './views/LiveDashboard'
import PublicDashboard from './views/PublicDashboard'
import logoMark from './assets/logo-mark.png'
import DonationCheckout from './components/donation/DonationCheckout'

function PortalNav({ user, onSignIn, onSignOut, onLiveDashboard, onOperatorDashboard, onDonate }) {
  const member = Boolean(user?.role && user.role !== 'public')
  const isOperator = user?.role === 'operator' || user?.role === 'reporter'

  return (
    <nav className="site-nav" aria-label="Primary">
      <div className="site-brand">
        <img className="site-logo" src={logoMark} alt="Bio-Sentinel" />
        <span className="site-brand-name">Bio-Sentinel</span>
      </div>
      <div className="site-nav-links">
        <a href="#gap" className="site-nav-link">The gap</a>
        <a href="#sensor" className="site-nav-link">The sensor</a>
        <a href="#how-it-works" className="site-nav-link">How it works</a>
        <a href="#roles" className="site-nav-link">Roles</a>
      </div>
      <div className="site-nav-actions">
        <button type="button" className="site-nav-donate-btn" onClick={onDonate}>
          Donate 💧
        </button>
        {member ? (
          <>
            <span className="site-userchip" title={user.email || user.name}>
              👤 {user.name || user.email?.split('@')[0] || 'Member'}
              {isOperator && (
                <span style={{ marginLeft: 6, fontSize: '0.72rem', background: '#0284c7', color: '#fff', padding: '1px 6px', borderRadius: 4 }}>
                  {user.role}
                </span>
              )}
            </span>
            <button type="button" className="site-nav-login" onClick={onSignOut}>Sign out</button>
            {isOperator && (
              <button type="button" className="site-nav-dashboard" onClick={onOperatorDashboard} style={{ background: '#0369a1' }}>
                Operator console ⚙️
              </button>
            )}
            <button type="button" className="site-nav-dashboard" onClick={onLiveDashboard}>Live dashboard →</button>
          </>
        ) : (
          <>
            <button type="button" className="site-nav-login" onClick={onSignIn}>Sign in</button>
            <button type="button" className="site-nav-dashboard" onClick={onLiveDashboard}>Live dashboard →</button>
          </>
        )}
      </div>
    </nav>
  )
}

function Portal() {
  const { user, signOut, notice } = useAuth()
  const [view, setView] = useState('home') // 'home' | 'auth' | 'dashboard' | 'operator-dashboard' | 'donate'
  const [authRole, setAuthRole] = useState('operator') // 'operator' | 'reporter' | 'citizen'
  const [authMode, setAuthMode] = useState('signin') // 'signin' | 'register'
  const [targetView, setTargetView] = useState(null)
  const member = Boolean(user?.role && user.role !== 'public')
  const isOperator = user?.role === 'operator' || user?.role === 'reporter'

  const openAuth = (role = 'operator', mode = 'signin', target = null) => {
    setAuthRole(role)
    setAuthMode(mode)
    setTargetView(target)
    setView('auth')
  }

  // Live public Yamuna Water Watch dashboard:
  // Must sign in first; redirects to sign in if not authenticated.
  const openDashboard = () => {
    if (!member) {
      openAuth('citizen', 'signin', 'dashboard')
    } else {
      setView('dashboard')
    }
  }

  // Operator console dashboard (previous LiveDashboard):
  const openOperatorDashboard = () => {
    if (!isOperator) {
      openAuth('operator', 'signin', 'operator-dashboard')
    } else {
      setView('operator-dashboard')
    }
  }

  // Donation is locked behind authorization wall:
  const openDonate = () => {
    if (!member) {
      openAuth('citizen', 'signin', 'donate')
    } else {
      setView('donate')
    }
  }

  // If user just authenticated while on auth view:
  // - if user had a target view requested (e.g. dashboard), take them there
  // - operator/reporter goes into operator console ('operator-dashboard')
  // - citizen goes to main landing page ('home')
  const effectiveView = (member && view === 'auth')
    ? (targetView || (isOperator ? 'operator-dashboard' : 'home'))
    : view

  if (effectiveView === 'auth') {
    return (
      <Auth
        initialRole={authRole}
        initialMode={authMode}
        onBack={() => {
          setView(targetView || 'home')
          setTargetView(null)
        }}
      />
    )
  }

  // 1. Operator Console Dashboard (The restored comprehensive LiveDashboard)
  if (effectiveView === 'operator-dashboard') {
    if (!isOperator && !member) {
      return <Auth initialRole="operator" initialMode="signin" onBack={() => setView('home')} />
    }
    return (
      <LiveDashboard
        onBack={() => setView('home')}
        onOpenAuth={openAuth}
        user={user}
        onSignOut={() => {
          setView('home')
          signOut()
        }}
      />
    )
  }

  // 2. Public Yamuna Water Watch Dashboard (Matching the reference design)
  // Protected behind sign in: redirect to sign in first if not authenticated.
  if (effectiveView === 'dashboard') {
    if (!member) {
      return <Auth initialRole="citizen" initialMode="signin" onBack={() => setView('home')} />
    }
    return (
      <PublicDashboard
        onBack={() => setView('home')}
        onOpenAuth={(role) => {
          if (isOperator) {
            setView('operator-dashboard')
          } else {
            openAuth(role || 'operator', 'signin')
          }
        }}
        user={user}
        onSignOut={() => {
          setView('home')
          signOut()
        }}
      />
    )
  }

  if (effectiveView === 'donate') {
    if (!member) {
      return <Auth initialRole="citizen" initialMode="signin" onBack={() => setView('home')} />
    }
    return (
      <div className="portal-donation-wrapper">
        <div className="donation-back-banner">
          <button type="button" className="btn-donation-back" onClick={() => setView('home')}>
            ← Return to Landing Page
          </button>
        </div>
        <DonationCheckout onBack={() => setView('home')} />
      </div>
    )
  }

  return (
    <div className="site">
      <PortalNav
        user={user}
        onSignIn={() => openAuth('operator')}
        onRegister={() => openAuth('citizen', 'register')}
        onSignOut={() => { setView('home'); signOut() }}
        onLiveDashboard={openDashboard}
        onOperatorDashboard={openOperatorDashboard}
        onDonate={openDonate}
      />
      {notice && <p className="site-portal-notice" role="alert">{notice}</p>}
      <Home onOpenAuth={openAuth} onOpenDashboard={openDashboard} onOpenDonate={openDonate} />
    </div>
  )
}

function Gate() {
  const { ready } = useAuth()
  if (!ready) return <div className="splash">Resolving session…</div>
  return <Portal />
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
