import { sim } from '../game/sim'
import { REAL } from './load'
import { ROUTE, routeXY } from './route'
import { halfWidth, stopDist, type RealMap } from './roads'

/**
 * The centre screen's map for a real place: heading-up, the roads drawn to width (main roads lighter), the street names along them,
 * buildings, STOP-controlled approaches marked red, and your car.
 */
let cache: { m: RealMap; roads: Path2D; main: Path2D; buildings: Path2D } | null = null
function paths(m: RealMap) {
  if (cache && cache.m === m) return cache
  const roads = new Path2D(), main = new Path2D(), buildings = new Path2D()
  for (const e of m.edges) {
    const p = e.cls === 'residential' || e.cls === 'service' || e.cls === 'living_street' || e.cls === 'unclassified' ? roads : main
    p.moveTo(e.pts[0], e.pts[1])
    for (let k = 2; k < e.pts.length; k += 2) p.lineTo(e.pts[k], e.pts[k + 1])
  }
  for (const b of m.buildings) {
    buildings.moveTo(b.pts[0], b.pts[1])
    for (let k = 2; k < b.pts.length; k += 2) buildings.lineTo(b.pts[k], b.pts[k + 1])
    buildings.closePath()
  }
  cache = { m, roads, main, buildings }
  return cache
}

export function drawRealMap(g: CanvasRenderingContext2D, w: number, h: number) {
  const m = REAL.map
  g.fillStyle = '#0d141e'
  g.fillRect(0, 0, w, h)
  if (!m) return
  const p = paths(m)
  const S = 2.6 * (1 - Math.min(0.4, sim.speed / 50)) // pixels per metre (zooms out a little with speed)
  const cx = w * 0.5, cy = h * 0.66
  g.save()
  g.translate(cx, cy)
  g.scale(S, S)
  g.rotate(sim.h) // heading up
  g.translate(-sim.x, -sim.z)
  g.fillStyle = '#1c2633'
  g.fill(p.buildings)
  g.lineCap = 'round'; g.lineJoin = 'round'
  g.strokeStyle = '#5d6b7e'; g.lineWidth = 9; g.stroke(p.roads)
  g.strokeStyle = '#9aa8ba'; g.lineWidth = 13; g.stroke(p.main)
  // the route still to drive (blue, edged white), and the destination
  const rp = routeXY()
  if (rp && !ROUTE.arrived) {
    const r = ROUTE.route!
    let k = Math.max(0, ROUTE.seg)
    const line = new Path2D()
    line.moveTo(sim.x, sim.z)
    for (k = k + 1; k < rp.length / 2; k++) { line.lineTo(rp[k * 2], rp[k * 2 + 1]); if (r.cum[k] - ROUTE.s > 3000) break }
    g.strokeStyle = '#fff'; g.lineWidth = 9; g.stroke(line)
    g.strokeStyle = '#0b5cff'; g.lineWidth = 6; g.stroke(line)
    const ex = rp[rp.length - 2], ez = rp[rp.length - 1]
    g.fillStyle = '#e11d48'; g.strokeStyle = '#fff'; g.lineWidth = 2
    g.beginPath(); g.arc(ex, ez, 6, 0, Math.PI * 2); g.fill(); g.stroke()
  }
  // STOP-controlled approaches: a short red bar at the stop line
  g.strokeStyle = '#ff4d4d'; g.lineWidth = 2.2
  for (const j of m.junctions) {
    if (Math.abs(j.x - sim.x) > 260 || Math.abs(j.z - sim.z) > 260) continue
    for (const { e: ei, atA } of j.ends) {
      if (j.ctl.get(ei) !== 'stop') continue
      const e = m.edges[ei]
      const k = atA ? 2 : e.pts.length - 4
      const dx = e.pts[k] - e.pts[atA ? 0 : e.pts.length - 2], dz = e.pts[k + 1] - e.pts[atA ? 1 : e.pts.length - 1]
      const L = Math.hypot(dx, dz) || 1, ux = dx / L, uz = dz / L
      const d = stopDist(j, ei), wR = atA ? halfWidth(e, -1) : halfWidth(e, 1)
      const bx = j.x + ux * d, bz = j.z + uz * d
      g.beginPath(); g.moveTo(bx, bz); g.lineTo(bx + uz * wR, bz - ux * wR); g.stroke()
    }
  }
  g.restore()
  // street names, upright, along the nearby roads
  g.fillStyle = 'rgba(230,238,248,.85)'; g.font = '600 13px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'
  const seen = new Set<string>()
  const ch = Math.cos(sim.h), sh = Math.sin(sim.h)
  for (const e of m.edges) {
    if (!e.name || seen.has(e.name) || e.len < 60) continue
    const k = Math.floor(e.pts.length / 4) * 2
    const x = e.pts[k] - sim.x, z = e.pts[k + 1] - sim.z
    const sx = cx + (x * ch - z * sh) * S, sy = cy + (x * sh + z * ch) * S
    if (sx < 40 || sx > w - 40 || sy < 20 || sy > h - 20) continue
    seen.add(e.name)
    g.fillText(e.name, sx, sy)
  }
  // you
  g.save(); g.translate(cx, cy)
  g.fillStyle = '#0b5cff'; g.strokeStyle = '#fff'; g.lineWidth = 2.5
  g.beginPath(); g.moveTo(0, -13); g.lineTo(9, 11); g.lineTo(0, 6); g.lineTo(-9, 11); g.closePath(); g.fill(); g.stroke()
  g.restore()
}
