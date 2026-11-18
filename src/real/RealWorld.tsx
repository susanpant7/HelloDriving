import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { quality } from '../game/quality'
import { sim } from '../game/sim'
import { useGame } from '../game/store'
import { REAL, tileBoxes, type Place } from './load'
import { disposeLabels, labelMeshes } from './labels'
import { RealLights } from './RealLights'
import { buildBuildings, buildRoads, placeTrees, signAtlas, signMesh, tileSignature, type Box } from './realBuild'

type Mats = ReturnType<typeof makeMats>
function makeMats(maxAniso: number) {
  const atlas = signAtlas()
  atlas.anisotropy = Math.min(16, maxAniso)
  const sign = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.55 })
  // the back of a sign is bare grey metal (the same shape, no picture)
  sign.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n  if (!gl_FrontFacing) diffuseColor.rgb = vec3(0.42, 0.44, 0.46);') }
  sign.customProgramCacheKey = () => 'real-sign-plain-back'
  const trunk = new THREE.CylinderGeometry(0.2, 0.28, 3, 6); trunk.translate(0, 1.5, 0)
  const crown = new THREE.IcosahedronGeometry(2.6, 1); crown.translate(0, 4.8, 0)
  return {
    atlas, sign, trunk, crown,
    road: new THREE.MeshStandardMaterial({ color: '#3b3e45', roughness: 0.92 }),
    marks: new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    solid: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    buildings: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }),
    trunkMat: new THREE.MeshStandardMaterial({ color: '#4a3524', roughness: 1 }),
    crownMat: new THREE.MeshStandardMaterial({ color: '#3a7334', roughness: 0.95, flatShading: true }),
  }
}

/** everything in one tile: road, paint, kerbs and sidewalks, signs, buildings, trees */
function buildTile(m: NonNullable<typeof REAL.map>, box: Box, mats: Mats) {
  const roads = buildRoads(m, box)
  const g = new THREE.Group()
  const geos = [roads.road, roads.marks, roads.solid, signMesh(roads.signs), buildBuildings(m, box)]
  const [road, marks, solid, signs, buildings] = geos
  g.add(Object.assign(new THREE.Mesh(road, mats.road), { receiveShadow: true }))
  const mk = new THREE.Mesh(marks, mats.marks); mk.renderOrder = 1; g.add(mk)
  g.add(new THREE.Mesh(solid, mats.solid))
  g.add(new THREE.Mesh(signs, mats.sign))
  const b = new THREE.Mesh(buildings, mats.buildings); b.layers.set(4); g.add(b) // (scenery: the mirrors show it only on high graphics)
  const trees = placeTrees(m, box)
  const inst: THREE.InstancedMesh[] = []
  if (trees.length) {
    const m1 = new THREE.InstancedMesh(mats.trunk, mats.trunkMat, trees.length)
    const m2 = new THREE.InstancedMesh(mats.crown, mats.crownMat, trees.length)
    const mt = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3()
    trees.forEach(([x, z, k], i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * 1.7)
      mt.compose(p.set(x, 0, z), q, sc.set(k, k * (0.9 + (i % 5) * 0.06), k))
      m1.setMatrixAt(i, mt); m2.setMatrixAt(i, mt)
    })
    for (const t of [m1, m2]) { t.layers.set(4); t.computeBoundingSphere(); g.add(t); inst.push(t) }
  }
  // route shields, numbers painted in the lanes, street-name blades
  const lab = labelMeshes(roads.labels)
  g.add(lab.group)
  return { group: g, dispose: () => { geos.forEach((x) => x.dispose()); inst.forEach((t) => t.dispose()); lab.dispose() } }
}

/** the cells built so far (kept between renders), for the place they were built for */
const built = new Map<string, { sig: string; group: THREE.Group; dispose: () => void }>()
let builtFor: Place | null = null
/** the 3D world is built in square cells of this size (m) */
const CELL = 160

/**
 * The real place being driven, built as you go: only the cells you could see (the view distance of the graphics setting, all round,
 * so the mirrors are filled too) plus a margin. As the car moves, the nearest missing cells are built (a few milliseconds' worth
 * each frame, so driving stays smooth) and the ones left behind are taken away. A cell is also rebuilt when newly downloaded map
 * changes its roads (a road crossing into it now meets a junction there).
 */
export function RealWorld() {
  const maxAniso = useThree((s) => s.gl.capabilities.getMaxAnisotropy())
  const mats = useMemo(() => makeMats(maxAniso), [maxAniso])
  const root = useMemo(() => new THREE.Group(), [])
  const plan = useMemo(() => ({ x: NaN, z: NaN, v: -1, t: 0, list: [] as Array<{ key: string; box: Box }> }), [])

  const drop = (key: string) => { const t = built.get(key); if (t) { root.remove(t.group); t.dispose(); built.delete(key) } }
  const clear = () => { for (const k of [...built.keys()]) drop(k) }

  /** which cells there should be round the car now, and which of those need (re)building */
  const replan = (m: NonNullable<typeof REAL.map>, version: number) => {
    const fresh = version !== plan.v
    Object.assign(plan, { x: sim.x, z: sim.z, v: version, t: 0 })
    const R = quality().far + 80
    const tiles = tileBoxes()
    // a cell is built if it is inside a downloaded tile, or if a downloaded road reaches into it (a road is downloaded whole, so it
    // often runs on past the edge of its tile: it must not stop dead there)
    const inTile = (b: Box) => tiles.some((t) => b.x0 < t.x1 && b.x1 > t.x0 && b.z0 < t.z1 && b.z1 > t.z0)
    const hasMap = (b: Box) => inTile(b) || tileSignature(m, b) !== ''
    const dist = (b: Box) => Math.hypot(Math.max(b.x0 - sim.x, 0, sim.x - b.x1), Math.max(b.z0 - sim.z, 0, sim.z - b.z1))
    // left behind (with a cell's slack, so a cell at the edge does not flicker in and out), or its map dropped: taken away
    for (const key of [...built.keys()]) {
      const [i, j] = key.split(',').map(Number)
      const b = { x0: i * CELL, x1: (i + 1) * CELL, z0: j * CELL, z1: (j + 1) * CELL }
      if (dist(b) > R + CELL || !hasMap(b)) drop(key)
    }
    const list: Array<{ key: string; box: Box; d: number }> = []
    const r = Math.ceil(R / CELL)
    const ci = Math.floor(sim.x / CELL), cj = Math.floor(sim.z / CELL)
    for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
      const box = { x0: i * CELL, x1: (i + 1) * CELL, z0: j * CELL, z1: (j + 1) * CELL }
      const d = dist(box)
      if (d > R || !hasMap(box)) continue
      const key = `${i},${j}`
      const have = built.get(key)
      if (have && (!fresh || have.sig === tileSignature(m, box))) continue
      list.push({ key, box, d })
    }
    plan.list = list.sort((a, b) => a.d - b.d)
  }

  useFrame((_, dt) => {
    if (REAL.place !== builtFor) { clear(); disposeLabels(); builtFor = REAL.place; plan.v = -1 }
    const m = REAL.map
    if (!m) { if (built.size) clear(); return }
    const version = useGame.getState().real.version
    plan.t += dt
    if (version !== plan.v || plan.t > 1 || !(Math.hypot(sim.x - plan.x, sim.z - plan.z) < 30)) replan(m, version)
    // build the nearest missing cells, a few milliseconds' worth a frame
    const t0 = performance.now()
    while (plan.list.length && performance.now() - t0 < 4) {
      const next = plan.list.shift()!
      drop(next.key)
      const t = buildTile(m, next.box, mats)
      root.add(t.group)
      built.set(next.key, { ...t, sig: tileSignature(m, next.box) })
    }
  })
  useEffect(() => () => {
    clear(); disposeLabels(); builtFor = null
    for (const v of Object.values(mats)) (v as { dispose?: () => void }).dispose?.()
  }, [mats])

  return (
    <>
      <primitive object={root} />
      <RealLights />
    </>
  )
}

if (typeof window !== 'undefined') Object.assign(window, { __cells: built }) // (for debugging in the console)
