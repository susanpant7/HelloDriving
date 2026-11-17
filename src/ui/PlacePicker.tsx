import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useGame } from '../game/store'
import { REAL, openPlace, placeName, savedPlace, searchPlaces, type Place } from '../real/load'
import { ROUTE, planRoute, savedDest, setDestination } from '../real/route'
import { MapPicker } from './MapPicker'

type Which = 'start' | 'dest'

/** an address search box with its list of matches */
function PlaceSearch({ value, onValue, placeholder, label, onChoose, extra }: { value: string; onValue: (v: string) => void; placeholder: string; label: string; onChoose: (p: Place) => void; extra?: ReactNode }) {
  const [results, setResults] = useState<Place[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const search = async () => {
    if (!value.trim()) return
    setBusy(true); setErr(''); setResults(null)
    try {
      const r = await searchPlaces(value.trim())
      setResults(r)
      if (!r.length) setErr('Nothing found: try a fuller address, with the town and state')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Search failed')
    } finally { setBusy(false) }
  }
  return (
    <>
      <form className="pp-search" onSubmit={(e) => { e.preventDefault(); void search() }}>
        <span className="pp-label">{label}</span>
        <input value={value} onChange={(e) => onValue(e.target.value)} placeholder={placeholder} aria-label={placeholder} onKeyDown={(e) => e.stopPropagation()} />
        <button type="submit" className="secondary" disabled={busy || !value.trim()}>{busy ? 'Searching…' : 'Search'}</button>
        {extra}
      </form>
      {err && <p className="pp-msg pp-err">{err}</p>}
      {results && results.length > 0 && (
        <ul className="pp-results">
          {results.map((p, i) => (
            <li key={i}><button type="button" onClick={() => { setResults(null); onChoose(p) }}>{p.label}</button></li>
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * Real place: where to start (A) and, if you like, where to drive to (B). Search for an address, or tap a street on the map. The
 * roads round the start are downloaded before you can start; the rest are downloaded as you drive. With a destination, the route
 * is planned and you are guided along it.
 */
export function PlacePicker() {
  const real = useGame((s) => s.real)
  const route = useGame((s) => s.route)
  const [qA, setQA] = useState(() => short(savedPlace()?.label ?? ''))
  const [qB, setQB] = useState(() => short(savedDest()?.label ?? ''))
  const [center, setCenter] = useState<{ lat: number; lon: number; zoom?: number } | null>(() => savedPlace())
  const [start, setStart] = useState<{ lat: number; lon: number } | null>(() => savedPlace())
  const [dest, setDest] = useState<{ lat: number; lon: number } | null>(() => savedDest())
  const [tapSets, setTapSets] = useState<Which>('start')
  const pickT = useRef(0)

  // reopen the last place you drove (from the browser's copy, if it still has one), and its route
  useEffect(() => {
    const p = savedPlace()
    if (p && !REAL.place && useGame.getState().real.status === 'idle') { void openPlace(p); void planRoute() }
    return () => clearTimeout(pickT.current)
  }, [])
  // show the whole route once it is planned
  useEffect(() => {
    const r = ROUTE.route
    if (route.status !== 'ready' || !r) return
    let a = 90, b = -90, c = 180, d = -180
    for (const [la, lo] of r.coords) { a = Math.min(a, la); b = Math.max(b, la); c = Math.min(c, lo); d = Math.max(d, lo) }
    const span = Math.max((b - a) * 1.3, ((d - c) * Math.cos((a * Math.PI) / 180)) * 0.8, 0.002)
    setCenter({ lat: (a + b) / 2, lon: (c + d) / 2, zoom: Math.max(4, Math.min(17, Math.log2(360 / span) - 0.3)) })
  }, [route.version])

  const setA = (p: Place) => {
    setQA(short(p.label))
    setStart({ lat: p.lat, lon: p.lon })
    if (!ROUTE.dest) setCenter({ lat: p.lat, lon: p.lon, zoom: 16 })
    void openPlace(p)
    void planRoute()
  }
  const setB = (p: Place | null) => {
    setQB(p ? short(p.label) : '')
    setDest(p ? { lat: p.lat, lon: p.lon } : null)
    setDestination(p)
  }
  // a tap on the map: the pin moves at once; the place is opened a moment later (so a few quick taps open only the last)
  const pickOnMap = (lat: number, lon: number) => {
    const which = tapSets
    if (which === 'start') {
      setStart({ lat, lon })
      useGame.setState((s) => ({ real: { ...s.real, status: 'loading', msg: 'Downloading the roads…', label: 'the chosen spot' } }))
    } else setDest({ lat, lon })
    clearTimeout(pickT.current)
    pickT.current = window.setTimeout(async () => {
      const p = { label: await placeName(lat, lon), lat, lon }
      if (which === 'start') setA(p)
      else setB(p)
    }, 500)
  }

  return (
    <div className="placepick">
      <PlaceSearch label="A" value={qA} onValue={setQA} placeholder="Start: address or place" onChoose={setA} />
      <PlaceSearch label="B" value={qB} onValue={setQB} placeholder="Destination (optional): address or place" onChoose={setB}
        extra={dest ? <button type="button" className="secondary" onClick={() => setB(null)} aria-label="Clear the destination">✕</button> : null} />
      <div className="pp-tap" role="group" aria-label="Tapping the map sets">
        <span>Tap the map to set:</span>
        <button type="button" className={tapSets === 'start' ? 'on' : ''} onClick={() => setTapSets('start')}>A start</button>
        <button type="button" className={tapSets === 'dest' ? 'on' : ''} onClick={() => setTapSets('dest')}>B destination</button>
      </div>
      <MapPicker center={center} marker={start} dest={dest} route={route.status === 'ready' ? ROUTE.route?.coords ?? null : null} tiles={[...REAL.tiles]} onPick={pickOnMap} />
      {real.status !== 'idle' && (
        <p className={`pp-msg${real.status === 'error' ? ' pp-err' : ''}`} aria-live="polite">
          {real.status === 'loading' && <>Loading <b>{short(real.label)}</b>: downloading its roads…</>}
          {real.status === 'ready' && <><b>{short(real.label)}</b> is ready. {real.msg}</>}
          {real.status === 'error' && <>{short(real.label)}: {real.msg}</>}
        </p>
      )}
      {real.status === 'idle' && <p className="pp-msg">Search for an address, or tap a street on the map to start there.</p>}
      {route.status !== 'none' && (
        <p className={`pp-msg${route.status === 'error' ? ' pp-err' : ''}`} aria-live="polite">
          {route.status === 'loading' && <>Planning the route…</>}
          {route.status === 'ready' && <>Route to <b>{short(route.dest)}</b>: {route.msg}</>}
          {route.status === 'error' && <>Route: {route.msg}</>}
        </p>
      )}
      <p className="pp-note">Map data © OpenStreetMap contributors; routes by OSRM. The roads round the start are downloaded first (shaded blue); more are downloaded as you drive. Stop signs and speed limits are often missing from the map: where they are, the usual US rules are used.</p>
    </div>
  )
}
const short = (label: string) => label.split(',').slice(0, 3).join(',').trim()
