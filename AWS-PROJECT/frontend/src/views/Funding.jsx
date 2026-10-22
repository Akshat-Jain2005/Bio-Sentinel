import { useRef, useState } from 'react'
import { api, usePoll } from '../api'
import { Panel, ReadState } from '../ui'

const money = n => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n || 0)
let checkoutScript
function loadCheckout() {
  if (window.Razorpay) return Promise.resolve()
  if (!checkoutScript) checkoutScript = new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    const timer = setTimeout(() => { s.remove(); checkoutScript = null; reject(new Error('Checkout took too long to load. Try again.')) }, 12000)
    s.onload = () => { clearTimeout(timer); resolve() }
    s.onerror = () => { clearTimeout(timer); s.remove(); checkoutScript = null; reject(new Error('Unable to load secure checkout. Try again.')) }
    document.head.appendChild(s)
  })
  return checkoutScript
}

export default function Funding({ ledgerOnly = false }) {
  const feed = usePoll('/campaigns', 15000)
  const [amount, setAmount] = useState(499)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState(null)
  const lock = useRef(false)
  const active = feed.data?.campaigns?.find(c => c.id === feed.data.active)
  const release = () => { lock.current = false; setBusy(false) }
  async function donate(e) {
    e.preventDefault()
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    const f = new FormData(e.currentTarget)
    try {
      await loadCheckout()
      const order = await api('/donations/order', { method: 'POST', body: { amount_inr: Number(amount), campaign_id: active.id, donor_name: f.get('name'), donor_email: f.get('email'), anonymous: f.get('anonymous') === 'on' } })
      if (order.mock) throw new Error('Live payments are not configured. No payment has been taken.')
      const checkout = new window.Razorpay({ key: order.key_id, amount: order.amount, currency: order.currency, order_id: order.order_id, name: 'Bio-Sentinel', description: active.title, prefill: { name: f.get('name'), email: f.get('email') },
        modal: { ondismiss: release }, handler: async response => {
          try { const verified = await api('/verify-payment', { method: 'POST', body: { order_id: response.razorpay_order_id, payment_id: response.razorpay_payment_id, signature: response.razorpay_signature } }); setReceipt(verified); feed.refresh() }
          catch (err) { setError(`Payment confirmation needs attention: ${err.message} Keep your provider payment reference.`) }
          finally { release() }
        } })
      checkout.on('payment.failed', response => { setError(response.error?.description || 'Payment failed. Please try again.'); release() })
      checkout.open()
    } catch (err) { setError(err.message); release() }
  }
  return <div className="funding-layout"><Panel title={ledgerOnly ? 'Funding ledger' : active?.title || 'Support the river watch'} meta={feed.data?.active === 'relief' ? 'Intake shutdown · emergency relief' : 'Routine monitoring'}>
    <ReadState {...feed} retry={feed.refresh}/>
    {!ledgerOnly && !receipt && active && <form onSubmit={donate} className="community-form"><p>{active.id === 'relief' ? 'Support emergency clean water relief for affected communities.' : 'Help maintain monitoring nodes and replenish Daphnia bio-cultures.'}</p>
      <div className="amount-options">{[199,499,999,2499].map(n => <button key={n} type="button" aria-pressed={Number(amount) === n} className="btn-secondary" onClick={() => setAmount(n)}>{money(n)}</button>)}</div>
      <label className="field-block">Donation amount (₹)<input type="number" min="10" max="500000" step="1" required value={amount} onChange={e => setAmount(e.target.value)}/></label>
      {active.id === 'relief' && <p className="hint">Estimated impact: approximately {Number(amount) * 2} L of tanker water. Actual delivery depends on relief operations.</p>}
      <label className="field-block">Full name<input name="name" autoComplete="name" maxLength={80}/></label><label className="field-block">Email for receipt<input name="email" type="email" required autoComplete="email" maxLength={120}/></label>
      <label className="check-label"><input type="checkbox" name="anonymous"/>Hide my name on the public donor wall.</label>
      <p className="muted">One-time donation. Choose UPI, cards, net banking or wallets in Razorpay’s secure checkout.</p>
      <button className="btn-primary" disabled={busy || Boolean(feed.error)}>{busy ? 'Completing payment…' : `Donate ${money(amount)}`}</button>
    </form>}
    {receipt && <div role="status"><h3>Thank you for your support</h3><p>{money(receipt.amount_inr)} · Signature verified</p><p className="mono">Order: {receipt.order_id}</p><div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}><button className="btn-secondary" onClick={() => window.print()}>Print payment confirmation</button>{receipt.payment_id && <a className="btn-primary" href={receipt.certificate_url || `/donations/certificate/${receipt.payment_id}`} download style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>Download impact certificate</a>}</div></div>}
    {error && <p role="alert" className="error">{error}</p>}
  </Panel><Panel title="Campaign contributions" meta="Recorded payments only"><dl className="campaign-totals">{feed.data?.campaigns?.map(c => <div key={c.id}><dt>{c.title}</dt><dd>{money(c.raised_inr)}</dd></div>)}</dl><h3>Recent contributions</h3>{!feed.data?.donor_wall?.length && <p className="muted">No verified contributions yet.</p>}<ul className="donor-wall">{feed.data?.donor_wall?.map((d,i) => <li key={i}><span>{d.name}<small>{d.campaign_id === 'relief' ? 'Emergency relief' : 'Node upkeep'}</small></span><strong>{money(d.amount_inr)}</strong></li>)}</ul></Panel></div>
}
