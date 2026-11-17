import { useEffect, useRef, useState } from 'react'
import { useGame } from '../game/store'
import { REAL, openPlace, placeName, savedPlace, searchPlaces, type Place } from '../real/load'
import { MapPicker } from './MapPicker'

/**
 * Real place: choose where to start, by searching for an address or by tapping a street on the map. The roads round it are
 * downloaded (or taken from the browser's copy) before you can start; the rest are downloaded as you drive.
 */
export function PlacePicker() {
  const real = useGame((s) => s.real)
  const [q, setQ] = useState(() => short(savedPlace()?.label ?? ''))
  const [results, setResults] = useState<Place[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [center, setCenter] = useState<{ lat: number; lon: number; zoom?: number } | null>(() => savedPlace())
  const [marker, setMarker] = useState<{ lat: number; lon: number } | null>(() => savedPlace())
  const pickT = useRef(0)

  // reopen the last place you drove (from the browser's copy, if it still has one)
  useEffect(() => {
    const p = savedPlace()
    if (p && !REAL.place && useGame.getState().real.status === 'idle') void openPlace(p)
    return () => clearTimeout(pickT.current)
  }, [])

  const search = async () => {
    if (!q.trim()) return
    setBusy(true); setErr(''); setResults(null)
    try {
      const r = await searchPlaces(q.trim())
      setResults(r)
      if (!r.length) setErr('Nothing found: try a fuller address, with the town and state')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Search failed')
    } finally { setBusy(false) }
  }
  const choose = (p: Place) => {
    setResults(null)
    setQ(short(p.label))
    setCenter({ lat: p.lat, lon: p.lon, zoom: 16 })
    setMarker({ lat: p.lat, lon: p.lon })
    void openPlace(p)
  }
  // a tap on the map: the pin moves at once; the roads there are loaded a moment later (so a few quick taps load only the last)
  const pickOnMap = (lat: number, lon: number) => {
    setResults(null)
    setMarker({ lat, lon })
    useGame.setState((s) => ({ real: { ...s.real, status: 'loading', msg: 'Downloading the roads…', label: 'the chosen spot' } }))
    clearTimeout(pickT.current)
    pickT.current = window.setTimeout(async () => {
      const label = await placeName(lat, lon)
      setQ(short(label))
      void openPlace({ label, lat, lon })
    }, 500)
  }

  return (
    <div className="placepick">
      <form className="pp-search" onSubmit={(e) => { e.preventDefault(); void search() }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Address or place, e.g. 100 Main St, Fort Worth, TX" aria-label="Address or place" onKeyDown={(e) => e.stopPropagation()} />
        <button type="submit" className="secondary" disabled={busy || !q.trim()}>{busy ? 'Searching…' : 'Search'}</button>
      </form>
      {err && <p className="pp-msg pp-err">{err}</p>}
      {results && results.length > 0 && (
        <ul className="pp-results">
          {results.map((p, i) => (
            <li key={i}><button type="button" onClick={() => choose(p)}>{p.label}</button></li>
          ))}
        </ul>
      )}
      <MapPicker center={center} marker={marker} tiles={[...REAL.tiles]} onPick={pickOnMap} />
      {real.status !== 'idle' && (
        <p className={`pp-msg${real.status === 'error' ? ' pp-err' : ''}`} aria-live="polite">
          {real.status === 'loading' && <>Loading <b>{short(real.label)}</b>: downloading its roads…</>}
          {real.status === 'ready' && <><b>{short(real.label)}</b> is ready. {real.msg}</>}
          {real.status === 'error' && <>{short(real.label)}: {real.msg}</>}
        </p>
      )}
      {real.status === 'idle' && <p className="pp-msg">Search for an address, or tap a street on the map to start there.</p>}
      <p className="pp-note">Map data © OpenStreetMap contributors. The roads round the start are downloaded first (shaded blue); more are downloaded as you drive. Stop signs and speed limits are often missing from the map: where they are, the usual US rules are used.</p>
    </div>
  )
}
const short = (label: string) => label.split(',').slice(0, 3).join(',').trim()
