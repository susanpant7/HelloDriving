import * as THREE from 'three'
import { FILLET, arrives, clusterHull, endDir, halfWidth, heightAt, junctionRing, laneOffsets, onRealRoad, pointAt, stopDist, type Edge, type Junction, type RealMap } from './roads'

/**
 * A real place, drawn from its map data: the road surface (with rounded kerb corners and cul-de-sac bulbs), kerbs and sidewalks,
 * the lane paint the US uses on each kind of road, stop lines with STOP signs, speed-limit signs, buildings and trees.
 */

type V3 = [number, number, number]
type P2 = [number, number]
const WHITE: V3 = [0.92, 0.92, 0.9], YELLOW: V3 = [0.95, 0.75, 0.1]
const CONCRETE: V3 = [0.68, 0.67, 0.64], CONCRETE_DARK: V3 = [0.45, 0.45, 0.44]
const KERB: V3 = [0.62, 0.62, 0.6], WALK: V3 = [0.7, 0.69, 0.66], POST: V3 = [0.45, 0.47, 0.5]
const Y_ROAD = 0, Y_MARK = 0.015, Y_WALK = 0.05

/** flat (or boxy) triangles with a colour each, gathered into one geometry */
export class Geo {
  pos: number[] = []
  nor: number[] = []
  col: number[] = []
  tri(a: V3, b: V3, c: V3, color: V3, n?: V3) {
    let nx = 0, ny = 1, nz = 0
    if (n) [nx, ny, nz] = n
    for (const p of [a, b, c]) { this.pos.push(p[0], p[1], p[2]); this.nor.push(nx, ny, nz); this.col.push(color[0], color[1], color[2]) }
  }
  /** a flat quad (a, b, c, d in order round it) at height y */
  quad(a: P2, b: P2, c: P2, d: P2, y: number, color: V3) {
    const A: V3 = [a[0], y, a[1]], B: V3 = [b[0], y, b[1]], C: V3 = [c[0], y, c[1]], D: V3 = [d[0], y, d[1]]
    this.tri(A, B, C, color); this.tri(A, C, D, color)
  }
  box(x: number, y0: number, z: number, w: number, h: number, d: number, color: V3) {
    const x0 = x - w / 2, x1 = x + w / 2, y1 = y0 + h, z0 = z - d / 2, z1 = z + d / 2
    const q = (a: V3, b: V3, c: V3, dd: V3, n: V3) => { this.tri(a, b, c, color, n); this.tri(a, c, dd, color, n) }
    q([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0])
    q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1])
    q([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1])
    q([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0])
    q([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0])
  }
  build() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.computeBoundingSphere()
    return g
  }
}

/** a point of a line: x, z, and the road's height there */
type LP = [number, number, number]
/** the centre-line between s0 and s1 (m along the edge), as points with the road's height (up on a bridge, climbing towards one;
 *  a climb is drawn in steps of 8 m or less, so it is a smooth slope) */
function sub(e: Edge, s0: number, s1: number): LP[] {
  if (s1 - s0 < 0.05) return []
  const ss = [s0]
  for (let k = 1; k < e.cum.length - 1; k++) if (e.cum[k] > s0 + 0.05 && e.cum[k] < s1 - 0.05) ss.push(e.cum[k])
  ss.push(s1)
  const ramps = e.hA > 0 || e.hB > 0
  const out: LP[] = []
  const at = (s: number) => { const p = pointAt(e, s); out.push([p[0], p[1], heightAt(e, s)]) }
  for (let i = 0; i < ss.length; i++) {
    if (ramps && i > 0) {
      const n = Math.floor((ss[i] - ss[i - 1]) / 8)
      for (let q = 1; q < n; q++) at(ss[i - 1] + ((ss[i] - ss[i - 1]) * q) / n)
    }
    at(ss[i])
  }
  return out
}
/** a strip following a line, between offsets o1 and o2 to its right (m), with mitred corners */
function strip(g: Geo, line: LP[], o1: number, o2: number, y: number, color: V3) {
  if (line.length < 2) return
  const nrm: P2[] = []
  for (let i = 0; i < line.length; i++) {
    const p = line[Math.max(0, i - 1)], q = line[Math.min(line.length - 1, i + 1)]
    // average of the neighbouring stretches' right-hand normals, lengthened at a bend so the strip keeps its width
    let nx = 0, nz = 0
    const seg = (u: LP, v: LP) => { const dx = v[0] - u[0], dz = v[1] - u[1], L = Math.hypot(dx, dz) || 1; return [-dz / L, dx / L] as P2 }
    const n1 = i > 0 ? seg(p, line[i]) : null, n2 = i < line.length - 1 ? seg(line[i], q) : null
    if (n1) { nx += n1[0]; nz += n1[1] }
    if (n2) { nx += n2[0]; nz += n2[1] }
    const L = Math.hypot(nx, nz) || 1
    nx /= L; nz /= L
    const ref = n1 ?? n2!
    const k = 1 / Math.max(0.5, nx * ref[0] + nz * ref[1])
    nrm.push([nx * k, nz * k])
  }
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1], na = nrm[i], nb = nrm[i + 1]
    const ya = y + a[2], yb = y + b[2]
    const A: V3 = [a[0] + na[0] * o1, ya, a[1] + na[1] * o1], B: V3 = [a[0] + na[0] * o2, ya, a[1] + na[1] * o2]
    const C: V3 = [b[0] + nb[0] * o2, yb, b[1] + nb[1] * o2], D: V3 = [b[0] + nb[0] * o1, yb, b[1] + nb[1] * o1]
    g.tri(A, B, C, color); g.tri(A, C, D, color)
  }
}
/** the side of a raised road: a wall along a line at offset o (m to its right), from `bottom` (below the surface, or down to the
 *  ground if null) up to `top` above the surface; faces outwards */
function wall(g: Geo, line: LP[], o: number, bottom: number | null, top: number, color: V3) {
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1]
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1
    const nx = -dz / L, nz = dx / L // right of the line
    const ax = a[0] + nx * o, az = a[1] + nz * o, bx = b[0] + nx * o, bz = b[1] + nz * o
    const a0 = bottom === null ? 0 : a[2] + bottom, b0 = bottom === null ? 0 : b[2] + bottom
    const s = Math.sign(o) || 1, n: V3 = [nx * s, 0, nz * s]
    g.tri([ax, a0, az], [bx, b0, bz], [bx, b[2] + top, bz], color, n)
    g.tri([ax, a0, az], [bx, b[2] + top, bz], [ax, a[2] + top, az], color, n)
    // (and the other face, so the wall is solid from either side)
    const m: V3 = [-n[0], 0, -n[2]]
    g.tri([ax, a0, az], [bx, b[2] + top, bz], [bx, b0, bz], color, m)
    g.tri([ax, a0, az], [ax, a[2] + top, az], [bx, b[2] + top, bz], color, m)
  }
}
/** a dashed line: 3 m paint, 9 m gap (the US 10 ft / 30 ft pattern) */
/** a dashed line between s0 and s1 (the whole painted stretch: the dashes keep the same spacing wherever the road is cut into
 *  pieces); only the dashes starting within [lo, hi) are drawn */
function dashes(g: Geo, e: Edge, s0: number, s1: number, o: number, color: V3, w = 0.12, lo = -Infinity, hi = Infinity) {
  for (let s = s0 + 1; s < s1 - 1; s += 12) if (s >= lo && s < hi) strip(g, sub(e, s, Math.min(s + 3, s1)), o - w / 2, o + w / 2, Y_MARK, color)
}
function disc(g: Geo, x: number, z: number, r: number, y: number, color: V3, n = 20) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2
    g.tri([x, y, z], [x + Math.cos(a1) * r, y, z + Math.sin(a1) * r], [x + Math.cos(a0) * r, y, z + Math.sin(a0) * r], color)
  }
}

/** how far from each end of an edge things stop at a junction: the paint at the stop line, kerbs and sidewalks where the
 *  rounded corner begins */
function trims(m: RealMap, e: Edge, walk = false) {
  const at = (j: Junction) => (j.ends.length >= 3 ? stopDist(j, e.id) + (walk ? FILLET - 0.5 : 0) : j.bulb ? j.bulb - 1 : 0)
  return [at(m.junctions[e.a]), at(m.junctions[e.b])]
}
const sidewalked = (e: Edge) => e.cls === 'residential' || e.cls === 'unclassified' || e.cls === 'living_street' || e.cls === 'tertiary' || e.cls === 'secondary' || e.cls === 'primary'
const isMainRoad = (e: Edge) => e.cls === 'tertiary' || e.cls === 'secondary' || e.cls === 'primary' || e.cls === 'trunk' || e.cls === 'motorway' || e.cls.endsWith('_link')

/** lane arrows, in the lane's travel frame (u forward 0..3.9 m, v to the travel-right), as on US roads */
const ARROW_SHAPES: Record<'L' | 'S' | 'R' | 'SR' | 'SL', P2[][]> = (() => {
  const straight: P2[][] = [[[0, -0.15], [2.6, -0.15], [2.6, 0.15], [0, 0.15]], [[2.5, -0.62], [2.5, 0.62], [3.9, 0]]]
  const turn = (d: 1 | -1): P2[][] => [
    [[0, -0.15], [1.9, -0.15], [1.9, 0.15], [0, 0.15]],
    [[1.7, 0], [2.1, 0], [2.1, 1.35 * d], [1.7, 1.35 * d]],
    [[1.35, 1.3 * d], [2.45, 1.3 * d], [1.9, 2.2 * d]],
  ]
  const sr: P2[][] = [...straight, [[1.45, 0], [1.8, 0], [1.8, 1.1], [1.45, 1.1]], [[1.1, 1.05], [2.15, 1.05], [1.62, 1.8]]]
  const sl: P2[][] = sr.map((poly) => poly.map(([u, v]) => [u, -v] as P2))
  return { S: straight, L: turn(-1), R: turn(1), SR: sr, SL: sl }
})()
/** which arrow a lane gets from what the map says it is for */
function arrowFor(t: string[]): keyof typeof ARROW_SHAPES | null {
  const l = t.some((x) => x.includes('left')), r = t.some((x) => x.includes('right')), s = t.includes('through')
  if (s && l) return 'SL'
  if (s && r) return 'SR'
  if (l) return 'L'
  if (r) return 'R'
  if (s) return 'S'
  return null
}

/** where each sign goes (and which picture), worked out once per area */
export interface SignDef { x: number; z: number; /** the ground (or road) height it stands on */ y0?: number; face: P2; kind: 'stop' | 'allway' | 'yield' | 'noentry' | number; /** the way away from the road (to move it clear) */ out?: P2 }

/** a tile's box (m): what lies in it is built with it */
export interface Box { x0: number; x1: number; z0: number; z1: number }
const inBox = (b: Box | undefined, x: number, z: number) => !b || (x >= b.x0 && x < b.x1 && z >= b.z0 && z < b.z1)
/** an edge's bounding box (with room for its width) */
const boxes = new WeakMap<Edge, Box>()
function edgeBox(e: Edge): Box {
  let b = boxes.get(e)
  if (!b) {
    b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity }
    for (let k = 0; k < e.pts.length; k += 2) { b.x0 = Math.min(b.x0, e.pts[k]); b.x1 = Math.max(b.x1, e.pts[k]); b.z0 = Math.min(b.z0, e.pts[k + 1]); b.z1 = Math.max(b.z1, e.pts[k + 1]) }
    b.x0 -= 20; b.x1 += 20; b.z0 -= 20; b.z1 += 20
    boxes.set(e, b)
  }
  return b
}
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0
/**
 * The parts of an edge that lie in a box, as stretches [a, b) of distance along it. The edge is cut into 5 m steps and each step
 * belongs to the box its middle is in, so neighbouring boxes share the road out exactly (no gaps, nothing drawn twice).
 */
function pieces(e: Edge, b: Box | undefined): Array<[number, number]> {
  if (!b) return [[0, e.len]]
  if (!overlaps(edgeBox(e), b)) return []
  const out: Array<[number, number]> = []
  const n = Math.max(1, Math.ceil(e.len / 5))
  let cur: [number, number] | null = null
  for (let i = 0; i < n; i++) {
    const sa = (e.len * i) / n, sb = (e.len * (i + 1)) / n
    const p = pointAt(e, (sa + sb) / 2)
    if (inBox(b, p[0], p[1])) { if (cur && cur[1] === sa) cur[1] = sb; else out.push((cur = [sa, sb])) } else cur = null
  }
  return out
}

/**
 * A fingerprint of what a tile's roads look like, so a tile is only rebuilt when a newly arrived neighbour changed it (a road
 * crossing the tile edge now meets a junction, a stop sign was worked out differently...).
 */
export function tileSignature(m: RealMap, b: Box) {
  const parts: string[] = []
  for (const e of m.edges) if (overlaps(edgeBox(e), b)) parts.push(`${e.pts[0].toFixed(1)},${e.pts[1].toFixed(1)},${e.len.toFixed(1)},${e.lanesF}${e.lanesB}${e.centre},${e.cls},${Math.round(e.limit)}`)
  for (const j of m.junctions) if (j.ends.length && inBox(b, j.x, j.z)) parts.push(`J${j.x.toFixed(1)},${j.z.toFixed(1)},${j.ends.length},${j.bulb},${[...j.ctl.values()].join('')}`)
  parts.sort()
  return parts.join('|')
}

export function buildRoads(m: RealMap, box?: Box) {
  const road = new Geo(), marks = new Geo(), solid = new Geo()
  const signs: SignDef[] = []

  for (const e of m.edges) for (const [a, b] of pieces(e, box)) buildEdge(e, a, b)
  /** one stretch [a, b) of an edge: its road surface, kerbs and sidewalks, paint and speed signs */
  function buildEdge(e: Edge, a: number, b: number) {
    const wR = halfWidth(e, 1), wL = halfWidth(e, -1)
    const line = sub(e, a, b)
    strip(road, line, -wL, wR, Y_ROAD, [1, 1, 1])
    // ---- a bridge or overpass: a concrete deck (its sides and underside), parapets along its edges, and pillars down to the ground;
    // the climb up to one: walls down to the ground on both sides (an embankment) ----
    const raised = line.some((p) => p[2] > 0.3)
    if (raised) {
      if (e.level > 0) {
        wall(solid, line, wR + 0.15, -1.2, 0.9, CONCRETE)
        wall(solid, line, -wL - 0.15, -1.2, 0.9, CONCRETE)
        strip(solid, line, wR + 0.15, -wL - 0.15, -1.2, CONCRETE_DARK) // (wound the other way: it is seen from below)
        for (let sp = Math.ceil(a / 30) * 30 + 15; sp < b; sp += 30) {
          const [px, pz] = pointAt(e, sp), top = heightAt(e, sp) - 1.2
          if (top > 1) solid.box(px, 0, pz, 1.1, top, 1.1, CONCRETE)
        }
      } else {
        wall(solid, line.filter((p) => p[2] > 0.05), wR + 0.15, null, 0.9, CONCRETE)
        wall(solid, line.filter((p) => p[2] > 0.05), -wL - 0.15, null, 0.9, CONCRETE)
      }
    }
    const [t0, t1] = trims(m, e)
    // (s0, s1: where the paint runs along the whole edge; lo, hi: the part of that in this stretch; w0..w1: the sidewalks)
    const s0 = Math.min(t0, e.len / 2), s1 = Math.max(e.len - t1, e.len / 2)
    const lo = Math.max(s0, a), hi = Math.min(s1, b)
    const seg = () => sub(e, lo, hi)
    const [u0, u1] = trims(m, e, true)
    const w0 = Math.max(Math.min(u0, e.len / 2), a), w1 = Math.min(Math.max(e.len - u1, e.len / 2), b)

    // (a piece of road inside a larger intersection: just the road surface; the intersection has no paint or kerbs in its middle)
    if (e.internal) return
    // ---- kerbs and sidewalks (a grass strip between the kerb and the sidewalk) ----
    if (sidewalked(e) && w1 - w0 > 0.5 && !raised) { // (no sidewalks up on a bridge or its climb)
      const divided = e.oneway && !e.cls.endsWith('_link')
      for (const side of divided ? [1] : [1, -1]) {
        const w = side === 1 ? wR : wL
        const l = sub(e, w0, w1)
        if (side === 1) { strip(solid, l, w, w + 0.25, Y_WALK, KERB); strip(solid, l, w + 1.6, w + 3.1, Y_WALK, WALK) }
        else { strip(solid, l, -w - 0.25, -w, Y_WALK, KERB); strip(solid, l, -w - 3.1, -w - 1.6, Y_WALK, WALK) }
      }
    }

    // ---- lane paint (lines a little wider than real ones, 20 cm, so they stay clear from the driver's seat at a distance) ----
    if (s1 - s0 > 2 && hi > lo) {
      const main = isMainRoad(e)
      const LW = 0.2, DW = 0.18
      if (e.oneway) {
        // a one-way carriageway: yellow line on the left edge, white on the right, dashes between its lanes
        const half = (e.lanesF * e.laneW) / 2
        if (main || e.lanesF > 1) {
          strip(marks, seg(), -half + 0.05, -half + 0.05 + LW, Y_MARK, YELLOW)
          strip(marks, seg(), half - 0.05 - LW, half - 0.05, Y_MARK, WHITE)
        }
        for (let k = 1; k < e.lanesF; k++) dashes(marks, e, s0, s1, -half + k * e.laneW, WHITE, DW, lo, hi)
      } else {
        // a two-way road: double yellow down the middle (a centre turn lane: solid yellow outside, dashed yellow inside, each side),
        // dashes between lanes going the same way, white edge lines on main roads
        const c = (e.centre * e.laneW) / 2
        if (main || e.lanesF + e.lanesB > 2) {
          if (e.centre) {
            for (const sd of [1, -1]) {
              strip(marks, seg(), sd * c - LW / 2, sd * c + LW / 2, Y_MARK, YELLOW)
              dashes(marks, e, s0, s1, sd * (c - 0.35), YELLOW, DW, lo, hi)
            }
          } else {
            strip(marks, seg(), -0.1 - LW, -0.1, Y_MARK, YELLOW)
            strip(marks, seg(), 0.1, 0.1 + LW, Y_MARK, YELLOW)
          }
          for (let k = 1; k < e.lanesF; k++) dashes(marks, e, s0, s1, c + k * e.laneW, WHITE, DW, lo, hi)
          for (let k = 1; k < e.lanesB; k++) dashes(marks, e, s0, s1, -(c + k * e.laneW), WHITE, DW, lo, hi)
          if (main) {
            const ef = c + e.lanesF * e.laneW, eb = c + e.lanesB * e.laneW
            strip(marks, seg(), ef - LW, ef, Y_MARK, WHITE)
            strip(marks, seg(), -eb, -eb + LW, Y_MARK, WHITE)
          }
        } else if (e.cls !== 'service' && e.cls !== 'living_street') {
          // a quiet two-way street (many US towns paint nothing here): a dashed yellow centre line, so your side is always clear
          dashes(marks, e, s0, s1, 0, YELLOW, DW, lo, hi)
        }
      }
    }

    // ---- lane arrows (where the map says what each lane is for): two in each lane before the junction ----
    for (const dir of [1, -1] as const) {
      const turns = dir === 1 ? e.turnF : e.turnB
      if (!turns) continue
      const j = m.junctions[dir === 1 ? e.b : e.a]
      if (j.ends.length < 3) continue
      const offs = laneOffsets(e, dir)
      const line = stopDist(j, e.id) // (the stop line, from the junction centre)
      for (const back of [7, 32]) {
        const dEnd = line + back // distance of the arrow's tip from the edge's end
        const sTip = dir === 1 ? e.len - dEnd : dEnd
        if (sTip < 3 || sTip > e.len - 3 || sTip < a || sTip >= b) continue
        turns.forEach((t, k) => {
          const shape = arrowFor(t)
          if (!shape || offs[k] === undefined) return
          const [px, pz, dx, dz] = pointAt(e, sTip)
          const fx = dx * dir, fz = dz * dir, rx = -fz, rz = fx // travel forward, travel right
          const cx = px - dz * offs[k], cz = pz + dx * offs[k]
          // (the shapes run 0..3.9 m forward: placed so the tip is at sTip, scaled up a little for a wide lane)
          const k2 = 1.25
          for (const poly of ARROW_SHAPES[shape]) {
            const pts = poly.map(([u, v]) => [cx + fx * (u * k2 - 3.9 * k2) + rx * v * k2, cz + fz * (u * k2 - 3.9 * k2) + rz * v * k2] as P2)
            const yy = Y_MARK + heightAt(e, sTip)
            for (let q = 1; q + 1 < pts.length; q++) marks.tri([pts[0][0], yy, pts[0][1]], [pts[q + 1][0], yy, pts[q + 1][1]], [pts[q][0], yy, pts[q][1]], WHITE)
          }
        })
      }
    }

    // ---- DO NOT ENTER: where a one-way road ends at a junction, facing anyone who would turn into it the wrong way ----
    if (e.oneway && !e.ring && !e.cls.startsWith('motorway')) { // (not round a roundabout, where every piece is one-way)
      const j = m.junctions[e.b]
      const sAt = Math.max(0, e.len - (stopDist(j, e.id) + 2))
      if (j.ends.length >= 3 && e.len > 12 && sAt >= a && sAt < b) {
        const [px, pz, dx, dz] = pointAt(e, sAt)
        // a driver turning in would travel b -> a (along -d); their right is (dz, -dx)... the sign stands on their right, facing them
        const tx = -dx, tz = -dz, rx = -tz, rz = tx
        const off = halfWidth(e, 1) + 1.1
        signs.push({ x: px + rx * off, z: pz + rz * off, y0: heightAt(e, sAt), face: [-tx, -tz], kind: 'noentry', out: [rx, rz] })
      }
    }

    // ---- speed limit signs: near the start of each long enough road, for each way it can be driven ----
    if (e.len > 130 && e.cls !== 'service' && !e.internal) {
      const mph = Math.round(e.limit / 0.44704 / 5) * 5
      for (const dir of e.oneway ? [1] : [1, -1]) {
        const s = dir === 1 ? s0 + 30 : s1 - 30
        if (s < s0 || s > s1 || s < a || s >= b) continue
        const [px, pz, dx, dz] = pointAt(e, s)
        const tx = dx * dir, tz = dz * dir // travel direction
        const off = (dir === 1 ? wR : wL) + 1.0
        signs.push({ x: px + -tz * off, z: pz + tx * off, y0: heightAt(e, s), face: [-tx, -tz], kind: mph, out: [-tz, tx] })
      }
    }
  }

  // ---- junctions: the surface where roads meet, with rounded corners; cul-de-sac bulbs; stop lines and STOP signs ----
  for (const j of m.junctions) {
    if (!inBox(box, j.x, j.z)) continue
    if (j.bulb) disc(road, j.x, j.z, j.bulb, Y_ROAD + j.y, [1, 1, 1], 28)
    // a dead end's rounded end, or a bend where two stretches of road join (fills the wedge on the outside of the bend)
    if ((j.ends.length === 1 && !j.bulb) || j.ends.length === 2) disc(road, j.x, j.z, j.r0, Y_ROAD + j.y, [1, 1, 1], 16)
    if (j.ends.length < 3) continue
    junctionSurface(road, m, j)
    // a larger intersection (a divided road crossing another): one surface over the whole of it, drawn with its first junction
    if (j.cluster >= 0 && m.clusters[j.cluster][0] === j) {
      const hull = clusterHull(m, j.cluster)
      let cx = 0, cz = 0
      for (const [x, z] of hull) { cx += x; cz += z }
      cx /= hull.length; cz /= hull.length
      const hy = Y_ROAD + m.clusters[j.cluster].reduce((t, k) => t + k.y, 0) / m.clusters[j.cluster].length
      for (let i = 0; i < hull.length; i++) { const p = hull[i], q = hull[(i + 1) % hull.length]; road.tri([cx, hy, cz], [p[0], hy, p[1]], [q[0], hy, q[1]], [1, 1, 1]) }
    }
    // stop lines and signs for each road that must stop here
    for (const { e: ei, atA } of j.ends) {
      const ctl = j.ctl.get(ei)
      if (ctl !== 'stop' && ctl !== 'signal' && ctl !== 'yield') continue
      if (!arrives(m.edges[ei], atA) || m.edges[ei].internal) continue
      const e = m.edges[ei]
      const d = endDir(e, atA) // pointing away from the junction, along the road
      const dist = stopDist(j, ei)
      if (dist > e.len - 2) continue
      // arriving traffic travels -d; its right-hand side is (d.z, -d.x)
      const rx = d[1], rz = -d[0]
      const right = atA ? halfWidth(e, -1) : halfWidth(e, 1) // (arriving at a = travelling b -> a: its right is a -> b's left)
      const c = (e.centre * e.laneW) / 2
      const inner = e.oneway ? -right + e.shoulder : c + 0.1
      const outer = right - e.shoulder
      const bx = j.x + d[0] * dist, bz = j.z + d[1] * dist
      const P = (o: number, along: number): P2 => [bx + rx * o + d[0] * along, bz + rz * o + d[1] * along]
      if (ctl === 'yield') {
        // a give-way line: white triangles across the lane ("shark's teeth"), and a YIELD sign
        for (let o = inner + 0.3; o + 0.6 < outer; o += 0.9) { const a1 = P(o, 0), a2 = P(o + 0.6, 0), tip = P(o + 0.3, 0.9); marks.tri([a1[0], Y_MARK + j.y, a1[1]], [tip[0], Y_MARK + j.y, tip[1]], [a2[0], Y_MARK + j.y, a2[1]], WHITE) }
        signs.push({ x: bx + rx * (right + 1.1) + d[0] * 0.8, z: bz + rz * (right + 1.1) + d[1] * 0.8, y0: j.y, face: [d[0], d[1]], kind: 'yield', out: [rx, rz] })
        continue
      }
      marks.quad(P(inner, 0), P(outer, 0), P(outer, 0.5), P(inner, 0.5), Y_MARK + j.y, WHITE)
      if (ctl === 'stop') signs.push({ x: bx + rx * (right + 1.1) + d[0] * 0.8, z: bz + rz * (right + 1.1) + d[1] * 0.8, y0: j.y, face: [d[0], d[1]], kind: j.allWay ? 'allway' : 'stop', out: [rx, rz] })
    }
  }

  // ---- keep every sign off the road: where junctions crowd together, move it further out, or leave it out if there is no room ----
  const placed: SignDef[] = []
  for (const s of signs) {
    for (const extra of [0, 1.5, 3]) {
      const x = s.x + (s.out?.[0] ?? 0) * extra, z = s.z + (s.out?.[1] ?? 0) * extra
      if (!onRealRoad(m, x, z, 0.3)) { placed.push({ ...s, x, z }); break }
    }
  }
  signs.length = 0
  signs.push(...placed)

  // ---- sign posts ----
  for (const s of signs) {
    solid.box(s.x, s.y0 ?? 0, s.z, 0.07, s.kind === 'stop' || s.kind === 'allway' ? 2.3 : 2.4, 0.07, POST)
  }
  return { road: road.build(), marks: marks.build(), solid: solid.build(), signs }
}

/** the surface of a junction: a fan from its centre round its outline (the roads' edges and the rounded corners between them) */
function junctionSurface(g: Geo, m: RealMap, j: Junction) {
  const ring = junctionRing(m, j)
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length]
    g.tri([j.x, Y_ROAD + j.y, j.z], [p[0], Y_ROAD + j.y, p[1]], [q[0], Y_ROAD + j.y, q[1]], [1, 1, 1])
  }
}

/* ---------------- buildings and trees ---------------- */
const WALLS: V3[] = [[0.86, 0.82, 0.72], [0.78, 0.72, 0.62], [0.9, 0.9, 0.86], [0.7, 0.76, 0.8], [0.8, 0.66, 0.56], [0.74, 0.8, 0.7], [0.92, 0.88, 0.8], [0.62, 0.42, 0.34]]
const ROOFS: V3[] = [[0.36, 0.2, 0.16], [0.26, 0.27, 0.3], [0.42, 0.3, 0.22], [0.2, 0.24, 0.28], [0.3, 0.32, 0.36]]
const hash = (x: number, z: number, k: number) => { const s = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453; return s - Math.floor(s) }

export function buildBuildings(m: RealMap, box?: Box) {
  const g = new Geo()
  for (const b of m.buildings) {
    if (!inBox(box, b.pts[0], b.pts[1])) continue
    const p = b.pts, n = p.length / 2
    let area = 0, cx = 0, cz = 0
    for (let i = 0; i < n; i++) {
      const x0 = p[i * 2], z0 = p[i * 2 + 1], x1 = p[((i + 1) % n) * 2], z1 = p[((i + 1) % n) * 2 + 1]
      area += x0 * z1 - x1 * z0; cx += x0; cz += z0
    }
    cx /= n; cz /= n
    if (Math.abs(area) < 8) continue
    const wall = WALLS[Math.floor(hash(cx, cz, 1) * WALLS.length)], roof = ROOFS[Math.floor(hash(cx, cz, 2) * ROOFS.length)]
    const H = b.h
    const out = area > 0 ? -1 : 1 // which way the outward normal points for this ring's winding
    for (let i = 0; i < n; i++) {
      const x0 = p[i * 2], z0 = p[i * 2 + 1], x1 = p[((i + 1) % n) * 2], z1 = p[((i + 1) % n) * 2 + 1]
      const L = Math.hypot(x1 - x0, z1 - z0) || 1
      const nrm: V3 = [((z1 - z0) / L) * -out, 0, ((x1 - x0) / L) * out]
      const shade = 0.8 + 0.2 * Math.abs(nrm[0])
      const c: V3 = [wall[0] * shade, wall[1] * shade, wall[2] * shade]
      g.tri([x0, 0, z0], [x1, 0, z1], [x1, H, z1], c, nrm)
      g.tri([x0, 0, z0], [x1, H, z1], [x0, H, z0], c, nrm)
    }
    // the roof: a low pitched roof on a convex footprint (most houses), flat otherwise
    let convex = true
    for (let i = 0; i < n && convex; i++) {
      const ax = p[i * 2], az = p[i * 2 + 1], bx = p[((i + 1) % n) * 2], bz = p[((i + 1) % n) * 2 + 1], qx = p[((i + 2) % n) * 2], qz = p[((i + 2) % n) * 2 + 1]
      const cr = (bx - ax) * (qz - bz) - (bz - az) * (qx - bx)
      if (cr * area < -1e-6) convex = false
    }
    if (convex && H <= 8 && n <= 12) {
      const rise = Math.min(2.6, Math.sqrt(Math.abs(area) / 2) * 0.28)
      for (let i = 0; i < n; i++) {
        const x0 = p[i * 2], z0 = p[i * 2 + 1], x1 = p[((i + 1) % n) * 2], z1 = p[((i + 1) % n) * 2 + 1]
        const s = 0.75 + 0.25 * hash(i, cx, 3)
        g.tri([x0, H, z0], [x1, H, z1], [cx, H + rise, cz], [roof[0] * s, roof[1] * s, roof[2] * s])
      }
    } else {
      const contour = []
      for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(p[i * 2], p[i * 2 + 1]))
      for (const [a, bb, c] of THREE.ShapeUtils.triangulateShape(contour, [])) {
        g.tri([p[a * 2], H, p[a * 2 + 1]], [p[bb * 2], H, p[bb * 2 + 1]], [p[c * 2], H, p[c * 2 + 1]], roof)
      }
    }
  }
  return g.build()
}

/** street trees in the front yards, and some scattered round, kept off the roads and out of the buildings */
export function placeTrees(m: RealMap, box: Box): Array<[number, number, number]> {
  const inBuilding = buildingTest(m)
  const out: Array<[number, number, number]> = []
  const ok = (x: number, z: number) => !onRealRoad(m, x, z, 2.5) && !inBuilding(x, z)
  for (const e of m.edges) {
    if (!sidewalked(e) || !overlaps(edgeBox(e), box)) continue
    for (let s = 8; s < e.len - 8; s += 16) {
      for (const side of [1, -1] as const) {
        if (hash(e.id, s, side) > 0.55) continue
        const [px, pz, dx, dz] = pointAt(e, s + hash(s, e.id, 5) * 6)
        const off = side * (halfWidth(e, side) + 4.2 + hash(e.id, s, 7) * 5)
        const x = px - dz * off, z = pz + dx * off
        if (inBox(box, x, z) && ok(x, z)) out.push([x, z, 0.8 + hash(x, z, 8) * 0.6])
      }
    }
  }
  // (about 200 a square kilometre, scattered)
  const n = Math.round(((box.x1 - box.x0) * (box.z1 - box.z0)) / 5000)
  for (let i = 0; i < n; i++) {
    const x = box.x0 + hash(i, box.x0, 9) * (box.x1 - box.x0), z = box.z0 + hash(i, box.z0, 10) * (box.z1 - box.z0)
    if (ok(x, z)) out.push([x, z, 0.8 + hash(x, z, 8) * 0.7])
  }
  return out
}
/** a quick "is this point inside a building?" test */
function buildingTest(m: RealMap) {
  const C = 40, grid = new Map<number, number[]>()
  m.buildings.forEach((b, i) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
    for (let k = 0; k < b.pts.length; k += 2) { x0 = Math.min(x0, b.pts[k]); x1 = Math.max(x1, b.pts[k]); z0 = Math.min(z0, b.pts[k + 1]); z1 = Math.max(z1, b.pts[k + 1]) }
    for (let cx = Math.floor(x0 / C); cx <= Math.floor(x1 / C); cx++) for (let cz = Math.floor(z0 / C); cz <= Math.floor(z1 / C); cz++) {
      const k = cx * 100000 + cz
      let l = grid.get(k)
      if (!l) grid.set(k, (l = []))
      l.push(i)
    }
  })
  return (x: number, z: number) => {
    const l = grid.get(Math.floor(x / C) * 100000 + Math.floor(z / C))
    if (!l) return false
    for (const i of l) {
      const p = m.buildings[i].pts, n = p.length / 2
      let inside = false
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const xa = p[a * 2], za = p[a * 2 + 1], xb = p[b * 2], zb = p[b * 2 + 1]
        if ((za > z) !== (zb > z) && x < ((xb - xa) * (z - za)) / (zb - za) + xa) inside = !inside
      }
      if (inside) return true
    }
    return false
  }
}

/* ---------------- sign pictures ---------------- */
/** the speed limits that have a sign picture (mph) */
export const LIMITS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80]
const COLS = 6, ROWS = 4
/** atlas cells: 0 STOP, 1 ALL-WAY STOP, 2.. speed limits, then YIELD and DO NOT ENTER */
const CELL_YIELD = 2 + LIMITS.length, CELL_NOENTRY = CELL_YIELD + 1
/** the sign pictures on one canvas, in a grid: STOP, STOP with the ALL-WAY plaque, and a SPEED LIMIT sign for each limit */
export function signAtlas() {
  const S = 256
  const cv = document.createElement('canvas')
  cv.width = S * COLS; cv.height = S * ROWS
  const g = cv.getContext('2d')!
  const stop = (ox: number, allWay: boolean) => {
    const cx = ox + S / 2, cy = allWay ? S * 0.4 : S / 2, R = allWay ? S * 0.38 : S * 0.47
    const oct = (r: number) => { g.beginPath(); for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + (i * Math.PI) / 4; g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r) } g.closePath() }
    g.fillStyle = '#fff'; oct(R); g.fill()
    g.fillStyle = '#c4161c'; oct(R * 0.9); g.fill()
    g.fillStyle = '#fff'; g.font = `800 ${R * 0.62}px Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('STOP', cx, cy + 2, R * 1.6)
    if (allWay) {
      g.fillStyle = '#fff'; g.fillRect(ox + S * 0.2, S * 0.8, S * 0.6, S * 0.17)
      g.fillStyle = '#c4161c'; g.fillRect(ox + S * 0.215, S * 0.81, S * 0.57, S * 0.15)
      g.fillStyle = '#fff'; g.font = `800 ${S * 0.1}px Arial, sans-serif`; g.fillText('ALL WAY', cx, S * 0.887, S * 0.54)
    }
  }
  stop(0, false)
  stop(S, true)
  {
    // YIELD: a red-edged white triangle, point down
    const ox = (CELL_YIELD % COLS) * S, oy = Math.floor(CELL_YIELD / COLS) * S
    const tri = (inset: number) => { g.beginPath(); g.moveTo(ox + S * 0.04 + inset * 1.7, oy + S * 0.1 + inset); g.lineTo(ox + S * 0.96 - inset * 1.7, oy + S * 0.1 + inset); g.lineTo(ox + S / 2, oy + S * 0.92 - inset * 2); g.closePath() }
    g.fillStyle = '#c4161c'; tri(0); g.fill()
    g.fillStyle = '#fff'; tri(S * 0.11); g.fill()
    g.fillStyle = '#c4161c'; g.font = `800 ${S * 0.13}px Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('YIELD', ox + S / 2, oy + S * 0.36)
  }
  {
    // DO NOT ENTER: a red disc with a white bar
    const ox = (CELL_NOENTRY % COLS) * S, oy = Math.floor(CELL_NOENTRY / COLS) * S, cx = ox + S / 2, cy = oy + S / 2
    g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy, S * 0.47, 0, Math.PI * 2); g.fill()
    g.fillStyle = '#c4161c'; g.beginPath(); g.arc(cx, cy, S * 0.44, 0, Math.PI * 2); g.fill()
    g.fillStyle = '#fff'; g.fillRect(cx - S * 0.33, cy - S * 0.065, S * 0.66, S * 0.13)
    g.font = `800 ${S * 0.085}px Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'
    g.fillText('DO NOT', cx, cy - S * 0.2); g.fillText('ENTER', cx, cy + S * 0.2)
  }
  LIMITS.forEach((mph, i) => {
    const c = i + 2, ox = (c % COLS) * S, oy = Math.floor(c / COLS) * S, w = S * 0.78, x0 = ox + (S - w) / 2
    g.fillStyle = '#111'; g.fillRect(x0, oy, w, S)
    g.fillStyle = '#fff'; g.fillRect(x0 + 4, oy + 4, w - 8, S - 8)
    g.strokeStyle = '#111'; g.lineWidth = 5; g.strokeRect(x0 + 12, oy + 12, w - 24, S - 24)
    g.fillStyle = '#111'; g.textAlign = 'center'; g.textBaseline = 'alphabetic'
    g.font = `800 ${S * 0.15}px Arial, sans-serif`; g.fillText('SPEED', ox + S / 2, oy + S * 0.27); g.fillText('LIMIT', ox + S / 2, oy + S * 0.43)
    g.font = `800 ${S * 0.42}px Arial, sans-serif`; g.fillText(String(mph), ox + S / 2, oy + S * 0.86)
  })
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}
export function signMesh(defs: SignDef[]) {
  const pos: number[] = [], uv: number[] = [], nor: number[] = []
  for (const s of defs) {
    const li = typeof s.kind === 'number' ? LIMITS.indexOf(Math.max(5, Math.min(80, s.kind))) : -1
    const cell = s.kind === 'stop' ? 0 : s.kind === 'allway' ? 1 : s.kind === 'yield' ? CELL_YIELD : s.kind === 'noentry' ? CELL_NOENTRY : 2 + Math.max(0, li)
    const isStop = s.kind === 'stop' || s.kind === 'allway' || s.kind === 'yield' || s.kind === 'noentry'
    const w = isStop ? 0.9 : 0.85, h = isStop ? 0.9 : 0.85
    const y = (isStop ? (s.kind === 'allway' ? 1.95 : 2.05) : 1.95) + (s.y0 ?? 0)
    const rx = s.face[1], rz = -s.face[0] // to the sign's right as you face it
    const u0 = (cell % COLS) / COLS, u1 = ((cell % COLS) + 1) / COLS
    const row = Math.floor(cell / COLS), v0 = 1 - (row + 1) / ROWS, v1 = 1 - row / ROWS // (the canvas is flipped: its top row is at v = 1)
    const BL: V3 = [s.x - rx * w / 2 + s.face[0] * 0.05, y - h / 2, s.z - rz * w / 2 + s.face[1] * 0.05]
    const BR: V3 = [s.x + rx * w / 2 + s.face[0] * 0.05, y - h / 2, s.z + rz * w / 2 + s.face[1] * 0.05]
    const TR: V3 = [BR[0], y + h / 2, BR[2]], TL: V3 = [BL[0], y + h / 2, BL[2]]
    for (const [p, u, v] of [[BL, u0, v0], [BR, u1, v0], [TR, u1, v1], [BL, u0, v0], [TR, u1, v1], [TL, u0, v1]] as Array<[V3, number, number]>) {
      pos.push(...p); uv.push(u, v); nor.push(s.face[0], 0, s.face[1])
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  return g
}

