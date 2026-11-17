/**
 * Real places: other traffic. Each car drives along the real lanes (curved roads included), picks a way at each junction (mostly
 * straight on, sometimes turning; round at a dead end), gets into the right lane and shows its indicator before a turn, and drives
 * a smooth curve through the junction. It keeps a safe distance to whatever is ahead (another car, or you), stops for red and
 * amber lights, makes a full stop at a STOP sign and goes when it is its turn, and gives way at a YIELD sign.
 *
 * The cars are drawn (and crash-checked) through the game's usual car slots (`cars` in trafficAI): this module only fills in where
 * each one is.
 */
import { cars, CAR_L } from '../game/trafficAI'
import { useGame } from '../game/store'
import { REAL } from './load'
import { endDir, headingOf, laneOffsets, nearEdges, pointAt, type Edge, type Junction, type RealMap } from './roads'
import { lightFor } from './signals'

/** how many cars round you, by traffic level (1-5) */
export const REAL_TRAFFIC = [6, 12, 20, 28, 36]
const MAXN = 40
const COLORS = ['#2e86de', '#f1c40f', '#ecf0f1', '#27ae60', '#8e44ad', '#e67e22', '#34495e', '#16a085', '#c0392b', '#95a5a6', '#1b1f24', '#d4c9b0']
const KINDS = [0, 0, 0, 0, 1, 1, 3, 4]

export interface Player { x: number; z: number; h: number; speed: number; dir: 1 | -1 }

interface Through { j: number; p: number[]; len: number; d: number; turn: number; fromE: number; fromDir: 1 | -1 }
interface RC {
  on: boolean
  /** the edge, which way along it (1: a -> b), the lane (0 = leftmost), distance travelled along it (m), sideways offset now (m) */
  e: number
  dir: 1 | -1
  lane: number
  u: number
  lat: number
  v: number
  /** speed it likes to drive at, as a share of the limit */
  pref: number
  /** where it goes at the end of this edge, and the turn (-1 left, 0 straight, 1 right) */
  next: { e: number; dir: 1 | -1; lane: number; turn: number } | null
  /** driving through a junction: a curve from the stop line to the next road */
  tr: Through | null
  /** at a STOP / YIELD sign: when it came to a stop there (-1: not yet), and whether it may go */
  stoppedAt: number
  released: boolean
  waitT: number
  acc: number
}
const rc: RC[] = Array.from({ length: MAXN }, () => ({ on: false, e: 0, dir: 1, lane: 0, u: 0, lat: 0, v: 0, pref: 1, next: null, tr: null, stoppedAt: -1, released: false, waitT: 0, acc: 0 }))
let ofMap: RealMap | null = null

/* ---------------- geometry helpers ---------------- */
const endJ = (m: RealMap, e: Edge, dir: 1 | -1) => m.junctions[dir === 1 ? e.b : e.a]
const startJ = (m: RealMap, e: Edge, dir: 1 | -1) => m.junctions[dir === 1 ? e.a : e.b]
/** where a car stops before the junction at the end (distance along the edge) */
function stopU(m: RealMap, e: Edge, dir: 1 | -1) {
  const j = endJ(m, e, dir)
  if (j.ends.length >= 3) return Math.max(1, e.len - (j.r + 1.2))
  if (j.ends.length === 1) return Math.max(1, e.len - (j.bulb ? j.bulb * 0.35 : 3))
  return e.len
}
/** where a car joins an edge after a junction */
function startU(m: RealMap, e: Edge, dir: 1 | -1) {
  const j = startJ(m, e, dir)
  if (j.ends.length >= 3) return Math.min(e.len - 1, j.r + 1.2)
  if (j.ends.length === 1) return Math.min(e.len - 1, j.bulb ? j.bulb * 0.35 : 3)
  return 0
}
function laneOff(e: Edge, dir: 1 | -1, lane: number) {
  const o = laneOffsets(e, dir)
  return o[Math.max(0, Math.min(o.length - 1, lane))] ?? 0
}
/** position and travel direction on an edge */
function onEdge(e: Edge, dir: 1 | -1, u: number, lat: number) {
  const [px, pz, dx, dz] = pointAt(e, dir === 1 ? u : e.len - u)
  return { x: px - dz * lat, z: pz + dx * lat, fx: dx * dir, fz: dz * dir }
}
function bez(p: number[], t: number) {
  const a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t
  const x = a * p[0] + b * p[2] + c * p[4], z = a * p[1] + b * p[3] + c * p[5]
  const dx = 2 * (1 - t) * (p[2] - p[0]) + 2 * t * (p[4] - p[2]), dz = 2 * (1 - t) * (p[3] - p[1]) + 2 * t * (p[5] - p[3])
  const L = Math.hypot(dx, dz) || 1
  return { x, z, fx: dx / L, fz: dz / L }
}

/* ---------------- choosing the way ---------------- */
function choose(m: RealMap, c: RC): RC['next'] {
  const e = m.edges[c.e]
  const j = endJ(m, e, c.dir)
  const inn = onEdge(e, c.dir, Math.max(0, e.len - 4), 0)
  const opts: Array<{ e: number; dir: 1 | -1; turn: number; w: number }> = []
  for (const q of j.ends) {
    if (q.e === c.e) continue
    const ne = m.edges[q.e]
    const dir: 1 | -1 = q.atA ? 1 : -1
    if (dir === -1 && ne.oneway) continue // (can't go the wrong way down a one-way road)
    const out = endDir(ne, q.atA)
    const cross = inn.fx * out[1] - inn.fz * out[0], dot = inn.fx * out[0] + inn.fz * out[1]
    const ang = Math.atan2(cross, dot) // + = to the right
    const turn = Math.abs(ang) < 0.5 ? 0 : ang > 0 ? 1 : -1
    if (Math.abs(ang) > 2.7) continue // (a hairpin back the way it came)
    let w = turn === 0 ? 3 : turn === 1 ? 1.3 : 1
    if (ne.cls === 'service') w *= 0.12
    if ((ne.cls === 'motorway' || ne.cls === 'motorway_link') && !(e.cls === 'motorway' || e.cls === 'motorway_link')) w *= 0.3
    opts.push({ e: q.e, dir, turn, w })
  }
  if (!opts.length) {
    // a dead end (or the edge of the downloaded map): turn round, if the road is two-way
    if (e.oneway) return null
    return { e: c.e, dir: (-c.dir) as 1 | -1, lane: laneOffsets(e, (-c.dir) as 1 | -1).length - 1, turn: 2 }
  }
  let r = Math.random() * opts.reduce((t, o) => t + o.w, 0)
  const o = opts.find((x) => (r -= x.w) <= 0) ?? opts[0]
  const n = laneOffsets(m.edges[o.e], o.dir).length
  const lane = o.turn === 1 ? n - 1 : o.turn === -1 ? 0 : Math.min(n - 1, c.lane)
  return { e: o.e, dir: o.dir, lane, turn: o.turn }
}
/** the curve through the junction, from where the car is now (at its stop line) to its place on the next road */
function through(m: RealMap, c: RC): Through | null {
  const nx = c.next
  if (!nx) return null
  const e = m.edges[c.e], ne = m.edges[nx.e]
  const j = endJ(m, e, c.dir)
  const a = onEdge(e, c.dir, c.u, c.lat)
  const b = onEdge(ne, nx.dir, startU(m, ne, nx.dir), laneOff(ne, nx.dir, nx.lane))
  // the control point: where the two directions of travel cross (half-way across for a straight run or a U-turn)
  let px = (a.x + b.x) / 2, pz = (a.z + b.z) / 2
  const det = a.fx * -b.fz - a.fz * -b.fx
  if (Math.abs(det) > 0.15) {
    const ox = b.x - a.x, oz = b.z - a.z
    const s = (ox * -b.fz - oz * -b.fx) / det, t = (a.fx * oz - a.fz * ox) / det
    if (s > 0 && t > 0 && s < 50 && t < 50) { px = a.x + a.fx * s; pz = a.z + a.fz * s }
  } else if (nx.turn === 2) { px = j.x + a.fx * 4; pz = j.z + a.fz * 4 }
  const p = [a.x, a.z, px, pz, b.x, b.z]
  let len = 0, prev = bez(p, 0)
  for (let i = 1; i <= 10; i++) { const q = bez(p, i / 10); len += Math.hypot(q.x - prev.x, q.z - prev.z); prev = q }
  return { j: j.id, p, len: Math.max(0.5, len), d: 0, turn: nx.turn, fromE: c.e, fromDir: c.dir }
}

/* ---------------- spawning ---------------- */
function place(m: RealMap, c: RC, p: Player, dMin: number, dMax: number) {
  for (let tries = 0; tries < 30; tries++) {
    const ei = Math.floor(Math.random() * m.edges.length)
    const e = m.edges[ei]
    if (e.cls === 'service' || e.len < 30) continue
    const [mx, mz] = pointAt(e, e.len / 2)
    const d = Math.hypot(mx - p.x, mz - p.z)
    if (d < dMin || d > dMax) continue
    const dir: 1 | -1 = e.oneway || Math.random() < 0.5 ? 1 : -1
    const u0 = startU(m, e, dir) + 5, u1 = stopU(m, e, dir) - 8
    if (u1 <= u0) continue
    const u = u0 + Math.random() * (u1 - u0)
    const lanes = laneOffsets(e, dir).length
    if (!lanes) continue
    const lane = Math.floor(Math.random() * lanes)
    const pos = onEdge(e, dir, u, laneOff(e, dir, lane))
    if (Math.hypot(pos.x - p.x, pos.z - p.z) < dMin) continue
    if (rc.some((o) => o.on && o !== c && o.e === ei && Math.abs(o.u - u) < 18)) continue
    Object.assign(c, { on: true, e: ei, dir, lane, u, lat: laneOff(e, dir, lane), pref: 0.88 + Math.random() * 0.17, next: null, tr: null, stoppedAt: -1, released: false, waitT: 0, acc: 0 })
    c.v = Math.min(e.limit * c.pref, 13) * 0.8
    const slot = cars[rc.indexOf(c)]
    slot.color = COLORS[Math.floor(Math.random() * COLORS.length)]
    slot.kind = KINDS[Math.floor(Math.random() * KINDS.length)]
    slot.len = undefined; slot.wid = undefined
    return true
  }
  return false
}

/** A new drive (or a new place): cars placed round you, none right beside you. */
export function initRealTraffic(p: Player) {
  for (const c of cars) c.active = false
  for (const c of rc) c.on = false
  ofMap = REAL.map
  const m = REAL.map
  if (!m) return
  const n = Math.min(MAXN, REAL_TRAFFIC[useGame.getState().traffic - 1] ?? 12)
  for (let i = 0; i < n; i++) place(m, rc[i], p, 45, 380)
  write(m)
}

/** when more of the map arrives the roads are numbered afresh: put each car back on its road (or take it away) */
function reanchor(m: RealMap) {
  rc.forEach((c, i) => {
    if (!c.on) return
    const car = cars[i]
    const fx = -Math.sin(car.h), fz = -Math.cos(car.h)
    let best: ReturnType<typeof nearEdges>[number] | null = null
    for (const n of nearEdges(m, car.x, car.z, 8)) if (Math.abs(n.dx * fx + n.dz * fz) > 0.6) { best = n; break }
    if (!best) { c.on = false; return }
    const dir: 1 | -1 = best.dx * fx + best.dz * fz > 0 ? 1 : -1
    const offs = laneOffsets(best.e, dir)
    if (!offs.length) { c.on = false; return }
    let lane = 0
    offs.forEach((o, k) => { if (Math.abs(o - best!.off) < Math.abs(offs[lane] - best!.off)) lane = k })
    Object.assign(c, { e: best.e.id, dir, lane, u: dir === 1 ? best.s : best.e.len - best.s, lat: best.off, next: null, tr: null, stoppedAt: -1, released: false })
  })
}

/* ---------------- each step ---------------- */
interface Pos { x: number; z: number; fx: number; fz: number }
const pos: Pos[] = rc.map(() => ({ x: 0, z: 0, fx: 0, fz: -1 }))

/** may this car drive into the junction now? */
function mayEnter(m: RealMap, c: RC, i: number, j: Junction, t: number, p: Player, dToLine: number): boolean {
  const ctl = j.ctl.get(c.e) ?? 'none'
  if (ctl === 'none' || c.released) return true
  if (ctl === 'signal') {
    const L = lightFor(m, j, c.e, t)
    if (L === 'G' || L === null) return true
    if (L === 'Y') return dToLine < (c.v * c.v) / (2 * 3) + 1 // (too close to stop safely: carry on)
    return false
  }
  // STOP: a full stop first, then a moment
  if (ctl === 'stop') {
    if (c.stoppedAt < 0) return false
    if (t - c.stoppedAt < 1.2) return false
  }
  // ... then go when the junction is clear: nobody crossing it, nobody who stopped there before us still waiting, and you not in it
  // or about to drive through it
  const busy = rc.some((o, k) => k !== i && o.on && ((o.tr && o.tr.j === j.id && o.tr.fromE !== c.e) || (ctl === 'stop' && !o.tr && o.stoppedAt >= 0 && !o.released && o.stoppedAt < c.stoppedAt && endJ(m, m.edges[o.e], o.dir) === j)))
  if (busy) return false
  const pd = Math.hypot(p.x - j.x, p.z - j.z)
  if (pd < j.r + 2) return false
  if (pd < j.r + 30 && p.speed > 2) {
    const toward = ((j.x - p.x) * -Math.sin(p.h) + (j.z - p.z) * -Math.cos(p.h)) * p.dir > 0
    if (toward) return false
  }
  // a YIELD sign: also wait for traffic on the main road coming up to the junction
  if (ctl === 'yield') {
    for (let k = 0; k < rc.length; k++) {
      const o = rc[k]
      if (k === i || !o.on || o.tr) continue
      const oe = m.edges[o.e]
      if (endJ(m, oe, o.dir) !== j || (j.ctl.get(o.e) ?? 'none') !== 'none') continue
      if (stopU(m, oe, o.dir) - o.u < 45 && o.v > 2) return false
    }
  }
  return true
}

export function stepRealTraffic(dt: number, t: number, p: Player) {
  const m = REAL.map
  if (!m) return
  if (m !== ofMap) { ofMap = m; reanchor(m) }
  const want = Math.min(MAXN, REAL_TRAFFIC[useGame.getState().traffic - 1] ?? 12)
  // current positions (for the distance checks)
  rc.forEach((c, i) => { if (c.on) Object.assign(pos[i], c.tr ? bez(c.tr.p, Math.min(1, c.tr.d / c.tr.len)) : onEdge(m.edges[c.e], c.dir, c.u, c.lat)) })
  const pfx = -Math.sin(p.h) * p.dir, pfz = -Math.cos(p.h) * p.dir

  let active = 0
  for (let i = 0; i < rc.length; i++) {
    const c = rc[i]
    if (!c.on) continue
    // far behind you (or too many cars): taken away
    if (Math.hypot(pos[i].x - p.x, pos[i].z - p.z) > 460 || active >= want) { c.on = false; continue }
    active++
    const e = m.edges[c.e]
    const P = pos[i]
    let v0 = e.limit * c.pref
    let gap = 1e9, vLead = 0
    const lead = (g: number, v: number) => { if (g < gap) { gap = g; vLead = v } }

    if (!c.tr) {
      const su = stopU(m, e, c.dir), j = endJ(m, e, c.dir)
      const toLine = su - c.u
      if (!c.next && toLine < 90) {
        c.next = choose(m, c)
        if (!c.next) { c.on = false; continue }
      }
      // get into the lane for the turn, and show the indicator
      const tl = c.next && toLine < 80 ? c.next.turn === 1 ? laneOffsets(e, c.dir).length - 1 : c.next.turn === -1 ? 0 : c.lane : c.lane
      c.lane = tl
      const latWant = laneOff(e, c.dir, c.lane)
      c.lat += Math.max(-1.2 * dt, Math.min(1.2 * dt, latWant - c.lat))
      cars[i].sig = c.next && toLine < 60 ? (c.next.turn === 1 ? 1 : c.next.turn === -1 || c.next.turn === 2 ? -1 : 0) : 0
      // slow for the turn ahead
      if (c.next && c.next.turn !== 0) v0 = Math.min(v0, Math.sqrt(5.5 * 5.5 + 2 * 1.8 * Math.max(0, toLine)))
      // the junction: go, or stop at the line
      // (an obstacle at the line: the car's own following distance then stops it with its nose at the line)
      if (j.ends.length >= 3 && !mayEnter(m, c, i, j, t, p, toLine)) lead(toLine, 0)
      if (j.ends.length >= 3 && (j.ctl.get(c.e) === 'stop' || j.ctl.get(c.e) === 'yield') && c.stoppedAt < 0 && toLine < 3.5 && c.v < 0.3) c.stoppedAt = t
      // the car ahead in this lane, on this road; and on the road after the junction
      for (let k = 0; k < rc.length; k++) {
        const o = rc[k]
        if (k === i || !o.on) continue
        if (!o.tr && o.e === c.e && o.dir === c.dir && o.u > c.u && Math.abs(o.lat - c.lat) < 2.4) lead(o.u - c.u - CAR_L - 0.5, o.v)
        else if (o.tr && o.tr.fromE === c.e && o.tr.fromDir === c.dir) lead(toLine + o.tr.d - CAR_L - 0.5, o.v)
        else if (c.next && !o.tr && o.e === c.next.e && o.dir === c.next.dir && Math.abs(o.lat - laneOff(m.edges[o.e], o.dir, c.next.lane)) < 2.4) lead(toLine + 2 * j.r + o.u - startU(m, m.edges[o.e], o.dir) - CAR_L, o.v)
      }
      // reached the line: into the junction (or straight onto the next stretch of road where two stretches simply join)
      if (c.u >= su - 0.05 && c.next) {
        if (j.ends.length === 2) {
          const ne = m.edges[c.next.e]
          Object.assign(c, { e: c.next.e, dir: c.next.dir, u: startU(m, ne, c.next.dir) + (c.u - su), lane: Math.min(c.lane, laneOffsets(ne, c.next.dir).length - 1), next: null, stoppedAt: -1, released: false })
        } else {
          c.tr = through(m, c)
          c.released = true
        }
      }
    } else {
      // driving through the junction
      const tr = c.tr
      v0 = Math.min(v0, tr.turn === 0 ? v0 : tr.turn === 2 ? 3.5 : 6.5)
      for (let k = 0; k < rc.length; k++) {
        const o = rc[k]
        if (k === i || !o.on) continue
        if (o.tr && o.tr.j === tr.j && o.e === c.e && o.tr.fromE === tr.fromE && o.tr.d > tr.d) lead(o.tr.d - tr.d - CAR_L - 0.5, o.v)
        else if (!o.tr && c.next && o.e === c.next.e && o.dir === c.next.dir) lead(tr.len - tr.d + o.u - startU(m, m.edges[o.e], o.dir) - CAR_L, o.v)
      }
    }

    // anything just ahead (another car crossing, or you): look in a narrow band in front
    for (let k = 0; k < rc.length; k++) {
      if (k === i || !rc[k].on) continue
      const rx = pos[k].x - P.x, rz = pos[k].z - P.z
      const f = rx * P.fx + rz * P.fz, l = Math.abs(rx * -P.fz + rz * P.fx)
      if (f > 0 && f < 28 && l < 2.1) lead(f - CAR_L - 0.8, rc[k].v * (pos[k].fx * P.fx + pos[k].fz * P.fz))
    }
    {
      const rx = p.x - P.x, rz = p.z - P.z
      const f = rx * P.fx + rz * P.fz, l = Math.abs(rx * -P.fz + rz * P.fx)
      if (f > 0 && f < 55 && l < 2.3) lead(f - CAR_L - 1, p.speed * (pfx * P.fx + pfz * P.fz))
    }

    // the Intelligent Driver Model: speed up towards the speed it wants, keep a safe time gap to what is ahead
    const A = 1.7, B = 2.8, v = c.v
    const sStar = 2.2 + v * 1.3 + (v * (v - vLead)) / (2 * Math.sqrt(A * B))
    let acc = A * (1 - (v / Math.max(1, v0)) ** 4) - (gap < 1e8 ? A * (sStar / Math.max(0.1, gap)) ** 2 : 0)
    acc = Math.max(-8, acc)
    c.v = Math.max(0, v + acc * dt)
    if (gap < 0.3) c.v = Math.min(c.v, 0.2)
    c.acc = acc
    // a car stuck for a long time in an odd spot gives up waiting (nothing on the map is perfect)
    c.waitT = c.v < 0.1 ? c.waitT + dt : 0
    if (c.waitT > 25 && !c.tr) { c.released = true; c.stoppedAt = Math.min(c.stoppedAt < 0 ? t : c.stoppedAt, t - 2) }
    if (c.waitT > 60) { c.on = false; continue }

    // move
    if (c.tr) {
      c.tr.d += c.v * dt
      if (c.tr.d >= c.tr.len && c.next) {
        const ne = m.edges[c.next.e]
        Object.assign(c, { e: c.next.e, dir: c.next.dir, lane: c.next.lane, u: startU(m, ne, c.next.dir) + (c.tr.d - c.tr.len), lat: laneOff(ne, c.next.dir, c.next.lane), next: null, tr: null, stoppedAt: -1, released: false })
      }
    } else {
      c.u += c.v * dt
      if (c.u > e.len + 5) c.on = false // (should not happen: the junction takes over at the line)
    }
  }
  // new cars, out of sight, until there are as many as the traffic level asks for (one a step)
  if (active < want) {
    const free = rc.find((c) => !c.on)
    if (free) place(m, free, p, 160, 400)
  }
  write(m)
}

/** copy each car's place into the game's car slots (drawn by Traffic.tsx, crash-checked by the sim) */
function write(m: RealMap) {
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i]
    const c = rc[i]
    if (!c || !c.on) { if (i < MAXN) car.active = false; continue }
    const q = c.tr ? bez(c.tr.p, Math.min(1, c.tr.d / c.tr.len)) : onEdge(m.edges[c.e], c.dir, c.u, c.lat)
    car.active = true
    car.x = q.x; car.z = q.z
    car.h = headingOf(q.fx, q.fz)
    car.speed = c.v
    car.braking = c.acc < -1 || (c.v < 0.5 && !c.tr)
    if (c.tr) car.sig = c.tr.turn === 1 ? 1 : c.tr.turn === -1 || c.tr.turn === 2 ? -1 : 0
  }
}

if (typeof window !== 'undefined') Object.assign(window, { __rt: rc }) // (for debugging in the console)
