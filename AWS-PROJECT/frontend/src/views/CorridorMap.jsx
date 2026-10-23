import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { api, usePoll } from '../api'
import { levelMeta } from '../format'

const CORRIDOR_BOUNDS = [
  [76.82, 28.62], // Southwest: below Wazirabad
  [77.38, 29.52], // Northeast: above Panipat
]

const CORRIDOR_CENTER = [77.08, 29.07]

const STATION_INFO = {
  STATION_01_PANIPAT: { short: 'Panipat I' },
  STATION_02_PANIPAT: { short: 'Panipat II' },
  STATION_03_SONIPAT: { short: 'Sonipat' },
  STATION_04_PALLA: { short: 'Palla' },
  STATION_05_WAZIRABAD: { short: 'Wazirabad Intake' },
}

export default function CorridorMap({
  stations = [],
  incident = null,
  intakeStatus = 'OPEN',
  selectedStationId = '',
  onSelectStation,
}) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef([])
  const [mapState, setMapState] = useState('loading') // 'loading' | 'ready' | 'error'
  const [selectedStation, setSelectedStation] = useState(null)
  const healthPoll = usePoll('/river-health/yamuna-panipat', 8000)

  // Initialize MapLibre with Amazon Location Service
  useEffect(() => {
    let cancelled = false
    let mapInstance = null

    ;(async () => {
      try {
        const cfg = await api('/map-config', { auth: false })
        if (cancelled || !containerRef.current) return

        mapInstance = new maplibregl.Map({
          container: containerRef.current,
          style: cfg.style_url,
          center: CORRIDOR_CENTER,
          zoom: 9.3,
          bounds: CORRIDOR_BOUNDS,
          fitBoundsOptions: { padding: 45, maxZoom: 11.5 },
          attributionControl: { compact: true },
        })

        mapInstance.addControl(
          new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }),
          'top-right'
        )

        mapInstance.on('load', () => {
          if (cancelled) return
          mapRef.current = mapInstance
          setMapState('ready')
          mapInstance.resize()
        })

        mapInstance.on('error', () => {
          if (!cancelled) setMapState((s) => (s === 'ready' ? s : 'error'))
        })
      } catch {
        if (!cancelled) setMapState('error')
      }
    })()

    return () => {
      cancelled = true
      markersRef.current.forEach((m) => m.remove())
      markersRef.current = []
      try {
        mapInstance?.remove()
      } catch {
        // cleanup safe
      }
      mapRef.current = null
    }
  }, [])

  // Render or update GeoJSON river reaches once map is ready
  useEffect(() => {
    const map = mapRef.current
    if (!map || mapState !== 'ready') return

    const reaches = healthPoll.data?.features || []
    const sourceData = {
      type: 'FeatureCollection',
      features: reaches.length > 0 ? reaches : [],
    }

    try {
      if (!map.getSource('river-reaches')) {
        map.addSource('river-reaches', {
          type: 'geojson',
          data: sourceData,
        })

        // Glowing outer corridor path
        map.addLayer({
          id: 'river-reaches-glow',
          type: 'line',
          source: 'river-reaches',
          paint: {
            'line-color': [
              'match',
              ['get', 'health_status'],
              'CRITICAL', '#ef4444',
              'WARNING', '#f59e0b',
              '#0284c7',
            ],
            'line-width': 8,
            'line-opacity': 0.35,
            'line-blur': 3,
          },
        })

        // Solid core river channel
        map.addLayer({
          id: 'river-reaches-core',
          type: 'line',
          source: 'river-reaches',
          paint: {
            'line-color': [
              'match',
              ['get', 'health_status'],
              'CRITICAL', '#ef4444',
              'WARNING', '#f59e0b',
              '#38bdf8',
            ],
            'line-width': 4,
            'line-opacity': 0.9,
          },
        })
      } else {
        const src = map.getSource('river-reaches')
        if (src?.setData) {
          src.setData(sourceData)
        }
      }
    } catch {
      // Map style loading in-flight safeguard
    }
  }, [mapState, healthPoll.data])

  // Update Station Markers
  useEffect(() => {
    const map = mapRef.current
    if (!map || mapState !== 'ready') return

    // Clear old markers
    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []

    stations.forEach((st) => {
      const coords = Array.isArray(st.coords) ? st.coords : null
      if (!coords || coords.length < 2) return
      const [lat, lng] = coords
      const sev = levelMeta(st.status).sev
      const isIncident = incident?.station_id === st.station_id
      const isSelected = selectedStationId === st.station_id
      const isIntake = st.station_id === 'STATION_05_WAZIRABAD'
      const info = STATION_INFO[st.station_id] || { short: st.name }

      // Marker element
      const el = document.createElement('div')
      el.className = `corridor-map-marker sev-${sev} ${isIncident ? 'is-incident' : ''} ${isSelected ? 'is-selected' : ''}`
      el.title = `${st.name} (${levelMeta(st.status).label})`

      el.innerHTML = `
        <div class="marker-pulse"></div>
        <div class="marker-pin ${isIntake ? 'marker-intake' : ''}">
          <span class="marker-icon">${isIntake ? '🛡️' : '📍'}</span>
        </div>
        <div class="marker-label">
          <span class="marker-name">${info.short}</span>
          ${isIntake ? `<span class="marker-gate gate-${intakeStatus.toLowerCase()}">${intakeStatus}</span>` : ''}
          ${st.community_reports_count > 0 ? `<span class="marker-reports-badge" title="${st.community_reports_count} field report(s)">📝 ${st.community_reports_count}</span>` : ''}
        </div>
      `

      el.addEventListener('click', () => {
        setSelectedStation(st)
        if (onSelectStation) onSelectStation(st.station_id)
        map.flyTo({ center: [lng, lat], zoom: 11, speed: 1.2 })
      })

      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([lng, lat])
        .addTo(map)

      markersRef.current.push(marker)
    })
  }, [mapState, stations, incident, intakeStatus, selectedStationId, onSelectStation])

  const fitCorridor = () => {
    if (!mapRef.current) return
    mapRef.current.fitBounds(CORRIDOR_BOUNDS, { padding: 45, maxZoom: 11.5, duration: 1000 })
  }

  return (
    <div className="corridor-map-container" aria-label="Amazon Location Service Yamuna Corridor Map">
      {/* Top Map Bar */}
      <div className="corridor-map-topbar">
        <div className="map-badge-group">
          <span className="map-service-badge">
            <span className="ticker-live-dot" aria-hidden="true"></span>
            AWS LOCATION SERVICE · AP-SOUTHEAST-2
          </span>
          <span className="map-style-badge">Standard Basemap</span>
        </div>
        <div className="map-controls-row">
          <button type="button" className="btn-map-control" onClick={fitCorridor} title="Fit entire river corridor">
            Fit Corridor
          </button>
        </div>
      </div>

      {/* Canvas Host */}
      <div className="corridor-map-stage">
        <div ref={containerRef} className="corridor-map-canvas" />

        {/* Loading / Fallback Overlay */}
        {mapState !== 'ready' && (
          <div className="corridor-map-overlay" role="status">
            <div className="map-loader-spinner" aria-hidden="true"></div>
            <p className="map-overlay-title">
              {mapState === 'loading'
                ? 'Loading Amazon Location Service vector tiles…'
                : 'Interactive AWS Location map offline or unconfigured'}
            </p>
            <p className="map-overlay-sub">
              {mapState === 'loading'
                ? 'Connecting to AWS Location V2 styles proxy'
                : 'Station telemetry is active. Coordinates are preserved below.'}
            </p>
          </div>
        )}

        {/* Active Incident Floating Alert */}
        {incident && (
          <div className="map-incident-banner" role="alert">
            <span className="incident-badge-icon">⚠️</span>
            <div className="incident-banner-text">
              <strong>POLLUTION PLUME DETECTED</strong>
              <span>
                Origin: {incident.station_id} · T-minus to Wazirabad intake:{' '}
                {Math.round(incident.t_minus_seconds / 60)} min
              </span>
            </div>
          </div>
        )}

        {/* Selected Station Floating Detail Card */}
        {selectedStation && (
          <div className="map-station-popup">
            <button
              type="button"
              className="popup-close-btn"
              onClick={() => setSelectedStation(null)}
              aria-label="Close station detail"
            >
              ×
            </button>
            <div className="popup-head">
              <h4>{selectedStation.name}</h4>
              <span className={`status-pill sev-${levelMeta(selectedStation.status).sev}`}>
                {levelMeta(selectedStation.status).label}
              </span>
            </div>
            <div className="popup-facts">
              <div>
                <span className="fact-k">DISTANCE TO INTAKE</span>
                <span className="fact-v">{Number.isFinite(selectedStation.distance_km) ? `${selectedStation.distance_km} km to intake` : 'Distance unavailable'}</span>
              </div>
              <div>
                <span className="fact-k">AMMONIA BAND</span>
                <span className="fact-v">{selectedStation.toxicity_band || 'SAFE'}</span>
              </div>
              <div>
                <span className="fact-k">GPS COORDINATES</span>
                <span className="fact-v mono">
                  {selectedStation.coords ? `${selectedStation.coords[0].toFixed(4)}, ${selectedStation.coords[1].toFixed(4)}` : '—'}
                </span>
              </div>
              {selectedStation.community_reports_count > 0 && (
                <div style={{ gridColumn: 'span 2', background: 'rgba(56, 189, 248, 0.1)', border: '1px solid rgba(56, 189, 248, 0.25)', borderRadius: '6px', padding: '6px 8px', marginTop: '4px' }}>
                  <span className="fact-k" style={{ color: '#38bdf8' }}>COMMUNITY FIELD REPORTS</span>
                  <span className="fact-v" style={{ display: 'block', color: '#f0f9ff' }}>
                    📝 {selectedStation.community_reports_count} report(s) in last 24h
                    {selectedStation.latest_report?.observations?.length > 0 && (
                      <span style={{ display: 'block', fontSize: '0.78rem', color: '#94a3b8', marginTop: '2px' }}>
                        Observations: {selectedStation.latest_report.observations.join(', ')}
                      </span>
                    )}
                  </span>
                </div>
              )}
            </div>
            {onSelectStation && (
              <button
                type="button"
                className="btn-popup-inspect"
                onClick={() => {
                  onSelectStation(selectedStation.station_id)
                  setSelectedStation(null)
                }}
              >
                Inspect Telemetry Trace →
              </button>
            )}
          </div>
        )}

        {/* Map Legend */}
        <div className="corridor-map-legend" aria-label="Map status legend">
          <span className="legend-title">RIVER HEALTH</span>
          <div className="legend-items">
            <span className="legend-item"><span className="legend-dot dot-normal"></span> Normal</span>
            <span className="legend-item"><span className="legend-dot dot-warning"></span> Elevated</span>
            <span className="legend-item"><span className="legend-dot dot-critical"></span> Critical</span>
            <span className="legend-item"><span className="legend-dot dot-intake"></span> Intake Gate</span>
          </div>
        </div>
      </div>
    </div>
  )
}
