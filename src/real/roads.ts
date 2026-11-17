/**
 * Real places: a road map built from OpenStreetMap data (© OpenStreetMap contributors, ODbL).
 *
 * The raw map data (roads as lists of points with tags) becomes a graph the game can drive on:
 *  - junctions (nodes) where roads meet, and the roads between them (edges) as curved centre-lines, in metres
 *  - for each road: how many lanes each way (a centre turn lane where there is an odd number), lane width, speed limit, name
 *  - for each junction: how it is controlled. OSM rarely records stop signs, so where it says nothing they are worked out the
 *    way US towns place them: the smaller road stops for the bigger one; where equal streets meet, the street that ends at a
 *    T stops, and a crossroads of equal streets is an all-way stop.
 *
 * Coordinates: x east, z south (so north is -z), metres from the centre of the area. No dependencies: this file also runs in Node
 * (for testing the conversion on saved data).
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type RoadClass =
  | 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'unclassified' | 'residential' | 'living_street' | 'service'
  | 'motorway_link' | 'trunk_link' | 'primary_link' | 'secondary_link' | 'tertiary_link'

export interface Edge {
  id: number
  /** junction ids at the start and the end of the centre-line */
  a: number
  b: number
  /** the centre-line, x / z pairs (metres) */
  pts: number[]
  name: string
  cls: RoadClass
  /** one-way: traffic only goes from a to b */
  oneway: boolean
  /** lanes going a -> b (forward) and b -> a (backward); a centre two-way left-turn lane between them */
  lanesF: number
  lanesB: number
  centre: number
  laneW: number
  /** paved width beyond the outer lanes (gutter / shoulder), each side */
  shoulder: number
  /** speed limit, m/s; `limitTagged`: from the map (otherwise the usual limit for this kind of road) */
  limit: number
  limitTagged: boolean
  /** the lane count is from the map (otherwise the usual for this kind of road) */
  lanesTagged: boolean
  /** part of a roundabout's ring */
  ring: boolean
  /** cumulative length at each point, and the total */
  cum: number[]
  len: number
}

export type Control = 'none' | 'stop' | 'yield' | 'signal'

export interface Junction {
  id: number
  x: number
  z: number
  /** the edges that meet here: edge index and which end (true = its a end) */
  ends: Array<{ e: number; atA: boolean }>
  /** how far from the centre the junction's own surface reaches (m): markings stop here, stop lines sit just outside it */
  r: number
  /** a cul-de-sac's turning circle (radius, m), or 0 */
  bulb: number
  /** the widest road's half width here (the round patch drawn at a bend or a dead end) */
  r0: number
  /** how each arriving road is controlled, by edge index (only roads that can arrive here) */
  ctl: Map<number, Control>
  /** all-way stop */
  allWay: boolean
  /** how it was decided: from the map, or worked out */
  ctlFromMap: boolean
}

export interface RealMap {
  /** the fixed origin of the coordinates (degrees: where the drive started), and metres per degree of longitude / latitude there */
  lat0: number
  lon0: number
  kx: number
  kz: number
  junctions: Junction[]
  edges: Edge[]
  /** building outlines (x / z pairs) and heights (m) */
  buildings: Array<{ pts: number[]; h: number }>
  /** where the place you searched for is (m) */
  focus: { x: number; z: number }
  /** a short summary of how complete the map data is */
  stats: { roads: number; km: number; lanesTagged: number; limitsTagged: number; stopsFromMap: number; stopsGuessed: number; signals: number }
  /** spatial index: cell -> [edge, segment] pairs */
  grid: Map<number, number[]>
}

/* ------------------------------------------------------------------ */
/* Road kinds: defaults where the map says nothing                     */
/* ------------------------------------------------------------------ */

const MPH = 0.44704
/** usual US speed limits (mph) by kind of road, when the map has none */
const DEFAULT_MPH: Record<RoadClass, number> = {
  motorway: 70, trunk: 55, primary: 45, secondary: 45, tertiary: 35, unclassified: 30, residential: 30, living_street: 15, service: 15,
  motorway_link: 45, trunk_link: 40, primary_link: 35, secondary_link: 35, tertiary_link: 30,
}
/** how important a road is (who gives way to whom) */
const RANK: Record<RoadClass, number> = {
  motorway: 9, trunk: 8, primary: 7, secondary: 6, tertiary: 5, unclassified: 3, residential: 3, living_street: 2, service: 1,
  motorway_link: 8, trunk_link: 7, primary_link: 6, secondary_link: 5, tertiary_link: 4,
}
export const DRIVABLE = new Set<string>(Object.keys(RANK))
const isLink = (c: RoadClass) => c.endsWith('_link')
const isMain = (c: RoadClass) => RANK[c] >= 5 && !isLink(c)

/** lanes each way when the map does not say (two-way road / one-way road) */
function defaultLanes(c: RoadClass, oneway: boolean): number {
  if (c === 'motorway') return oneway ? 2 : 2
  if (c === 'trunk' || c === 'primary') return oneway ? 2 : 2
  if (c === 'secondary') return oneway ? 2 : 1
  return 1
}
/** lane width: wide suburban streets (cars park at the kerb), standard elsewhere */
function laneWidth(c: RoadClass, lanesEachWay: number): number {
  if (c === 'service') return 3.0
  if (c === 'living_street') return 3.2
  if ((c === 'residential' || c === 'unclassified') && lanesEachWay <= 1) return 4.3 // (a 30-31 ft kerb-to-kerb street: one lane each way plus room to park)
  if (c === 'motorway' || c === 'trunk') return 3.7
  return 3.5
}
function shoulderOf(c: RoadClass): number {
  if (c === 'motorway' || c === 'trunk') return 2.4
  if (isLink(c)) return 1.2
  if (isMain(c)) return 0.6
  return 0.3
}
/** "45 mph", "50", "signals"... -> m/s (numbers alone are km/h, as OSM defines them) */
function parseLimit(v: string | undefined): number | null {
  if (!v) return null
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?/i.exec(v)
  if (!m) return null
  const n = Number(m[1])
  return m[2] && m[2].toLowerCase() === 'mph' ? n * MPH : n / 3.6
}

/* ------------------------------------------------------------------ */
/* Conversion                                                          */
/* ------------------------------------------------------------------ */

interface OsmNode { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }
interface OsmWay { type: 'way'; id: number; nodes: number[]; tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }> }
export interface OsmData { elements: Array<OsmNode | OsmWay | { type: string }> }

const CELL = 32

/** Turn Overpass data into a drivable map. `lat0` / `lon0`: the origin of the coordinates; `focus`: the place chosen. */
export function convertOsm(data: OsmData, lat0: number, lon0: number, focus?: { lat: number; lon: number }): RealMap {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), kz = 110540
  const X = (lon: number) => (lon - lon0) * kx
  const Z = (lat: number) => -(lat - lat0) * kz
  const nodes = new Map<number, OsmNode>()
  const ways: OsmWay[] = []
  const bWays: OsmWay[] = []
  for (const e of data.elements) {
    if (e.type === 'node') nodes.set((e as OsmNode).id, e as OsmNode)
    else if (e.type === 'way') {
      const w = e as OsmWay
      const t = w.tags ?? {}
      if (t.building) bWays.push(w)
      else if (t.highway && DRIVABLE.has(t.highway) && t.area !== 'yes' && t.access !== 'no' && t.service !== 'driveway' && t.service !== 'parking_aisle' && t.service !== 'drive-through') ways.push(w)
    }
  }

  // ---- junctions: points used by two or more roads (or twice by one), and the ends of every road ----
  const uses = new Map<number, number>()
  for (const w of ways) for (const n of w.nodes) uses.set(n, (uses.get(n) ?? 0) + 1)
  const jIndex = new Map<number, number>()
  const junctions: Junction[] = []
  const jOf = (n: number) => {
    let k = jIndex.get(n)
    if (k === undefined) {
      const o = nodes.get(n)!
      k = junctions.length
      jIndex.set(n, k)
      junctions.push({ id: k, x: X(o.lon), z: Z(o.lat), ends: [], r: 0, r0: 0, bulb: 0, ctl: new Map(), allWay: false, ctlFromMap: false })
    }
    return k
  }

  // ---- roads: each way cut at its junctions ----
  const edges: Edge[] = []
  /** which edge (and its points) each OSM point ended up in: for placing signs recorded on the map */
  const nodeEdge = new Map<number, { e: number; i: number }>()
  for (const w of ways) {
    const t = w.tags ?? {}
    const cls = t.highway as RoadClass
    let list = w.nodes.filter((n) => nodes.has(n))
    if (list.length < 2) continue
    let oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true' || t.junction === 'roundabout' || t.junction === 'circular' || ((cls === 'motorway' || cls === 'motorway_link') && t.oneway !== 'no')
    if (t.oneway === '-1') { list = list.slice().reverse(); oneway = true }
    // lanes each way
    const lanes = Number(t.lanes) || 0
    let lf: number, lb: number, centre = 0
    if (oneway) { lf = lanes || defaultLanes(cls, true); lb = 0 }
    else {
      const f = Number(t['lanes:forward']) || 0, b = Number(t['lanes:backward']) || 0
      if (f || b) { lf = f || Math.max(1, lanes - b); lb = b || Math.max(1, lanes - f); centre = lanes > lf + lb ? 1 : 0 }
      else if (lanes) { lf = lb = Math.max(1, Math.floor(lanes / 2)); centre = lanes >= 3 && lanes % 2 === 1 ? 1 : 0 }
      else { lf = lb = defaultLanes(cls, false) }
      if (t['lanes:both_ways']) centre = 1
    }
    lf = Math.min(lf, 6); lb = Math.min(lb, 6)
    const lw = laneWidth(cls, Math.max(lf, lb))
    const tagged = parseLimit(t.maxspeed)
    const base = { ring: t.junction === 'roundabout' || t.junction === 'circular', lanesTagged: lanes > 0 || !!t['lanes:forward'], name: t.name ?? t.ref ?? '', cls, oneway, lanesF: lf, lanesB: lb, centre, laneW: lw, shoulder: shoulderOf(cls), limit: tagged ?? DEFAULT_MPH[cls] * MPH, limitTagged: tagged !== null }
    let start = 0
    for (let i = 1; i < list.length; i++) {
      if (i < list.length - 1 && (uses.get(list[i]) ?? 0) < 2) continue // (not a junction: the road carries on)
      const seg = list.slice(start, i + 1)
      const pts: number[] = []
      for (const n of seg) {
        const o = nodes.get(n)!
        const x = X(o.lon), z = Z(o.lat)
        const L = pts.length
        if (L && Math.hypot(x - pts[L - 2], z - pts[L - 1]) < 0.3) continue
        pts.push(x, z)
      }
      if (pts.length >= 4) {
        const e = edges.length
        seg.forEach((n, k) => { if (!nodeEdge.has(n) || (k > 0 && k < seg.length - 1)) nodeEdge.set(n, { e, i: k }) })
        const a = jOf(seg[0]), b = jOf(seg[seg.length - 1])
        const cum = [0]
        for (let k = 2; k < pts.length; k += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]))
        edges.push({ id: e, a, b, pts, cum, len: cum[cum.length - 1], ...base })
        junctions[a].ends.push({ e, atA: true })
        junctions[b].ends.push({ e, atA: false })
      }
      start = i
    }
  }

  // ---- each junction's size: as wide as the widest road meeting there ----
  for (const j of junctions) {
    let r = 0
    for (const { e } of j.ends) r = Math.max(r, halfWidth(edges[e], 1), halfWidth(edges[e], -1))
    j.r0 = r
    j.r = j.ends.length >= 3 ? r + 0.5 : j.ends.length === 2 ? 0 : r
  }

  // ---- what the map records: traffic lights, stop / give-way signs, turning circles ----
  let stopsFromMap = 0, signals = 0
  for (const o of nodes.values()) {
    const h = o.tags?.highway
    if (!h) continue
    const x = X(o.lon), z = Z(o.lat)
    if (h === 'turning_circle' || h === 'turning_loop') {
      const k = jIndex.get(o.id)
      if (k !== undefined && junctions[k].ends.length === 1) junctions[k].bulb = edges[junctions[k].ends[0].e].cls === 'service' ? 9 : 12.5
    } else if (h === 'traffic_signals') {
      // usually tagged on the junction itself, sometimes on each approach just before it
      const j = nearestJunction(junctions, x, z, 30, 3)
      if (j && !j.ctlFromMap) {
        j.ctlFromMap = true; signals++
        for (const { e, atA } of j.ends) if (arrives(edges[e], atA)) j.ctl.set(e, 'signal')
      }
    } else if (h === 'stop' || h === 'give_way') {
      // a sign on a road: it controls that road where it arrives at the nearest junction along it
      const ne = nodeEdge.get(o.id)
      const j = nearestJunction(junctions, x, z, 40, 3)
      if (!j) continue
      if (o.tags?.stop === 'all') {
        j.ctlFromMap = true; j.allWay = true
        for (const { e, atA } of j.ends) if (arrives(edges[e], atA)) j.ctl.set(e, 'stop')
        stopsFromMap++
        continue
      }
      const end = ne ? j.ends.find((q) => q.e === ne.e) : null
      if (end && arrives(edges[end.e], end.atA)) { j.ctl.set(end.e, h === 'stop' ? 'stop' : 'yield'); j.ctlFromMap = true; stopsFromMap++ }
    }
  }

  // ---- the rest: worked out from the kinds of road that meet ----
  let stopsGuessed = 0
  for (const j of junctions) {
    if (j.ends.length < 3) continue
    const arriving = j.ends.filter(({ e, atA }) => arrives(edges[e], atA))
    if (j.ctlFromMap) { for (const q of arriving) if (!j.ctl.has(q.e)) j.ctl.set(q.e, 'none'); continue }
    const cls = j.ends.map(({ e }) => edges[e].cls)
    // a roundabout: traffic on the ring has priority, traffic entering yields
    if (j.ends.some(({ e }) => edges[e].ring)) { for (const q of arriving) j.ctl.set(q.e, edges[q.e].ring ? 'none' : 'yield'); continue }
    // highway merges and splits, and roads joining a highway's slip roads: lanes merge, no signs
    if (cls.every((c) => c === 'motorway' || c === 'motorway_link' || c === 'trunk' || c === 'trunk_link')) { for (const q of arriving) j.ctl.set(q.e, 'none'); continue }
    const top = Math.max(...j.ends.map(({ e }) => RANK[edges[e].cls]))
    const minor = arriving.filter(({ e }) => RANK[edges[e].cls] < top)
    if (minor.length) {
      for (const q of arriving) {
        const c = edges[q.e].cls
        const ctl: Control = RANK[c] < top ? (isLink(c) ? 'yield' : 'stop') : 'none'
        j.ctl.set(q.e, ctl)
        if (ctl === 'stop') stopsGuessed++
      }
      continue
    }
    // streets of the same kind
    if (isMain(edges[j.ends[0].e].cls) && j.ends.length >= 4) {
      // two main roads crossing: such junctions usually have lights (not recorded here); an all-way stop is the safe guess
      j.allWay = true
      for (const q of arriving) { j.ctl.set(q.e, 'stop'); stopsGuessed++ }
      continue
    }
    if (j.ends.length >= 4) {
      j.allWay = true
      for (const q of arriving) { j.ctl.set(q.e, 'stop'); stopsGuessed++ }
      continue
    }
    // a T: the two roads most nearly in line are the through road; the third stops
    let best = -2, through: [number, number] = [0, 1]
    for (let p = 0; p < j.ends.length; p++) for (let q = p + 1; q < j.ends.length; q++) {
      const dp = endDir(edges[j.ends[p].e], j.ends[p].atA), dq = endDir(edges[j.ends[q].e], j.ends[q].atA)
      const straight = -(dp[0] * dq[0] + dp[1] * dq[1]) // 1 = exactly opposite (in line)
      if (straight > best) { best = straight; through = [p, q] }
    }
    j.ends.forEach((q, k) => {
      if (!arrives(edges[q.e], q.atA)) return
      const ctl: Control = k === through[0] || k === through[1] ? 'none' : 'stop'
      j.ctl.set(q.e, ctl)
      if (ctl === 'stop') stopsGuessed++
    })
  }

  // ---- buildings ----
  const buildings: RealMap['buildings'] = []
  for (const w of bWays) {
    const pts: number[] = []
    if (w.geometry) for (const g of w.geometry) pts.push(X(g.lon), Z(g.lat)) // (buildings come with their outline inline)
    else for (const n of w.nodes) { const o = nodes.get(n); if (o) pts.push(X(o.lon), Z(o.lat)) }
    if (pts.length < 8) continue
    if (pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) pts.length -= 2 // (closed ring: drop the repeated point)
    const t = w.tags ?? {}
    const lv = Number(t['building:levels']) || 0
    const h = parseFloat(t.height ?? '') || (lv ? lv * 3.1 + 1 : t.building === 'garage' || t.building === 'shed' ? 3 : t.building === 'house' || t.building === 'detached' || t.building === 'residential' || t.building === 'yes' ? 5 : 7)
    buildings.push({ pts, h })
  }

  // ---- spatial index ----
  const grid = new Map<number, number[]>()
  edges.forEach((e, ei) => {
    for (let k = 0; k + 3 < e.pts.length; k += 2) {
      const x0 = e.pts[k], z0 = e.pts[k + 1], x1 = e.pts[k + 2], z1 = e.pts[k + 3]
      const pad = Math.max(halfWidth(e, 1), halfWidth(e, -1)) + 2
      const cx0 = Math.floor((Math.min(x0, x1) - pad) / CELL), cx1 = Math.floor((Math.max(x0, x1) + pad) / CELL)
      const cz0 = Math.floor((Math.min(z0, z1) - pad) / CELL), cz1 = Math.floor((Math.max(z0, z1) + pad) / CELL)
      for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
        const key = cellKey(cx, cz)
        let l = grid.get(key)
        if (!l) grid.set(key, (l = []))
        l.push(ei, k / 2)
      }
    }
  })

  let km = 0, lanesTaggedLen = 0, limitsTaggedLen = 0
  for (const e of edges) { km += e.len; if (e.limitTagged) limitsTaggedLen += e.len; if (e.lanesTagged) lanesTaggedLen += e.len }
  const f = focus ? { x: X(focus.lon), z: Z(focus.lat) } : { x: 0, z: 0 }
  return {
    lat0, lon0, kx, kz, junctions, edges, buildings, focus: f, grid,
    stats: { roads: edges.length, km: km / 1000, lanesTagged: km ? lanesTaggedLen / km : 0, limitsTagged: km ? limitsTaggedLen / km : 0, stopsFromMap, stopsGuessed, signals },
  }
}

const cellKey = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096)

/** can traffic arrive at this end of the edge? (a one-way road only arrives at its b end) */
export function arrives(e: Edge, atA: boolean) { return !e.oneway || !atA }
/** half the paved width on one side of the centre-line: side +1 = right of a -> b, -1 = left */
export function halfWidth(e: Edge, side: 1 | -1): number {
  if (e.oneway) return (e.lanesF * e.laneW) / 2 + e.shoulder
  const lanes = side === 1 ? e.lanesF : e.lanesB
  return lanes * e.laneW + (e.centre * e.laneW) / 2 + e.shoulder
}
/** unit direction leaving the junction along the edge's first (or last) stretch, sampled a few metres in to skip tiny kinks */
export function endDir(e: Edge, atA: boolean): [number, number] {
  const p = pointAt(e, atA ? Math.min(8, e.len) : Math.max(0, e.len - 8))
  const q = atA ? [e.pts[0], e.pts[1]] : [e.pts[e.pts.length - 2], e.pts[e.pts.length - 1]]
  const dx = p[0] - q[0], dz = p[1] - q[1], L = Math.hypot(dx, dz) || 1
  return [dx / L, dz / L]
}
function nearestJunction(js: Junction[], x: number, z: number, maxD: number, minEnds: number) {
  let best: Junction | null = null, bd = maxD
  for (const j of js) {
    if (j.ends.length < minEnds) continue
    const d = Math.hypot(j.x - x, j.z - z)
    if (d < bd) { bd = d; best = j }
  }
  return best
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

/** the point s metres along an edge, and the unit direction there (a -> b) */
export function pointAt(e: Edge, s: number): [number, number, number, number] {
  s = Math.max(0, Math.min(e.len, s))
  let k = 1
  while (k < e.cum.length - 1 && e.cum[k] < s) k++
  const i = (k - 1) * 2
  const x0 = e.pts[i], z0 = e.pts[i + 1], x1 = e.pts[i + 2], z1 = e.pts[i + 3]
  const L = e.cum[k] - e.cum[k - 1] || 1
  const t = (s - e.cum[k - 1]) / L
  return [x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, (x1 - x0) / L, (z1 - z0) / L]
}

export interface Near {
  e: Edge
  /** distance along the edge (m), the signed distance to the right of a -> b (m), and the direction there */
  s: number
  off: number
  dx: number
  dz: number
  /** the closest point on the centre-line, and how far away it is */
  px: number
  pz: number
  d: number
}
/** the edges near a point, closest first (within `maxD` of the centre-line) */
export function nearEdges(m: RealMap, x: number, z: number, maxD = 30): Near[] {
  const out: Near[] = []
  const seen = new Set<number>()
  const r = Math.ceil(maxD / CELL)
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL)
  const best = new Map<number, Near>()
  for (let ix = cx - r; ix <= cx + r; ix++) for (let iz = cz - r; iz <= cz + r; iz++) {
    const l = m.grid.get(cellKey(ix, iz))
    if (!l) continue
    for (let q = 0; q < l.length; q += 2) {
      const ei = l[q], si = l[q + 1]
      const key = ei * 100000 + si
      if (seen.has(key)) continue
      seen.add(key)
      const e = m.edges[ei]
      const i = si * 2
      const x0 = e.pts[i], z0 = e.pts[i + 1], x1 = e.pts[i + 2], z1 = e.pts[i + 3]
      const dx = x1 - x0, dz = z1 - z0, L2 = dx * dx + dz * dz
      if (L2 < 1e-6) continue
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / L2))
      const px = x0 + dx * t, pz = z0 + dz * t
      const d = Math.hypot(x - px, z - pz)
      if (d > maxD) continue
      const prev = best.get(ei)
      if (prev && prev.d <= d) continue
      const L = Math.sqrt(L2)
      const ux = dx / L, uz = dz / L
      // right of a -> b is (-uz, ux)
      best.set(ei, { e, s: e.cum[si] + t * L, off: (x - px) * -uz + (z - pz) * ux, dx: ux, dz: uz, px, pz, d })
    }
  }
  for (const v of best.values()) out.push(v)
  out.sort((p, q) => p.d - q.d)
  return out
}

/** is this point on the road (with `slack` metres to spare beyond the paved edge)? */
export function onRealRoad(m: RealMap, x: number, z: number, slack = 1.2): boolean {
  for (const n of nearEdges(m, x, z, 30)) {
    const side = n.off >= 0 ? 1 : -1
    if (Math.abs(n.off) <= halfWidth(n.e, side) + slack) return true
  }
  // junction surfaces (with their rounded corners), bends, dead ends and cul-de-sac bulbs
  for (const j of junctionsNear(m, x, z)) {
    const d = Math.hypot(x - j.x, z - j.z)
    if (j.bulb && d <= j.bulb + slack) return true
    if (j.ends.length < 3) { if (j.ends.length && d <= j.r0 + slack) return true; continue }
    if (d <= j.r + slack) return true
    if (d > j.r + FILLET + 4 + slack) continue
    // inside the outline, allowing `slack` (the point is moved that much towards the centre)
    const k = d > slack ? (d - slack) / d : 0
    if (inRing(junctionRing(m, j), j.x + (x - j.x) * k, j.z + (z - j.z) * k)) return true
  }
  return false
}
function inRing(ring: Array<[number, number]>, x: number, z: number) {
  let inside = false
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const [xa, za] = ring[a], [xb, zb] = ring[b]
    if ((za > z) !== (zb > z) && x < ((xb - xa) * (z - za)) / (zb - za) + xa) inside = !inside
  }
  return inside
}

const rings = new WeakMap<Junction, Array<[number, number]>>()
/**
 * The outline of a junction where three or more roads meet: round from road to road, along each road's edge and then a rounded kerb
 * corner to the next road (a straight line across where the angle is too wide for a corner). Used for the road surface and the
 * "on the road" test.
 */
export function junctionRing(m: RealMap, j: Junction): Array<[number, number]> {
  const got = rings.get(j)
  if (got) return got
  const ends = j.ends.map(({ e, atA }) => {
    const ed = m.edges[e]
    const d = endDir(ed, atA)
    // looking out along the road from the junction: its right side is a -> b's right when leaving from a
    const wR = atA ? halfWidth(ed, 1) : halfWidth(ed, -1), wL = atA ? halfWidth(ed, -1) : halfWidth(ed, 1)
    return { d, wR, wL, ang: Math.atan2(d[1], d[0]), len: ed.len }
  }).sort((p, q) => p.ang - q.ang)
  const ring: Array<[number, number]> = []
  const n = ends.length
  for (let k = 0; k < n; k++) {
    const a = ends[k], b = ends[(k + 1) % n]
    const na = [-a.d[1], a.d[0]], nb = [-b.d[1], b.d[0]] // right-hand normals
    let gap = b.ang - a.ang
    if (gap <= 0) gap += Math.PI * 2
    // a's right edge: na*wR + t*a.d ; b's left edge: -nb*wL + u*b.d
    const ox = -nb[0] * b.wL - na[0] * a.wR, oz = -nb[1] * b.wL - na[1] * a.wR
    const det = a.d[0] * -b.d[1] - a.d[1] * -b.d[0]
    let done = false
    if (gap < Math.PI * 0.94 && Math.abs(det) > 1e-3) {
      const t = (ox * -b.d[1] - oz * -b.d[0]) / det
      const u = (a.d[0] * oz - a.d[1] * ox) / det
      if (t > -0.5 && u > -0.5 && t < 30 && u < 30) {
        const f = Math.min(FILLET, a.len * 0.4, b.len * 0.4)
        const C = [j.x + na[0] * a.wR + a.d[0] * t, j.z + na[1] * a.wR + a.d[1] * t]
        const T1 = [C[0] + a.d[0] * f, C[1] + a.d[1] * f], T2 = [C[0] + b.d[0] * f, C[1] + b.d[1] * f]
        // a rounded kerb from T1 to T2 (a curve drawn towards the sharp corner C)
        for (let i = 0; i <= 8; i++) {
          const s = i / 8, w0 = (1 - s) * (1 - s), w1 = 2 * s * (1 - s), w2 = s * s
          ring.push([T1[0] * w0 + C[0] * w1 + T2[0] * w2, T1[1] * w0 + C[1] * w1 + T2[1] * w2])
        }
        done = true
      }
    }
    if (!done) {
      // a wide angle: straight across from a's right edge to b's left edge
      ring.push([j.x + na[0] * a.wR + a.d[0] * j.r, j.z + na[1] * a.wR + a.d[1] * j.r])
      ring.push([j.x - nb[0] * b.wL + b.d[0] * j.r, j.z - nb[1] * b.wL + b.d[1] * j.r])
    }
  }
  rings.set(j, ring)
  return ring
}
/** corner rounding (kerb return radius, m) */
export const FILLET = 6

let jGrid: { m: RealMap; g: Map<number, Junction[]> } | null = null
/** junctions within about 40 m of a point */
export function junctionsNear(m: RealMap, x: number, z: number): Junction[] {
  if (!jGrid || jGrid.m !== m) {
    const g = new Map<number, Junction[]>()
    for (const j of m.junctions) {
      const k = cellKey(Math.floor(j.x / CELL), Math.floor(j.z / CELL))
      let l = g.get(k)
      if (!l) g.set(k, (l = []))
      l.push(j)
    }
    jGrid = { m, g }
  }
  const out: Junction[] = []
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL)
  for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iz = cz - 1; iz <= cz + 1; iz++) {
    const l = jGrid.g.get(cellKey(ix, iz))
    if (l) out.push(...l)
  }
  return out
}

/** heading for travelling along unit direction (dx, dz): the game's convention is forward = (-sin h, -cos h) */
export const headingOf = (dx: number, dz: number) => Math.atan2(-dx, -dz)

/** lane centres for travel along an edge: offsets to the right of a -> b (m), for travel a -> b (dir 1) or b -> a (dir -1) */
export function laneOffsets(e: Edge, dir: 1 | -1): number[] {
  const out: number[] = []
  if (e.oneway) {
    if (dir === -1) return out
    const w = e.lanesF * e.laneW
    for (let k = 0; k < e.lanesF; k++) out.push(-w / 2 + (k + 0.5) * e.laneW)
    return out
  }
  const c = (e.centre * e.laneW) / 2
  const n = dir === 1 ? e.lanesF : e.lanesB
  for (let k = 0; k < n; k++) out.push(dir * (c + (k + 0.5) * e.laneW))
  return out
}

/**
 * The middle of the lane you are in, for travel in the direction you are heading (lane assist, recovery). Returns the point on the
 * lane's centre-line beside (x, z) and the lane's heading there.
 */
export function realLaneTarget(m: RealMap, x: number, z: number, h: number, maxD = 9): { x: number; z: number; h: number; w: number } | null {
  const fx = -Math.sin(h), fz = -Math.cos(h)
  let best: { x: number; z: number; h: number; w: number } | null = null, bd = maxD
  for (const n of nearEdges(m, x, z, maxD + 12)) {
    const along = n.dx * fx + n.dz * fz
    if (Math.abs(along) < 0.4) continue
    const dir: 1 | -1 = along > 0 ? 1 : -1
    for (const o of laneOffsets(n.e, dir)) {
      const d = Math.abs(n.off - o)
      if (d < bd) {
        bd = d
        // right of a -> b is (-dz, dx)
        best = { x: n.px - n.dz * o, z: n.pz + n.dx * o, h: headingOf(n.dx * dir, n.dz * dir), w: n.e.laneW }
      }
    }
  }
  return best
}

/** where to start (or be put back): on the nearest road to (x, z), in its right-hand lane, facing as close to `h` as the road allows */
export function realPose(m: RealMap, x: number, z: number, h?: number): { x: number; z: number; h: number } {
  const ns = nearEdges(m, x, z, 400)
  // prefer a proper street to a service road or a highway
  const pick = ns.find((n) => n.e.cls !== 'service' && n.e.cls !== 'motorway' && n.e.cls !== 'motorway_link') ?? ns[0]
  if (!pick) return { x, z, h: h ?? 0 }
  const e = pick.e
  // keep clear of the junctions at either end
  const s = Math.max(Math.min(e.len * 0.5, 25), Math.min(e.len - Math.min(e.len * 0.5, 25), pick.s))
  const [px, pz, dx, dz] = pointAt(e, s)
  let dir: 1 | -1 = 1
  if (!e.oneway && h !== undefined) dir = dx * -Math.sin(h) + dz * -Math.cos(h) >= 0 ? 1 : -1
  const offs = laneOffsets(e, dir)
  const o = offs[offs.length - 1] ?? 0 // the right-hand lane
  return { x: px - dz * o, z: pz + dx * o, h: headingOf(dx * dir, dz * dir) }
}

/** the road you are on (the closest whose paved surface you are on, or the nearest) */
export function roadAt(m: RealMap, x: number, z: number): Near | null {
  const ns = nearEdges(m, x, z, 25)
  return ns.find((n) => Math.abs(n.off) <= halfWidth(n.e, n.off >= 0 ? 1 : -1) + 0.5) ?? ns[0] ?? null
}

/** metres (x east, z south) -> degrees */
export function toLatLon(m: { lat0: number; lon0: number; kx: number; kz: number }, x: number, z: number) {
  return { lat: m.lat0 - z / m.kz, lon: m.lon0 + x / m.kx }
}
