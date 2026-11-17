import { useRef, useState, type ReactNode } from 'react'
import { startGame } from '../game/sim'
import { useGame } from '../game/store'
import { REAL, cancelPlace, openPlace, placeName, savedPlace, searchPlaces, type Place } from '../real/load'
import { ROUTE, cancelRoute, savedDest, setDestination } from '../real/route'
import { MapPicker } from './MapPicker'

type Which = 'start' | 'dest'

/** an address search box with its list of matches */
function PlaceSearch({ value, onValue, placeholder, label, onChoose, disabled, extra }: { value: string; onValue: (v: string) => void; placeholder: string; label: string; onChoose: (p: Place) => void; disabled: boolean; extra?: ReactNode }) {
  const [results, setResults] = useState<Place[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const search = async () => {
    if (!value.trim() || disabled) return
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
        <span className={`pp-label ${label === 'A' ? 'a' : 'b'}`}>{label}</span>
        <input value={value} onChange={(e) => onValue(e.target.value)} placeholder={placeholder} aria-label={placeholder} disabled={disabled} onKeyDown={(e) => e.stopPropagation()} />
        <button type="submit" className="secondary" disabled={disabled || busy || !value.trim()}>{busy ? 'Searching…' : 'Search'}</button>
        {extra}
      </form>
      {err && <p className="pp-msg pp-err">{err}</p>}
      {results && results.length > 0 && !disabled && (
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
 * Real place, the map page: choose where to start (A) and, if you like, where to drive to (B), by searching for an address or by
 * tapping the map. "Download map" then locks the choice and downloads the roads round the start (and plans the route); when it is
 * done, Drive starts. Cancel stops the download and goes back to the main page.
 */
export function PlacePicker({ onBack }: { onBack: () => void }) {
  const real = useGame((s) => s.real)
  const route = useGame((s) => s.route)
  const [a, setA] = useState<Place | null>(() => (REAL.place ?? savedPlace()))
  const [b, setB] = useState<Place | null>(() => savedDest())
  const [qA, setQA] = useState(() => short(a?.label ?? ''))
  const [qB, setQB] = useState(() => short(b?.label ?? ''))
  const [center, setCenter] = useState<{ lat: number; lon: number; zoom?: number } | null>(() => a)
  const [tapSets, setTapSets] = useState<Which>('start')
  const pickT = useRef(0)

  // the place's map: being downloaded, ready, or failed (the choice is locked from "Download map" until it is cancelled)
  const downloading = real.status === 'loading' || route.status === 'loading'
  const ready = real.status === 'ready' && !downloading
  const locked = downloading || ready

  const chooseA = (p: Place) => { setA(p); setQA(short(p.label)); setCenter({ lat: p.lat, lon: p.lon, zoom: 16 }) }
  const chooseB = (p: Place | null) => { setB(p); setQB(p ? short(p.label) : ''); if (p) setCenter({ lat: p.lat, lon: p.lon, zoom: 15 }) }
  // a tap on the map: the pin moves at once, and the street name is looked up
  const pickOnMap = (lat: number, lon: number) => {
    if (locked) return
    const which = tapSets
    const p = { label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon }
    if (which === 'start') { setA(p); setQA('Looking up the street…') } else { setB(p); setQB('Looking up the street…') }
    clearTimeout(pickT.current)
    pickT.current = window.setTimeout(async () => {
      const named = { ...p, label: await placeName(lat, lon) }
      if (which === 'start') { setA(named); setQA(short(named.label)) } else { setB(named); setQB(short(named.label)) }
    }, 300)
  }
  const download = () => {
    if (!a) return
    void openPlace(a)
    setDestination(b) // (plans the route from A, if there is a B)
  }
  const stop = () => { cancelPlace(); cancelRoute() }

  // the route on the map, once it is planned
  const routeLine = route.status === 'ready' ? ROUTE.route?.coords ?? null : null

  return (
    <div className="mappage">
      <header className="pagehead">
        <button type="button" className="iconbtn" aria-label="Back to the main page" onClick={() => { if (downloading) stop(); onBack() }}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <h2>Where do you want to drive?</h2>
      </header>
      <div className={`pp-pick${locked ? ' locked' : ''}`}>
        <PlaceSearch label="A" value={qA} onValue={setQA} placeholder="Start: address or place" onChoose={chooseA} disabled={locked} />
        <PlaceSearch label="B" value={qB} onValue={setQB} placeholder="Destination (optional): address or place" onChoose={chooseB} disabled={locked}
          extra={b && !locked ? <button type="button" className="secondary" onClick={() => chooseB(null)} aria-label="Clear the destination">✕</button> : null} />
        <div className="pp-tap" role="group" aria-label="Tapping the map sets">
          <span>Tap the map to set:</span>
          <button type="button" disabled={locked} className={tapSets === 'start' ? 'on' : ''} onClick={() => setTapSets('start')}>A start</button>
          <button type="button" disabled={locked} className={tapSets === 'dest' ? 'on' : ''} onClick={() => setTapSets('dest')}>B destination</button>
        </div>
      </div>
      <MapPicker center={center} marker={a} dest={b} route={routeLine} tiles={[...REAL.tiles]} onPick={pickOnMap} />

      <div className="pp-status" aria-live="polite">
        {!locked && real.status !== 'error' && route.status !== 'error' && <p className="pp-msg">{a ? <>Start: <b>{short(a.label)}</b>{b ? <> · Destination: <b>{short(b.label)}</b></> : ' · no destination (free drive)'}</> : 'Search for an address, or tap a street on the map, to choose where to start.'}</p>}
        {downloading && (
          <div className="pp-progress">
            <span className="spinner" aria-hidden="true" />
            <p className="pp-msg">{real.status === 'loading' ? real.msg : 'Planning the route…'}</p>
          </div>
        )}
        {ready && <p className="pp-msg"><b>Map downloaded.</b> {real.msg}{route.status === 'ready' && <><br />Route: {route.msg}</>}</p>}
        {real.status === 'error' && <p className="pp-msg pp-err">Could not download the map: {real.msg}</p>}
        {route.status === 'error' && <p className="pp-msg pp-err">Could not plan the route: {route.msg}</p>}
      </div>

      <div className="pagefoot">
        {!locked && (
          <>
            <button type="button" className="secondary" onClick={() => { stop(); onBack() }}>Cancel</button>
            <button type="button" className="primary" disabled={!a} onClick={download}>{real.status === 'error' || route.status === 'error' ? 'Try again' : 'Download map'}</button>
          </>
        )}
        {downloading && <button type="button" className="secondary" onClick={() => { stop(); onBack() }}>Cancel</button>}
        {ready && (
          <>
            <button type="button" className="secondary" onClick={stop}>Change places</button>
            <button type="button" className="primary" onClick={() => startGame()}>Drive</button>
          </>
        )}
      </div>
      <p className="pp-note">Map data © OpenStreetMap contributors; routes by OSRM. The roads round the start are downloaded before you drive (shaded blue); more are downloaded as you drive. Stop signs, lights and speed limits are often missing from the map: where they are, the usual US rules are used.</p>
    </div>
  )
}
const short = (label: string) => label.split(',').slice(0, 3).join(',').trim()
