import { lazy, Suspense, useRef, useState } from 'react'
import { usePoll } from '../api'
import { Panel, ReadState } from '../ui'
import { levelMeta, fmtClock } from '../format'

const StationMap = lazy(() => import('./StationMap'))

const OpenMapIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 10 10.5 5.5" /><path d="M6.5 5.5H10.5V9.5" />
  </svg>
)

function Trace({ rows, field, label, unit }) {
  const samples = rows.filter(r => Number.isFinite(r[field]) && Number.isFinite(r.timestamp)).toSorted((a, b) => a.timestamp - b.timestamp)
  const values = samples.map(r => r[field])
  const lo = Math.min(...values), hi = Math.max(...values)
  const start = samples[0]?.timestamp, end = samples.at(-1)?.timestamp
  const points = samples.map(r => `${10 + (r.timestamp - start) * 380 / (end - start || 1)},${90 - (r[field] - lo) / (hi - lo || 1) * 65}`).join(' ')
  return <div className="telemetry-trace"><h3>{label}</h3><strong>{values.length ? `${values.at(-1).toFixed(2)} ${unit}` : 'No readings'}</strong>
    {values.length > 1 ? <><div className="trace-scale"><span>Min {lo.toFixed(2)} {unit}</span><span>Max {hi.toFixed(2)} {unit}</span></div><svg viewBox="0 0 400 110" role="img" aria-label={`${label}, ${values.length} samples from ${fmtClock(start)} to ${fmtClock(end)}; minimum ${lo}, maximum ${hi} ${unit}`}><path d="M10 95H390" stroke="currentColor" opacity=".25" /><polyline points={points} fill="none" stroke="currentColor" strokeWidth="3" /></svg><div className="trace-scale"><time>{fmtClock(start)}</time><time>{fmtClock(end)}</time></div></> : <p className="muted">Waiting for enough readings to draw a trend.</p>}
  </div>
}

export default function StationWatch({ stations = [], status, selectedStationId }) {
  const list = stations.length ? stations : (status?.stations || [])
  const [userSelected, setUserSelected] = useState('')
  const [lastPropSid, setLastPropSid] = useState(selectedStationId)
  const [mapOpen, setMapOpen] = useState(false)
  const dialogRef = useRef(null)

  if (selectedStationId !== lastPropSid) {
    setLastPropSid(selectedStationId)
    setUserSelected('')
  }

  const sid = userSelected || selectedStationId || list[0]?.station_id
  const feed = usePoll(`/telemetry/${encodeURIComponent(sid || '')}`, 5000, { enabled: Boolean(sid) })
  const rows = feed.error ? [] : feed.data?.readings || []
  const latest = rows.at(-1)
  const station = list.find(s => s.station_id === sid)
  const coords = Array.isArray(station?.coords) ? station.coords : null
  const condition = levelMeta(latest?.threat_level)
  const value = (key, unit = '') => latest?.[key] == null ? 'NOT REPORTED' : `${latest[key]} ${unit}`
  const openMap = () => { setMapOpen(true); dialogRef.current?.showModal() }
  const closeMap = () => dialogRef.current?.close()

  return <Panel title="Yamuna Watch" meta="Synchronized chemical + biological telemetry" className="watch-panel">
    <label className="field-block">Monitoring node<select value={sid || ''} onChange={e => setUserSelected(e.target.value)}><option value="" disabled>Select station</option>{list.map(s => <option key={s.station_id} value={s.station_id}>{s.name || s.station_id}</option>)}</select></label>
    <ReadState {...feed} retry={feed.refresh} />
    <div className="watch-layout">
      <div className={`lcd-display lcd-${condition.sev}`}>
        <h3>BIO-SENTINEL YAMUNA WATCH</h3><p>{station?.name || 'Awaiting station'}</p>
        <div className="lcd-status">SYSTEM STATUS: {latest ? condition.label.toUpperCase() : 'AWAITING TELEMETRY'}</div>
        <dl>
          {[['AMMONIA', value('ammonia_ppm', 'ppm')], ['pH LEVEL', value('ph')], ['DAPHNIA SPEED', value('avg_velocity_mms', 'mm/s')], ['DAPHNIA DEPTH', value('avg_depth_cm', 'cm')], ['ERRATIC INDEX', value('erratic_index')], ['WATER TEMP', value('temperature_c', '°C')], ['TDS', value('tds_mgl', 'mg/L')], ['BATTERY', value('battery_percent', '%')], ['CELLULAR', latest?.cellular || 'NOT REPORTED']].map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          <div className="lcd-gps"><dt>GPS</dt><dd>
            <span>{coords ? `${coords[0].toFixed(4)}, ${coords[1].toFixed(4)}` : 'NOT REPORTED'}</span>
            {coords && <button type="button" className="lcd-map-btn" onClick={openMap} aria-label={`Open map of ${station?.name || 'this station'}`}><OpenMapIcon /></button>}
          </dd></div>
          {station?.community_reports_count > 0 && (
            <div className="lcd-reports" style={{ gridColumn: 'span 2', borderTop: '1px solid rgba(255,255,255,0.15)', paddingTop: '4px', marginTop: '4px' }}>
              <dt style={{ color: '#38bdf8' }}>FIELD REPORTS</dt>
              <dd style={{ color: '#38bdf8' }}>
                {station.community_reports_count} report(s) in 24h {station.latest_report?.observations?.length ? `(${station.latest_report.observations.join(', ')})` : ''}
              </dd>
            </div>
          )}
        </dl>
        <p className="lcd-foot">{latest ? `Last sample ${fmtClock(latest.timestamp)}` : 'No sample received'} · Live feed</p>
      </div>
      <div className="dual-telemetry"><Trace rows={rows} field="ammonia_ppm" label="Chemical probe · ammonia" unit="ppm" /><Trace rows={rows} field="avg_depth_cm" label="Daphnia · depth" unit="cm" /><Trace rows={rows} field="avg_velocity_mms" label="Daphnia · movement" unit="mm/s" /></div>
    </div>
    <dialog ref={dialogRef} className="map-dialog" aria-label={`${station?.name || 'Station'} location`} onClose={() => setMapOpen(false)}>
      <div className="map-dialog-head">
        <div><h3>{station?.name || 'Station'} · location</h3>{coords && <p className="mono">{coords[0].toFixed(5)}, {coords[1].toFixed(5)}</p>}</div>
        <button type="button" className="btn-ghost" onClick={closeMap}>Close</button>
      </div>
      {mapOpen && station && <Suspense fallback={<div className="station-map-overlay"><p>Loading map…</p></div>}><StationMap key={sid} station={station} /></Suspense>}
    </dialog>
    <details className="hardware-reference"><summary>About the monitoring hardware</summary><div className="hardware-pair"><figure><img src="/reference/biosensor.png" alt="Reference design of a Daphnia chamber with a monitoring camera" loading="lazy" /><figcaption>Biological monitoring chamber · supplied design reference</figcaption></figure><figure><img src="/reference/field-monitor.jpeg" alt="Reference photograph of a Yamuna Watch field LCD" loading="lazy" /><figcaption>Field monitor reference · pictured values are illustrative</figcaption></figure></div></details>
  </Panel>
}
