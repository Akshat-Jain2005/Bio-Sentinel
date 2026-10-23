import { useRef, useState } from 'react'
import { api, usePoll } from '../api'
import { Panel, ReadState } from '../ui'

const OBSERVATIONS = { dark_color: 'Dark color', foam: 'Foam', sharp_smell: 'Sharp smell', dead_fish: 'Dead fish', oil_sheen: 'Oil sheen', clear: 'Clear water' }

export const MONITOR_STATIONS = [
  { id: 'STATION_01_PANIPAT', name: 'Panipat Upstream Drain Outfall', lat: 29.43, lng: 76.97 },
  { id: 'STATION_02_PANIPAT', name: 'Panipat Industrial Outfall', lat: 29.39, lng: 76.97 },
  { id: 'STATION_03_SONIPAT', name: 'Sonipat Industrial Cluster', lat: 28.99, lng: 77.02 },
  { id: 'STATION_04_PALLA', name: 'Palla Delhi-Haryana Entry Point', lat: 28.83, lng: 77.20 },
  { id: 'STATION_05_WAZIRABAD', name: 'Wazirabad DJB Intake Reservoir', lat: 28.71, lng: 77.23 },
]

export function ReportForm({ onSubmitted, onViewDashboard }) {
  const [position, setPosition] = useState(null)
  const [selectedStation, setSelectedStation] = useState('')
  const [locationLabel, setLocationLabel] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [locating, setLocating] = useState(false)

  const handleStationPick = (e) => {
    const sid = e.target.value
    setSelectedStation(sid)
    const st = MONITOR_STATIONS.find((s) => s.id === sid)
    if (st) {
      setPosition({ lat: st.lat, lng: st.lng })
      setLocationLabel(st.name)
      setError('')
    }
  }

  const locate = () => {
    if (!navigator.geolocation) {
      setError('Location is unavailable in this browser.')
      return
    }
    setLocating(true)
    setError('')
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setPosition({ lat: p.coords.latitude, lng: p.coords.longitude })
        setSelectedStation('')
        setLocating(false)
      },
      () => {
        setError('Allow location access or select a river monitoring station above.')
        setLocating(false)
      },
      { enableHighAccuracy: true, timeout: 15000 }
    )
  }

  async function submit(e) {
    e.preventDefault()
    if (lock.current || !position) return
    lock.current = true
    setBusy(true)
    setError('')
    const form = new FormData(e.currentTarget)
    try {
      let photo_key = null
      const photo = form.get('photo')
      if (photo?.size) {
        if (photo.size > 5 * 1024 * 1024) throw new Error('Choose a photo smaller than 5 MB.')
        const upload = await api('/reports/upload-url', {
          method: 'POST',
          body: { content_type: photo.type },
        })
        if (!upload.upload_url)
          throw new Error('Photo storage is not configured yet. Remove the photo to submit the readings, or try again later.')
        const payload = new FormData()
        Object.entries(upload.fields || {}).forEach(([key, value]) => payload.append(key, value))
        payload.append('file', photo)
        const response = await fetch(upload.upload_url, {
          method: 'POST',
          body: payload,
          signal: AbortSignal.timeout(30000),
        })
        if (!response.ok) throw new Error('Photo upload failed. Please try again.')
        photo_key = upload.photo_key
      }
      const number = (k) => (form.get(k) === '' ? null : Number(form.get(k)))
      const body = {
        ...position,
        station_id: selectedStation || null,
        source_type: form.get('source_type'),
        location_label: locationLabel || form.get('location_label') || '',
        ammonia_ppm: number('ammonia_ppm'),
        ph: number('ph'),
        observations: form.getAll('observations'),
        note: form.get('note'),
        photo_key,
      }
      const res = await api('/reports', { method: 'POST', body })
      setResult(res)

      // Save user submission locally so it instantly reflects in user's dashboard view
      try {
        const stored = JSON.parse(localStorage.getItem('biosentinel_user_reports') || '[]')
        localStorage.setItem(
          'biosentinel_user_reports',
          JSON.stringify([res, ...stored.filter((r) => r.id !== res.id)].slice(0, 20))
        )
      } catch {
        // storage fallback
      }

      onSubmitted?.(res)
    } catch (err) {
      setError(err.message)
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  if (result)
    return (
      <Panel title="Report registered & synced">
        <p role="status">
          Your field report has been submitted for{' '}
          <strong>
            {MONITOR_STATIONS.find((s) => s.id === result.station_id)?.name ||
              result.location_label ||
              'Yamuna River Corridor'}
          </strong>{' '}
          and registered in the Bio-Sentinel live network.
        </p>
        <p className="mono">Reference ID: {result.id}</p>
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
          {onViewDashboard && (
            <button type="button" className="btn-primary" onClick={onViewDashboard}>
              View on live dashboard →
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={() => setResult(null)}>
            Report another sample
          </button>
        </div>
      </Panel>
    )

  return (
    <Panel title="Report a water sample" meta="GPS or River Station selection">
      <form onSubmit={submit} className="community-form">
        <p>Share what you observe. Never enter the river or touch suspected contaminated water.</p>

        <label className="field-block">
          <span>Choose River Monitoring Station</span>
          <select
            className="ward-select"
            value={selectedStation}
            onChange={handleStationPick}
          >
            <option value="">-- Select a Yamuna Station --</option>
            {MONITOR_STATIONS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.id.replace('STATION_', 'ST_')})
              </option>
            ))}
          </select>
        </label>

        <div style={{ margin: '8px 0' }}>
          <button type="button" className="btn-secondary" onClick={locate} disabled={locating}>
            {locating ? 'Finding location…' : position ? 'Refresh GPS location' : 'Or use my device GPS location'}
          </button>
        </div>

        {position && (
          <p role="status" className="mono" style={{ color: '#38bdf8' }}>
            Location locked:{' '}
            {selectedStation
              ? `${MONITOR_STATIONS.find((s) => s.id === selectedStation)?.name} (${position.lat.toFixed(4)}, ${position.lng.toFixed(4)})`
              : `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}`}
          </p>
        )}

        <label className="field-block">
          Nearby landmark or drain outfall name
          <input
            name="location_label"
            maxLength={120}
            value={locationLabel}
            onChange={(e) => setLocationLabel(e.target.value)}
            placeholder="Drain outfall, river bank or street"
          />
        </label>

        <label className="field-block">
          Water source
          <select name="source_type">
            <option value="river">River</option>
            <option value="drain_outfall">Drain outfall</option>
            <option value="tap">Tap</option>
            <option value="tanker">Tanker</option>
          </select>
        </label>

        <div className="form-pair">
          <label className="field-block">
            Ammonia (ppm)
            <input type="number" name="ammonia_ppm" min="0" max="50" step="0.01" />
          </label>
          <label className="field-block">
            pH
            <input type="number" name="ph" min="0" max="14" step="0.1" />
          </label>
        </div>

        <fieldset>
          <legend>What do you see?</legend>
          <div className="check-options">
            {Object.entries(OBSERVATIONS).map(([value, label]) => (
              <label key={value}>
                <input type="checkbox" name="observations" value={value} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="field-block">
          Photo of sample or test strip (optional)
          <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" />
          <span className="hint">JPEG, PNG or WebP · up to 5 MB</span>
        </label>

        <label className="field-block">
          Note (optional)
          <textarea name="note" maxLength={500} rows={3} />
        </label>

        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn-primary" disabled={!position || busy}>
          {busy ? 'Submitting…' : 'Submit report'}
        </button>
      </form>
    </Panel>
  )
}

export function ReportList({ rows, onReview, reviewingId, onInspectStation }) {
  return (
    <div className="report-list">
      {rows.map((r) => {
        const isPending = r.status === 'pending'
        const isApproved = r.status === 'approved'
        const isRejected = r.status === 'rejected'
        return (
          <article key={r.id} className="report-row">
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <h3>{r.location_label || r.source_type?.replaceAll('_', ' ')}</h3>
                  {r.station_id && (
                    <span className="station-role-tag" style={{ fontSize: '0.68rem' }}>
                      {r.station_id.replace('STATION_', '')}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className={`status-pill ${isPending ? 'sev-warning' : isRejected ? 'sev-critical' : 'sev-normal'}`}>
                    {isPending ? 'Pending review' : isRejected ? 'Declined' : 'Verified observation'}
                  </span>
                </div>
              </div>
              <p>{r.note || 'No additional notes.'}</p>
              <p className="muted">
                {r.station_id && `Station: ${r.station_id.replace('STATION_', '')} · `}
                {r.ammonia_ppm != null && `Ammonia ${r.ammonia_ppm} ppm · `}
                {r.ph != null && `pH ${r.ph} · `}
                {r.reporter_type === 'verified' ? 'Verified reporter' : 'Citizen'} ·{' '}
                {new Date(r.created_at * 1000).toLocaleString()}
              </p>
              <div className="report-tags">
                {r.observations?.map((o) => (
                  <span key={o}>{OBSERVATIONS[o] || o}</span>
                ))}
              </div>

              {/* Approve & Decline buttons */}
              {isPending && onReview && (
                <div className="report-review-actions" style={{ display: 'flex', gap: '8px', marginTop: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn-approve-report"
                    onClick={() => onReview(r.id, 'approve')}
                    disabled={reviewingId === r.id}
                  >
                    {reviewingId === r.id ? 'Approving…' : '✓ Approve & Update Station'}
                  </button>
                  <button
                    type="button"
                    className="btn-decline-report"
                    onClick={() => onReview(r.id, 'reject')}
                    disabled={reviewingId === r.id}
                  >
                    ✕ Decline
                  </button>
                  <span className="review-hint" style={{ fontSize: '0.74rem', color: '#94a3b8' }}>
                    Approving updates telemetry & condition for {r.station_id ? r.station_id.replace('STATION_', '') : 'nearest station'}.
                  </span>
                </div>
              )}

              {isApproved && r.station_id && onInspectStation && (
                <div style={{ marginTop: '10px' }}>
                  <button
                    type="button"
                    className="btn-dash-secondary"
                    style={{ fontSize: '0.74rem', padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    onClick={() => onInspectStation(r.station_id)}
                  >
                    📊 View {r.station_id.replace('STATION_', '')} on Yamuna Watch ↓
                  </button>
                </div>
              )}
            </div>
          </article>
        )
      })}
    </div>
  )
}

export default function Reports() {
  const feed = usePoll('/reports/pending', 10000)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const lock = useRef(false)
  async function review(id, action) {
    if (lock.current) return
    lock.current = true; setBusy(id); setError('')
    try { await api(`/reports/${id}`, { method: 'PATCH', body: { action, note: '' } }); feed.refresh() } catch (e) { setError(e.message) } finally { lock.current = false; setBusy('') }
  }
  return <Panel title="Field report moderation" meta={`${feed.data?.length || 0} pending`}>
    <p className="muted">Review readings and location before approving. Citizen observations never authorize a gate command.</p>
    <ReadState {...feed} retry={feed.refresh}/>{error && <p role="alert" className="error">{error}</p>}
    {!feed.loading && !feed.error && !feed.data?.length && <p className="calm">No reports waiting for review.</p>}
    {!feed.error && feed.data?.map(r => <div key={r.id} className="moderation-item"><ReportList rows={[r]}/>{r.photo_url && <a href={r.photo_url} target="_blank" rel="noreferrer"><img className="report-photo" src={r.photo_url} alt="Submitted water sample" loading="lazy"/></a>}<dl className="triage-facts"><div><dt>GPS</dt><dd>{r.lat}, {r.lng}</dd></div><div><dt>Photo</dt><dd>{r.photo_key ? 'Attached' : 'Not provided'}</dd></div><div><dt>Translation</dt><dd>{r.translated_note || 'Not available'}</dd></div><div><dt>Image tags</dt><dd>{r.image_tags?.join(', ') || 'Not available'}</dd></div></dl><div className="action-row"><button className="btn-primary" disabled={Boolean(busy)} onClick={() => review(r.id, 'approve')}>{busy === r.id ? 'Saving…' : 'Approve report'}</button><button className="btn-secondary" disabled={Boolean(busy)} onClick={() => review(r.id, 'reject')}>Reject report</button></div></div>)}
  </Panel>
}
