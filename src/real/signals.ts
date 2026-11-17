/**
 * Real places: traffic lights. Junctions controlled by lights are grouped into controllers: where a divided road crosses another,
 * its two carriageways make several junctions a few metres apart, and they all change together. Each controller runs a simple
 * two-phase cycle: one direction of travel (the "axis") has green, then amber, then all red, then the other direction has its turn.
 * A controller's timing comes from where it is, so it stays the same when more of the map arrives.
 */
import { endDir, type Junction, type RealMap } from './roads'

export type Light = 'G' | 'Y' | 'R'
export interface Controller { id: number; x: number; z: number; offset: number; greenA: number; greenB: number }
interface SigInfo { ctl: Controller; axis: Map<number, 0 | 1> }

const YELLOW = 4, ALL_RED = 2
let cache: { m: RealMap; info: Map<Junction, SigInfo>; ctls: Controller[] } | null = null

function build(m: RealMap) {
  const lit = m.junctions.filter((j) => [...j.ctl.values()].includes('signal'))
  // group lit junctions less than 45 m apart
  const parent = lit.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let a = 0; a < lit.length; a++) for (let b = a + 1; b < lit.length; b++) {
    if (Math.hypot(lit[a].x - lit[b].x, lit[a].z - lit[b].z) < 45) parent[find(a)] = find(b)
  }
  const groups = new Map<number, Junction[]>()
  lit.forEach((j, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), j]) })
  const info = new Map<Junction, SigInfo>()
  const ctls: Controller[] = []
  for (const js of groups.values()) {
    const x = js.reduce((t, j) => t + j.x, 0) / js.length, z = js.reduce((t, j) => t + j.z, 0) / js.length
    // a steady "random" timing from the position (in degrees, so it does not depend on where the drive started)
    const lat = Math.round((m.lat0 - z / m.kz) * 1e4), lon = Math.round((m.lon0 + x / m.kx) * 1e4)
    const h = Math.abs(Math.sin(lat * 12.9898 + lon * 78.233) * 43758.5453) % 1
    const ctl: Controller = { id: ctls.length, x, z, offset: h * 60, greenA: 22 + Math.round(h * 8), greenB: 16 + Math.round(((h * 7) % 1) * 8) }
    ctls.push(ctl)
    // the two directions: the first approach's line, and everything across it
    let ref: [number, number] | null = null
    for (const j of js) {
      const axis = new Map<number, 0 | 1>()
      for (const { e, atA } of j.ends) {
        if (j.ctl.get(e) !== 'signal') continue
        const d = endDir(m.edges[e], atA)
        if (!ref) ref = d
        const along = Math.abs(d[0] * ref[0] + d[1] * ref[1])
        axis.set(e, along > Math.SQRT1_2 ? 0 : 1)
      }
      info.set(j, { ctl, axis })
    }
  }
  cache = { m, info, ctls }
  return cache
}
const get = (m: RealMap) => (cache && cache.m === m ? cache : build(m))

/** the controllers on this map (for drawing the lights) */
export function controllers(m: RealMap) { return get(m).ctls }

/** what a controller shows to one direction of travel at time t */
export function lightOf(ctl: Controller, axis: 0 | 1, t: number): Light {
  const cycle = ctl.greenA + YELLOW + ALL_RED + ctl.greenB + YELLOW + ALL_RED
  const u = (((t + ctl.offset) % cycle) + cycle) % cycle
  const a = u < ctl.greenA ? 'G' : u < ctl.greenA + YELLOW ? 'Y' : u < ctl.greenA + YELLOW + ALL_RED ? 'R' : null
  if (a) return axis === 0 ? a : 'R'
  const v = u - ctl.greenA - YELLOW - ALL_RED
  const b: Light = v < ctl.greenB ? 'G' : v < ctl.greenB + YELLOW ? 'Y' : 'R'
  return axis === 1 ? b : 'R'
}
/** the light facing traffic arriving at junction j along edge e (null if that approach has no light) */
export function lightFor(m: RealMap, j: Junction, e: number, t: number): Light | null {
  const s = get(m).info.get(j)
  const ax = s?.axis.get(e)
  return s && ax !== undefined ? lightOf(s.ctl, ax, t) : null
}
/** the controller and direction for an approach (for drawing its light) */
export function signalOf(m: RealMap, j: Junction, e: number): { ctl: Controller; axis: 0 | 1 } | null {
  const s = get(m).info.get(j)
  const ax = s?.axis.get(e)
  return s && ax !== undefined ? { ctl: s.ctl, axis: ax } : null
}
