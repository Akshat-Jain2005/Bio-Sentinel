import { useState } from 'react'
import { Check, Download, Share2, X } from 'lucide-react'
import { inr, litersFor } from './AmountSelector'

// Builds a minimal valid single-page PDF so the download works without deps.
function buildCertificatePdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7E]/g, '')
  const text = lines.map((l, i) => `BT /F1 ${i === 0 ? 22 : 13} Tf 60 ${740 - i * 34} Td (${esc(l)}) Tj ET`).join('\n')
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'; const offs = []
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new Blob([pdf], { type: 'application/pdf' })
}

export default function PaymentSuccessModal({ open, onClose, amount, email, location, orderId, paymentId, donorName }) {
  const [shared, setShared] = useState(false)
  if (!open) return null
  const place = location || 'Sangam Vihar'
  const liters = litersFor(amount)

  const download = async () => {
    try {
      const pid = paymentId || `pay_${Date.now().toString(36)}`
      const res = await fetch(`/donations/certificate/${pid}`)
      if (res.ok) {
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = Object.assign(document.createElement('a'), {
          href: url,
          download: `impact-certificate-${pid}.pdf`,
        })
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        return
      }
    } catch (err) {
      console.warn('Backend certificate fetch error, using fallback:', err)
    }

    const blob = buildCertificatePdf([
      'Certificate of Impact',
      'Bio-Sentinel Emergency Clean Water Relief Fund',
      `Awarded to: ${donorName || 'A generous donor'}`,
      `Contribution: INR ${inr(amount)}`,
      `Impact: ${liters} L of verified tanker water to ${place}`,
      `Order: ${orderId}   Payment: ${paymentId}`,
      `Issued: ${new Date().toLocaleDateString('en-IN')}`,
    ])
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `impact-certificate-${paymentId}.pdf` })
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  const share = async () => {
    const data = { title: 'Bio-Sentinel Clean Water Relief', text: `I just funded ${liters} L of clean water for ${place}. Join me!`, url: window.location.href }
    try {
      if (navigator.share) await navigator.share(data)
      else { await navigator.clipboard.writeText(`${data.text} ${data.url}`); setShared(true); setTimeout(() => setShared(false), 2000) }
    } catch { /* user cancelled */ }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/60 backdrop-blur-sm bs-fade" role="dialog" aria-modal="true" aria-labelledby="success-title">
      <div className="relative w-full max-w-md bg-stone-50 rounded-2xl shadow-2xl p-6 sm:p-8 text-center">
        <button id="success-close" type="button" onClick={onClose} aria-label="Close"
          className="absolute top-3 right-3 p-1.5 rounded-full bg-transparent border-0 text-slate-500 hover:bg-slate-200 cursor-pointer"><X size={18} /></button>
        <div className="bs-pop mx-auto w-20 h-20 rounded-full bg-emerald-600 text-white flex items-center justify-center shadow-lg shadow-emerald-600/30">
          <Check size={44} strokeWidth={3} />
        </div>
        <h2 id="success-title" className="text-3xl font-bold text-slate-900 mt-5">Thank you!</h2>
        <p className="text-slate-600 mt-2">Your ₹{inr(amount)} will dispatch {liters} L of verified tanker water to {place}.</p>

        <div className="text-left bg-white border border-slate-200 rounded-xl p-5 mt-5 space-y-1.5 text-[15px] text-slate-800">
          <p className="font-semibold text-slate-900 mb-1">Receipt</p>
          <p>Order: {orderId} (sample)</p>
          <p>Payment: {paymentId} (sample)</p>
          <p>Status: <strong className="text-emerald-600">Signature verified</strong></p>
          <p className="break-all">Receipt sent to {email}</p>
        </div>

        <button id="download-certificate" type="button" onClick={download}
          className="mt-5 w-full h-12 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-semibold border-0 cursor-pointer flex items-center justify-center gap-2 transition-colors">
          <Download size={18} /> Download impact certificate
        </button>
        <button id="share-campaign" type="button" onClick={share}
          className="mt-3 w-full h-12 rounded-xl bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 font-semibold cursor-pointer flex items-center justify-center gap-2 transition-colors">
          <Share2 size={18} /> {shared ? 'Link copied!' : 'Share this campaign'}
        </button>
      </div>
    </div>
  )
}
