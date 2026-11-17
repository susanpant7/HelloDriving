/**
 * Real places: finding a place and downloading its roads, using OpenStreetMap's free public services (Nominatim for the address
 * search, Overpass for the map data).
 *
 * The world is cut into tiles of 0.01 x 0.01 degrees (about 1.1 x 0.9 km in the US). Only the tiles round the starting point are
 * needed to start driving; while you drive, the tiles ahead are downloaded in the background (see `keepLoadedAround`). Every tile is
 * kept in the browser (IndexedDB), so a place opens straight away the next time, even offline.
 */
import { useGame } from '../game/store'
import { convertOsm, toLatLon, type OsmData, type RealMap } from './roads'

export interface Place { label: string; lat: number; lon: number }

/** the place being driven: its map (all the tiles loaded so far), the start, and which tiles are loaded */
export const REAL: { map: RealMap | null; place: Place | null; tiles: Set<string> } = { map: null, place: null, tiles: new Set() }

const TILE = 0.01 // degrees
/** before you can start: the tiles within this distance of the start (m) */
const START_RADIUS = 450
/** while driving: keep the tiles within this distance of the car loaded (m) */
const DRIVE_RADIUS = 750

const PLACE_KEY = 'driveme.realPlace'

export function savedPlace(): Place | null {
  try {
    const v = JSON.parse(localStorage.getItem(PLACE_KEY) || 'null')
    return v && typeof v.lat === 'number' && typeof v.lon === 'number' ? v : null
  } catch { return null }
}

/* ---------------- address search ---------------- */
/** Search for an address or place name: up to 6 matches. */
export async function searchPlaces(q: string): Promise<Place[]> {
  const u = new URL('https://nominatim.openstreetmap.org/search')
  u.searchParams.set('q', q)
  u.searchParams.set('format', 'json')
  u.searchParams.set('limit', '6')
  const r = await fetch(u, { headers: { Accept: 'application/json' } })
  if (!r.ok) throw new Error(`Search failed (${r.status})`)
  const list = (await r.json()) as Array<{ display_name: string; lat: string; lon: string }>
  return list.map((p) => ({ label: p.display_name, lat: Number(p.lat), lon: Number(p.lon) }))
}
/** The street (or place) at a point on the map, for a spot picked on the map. */
export async function placeName(lat: number, lon: number): Promise<string> {
  try {
    const u = new URL('https://nominatim.openstreetmap.org/reverse')
    u.searchParams.set('lat', lat.toFixed(6)); u.searchParams.set('lon', lon.toFixed(6)); u.searchParams.set('format', 'json'); u.searchParams.set('zoom', '17')
    const r = await fetch(u, { headers: { Accept: 'application/json' } })
    if (r.ok) { const v = await r.json(); if (v?.display_name) return v.display_name as string }
  } catch { /* fall through */ }
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`
}

/* ---------------- the browser's copy of downloaded tiles ---------------- */
let dbP: Promise<IDBDatabase | null> | null = null
function db(): Promise<IDBDatabase | null> {
  if (!dbP) {
    dbP = new Promise((res) => {
      try {
        const rq = indexedDB.open('driveme-real', 1)
        rq.onupgradeneeded = () => rq.result.createObjectStore('tiles')
        rq.onsuccess = () => res(rq.result)
        rq.onerror = () => res(null)
      } catch { res(null) }
    })
    // (the first version kept whole areas in localStorage: free that space)
    try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k?.startsWith('driveme.realArea.')) localStorage.removeItem(k) } } catch { /* ignore */ }
  }
  return dbP
}
async function cacheGet(key: string): Promise<string | null> {
  const d = await db()
  if (!d) return null
  return new Promise((res) => {
    try {
      const rq = d.transaction('tiles').objectStore('tiles').get(key)
      rq.onsuccess = () => res(typeof rq.result === 'string' ? rq.result : null)
      rq.onerror = () => res(null)
    } catch { res(null) }
  })
}
async function cachePut(key: string, text: string) {
  const d = await db()
  if (!d) return
  try { d.transaction('tiles', 'readwrite').objectStore('tiles').put(text, key) } catch { /* full: it is downloaded again next time */ }
}

/* ---------------- tiles ---------------- */
const tileKey = (i: number, j: number) => `${i},${j}`
/** the tiles that come within `r` metres of a point */
function tilesAround(lat: number, lon: number, r: number): string[] {
  const dLat = r / 110540, dLon = r / (111320 * Math.cos((lat * Math.PI) / 180))
  const out: string[] = []
  for (let i = Math.floor((lat - dLat) / TILE); i <= Math.floor((lat + dLat) / TILE); i++)
    for (let j = Math.floor((lon - dLon) / TILE); j <= Math.floor((lon + dLon) / TILE); j++) out.push(tileKey(i, j))
  return out
}
function tileQuery(key: string) {
  const [i, j] = key.split(',').map(Number)
  const bb = `${(i * TILE).toFixed(4)},${(j * TILE).toFixed(4)},${((i + 1) * TILE).toFixed(4)},${((j + 1) * TILE).toFixed(4)}`
  const roads = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link'
  return `[out:json][timeout:90];
way["highway"~"^(${roads})$"](${bb})->.r;
.r out body;
.r >;
out skel qt;
node["highway"~"^(stop|give_way|traffic_signals|turning_circle|turning_loop)$"](${bb});
out body qt;
way["building"](${bb});
out geom qt;`
}

/** all the map data downloaded for this drive, each item once (tiles overlap where a road or building crosses their edge) */
const elements = new Map<string, OsmData['elements'][number]>()
/** a new place starts a new session: downloads for an older one are dropped */
let session = 0
/** tiles waiting to be downloaded, and the one being downloaded */
const queue: string[] = []
const pending = new Set<string>()
const failed = new Map<string, number>() // tile -> when it last failed (to retry later)
let lastErr = ''

async function fetchTile(key: string): Promise<OsmData> {
  const cached = await cacheGet(key)
  if (cached) return JSON.parse(cached) as OsmData
  // the main public server, and another public one if it is busy or down
  let last = 'Download failed'
  for (const url of SERVERS) {
    try {
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: tileQuery(key) }) })
      if (!r.ok) { last = r.status === 429 || r.status === 504 ? 'The map server is busy: try again in a minute' : `Download failed (${r.status})`; continue }
      const text = await r.text()
      const data = JSON.parse(text) as OsmData
      void cachePut(key, text)
      return data
    } catch { last = 'Could not reach the map server' }
  }
  throw new Error(last)
}
const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']

/** where the car is and which way it is going (degrees): the tiles nearest it, and ahead of it, are downloaded first */
const aim = { lat: 0, lon: 0, dLat: 0, dLon: 0 }
function nextTile(): string | undefined {
  if (!queue.length) return undefined
  let best = 0, bs = Infinity
  queue.forEach((k, n) => {
    const [i, j] = k.split(',').map(Number)
    const dLat = (i + 0.5) * TILE - aim.lat, dLon = ((j + 0.5) * TILE - aim.lon) * Math.cos((aim.lat * Math.PI) / 180)
    const d = Math.hypot(dLat, dLon), ahead = (dLat * aim.dLat + dLon * aim.dLon) / (d || 1)
    const score = d * (1.4 - 0.6 * ahead) // (a tile ahead counts as nearer than one behind)
    if (score < bs) { bs = score; best = n }
  })
  return queue.splice(best, 1)[0]
}
/** download the queued tiles, two at a time (the public servers ask for no more than that) */
let workers = 0
async function pump() {
  while (workers < 2 && queue.length) void worker()
}
async function worker() {
  workers++
  for (let key = nextTile(); key; key = nextTile()) {
    const s = session
    try {
      const data = await fetchTile(key)
      if (s !== session) continue
      for (const e of data.elements) elements.set(`${e.type}/${(e as { id: number }).id}`, e)
      REAL.tiles.add(key)
      failed.delete(key)
      rebuild()
    } catch (err) {
      if (s !== session) continue
      failed.set(key, performance.now())
      lastErr = err instanceof Error ? err.message : 'Download failed'
    } finally {
      pending.delete(key)
    }
  }
  workers--
  settle()
}
/** once the tiles needed to start are in (and merged), you can drive */
function settle() {
  if (useGame.getState().real.status !== 'loading' || queue.length || pending.size || rebuildT) return
  if (REAL.map) ready()
  else if (failed.size) useGame.setState((st) => ({ real: { ...st.real, status: 'error', msg: lastErr } }))
  else if (REAL.tiles.size) useGame.setState((st) => ({ real: { ...st.real, status: 'error', msg: 'No roads found here: pick a spot on a street' } }))
}
function want(keys: string[]) {
  let added = false
  for (const k of keys) {
    if (REAL.tiles.has(k) || pending.has(k)) continue
    const f = failed.get(k)
    if (f !== undefined && performance.now() - f < 30000) continue // (a failed tile is tried again after half a minute)
    pending.add(k); queue.push(k); added = true
  }
  if (added) void pump()
}

/** turn everything downloaded so far into the drivable map (the origin stays where the drive started, so nothing moves) */
let rebuildT = 0
function rebuild() {
  const p = REAL.place
  if (!p) return
  // (several tiles arriving together are merged once)
  clearTimeout(rebuildT)
  rebuildT = window.setTimeout(() => {
    rebuildT = 0
    const map = convertOsm({ elements: [...elements.values()] }, p.lat, p.lon, p)
    if (map.edges.length) {
      REAL.map = map
      useGame.setState((st) => ({ real: { ...st.real, version: st.real.version + 1, msg: summary(map) } }))
    }
    settle()
  }, 60)
}
const summary = (m: RealMap) => `${m.stats.km.toFixed(1)} km of road · ${m.stats.stopsFromMap + m.stats.stopsGuessed} stop signs (${m.stats.stopsGuessed} worked out) · ${m.buildings.length} buildings`
function ready() {
  const m = REAL.map
  if (!m) return
  useGame.setState((st) => ({ real: { ...st.real, status: 'ready', msg: summary(m) } }))
}

/** Open a place: the tiles round it are downloaded (or taken from the browser's copy); you can start once they are in. */
export async function openPlace(p: Place) {
  session++
  clearTimeout(rebuildT); rebuildT = 0
  queue.length = 0
  pending.clear()
  failed.clear()
  elements.clear()
  REAL.tiles.clear()
  REAL.map = null
  REAL.place = p
  try { localStorage.setItem(PLACE_KEY, JSON.stringify(p)) } catch { /* ignore */ }
  useGame.setState((st) => ({ real: { ...st.real, status: 'loading', msg: 'Downloading the roads…', label: p.label, version: st.real.version + 1 } }))
  Object.assign(aim, { lat: p.lat, lon: p.lon, dLat: 0, dLon: 0 })
  want(tilesAround(p.lat, p.lon, START_RADIUS))
}

/** While driving: keep the map loaded round the car (called every second or so). */
export function keepLoadedAround(x: number, z: number, h: number) {
  const m = REAL.map
  if (!m) return
  const { lat, lon } = toLatLon(m, x, z)
  Object.assign(aim, { lat, lon, dLat: Math.cos(h), dLon: -Math.sin(h) }) // (heading h: forward is (-sin h, -cos h) in x / z; north is -z)
  want(tilesAround(lat, lon, DRIVE_RADIUS))
}
/** are the tiles under this point loaded? (if not, the road there simply has not arrived yet) */
export function loadedAt(x: number, z: number) {
  const m = REAL.map
  if (!m) return false
  const { lat, lon } = toLatLon(m, x, z)
  return REAL.tiles.has(tileKey(Math.floor(lat / TILE), Math.floor(lon / TILE)))
}
/** the tiles loaded so far, as boxes in metres (for drawing the map and placing scenery) */
export function tileBoxes(): Array<{ key: string; x0: number; x1: number; z0: number; z1: number }> {
  const m = REAL.map
  if (!m) return []
  return [...REAL.tiles].map((key) => {
    const [i, j] = key.split(',').map(Number)
    const x0 = (j * TILE - m.lon0) * m.kx, x1 = ((j + 1) * TILE - m.lon0) * m.kx
    const z1 = -(i * TILE - m.lat0) * m.kz, z0 = -((i + 1) * TILE - m.lat0) * m.kz
    return { key, x0, x1, z0, z1 }
  })
}

if (typeof window !== 'undefined') Object.assign(window, { __real: REAL }) // (for debugging in the console)
