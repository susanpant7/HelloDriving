/**
 * Real places: driving from A to B. The route is planned by OSRM (an open-source route planner running on OpenStreetMap data;
 * its free public server), because the destination can be far beyond the roads downloaded so far. The game then follows your
 * progress along it: the next instruction and its distance for the banner, the map tiles along the route to download next,
 * a new route if you leave it, and your arrival.
 */
import { useGame } from '../game/store'
import { REAL, type Place } from './load'

export interface RouteStep {
  /** distance along the route where it happens (m) */
  s: number
  /** banner icon (see drawIcon) and words */
  icon: string
  text: string
  /** the road it leads onto */
  name: string
}
export interface Route {
  /** the route's line (degrees) and the distance along it at each point (m) */
  coords: Array<[number, number]>
  cum: number[]
  len: number
  duration: number
  steps: RouteStep[]
}

export const ROUTE = {
  dest: null as Place | null,
  route: null as Route | null,
  /** progress: distance along the route, the stretch of it you are on, how long you have been away from it */
  s: 0,
  seg: 0,
  offT: 0,
  rerouting: false,
  arrived: false,
  /** the route's line in game metres (for the origin of the current map) */
  xy: null as null | { key: string; pts: number[] },
}

const DEST_KEY = 'driveme.realDest'
export function savedDest(): Place | null {
  try {
    const v = JSON.parse(localStorage.getItem(DEST_KEY) || 'null')
    return v && typeof v.lat === 'number' && typeof v.lon === 'number' ? v : null
  } catch { return null }
}
ROUTE.dest = savedDest()

const setStatus = (status: 'none' | 'loading' | 'ready' | 'error', msg = '') =>
  useGame.setState((st) => ({ route: { status, msg, dest: ROUTE.dest?.label ?? '', version: st.route.version + 1 } }))

/** Set (or clear) the destination, and plan the route to it from the start. */
export function setDestination(p: Place | null) {
  ROUTE.dest = p
  try { if (p) localStorage.setItem(DEST_KEY, JSON.stringify(p)); else localStorage.removeItem(DEST_KEY) } catch { /* ignore */ }
  void planRoute()
}

let planId = 0
/** plan the route from the start (the chosen place) to the destination */
export async function planRoute() {
  const id = ++planId
  ROUTE.route = null; ROUTE.xy = null
  const a = REAL.place, b = ROUTE.dest
  if (!a || !b) { setStatus('none'); return }
  setStatus('loading', 'Planning the route…')
  try {
    const r = await osrm(a, b)
    if (id !== planId) return
    ROUTE.route = r
    resetProgress()
    setStatus('ready', routeSummary(r))
  } catch (e) {
    if (id !== planId) return
    setStatus('error', e instanceof Error ? e.message : 'Could not plan a route')
  }
}
export function resetProgress() {
  Object.assign(ROUTE, { s: 0, seg: 0, offT: 0, rerouting: false, arrived: false, xy: null })
}
export function routeSummary(r: Route) {
  const mi = r.len / 1609.34
  return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi (${(r.len / 1000).toFixed(1)} km) · about ${Math.max(1, Math.round(r.duration / 60))} min`
}

/* ---------------- the route planner ---------------- */
const ord = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`
interface OsrmStep { distance: number; name: string; ref?: string; maneuver: { type: string; modifier?: string; exit?: number } }

/** one OSRM step -> what the banner says (null: nothing to say, e.g. leaving a roundabout) */
function describe(st: OsrmStep): { icon: string; text: string } | null {
  const { type, modifier: mod = 'straight', exit } = st.maneuver
  const lr = mod.includes('left') ? 'left' : mod.includes('right') ? 'right' : ''
  const icon = mod === 'uturn' ? 'U' : lr === 'left' ? 'L' : lr === 'right' ? 'R' : 'S'
  const how = mod.replace('slight ', 'slightly ').replace('sharp ', 'sharply ')
  switch (type) {
    case 'depart': case 'exit roundabout': case 'exit rotary': case 'notification': return null
    case 'arrive': return { icon: 'F', text: lr ? `Your destination is on the ${lr}` : 'You are arriving' }
    case 'turn': case 'roundabout turn': return mod === 'uturn' ? { icon, text: 'Make a U-turn' } : mod === 'straight' ? { icon, text: 'Go straight on' } : { icon, text: `Turn ${how}` }
    case 'end of road': return { icon, text: `At the end of the road, turn ${lr || how}` }
    case 'fork': return { icon, text: `Keep ${lr || 'straight on'} at the fork` }
    case 'merge': return { icon: 'M', text: `Merge ${lr ? `to the ${lr}` : ''}`.trim() }
    case 'on ramp': return { icon, text: `Take the ramp${lr ? ` on the ${lr}` : ''}` }
    case 'off ramp': return { icon, text: `Take the exit${lr ? ` on the ${lr}` : ''}` }
    case 'roundabout': case 'rotary': return { icon: `O${Math.min(4, Math.max(1, exit ?? 1))}`, text: `At the roundabout, take the ${ord(exit ?? 1)} exit` }
    case 'new name': return mod === 'straight' ? { icon: 'S', text: 'Continue' } : { icon, text: `Bear ${lr || how}` }
    case 'continue': return mod === 'uturn' ? { icon, text: 'Make a U-turn' } : mod === 'straight' ? { icon, text: 'Continue straight on' } : { icon, text: `Keep ${lr || how}` }
    default: return lr ? { icon, text: `Turn ${how}` } : null
  }
}

async function osrm(a: { lat: number; lon: number }, b: { lat: number; lon: number }, bearing?: number): Promise<Route> {
  const u = new URL(`https://router.project-osrm.org/route/v1/driving/${a.lon.toFixed(6)},${a.lat.toFixed(6)};${b.lon.toFixed(6)},${b.lat.toFixed(6)}`)
  u.searchParams.set('overview', 'full'); u.searchParams.set('geometries', 'geojson'); u.searchParams.set('steps', 'true')
  // (when re-planning on the move: leave in the direction you are driving)
  if (bearing !== undefined) u.searchParams.set('bearings', `${Math.round(((bearing % 360) + 360) % 360)},60;`)
  const r = await fetch(u)
  if (!r.ok) throw new Error(r.status === 429 ? 'The route planner is busy: try again in a minute' : `Route planning failed (${r.status})`)
  const d = await r.json()
  if (d.code !== 'Ok' || !d.routes?.length) throw new Error(d.code === 'NoRoute' ? 'No route by road between these places' : 'Could not plan a route')
  const rt = d.routes[0]
  const coords: Array<[number, number]> = rt.geometry.coordinates.map(([lon, lat]: [number, number]) => [lat, lon])
  const cum = [0]
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + metres(coords[i - 1], coords[i]))
  const len = cum[cum.length - 1]
  // the steps, placed along the line by their distances (scaled to the line's own length)
  const raw: OsrmStep[] = rt.legs[0].steps
  const total = raw.reduce((t, st) => t + st.distance, 0) || 1
  const steps: RouteStep[] = []
  let s = 0
  for (const st of raw) {
    const say = describe(st)
    if (say) steps.push({ s: (s / total) * len, ...say, name: st.name || st.ref || '' })
    s += st.distance
  }
  return { coords, cum, len, duration: rt.duration, steps }
}
function metres(p: [number, number], q: [number, number]) {
  const kx = 111320 * Math.cos((p[0] * Math.PI) / 180)
  return Math.hypot((q[1] - p[1]) * kx, (q[0] - p[0]) * 110540)
}

/* ---------------- following the route while driving ---------------- */
/** the route in game metres (x east, z south), for the current map's origin */
export function routeXY(): number[] | null {
  const m = REAL.map, r = ROUTE.route
  if (!m || !r) return null
  const key = `${m.lat0},${m.lon0},${r.len}`
  if (ROUTE.xy?.key === key) return ROUTE.xy.pts
  const pts: number[] = []
  for (const [lat, lon] of r.coords) pts.push((lon - m.lon0) * m.kx, -(lat - m.lat0) * m.kz)
  ROUTE.xy = { key, pts }
  return pts
}
/** the point (degrees) s metres along the route */
export function routeAt(s: number): { lat: number; lon: number } | null {
  const r = ROUTE.route
  if (!r) return null
  s = Math.max(0, Math.min(r.len, s))
  let k = 1
  while (k < r.cum.length - 1 && r.cum[k] < s) k++
  const t = (s - r.cum[k - 1]) / (r.cum[k] - r.cum[k - 1] || 1)
  const [a, b] = [r.coords[k - 1], r.coords[k]]
  return { lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t }
}
/** where to start: the route's first point and the way it leaves (game metres, heading) */
export function routeStart(): { x: number; z: number; h: number } | null {
  const p = routeXY()
  if (!p || p.length < 4) return null
  // (the way it goes over its first 15 m or so: skips tiny kinks where it joins the road)
  let k = 2
  while (k + 2 < p.length && Math.hypot(p[k] - p[0], p[k + 1] - p[1]) < 15) k += 2
  return { x: p[0], z: p[1], h: Math.atan2(-(p[k] - p[0]), -(p[k + 1] - p[1])) }
}

export interface RouteNow { text: string; sub: string; icon: string; dist: number; event: null | 'arrived' | 'rerouting' | 'rerouted' | 'reroute-failed' }
/**
 * Where you are on the route (call every frame while driving): the next instruction and how far it is. Leaving the route for a few
 * seconds plans a new one from where you are, setting off the way you are driving.
 */
export function followRoute(x: number, z: number, h: number, speed: number, dt: number): RouteNow | null {
  const r = ROUTE.route, p = routeXY()
  if (!r || !p) return null
  if (ROUTE.arrived) return { text: 'You have arrived', sub: ROUTE.dest ? short(ROUTE.dest.label) : '', icon: 'F', dist: 0, event: null }
  // the nearest point of the route, looking a little back and well ahead of where you were on it
  const n = p.length / 2
  let bd = Infinity, bs = ROUTE.s, bk = ROUTE.seg
  for (let k = Math.max(0, ROUTE.seg - 4); k < Math.min(n - 1, ROUTE.seg + 80); k++) {
    const ax = p[k * 2], az = p[k * 2 + 1], dx = p[k * 2 + 2] - ax, dz = p[k * 2 + 3] - az
    const L2 = dx * dx + dz * dz || 1
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2))
    const d = Math.hypot(x - ax - dx * t, z - az - dz * t)
    if (d < bd - 0.5) { bd = d; bk = k; bs = r.cum[k] + t * (r.cum[k + 1] - r.cum[k]) }
  }
  let event: RouteNow['event'] = null
  if (bd < 30) { ROUTE.offT = 0; ROUTE.seg = bk; ROUTE.s = bs }
  else if (speed > 1.5 && !ROUTE.rerouting && (ROUTE.offT += dt) > 3) { ROUTE.offT = 0; event = 'rerouting'; void reroute(x, z, h) }
  // arrived?
  if (r.len - ROUTE.s < 18 && bd < 30) { ROUTE.arrived = true; return { text: 'You have arrived', sub: ROUTE.dest ? short(ROUTE.dest.label) : '', icon: 'F', dist: 0, event: 'arrived' } }
  if (rerouteNote) { event = rerouteNote; rerouteNote = null }
  const next = r.steps.find((st) => st.s > ROUTE.s + 4)
  if (!next) return { text: 'Continue to your destination', sub: '', icon: 'S', dist: r.len - ROUTE.s, event }
  return { text: next.text, sub: next.icon === 'F' ? (ROUTE.dest ? short(ROUTE.dest.label) : '') : next.name ? `onto ${next.name}` : '', icon: next.icon, dist: next.s - ROUTE.s, event }
}
let rerouteNote: RouteNow['event'] = null
async function reroute(x: number, z: number, h: number) {
  const m = REAL.map, b = ROUTE.dest
  if (!m || !b) return
  ROUTE.rerouting = true
  try {
    const from = { lat: m.lat0 - z / m.kz, lon: m.lon0 + x / m.kx }
    const bearing = (Math.atan2(-Math.sin(h), Math.cos(h)) * 180) / Math.PI // (compass: 0 north, 90 east; forward is (-sin h, -cos h) in x / z)
    const r = await osrm(from, b, bearing)
    ROUTE.route = r
    resetProgress()
    rerouteNote = 'rerouted'
    useGame.setState((st) => ({ route: { ...st.route, msg: routeSummary(r), version: st.route.version + 1 } }))
  } catch {
    rerouteNote = 'reroute-failed'
  } finally {
    ROUTE.rerouting = false
  }
}
const short = (label: string) => label.split(',').slice(0, 2).join(',').trim()

if (typeof window !== 'undefined') Object.assign(window, { __route: ROUTE, __routeXY: routeXY }) // (for debugging in the console)
