/**
 * Real places: finding a place and downloading its roads, using OpenStreetMap's free public services (Nominatim for the address
 * search, Overpass for the map data).
 *
 * The world is cut into tiles of 0.01 x 0.01 degrees (about 1.1 x 0.9 km in the US). Only the roads are downloaded (no buildings).
 * The tile with the starting point is all that is needed to start driving; while you drive, the tile the car is heading into is
 * downloaded in the background (see `keepLoadedAround`), and only the 4 tiles nearest the car are kept in memory: the furthest one is
 * dropped when a new one arrives. Small tiles are also kept in the browser for a while (see below), so going back to one needs no
 * download; anything else is downloaded again when needed.
 */
import { useGame } from '../game/store'
import { hasMapillary, parse, seenIn, type Seen } from './mapillary'
import { convertOsm, toLatLon, type OsmData, type RealMap } from './roads'

export interface Place { label: string; lat: number; lon: number }

/** the place being driven: its map (all the tiles loaded so far), the start, and which tiles are loaded */
export const REAL: { map: RealMap | null; place: Place | null; tiles: Set<string> } = { map: null, place: null, tiles: new Set() }

const TILE = 0.01 // degrees
/** how many tiles are kept in memory at once */
const MAX_TILES = 4
/** while driving: how far ahead (m) the map must be there (the tiles under these points are downloaded first and never dropped) */
const LOOK_AHEAD = [250, 500]

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
/**
 * Only small things are kept in the browser: a tile is saved only if it is small (a tile of roads is usually 30-100 KB), at most
 * CACHE_TILES of them (the oldest go first), and only for a week, so changes made to OpenStreetMap (new lanes, lights...) come
 * through. Anything else is simply downloaded again when it is needed.
 */
const CACHE_MAX_BYTES = 100_000
const CACHE_TILES = 30
const CACHE_DAYS = 7
interface Saved { t: number; text: string }
let dbP: Promise<IDBDatabase | null> | null = null
function db(): Promise<IDBDatabase | null> {
  if (!dbP) {
    dbP = new Promise((res) => {
      try {
        // version 2: the earlier copies (whole areas, with buildings: much bigger) are thrown away
        const rq = indexedDB.open('driveme-real', 2)
        rq.onupgradeneeded = () => {
          if (rq.result.objectStoreNames.contains('tiles')) rq.result.deleteObjectStore('tiles')
          rq.result.createObjectStore('tiles')
        }
        rq.onsuccess = () => res(rq.result)
        rq.onerror = () => res(null)
      } catch { res(null) }
    })
    // (the first version kept whole areas in localStorage: free that space)
    try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k?.startsWith('driveme.realArea.')) localStorage.removeItem(k) } } catch { /* ignore */ }
  }
  return dbP
}
const fresh = (v: unknown): v is Saved => !!v && typeof (v as Saved).text === 'string' && Date.now() - (v as Saved).t < CACHE_DAYS * 864e5
async function cacheGet(key: string): Promise<string | null> {
  const d = await db()
  if (!d) return null
  return new Promise((res) => {
    try {
      const rq = d.transaction('tiles').objectStore('tiles').get(key)
      rq.onsuccess = () => res(fresh(rq.result) ? rq.result.text : null)
      rq.onerror = () => res(null)
    } catch { res(null) }
  })
}
async function cachePut(key: string, text: string) {
  if (text.length > CACHE_MAX_BYTES) return // (too big to keep: downloaded again when needed)
  const d = await db()
  if (!d) return
  try {
    const st = d.transaction('tiles', 'readwrite').objectStore('tiles')
    st.put({ t: Date.now(), text } satisfies Saved, key)
    // keep only the newest few (and nothing out of date)
    const all: Array<{ k: IDBValidKey; t: number }> = []
    const cur = st.openCursor()
    cur.onsuccess = () => {
      const c = cur.result
      if (c) { const v = c.value as Saved; if (!fresh(v)) c.delete(); else all.push({ k: c.key, t: v.t }); c.continue(); return }
      all.sort((a, b) => b.t - a.t).slice(CACHE_TILES).forEach(({ k }) => st.delete(k))
    }
  } catch { /* storage full or unavailable: nothing is kept */ }
}
if (typeof window !== 'undefined') void db() // (open it now: this also clears out the old, bigger copies)

/* ---------------- tiles ---------------- */
const tileKey = (i: number, j: number) => `${i},${j}`
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
out body qt;`
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
      // (a request that hangs is given up after 30 s, so it never holds up the tiles behind it)
      const ac = new AbortController(), to = setTimeout(() => ac.abort(), 30000)
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: tileQuery(key) }), signal: ac.signal }).finally(() => clearTimeout(to))
      if (!r.ok) { last = r.status === 429 || r.status === 504 ? 'The map server is busy: try again in a minute' : `Download failed (${r.status})`; continue }
      const text = await r.text()
      const data = JSON.parse(text) as OsmData
      void cachePut(key, text)
      return data
    } catch { last = 'Could not reach the map server' }
  }
  throw new Error(last)
}
/** public OpenStreetMap data servers, tried in turn when one is busy or down */
const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']

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
/** traffic lights and signs Mapillary has seen in a tile (from the browser's copy if it has a recent one) */
async function fetchSeen(key: string): Promise<Seen[]> {
  if (!hasMapillary()) return []
  const cached = await cacheGet(`mly:${key}`)
  if (cached) return parse(cached)
  const [i, j] = key.split(',').map(Number)
  const got = await seenIn(i * TILE, j * TILE, (i + 1) * TILE, (j + 1) * TILE)
  if (!got) return []
  void cachePut(`mly:${key}`, got.text)
  return got.list
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
      // the roads, and what street photos show there (lights and signs: optional, nothing lost if it is not there)
      const [data, seen] = await Promise.all([fetchTile(key), fetchSeen(key)])
      if (s !== session) continue
      addTile(key, { elements: [...data.elements, ...seen] })
      failed.delete(key)
      evict()
      rebuild()
      // (before the drive: how far the download has got)
      if (useGame.getState().real.status === 'loading') {
        const got = startTiles.filter((k) => REAL.tiles.has(k)).length
        useGame.setState((st) => ({ real: { ...st.real, msg: `Downloading the roads… ${got} of ${startTiles.length} map tiles` } }))
      }
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
const summary = (m: RealMap) => {
  const s = m.stats
  const photos = hasMapillary()
  return `${s.km.toFixed(1)} km of road · lane counts: ${Math.round(s.lanesTagged * 100)}% from the map, the rest estimated` +
    ` · ${s.signals} traffic light junctions (${s.signalsFromMap} from the map${photos ? `, ${s.signalsFromPhotos} from street photos` : ''}, ${s.signals - s.signalsFromMap - s.signalsFromPhotos} estimated)` +
    ` · ${s.stopsFromMap + s.stopsFromPhotos + s.stopsGuessed} stop signs (${s.stopsFromMap} from the map${photos ? `, ${s.stopsFromPhotos} from street photos` : ''}, ${s.stopsGuessed} estimated)` +
    (photos ? ` · speed limits: ${Math.round((s.limitsTagged + s.limitsPhoto) * 100)}% from the map and street photos` : '')
}
function ready() {
  const m = REAL.map
  if (!m) return
  useGame.setState((st) => ({ real: { ...st.real, status: 'ready', msg: summary(m) } }))
}

/** Open a place: the tiles round it are downloaded (or taken from the browser's copy); you can start once they are in. */
export async function openPlace(p: Place) {
  forget()
  REAL.place = p
  try { localStorage.setItem(PLACE_KEY, JSON.stringify(p)) } catch { /* ignore */ }
  startTiles = [tileOf(p.lat, p.lon)]
  keep = startTiles
  useGame.setState((st) => ({ real: { ...st.real, status: 'loading', msg: `Downloading the roads… 0 of ${startTiles.length} map tiles`, label: p.label, version: st.real.version + 1 } }))
  Object.assign(aim, { lat: p.lat, lon: p.lon, dLat: 0, dLon: 0 })
  want(startTiles)
}
/** the tiles needed before the drive can start */
let startTiles: string[] = []
/** drop the place being opened (or driven): downloads still under way are ignored when they arrive */
function forget() {
  session++
  clearTimeout(rebuildT); rebuildT = 0
  queue.length = 0
  pending.clear()
  failed.clear()
  elements.clear()
  tileItems.clear()
  refs.clear()
  keep = []
  REAL.tiles.clear()
  REAL.map = null
  REAL.place = null
}
/** Cancel: stop downloading and forget the place (the tiles already downloaded stay in the browser's copy). */
export function cancelPlace() {
  forget()
  useGame.setState((st) => ({ real: { ...st.real, status: 'idle', msg: '', label: '', version: st.real.version + 1 } }))
}

/**
 * While driving (every second or so): the tile the car is on and the tile(s) it is heading into must be there. "Ahead" is the way the
 * car is pointing, or, on a route, the route itself (`ahead`: the points 250 and 500 m further along it).
 */
export function keepLoadedAround(x: number, z: number, h: number, ahead?: Array<{ lat: number; lon: number }>) {
  const m = REAL.map
  if (!m) return
  const { lat, lon } = toLatLon(m, x, z)
  Object.assign(aim, { lat, lon, dLat: Math.cos(h), dLon: -Math.sin(h) }) // (heading h: forward is (-sin h, -cos h) in x / z; north is -z)
  const pts = ahead?.length ? ahead : LOOK_AHEAD.map((d) => toLatLon(m, x - Math.sin(h) * d, z - Math.cos(h) * d))
  keep = [...new Set([tileOf(lat, lon), ...pts.map((p) => tileOf(p.lat, p.lon))])]
  // tiles queued earlier that the car no longer needs (it has moved on, or turned) are dropped from the queue
  for (let n = queue.length - 1; n >= 0; n--) if (!keep.includes(queue[n])) { pending.delete(queue[n]); queue.splice(n, 1) }
  want(keep)
}

/* ---------------- tiles in memory ---------------- */
const tileOf = (lat: number, lon: number) => tileKey(Math.floor(lat / TILE), Math.floor(lon / TILE))
/** the tiles needed right now (never dropped) */
let keep: string[] = []
/** which map items each tile brought, and how many loaded tiles share each item (a road crossing a tile edge is in both) */
const tileItems = new Map<string, string[]>()
const refs = new Map<string, number>()
function addTile(key: string, data: OsmData) {
  const items: string[] = []
  for (const e of data.elements) {
    if (e.type === 'way' && (e as { tags?: Record<string, string> }).tags?.building) continue // (no buildings: tiles saved by an older version had them)
    const k = `${e.type}/${(e as { id: number }).id}`
    items.push(k)
    elements.set(k, e)
    refs.set(k, (refs.get(k) ?? 0) + 1)
  }
  tileItems.set(key, items)
  REAL.tiles.add(key)
}
/** more than MAX_TILES in memory: drop the ones furthest from the car (not the ones it is on or heading into) */
function evict() {
  while (REAL.tiles.size > MAX_TILES) {
    let worst = '', wd = -1
    for (const k of REAL.tiles) {
      if (keep.includes(k)) continue
      const [i, j] = k.split(',').map(Number)
      const d = Math.hypot((i + 0.5) * TILE - aim.lat, ((j + 0.5) * TILE - aim.lon) * Math.cos((aim.lat * Math.PI) / 180))
      if (d > wd) { wd = d; worst = k }
    }
    if (!worst) return
    for (const k of tileItems.get(worst) ?? []) {
      const n = (refs.get(k) ?? 1) - 1
      if (n <= 0) { refs.delete(k); elements.delete(k) } else refs.set(k, n)
    }
    tileItems.delete(worst)
    REAL.tiles.delete(worst)
  }
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
