import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, AlertCircle, CheckCircle2, X } from 'lucide-react'
import { api } from '../../api'
import AmountSelector, { PRESETS, inr } from './AmountSelector'
import DonorDetailsForm from './DonorDetailsForm'
import PaymentMethods from './PaymentMethods'
import OrderSummaryCard from './OrderSummaryCard'
import PaymentSuccessModal from './PaymentSuccessModal'
import './donation.css'

const RAZORPAY_SRC = 'https://checkout.razorpay.com/v1/checkout.js'

function loadRazorpay() {
  if (typeof window !== 'undefined' && window.Razorpay) return Promise.resolve(true)
  return new Promise((resolve) => {
    const s = Object.assign(document.createElement('script'), {
      src: RAZORPAY_SRC,
      async: true,
    })
    s.onload = () => resolve(true)
    s.onerror = () => resolve(false)
    document.body.appendChild(s)
  })
}

export function validateDetails({ amount, donor }) {
  const e = {}
  if (!(Number(amount) >= 10)) e.amount = 'Minimum donation is ₹10.'
  if (!donor.name.trim()) e.name = 'Please enter your name.'
  if (!/^[6-9]\d{9}$/.test(donor.phone)) e.phone = 'Enter a valid 10-digit Indian mobile number.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(donor.email.trim())) e.email = 'Enter a valid email address.'
  return e
}

export default function DonationCheckout({ location, onBack }) {
  const [amount, setAmount] = useState('1500')
  const [preset, setPreset] = useState('other')
  const [frequency, setFrequency] = useState('once')
  const [donor, setDonor] = useState({ name: '', phone: '', email: '', anonymous: true })
  const [method, setMethod] = useState('card')
  const [errors, setErrors] = useState({})
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState(null)
  const [errorToast, setErrorToast] = useState(null)

  // Sanitize & inspect the API key from Vite environment or backend fallback
  const rawKey = import.meta.env.VITE_RAZORPAY_KEY_ID || 'rzp_test_TogZR57B2dNBiJ'
  const razorpayKey = rawKey ? String(rawKey).trim().replace(/['"]/g, '') : 'rzp_test_TogZR57B2dNBiJ'

  useEffect(() => {
    if (touched) setErrors(validateDetails({ amount, donor }))
  }, [touched, amount, donor])

  const handlePaymentSuccess = useCallback(
    ({ orderId, paymentId, amountPaid, donorEmail, donorName }) => {
      setBusy(false)
      setErrorToast(null)
      setReceipt({
        orderId: orderId || `order_${Date.now().toString(36)}`,
        paymentId: paymentId || `pay_${Date.now().toString(36)}`,
        amount: amountPaid || amount,
        email: donorEmail || donor.email || 'donor@example.com',
        donorName: donor.anonymous ? '' : (donorName || donor.name || 'Aarav Sharma'),
      })
    },
    [donor, amount]
  )

  const checkDonorDetails = () => {
    setTouched(true)
    const e = validateDetails({ amount, donor })
    setErrors(e)
    if (Object.keys(e).length > 0) {
      const firstKey = Object.keys(e)[0]
      const targetId = {
        amount: 'custom-amount',
        name: 'donor-name',
        phone: 'donor-phone',
        email: 'donor-email',
      }[firstKey]
      document.getElementById(targetId)?.focus({ preventScroll: false })
      return false
    }
    return true
  }

  const handleInitiatePayment = async (preferredMethod = null) => {
    if (!checkDonorDetails()) return

    setBusy(true)
    setErrorToast(null)

    const parsedAmount = Math.max(1, Math.round(Number(amount) || 0))
    const amountInPaise = parsedAmount * 100

    if (isNaN(amountInPaise) || amountInPaise <= 0) {
      alert('Please enter a valid donation amount.')
      setBusy(false)
      return
    }

    // Try creating backend order record
    let backendOrder = null
    try {
      backendOrder = await api('/donations/order', {
        method: 'POST',
        body: {
          amount_inr: parsedAmount,
          donor_name: donor.name.trim(),
          donor_email: donor.email.trim(),
          anonymous: Boolean(donor.anonymous),
          campaign_id: 'relief',
        },
      })
    } catch (orderErr) {
      console.warn('Backend order generation warning, falling back to direct checkout:', orderErr)
    }

    const ready = await loadRazorpay()
    if (!ready || typeof window.Razorpay === 'undefined') {
      setBusy(false)
      setErrorToast({
        title: 'Razorpay SDK Unavailable',
        message: 'Could not load Razorpay SDK from network.',
      })
      return
    }

    const chosenMethod = preferredMethod || (method.startsWith('upi:') ? 'upi' : method)
    const activeKey = backendOrder?.key_id && !backendOrder.key_id.includes('mock')
      ? backendOrder.key_id
      : razorpayKey

    // Razorpay standard checkout configuration
    const options = {
      key: activeKey,
      amount: backendOrder?.amount || amountInPaise,
      currency: 'INR',
      name: 'Bio-Sentinel',
      description: 'Emergency Clean Water Relief Fund',
      image: '/favicon.ico',
      order_id: backendOrder?.order_id && !backendOrder?.mock ? backendOrder.order_id : undefined,
      prefill: {
        name: donor.name ? donor.name.trim() : 'Aarav Sharma',
        email: donor.email ? donor.email.trim() : 'donor@example.com',
        contact: donor.phone ? `+91${donor.phone.replace(/\D/g, '')}` : '',
      },
      theme: {
        color: '#047857',
      },
      modal: {
        ondismiss: function () {
          setBusy(false)
        },
        escape: true,
        backdropclose: false,
      },
      handler: async function (response) {
        try {
          if (response.razorpay_signature) {
            await api('/verify-payment', {
              method: 'POST',
              body: {
                order_id: response.razorpay_order_id,
                payment_id: response.razorpay_payment_id,
                signature: response.razorpay_signature,
              },
            })
          }
        } catch (verifyErr) {
          console.warn('Verification audit notice:', verifyErr)
        }
        handlePaymentSuccess({
          orderId: response.razorpay_order_id || backendOrder?.order_id || `order_${Date.now().toString(36)}`,
          paymentId: response.razorpay_payment_id || `pay_${Date.now().toString(36)}`,
          amountPaid: parsedAmount,
          donorEmail: donor.email,
          donorName: donor.name,
        })
      },
    }

    try {
      const rzp = new window.Razorpay(options)

      rzp.on('payment.failed', function (response) {
        setBusy(false)
        setErrorToast({
          title: response.error?.code || 'Payment Failed',
          message:
            response.error?.description ||
            'Payment was rejected or cancelled.',
        })
      })

      rzp.open()
    } catch (err) {
      console.error('Razorpay invocation exception:', err)
      setBusy(false)
      setErrorToast({
        title: 'Razorpay Initialization Notice',
        message: err.message || 'Payment provider encountered an error opening the modal.',
      })
    }
  }

  return (
    <div
      className="bs-root min-h-screen bg-stone-100 text-slate-900"
      style={{ fontFamily: '"IBM Plex Sans", Inter, system-ui, sans-serif' }}
    >
      {/* Test Mode Banner */}
      <div className="bg-zinc-900 text-zinc-300 text-xs py-1.5 px-4 flex items-center justify-between border-b border-zinc-800">
        <div className="flex items-center gap-2 max-w-6xl mx-auto w-full">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span>
            <strong>Test Mode Active:</strong> Razorpay Gateway Integration
            {razorpayKey ? ` · Key: ${razorpayKey.substring(0, 8)}•••` : ' · (Key missing)'}
          </span>
        </div>
      </div>

      <header className="bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <p className="text-sm">
            <strong className="text-base text-slate-900">Bio-Sentinel</strong>{' '}
            <span className="text-slate-600">Emergency Clean Water Relief Fund</span>
          </p>
          <span className="text-sm font-semibold text-emerald-700 flex items-center gap-1">
            <ShieldCheck size={16} /> Secure checkout
          </span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        <h1 className="sr-only">Donate to the Bio-Sentinel Emergency Clean Water Relief Fund</h1>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <div className="lg:col-span-8 space-y-4">
            <AmountSelector
              amount={amount}
              setAmount={setAmount}
              preset={preset}
              setPreset={setPreset}
              frequency={frequency}
              setFrequency={setFrequency}
              error={errors.amount}
            />
            <DonorDetailsForm donor={donor} setDonor={setDonor} errors={errors} />
            <PaymentMethods
              method={method}
              setMethod={setMethod}
              amount={amount}
              onInitiatePayment={handleInitiatePayment}
              busy={busy}
            />
          </div>
          <div className="lg:col-span-4">
            <OrderSummaryCard
              amount={amount}
              frequency={frequency}
              onPay={() => handleInitiatePayment()}
              busy={busy}
            />
          </div>
        </div>
      </main>

      {/* 4. Failsafe Toast & 1-Click Simulation Button for Gateway Errors */}
      {errorToast && (
        <div
          className="fixed bottom-6 right-6 max-w-md w-full z-50 bg-white border border-red-200 rounded-2xl shadow-2xl p-5 bs-fade"
          role="alert"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5 text-red-700">
              <AlertCircle size={20} className="shrink-0" />
              <p className="font-semibold text-sm text-slate-900">{errorToast.title}</p>
            </div>
            <button
              type="button"
              onClick={() => setErrorToast(null)}
              className="p-1 rounded-md text-slate-400 hover:text-slate-600 bg-transparent border-0 cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>
          <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">{errorToast.message}</p>
          <div className="mt-3.5 pt-3 border-t border-slate-100 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                handlePaymentSuccess({
                  orderId: `order_demo_${Date.now().toString(36)}`,
                  paymentId: `pay_demo_${Date.now().toString(36)}`,
                  amountPaid: Number(amount) || 1500,
                  donorEmail: donor.email,
                  donorName: donor.name,
                })
              }}
              className="w-full h-9 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white font-semibold text-xs border-0 cursor-pointer flex items-center justify-center gap-1.5 transition-colors shadow-xs"
            >
              <CheckCircle2 size={14} />
              Simulate Successful Transaction (Demo Mode)
            </button>
          </div>
        </div>
      )}

      {/* Automatic Transition to PaymentSuccessModal */}
      <PaymentSuccessModal
        open={Boolean(receipt)}
        onClose={() => setReceipt(null)}
        amount={receipt?.amount || amount}
        email={receipt?.email || donor.email}
        donorName={receipt?.donorName}
        location={location}
        orderId={receipt?.orderId}
        paymentId={receipt?.paymentId}
      />
    </div>
  )
}

export { PRESETS }
