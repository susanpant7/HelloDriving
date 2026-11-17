import * as THREE from 'three'
import { FILLET, endDir, halfWidth, junctionRing, onRealRoad, pointAt, type Edge, type Junction, type RealMap } from './roads'

/**
 * A real place, drawn from its map data: the road surface (with rounded kerb corners and cul-de-sac bulbs), kerbs and sidewalks,
 * the lane paint the US uses on each kind of road, stop lines with STOP signs, speed-limit signs, buildings and trees.
 */

type V3 = [number, number, number]
type P2 = [number, number]
const WHITE: V3 = [0.92, 0.92, 0.9], YELLOW: V3 = [0.95, 0.75, 0.1]
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

/** the centre-line between s0 and s1 (m along the edge), as points */
function sub(e: Edge, s0: number, s1: number): P2[] {
  if (s1 - s0 < 0.05) return []
  const a = pointAt(e, s0), b = pointAt(e, s1)
  const out: P2[] = [[a[0], a[1]]]
  for (let k = 1; k < e.cum.length - 1; k++) if (e.cum[k] > s0 + 0.05 && e.cum[k] < s1 - 0.05) out.push([e.pts[k * 2], e.pts[k * 2 + 1]])
  out.push([b[0], b[1]])
  return out
}
/** a strip following a line, between offsets o1 and o2 to its right (m), with mitred corners */
function strip(g: Geo, line: P2[], o1: number, o2: number, y: number, color: V3) {
  if (line.length < 2) return
  const nrm: P2[] = []
  for (let i = 0; i < line.length; i++) {
    const p = line[Math.max(0, i - 1)], q = line[Math.min(line.length - 1, i + 1)]
    // average of the neighbouring stretches' right-hand normals, lengthened at a bend so the strip keeps its width
    let nx = 0, nz = 0
    const seg = (u: P2, v: P2) => { const dx = v[0] - u[0], dz = v[1] - u[1], L = Math.hypot(dx, dz) || 1; return [-dz / L, dx / L] as P2 }
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
    g.quad([a[0] + na[0] * o1, a[1] + na[1] * o1], [a[0] + na[0] * o2, a[1] + na[1] * o2], [b[0] + nb[0] * o2, b[1] + nb[1] * o2], [b[0] + nb[0] * o1, b[1] + nb[1] * o1], y, color)
  }
}
/** a dashed line: 3 m paint, 9 m gap (the US 10 ft / 30 ft pattern) */
function dashes(g: Geo, e: Edge, s0: number, s1: number, o: number, color: V3, w = 0.12) {
  for (let s = s0 + 1; s < s1 - 1; s += 12) strip(g, sub(e, s, Math.min(s + 3, s1)), o - w / 2, o + w / 2, Y_MARK, color)
}
function disc(g: Geo, x: number, z: number, r: number, y: number, color: V3, n = 20) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2
    g.tri([x, y, z], [x + Math.cos(a1) * r, y, z + Math.sin(a1) * r], [x + Math.cos(a0) * r, y, z + Math.sin(a0) * r], color)
  }
}

/** how far from each end of an edge the junction (and its rounded corners) reaches: paint, kerbs and sidewalks stop there */
function trims(m: RealMap, e: Edge) {
  const at = (j: Junction) => (j.ends.length >= 3 ? j.r + FILLET + 1 : j.bulb ? j.bulb - 1 : 0)
  return [at(m.junctions[e.a]), at(m.junctions[e.b])]
}
const sidewalked = (e: Edge) => e.cls === 'residential' || e.cls === 'unclassified' || e.cls === 'living_street' || e.cls === 'tertiary' || e.cls === 'secondary' || e.cls === 'primary'
const isMainRoad = (e: Edge) => e.cls === 'tertiary' || e.cls === 'secondary' || e.cls === 'primary' || e.cls === 'trunk' || e.cls === 'motorway' || e.cls.endsWith('_link')

/** where each sign goes (and which picture), worked out once per area */
export interface SignDef { x: number; z: number; face: P2; kind: 'stop' | 'allway' | number; /** the way away from the road (to move it clear) */ out?: P2 }

/** a tile's box (m): what lies in it is built with it */
export interface Box { x0: number; x1: number; z0: number; z1: number }
const inBox = (b: Box | undefined, x: number, z: number) => !b || (x >= b.x0 && x < b.x1 && z >= b.z0 && z < b.z1)
/** the tile an edge belongs to: where its middle is */
const edgeIn = (b: Box | undefined, e: Edge) => { if (!b) return true; const p = pointAt(e, e.len / 2); return inBox(b, p[0], p[1]) }

/**
 * A fingerprint of what a tile's roads look like, so a tile is only rebuilt when a newly arrived neighbour changed it (a road
 * crossing the tile edge now meets a junction, a stop sign was worked out differently...).
 */
export function tileSignature(m: RealMap, b: Box) {
  const parts: string[] = []
  for (const e of m.edges) if (edgeIn(b, e)) parts.push(`${e.pts[0].toFixed(1)},${e.pts[1].toFixed(1)},${e.len.toFixed(1)},${e.lanesF}${e.lanesB}${e.centre},${e.cls},${Math.round(e.limit)}`)
  for (const j of m.junctions) if (j.ends.length && inBox(b, j.x, j.z)) parts.push(`J${j.x.toFixed(1)},${j.z.toFixed(1)},${j.ends.length},${j.bulb},${[...j.ctl.values()].join('')}`)
  parts.sort()
  return parts.join('|')
}

export function buildRoads(m: RealMap, box?: Box) {
  const road = new Geo(), marks = new Geo(), solid = new Geo()
  const signs: SignDef[] = []

  for (const e of m.edges) {
    if (!edgeIn(box, e)) continue
    const wR = halfWidth(e, 1), wL = halfWidth(e, -1)
    const line = sub(e, 0, e.len)
    strip(road, line, -wL, wR, Y_ROAD, [1, 1, 1])
    const [t0, t1] = trims(m, e)
    const s0 = Math.min(t0, e.len / 2), s1 = Math.max(e.len - t1, e.len / 2)

    // ---- kerbs and sidewalks (a grass strip between the kerb and the sidewalk) ----
    if (sidewalked(e) && s1 - s0 > 4) {
      const divided = e.oneway && !e.cls.endsWith('_link')
      for (const side of divided ? [1] : [1, -1]) {
        const w = side === 1 ? wR : wL
        const l = sub(e, s0, s1)
        if (side === 1) { strip(solid, l, w, w + 0.25, Y_WALK, KERB); strip(solid, l, w + 1.6, w + 3.1, Y_WALK, WALK) }
        else { strip(solid, l, -w - 0.25, -w, Y_WALK, KERB); strip(solid, l, -w - 3.1, -w - 1.6, Y_WALK, WALK) }
      }
    }

    // ---- lane paint ----
    if (s1 - s0 > 2) {
      const main = isMainRoad(e)
      if (e.oneway) {
        // a one-way carriageway: yellow line on the left edge, white on the right, dashes between its lanes
        const half = (e.lanesF * e.laneW) / 2
        if (main) {
          strip(marks, sub(e, s0, s1), -half + 0.05, -half + 0.2, Y_MARK, YELLOW)
          strip(marks, sub(e, s0, s1), half - 0.2, half - 0.05, Y_MARK, WHITE)
        }
        for (let k = 1; k < e.lanesF; k++) dashes(marks, e, s0, s1, -half + k * e.laneW, WHITE)
      } else {
        // a two-way road: double yellow down the middle (a centre turn lane gets a yellow line on each side), dashes between lanes
        // going the same way, white edge lines on main roads. Quiet residential streets have no paint, as in most US towns.
        const c = (e.centre * e.laneW) / 2
        if (main || e.lanesF + e.lanesB > 2) {
          if (e.centre) {
            for (const sd of [1, -1]) {
              strip(marks, sub(e, s0, s1), sd * c - 0.07, sd * c + 0.07, Y_MARK, YELLOW)
              dashes(marks, e, s0, s1, sd * (c - 0.25), YELLOW, 0.12)
            }
          } else {
            strip(marks, sub(e, s0, s1), -0.22, -0.08, Y_MARK, YELLOW)
            strip(marks, sub(e, s0, s1), 0.08, 0.22, Y_MARK, YELLOW)
          }
          for (let k = 1; k < e.lanesF; k++) dashes(marks, e, s0, s1, c + k * e.laneW, WHITE)
          for (let k = 1; k < e.lanesB; k++) dashes(marks, e, s0, s1, -(c + k * e.laneW), WHITE)
          if (main) {
            const ef = c + e.lanesF * e.laneW, eb = c + e.lanesB * e.laneW
            strip(marks, sub(e, s0, s1), ef - 0.15, ef, Y_MARK, WHITE)
            strip(marks, sub(e, s0, s1), -eb, -eb + 0.15, Y_MARK, WHITE)
          }
        }
      }
    }

    // ---- speed limit signs: near the start of each long enough road, for each way it can be driven ----
    if (e.len > 130 && e.cls !== 'service') {
      const mph = Math.round(e.limit / 0.44704 / 5) * 5
      for (const dir of e.oneway ? [1] : [1, -1]) {
        const s = dir === 1 ? s0 + 30 : s1 - 30
        if (s < s0 || s > s1) continue
        const [px, pz, dx, dz] = pointAt(e, s)
        const tx = dx * dir, tz = dz * dir // travel direction
        const off = (dir === 1 ? wR : wL) + 1.0
        signs.push({ x: px + -tz * off, z: pz + tx * off, face: [-tx, -tz], kind: mph, out: [-tz, tx] })
      }
    }
  }

  // ---- junctions: the surface where roads meet, with rounded corners; cul-de-sac bulbs; stop lines and STOP signs ----
  for (const j of m.junctions) {
    if (!inBox(box, j.x, j.z)) continue
    if (j.bulb) disc(road, j.x, j.z, j.bulb, Y_ROAD, [1, 1, 1], 28)
    // a dead end's rounded end, or a bend where two stretches of road join (fills the wedge on the outside of the bend)
    if ((j.ends.length === 1 && !j.bulb) || j.ends.length === 2) disc(road, j.x, j.z, j.r0, Y_ROAD, [1, 1, 1], 16)
    if (j.ends.length < 3) continue
    junctionSurface(road, m, j)
    // stop lines and signs for each road that must stop here
    for (const { e: ei, atA } of j.ends) {
      const ctl = j.ctl.get(ei)
      if (ctl !== 'stop' && ctl !== 'signal') continue
      const e = m.edges[ei]
      const d = endDir(e, atA) // pointing away from the junction, along the road
      const dist = j.r + 1.2
      if (dist > e.len - 2) continue
      // arriving traffic travels -d; its right-hand side is (d.z, -d.x)
      const rx = d[1], rz = -d[0]
      const right = atA ? halfWidth(e, -1) : halfWidth(e, 1) // (arriving at a = travelling b -> a: its right is a -> b's left)
      const c = (e.centre * e.laneW) / 2
      const inner = e.oneway ? -right + e.shoulder : c + 0.1
      const outer = right - e.shoulder
      const bx = j.x + d[0] * dist, bz = j.z + d[1] * dist
      const P = (o: number, along: number): P2 => [bx + rx * o + d[0] * along, bz + rz * o + d[1] * along]
      marks.quad(P(inner, 0), P(outer, 0), P(outer, 0.5), P(inner, 0.5), Y_MARK, WHITE)
      if (ctl === 'stop') signs.push({ x: bx + rx * (right + 1.1) + d[0] * 0.8, z: bz + rz * (right + 1.1) + d[1] * 0.8, face: [d[0], d[1]], kind: j.allWay ? 'allway' : 'stop', out: [rx, rz] })
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
    solid.box(s.x, 0, s.z, 0.07, s.kind === 'stop' || s.kind === 'allway' ? 2.3 : 2.4, 0.07, POST)
  }
  return { road: road.build(), marks: marks.build(), solid: solid.build(), signs }
}

/** the surface of a junction: a fan from its centre round its outline (the roads' edges and the rounded corners between them) */
function junctionSurface(g: Geo, m: RealMap, j: Junction) {
  const ring = junctionRing(m, j)
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length]
    g.tri([j.x, Y_ROAD, j.z], [p[0], Y_ROAD, p[1]], [q[0], Y_ROAD, q[1]], [1, 1, 1])
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
    if (!sidewalked(e) || !edgeIn(box, e)) continue
    for (let s = 8; s < e.len - 8; s += 16) {
      for (const side of [1, -1] as const) {
        if (hash(e.id, s, side) > 0.55) continue
        const [px, pz, dx, dz] = pointAt(e, s + hash(s, e.id, 5) * 6)
        const off = side * (halfWidth(e, side) + 4.2 + hash(e.id, s, 7) * 5)
        const x = px - dz * off, z = pz + dx * off
        if (ok(x, z)) out.push([x, z, 0.8 + hash(x, z, 8) * 0.6])
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
const COLS = 6, ROWS = 3
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
    const cell = s.kind === 'stop' ? 0 : s.kind === 'allway' ? 1 : 2 + Math.max(0, li)
    const isStop = s.kind === 'stop' || s.kind === 'allway'
    const w = isStop ? 0.9 : 0.85, h = isStop ? 0.9 : 0.85
    const y = isStop ? (s.kind === 'allway' ? 1.95 : 2.05) : 1.95
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

