import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { sim } from '../game/sim'
import { useGame } from '../game/store'
import { REAL, tileBoxes, type Place } from './load'
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
  return { group: g, dispose: () => { geos.forEach((x) => x.dispose()); inst.forEach((t) => t.dispose()) } }
}

/** the tiles built so far (kept between renders), for the place they were built for */
const built = new Map<string, { sig: string; group: THREE.Group; dispose: () => void }>()
let builtFor: Place | null = null

/**
 * The real place being driven, tile by tile. When a tile arrives it is built, and so is any neighbour whose roads it changed (a road
 * crossing the tile edge now meets a junction there): one tile per frame, so driving stays smooth while the map loads.
 */
export function RealWorld() {
  const version = useGame((s) => s.real.version)
  const maxAniso = useThree((s) => s.gl.capabilities.getMaxAnisotropy())
  const mats = useMemo(() => makeMats(maxAniso), [maxAniso])
  const root = useMemo(() => new THREE.Group(), [])
  const work = useMemo(() => ({ list: [] as Array<{ key: string; box: Box; sig: string }> }), [])

  const clear = () => { for (const t of built.values()) { root.remove(t.group); t.dispose() } built.clear() }
  // which tiles need building
  useEffect(() => {
    if (REAL.place !== builtFor) { clear(); builtFor = REAL.place }
    const m = REAL.map
    if (!m) { clear(); work.list = []; return }
    work.list = []
    for (const b of tileBoxes()) {
      const sig = tileSignature(m, b)
      if (built.get(b.key)?.sig !== sig) work.list.push({ key: b.key, box: b, sig })
    }
    // the tiles nearest the car first
    const d = (b: Box) => Math.hypot((b.x0 + b.x1) / 2 - sim.x, (b.z0 + b.z1) / 2 - sim.z)
    work.list.sort((u, v) => d(u.box) - d(v.box))
  }, [version])
  useFrame(() => {
    const m = REAL.map
    const next = work.list.shift()
    if (!m || !next) return
    const old = built.get(next.key)
    if (old) { root.remove(old.group); old.dispose() }
    const t = buildTile(m, next.box, mats)
    root.add(t.group)
    built.set(next.key, { ...t, sig: next.sig })
  })
  useEffect(() => () => {
    clear(); builtFor = null
    for (const v of Object.values(mats)) (v as { dispose?: () => void }).dispose?.()
  }, [mats])

  return (
    <>
      <primitive object={root} />
      <RealLights />
    </>
  )
}
