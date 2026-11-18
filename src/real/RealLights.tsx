import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { sim } from '../game/sim'
import { useGame } from '../game/store'
import { REAL } from './load'
import { endDir, halfWidth, laneOffsets, onRealRoad, stopDist } from './roads'
import { lightOf, signalOf, type Controller } from './signals'

/**
 * The traffic lights of a real place, US style: for each road arriving at a junction with lights, a pole on the far corner with a
 * mast arm over the road and a three-lamp head above each of its lanes, facing the arriving traffic (or, where the far corner is
 * taken by another road, a single head on a pole on the near corner). The lamps are lit from the controllers every frame.
 */
interface Head { x: number; y: number; z: number; yaw: number; ctl: Controller; axis: 0 | 1 }

const LIT = [new THREE.Color('#ff2a1a'), new THREE.Color('#ffb300'), new THREE.Color('#22e06b')]
const BLACK = new THREE.Color('#000000')
const DARK = [new THREE.Color('#2b0e0c'), new THREE.Color('#2b230c'), new THREE.Color('#0c2614')]
const POLE = new THREE.Color('#5d6168'), HOUSING = new THREE.Color('#2a2c30'), PLATE = new THREE.Color('#141518'), PLATE_EDGE = new THREE.Color('#e8c21a')

function build() {
  const m = REAL.map
  const heads: Head[] = []
  const parts: THREE.BufferGeometry[] = []
  if (!m) return { heads, geo: null }
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, yaw: number, col: THREE.Color) => {
    const g = new THREE.BoxGeometry(w, h, d).toNonIndexed()
    g.rotateY(yaw); g.translate(x, y, z)
    const n = g.getAttribute('position').count
    const c = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3))
    parts.push(g)
  }
  for (const j of m.junctions) {
    for (const { e: ei, atA } of j.ends) {
      const sg = signalOf(m, j, ei)
      if (!sg) continue
      const e = m.edges[ei]
      const d = endDir(e, atA) // back along the arriving road (the way the lights face)
      const tx = -d[0], tz = -d[1] // travel
      const rx = -tz, rz = tx // to the right of travel
      const dirArr: 1 | -1 = atA ? -1 : 1
      const right = atA ? halfWidth(e, -1) : halfWidth(e, 1)
      const lats = laneOffsets(e, dirArr).map((o) => o * dirArr) // lane centres, to the right of travel
      if (!lats.length) continue
      const yaw = Math.atan2(d[0], d[1]) // (the head's front faces the arriving drivers)
      const stop = stopDist(j, ei)
      /** a signal head: a black backplate with a yellow border (as in Texas), the housing, and its three lamps */
      const head = (hx: number, hy: number, hz: number) => {
        box(0.86, 1.86, 0.04, hx - d[0] * 0.02, hy, hz - d[1] * 0.02, yaw, PLATE_EDGE)
        box(0.76, 1.76, 0.05, hx, hy, hz, yaw, PLATE)
        box(0.5, 1.45, 0.34, hx + d[0] * 0.18, hy, hz + d[1] * 0.18, yaw, HOUSING)
        heads.push({ x: hx + d[0] * 0.36, y: hy, z: hz + d[1] * 0.36, yaw, ctl: sg.ctl, axis: sg.axis })
      }
      // the far corner, across the junction: a pole with a mast arm, one head over each lane
      const fx = j.x + tx * (stop - 0.5), fz = j.z + tz * (stop - 0.5)
      const px = fx + rx * (right + 1.6), pz = fz + rz * (right + 1.6)
      if (!onRealRoad(m, px, pz, 0.3)) {
        const H = 6.4
        box(0.26, H, 0.26, px, H / 2 + j.y, pz, yaw, POLE)
        const far = Math.min(...lats)
        const armLen = right + 1.6 - far + 0.5
        box(armLen, 0.18, 0.18, px - rx * armLen / 2, H - 0.2 + j.y, pz - rz * armLen / 2, Math.atan2(-rz, rx), POLE) // (the arm's length turned to run across the road)
        for (const l of lats) head(fx + rx * l, H - 1.15 + j.y, fz + rz * l)
      }
      // and the near corner, by the stop line: a head on a pole at eye height, which you can see when stopped close to the line
      const nx = j.x + d[0] * (stop + 0.6) + rx * (right + 1.2), nz = j.z + d[1] * (stop + 0.6) + rz * (right + 1.2)
      if (!onRealRoad(m, nx, nz, 0.3)) {
        box(0.2, 3.3, 0.2, nx, 1.65 + j.y, nz, yaw, POLE)
        head(nx, 3.3 + j.y, nz)
      }
    }
  }
  return { heads, geo: parts.length ? mergeAll(parts) : null }
}
function mergeAll(parts: THREE.BufferGeometry[]) {
  let n = 0
  for (const p of parts) n += p.getAttribute('position').count
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3)
  let o = 0
  for (const p of parts) {
    pos.set(p.getAttribute('position').array as Float32Array, o * 3)
    nor.set(p.getAttribute('normal').array as Float32Array, o * 3)
    col.set(p.getAttribute('color').array as Float32Array, o * 3)
    o += p.getAttribute('position').count
    p.dispose()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.computeBoundingSphere()
  return g
}

export function RealLights() {
  const version = useGame((s) => s.real.version)
  const data = useMemo(() => build(), [version])
  const mats = useMemo(() => ({
    frame: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 }),
    lamp: new THREE.MeshBasicMaterial({ toneMapped: false }),
    // the glow round a lit lamp (added light: a dark lamp adds nothing)
    glow: new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
    disc: new THREE.CircleGeometry(0.17, 18),
    halo: new THREE.CircleGeometry(0.62, 24),
  }), [])
  const SPACING = 0.44
  const make = (geo: THREE.BufferGeometry, mat: THREE.Material, ahead: number) => {
    const im = new THREE.InstancedMesh(geo, mat, Math.max(1, data.heads.length * 3))
    const mt = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1)
    data.heads.forEach((h, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), h.yaw)
      const fx = Math.sin(h.yaw) * ahead, fz = Math.cos(h.yaw) * ahead
      for (let k = 0; k < 3; k++) {
        mt.compose(p.set(h.x + fx, h.y + SPACING - k * SPACING, h.z + fz), q, s)
        im.setMatrixAt(i * 3 + k, mt)
        im.setColorAt(i * 3 + k, BLACK)
      }
    })
    im.count = data.heads.length * 3
    im.computeBoundingSphere()
    return im
  }
  const lamps = useMemo(() => make(mats.disc, mats.lamp, 0), [data, mats])
  const glows = useMemo(() => { const g = make(mats.halo, mats.glow, 0.03); g.renderOrder = 2; return g }, [data, mats])
  useEffect(() => () => { data.geo?.dispose(); lamps.dispose(); glows.dispose() }, [data, lamps, glows])
  useEffect(() => () => { Object.values(mats).forEach((v) => v.dispose()) }, [mats])

  // light the lamps (red top, amber middle, green bottom), with a glow round the lit one
  useFrame(() => {
    const hs = data.heads
    if (!hs.length || !lamps.instanceColor || !glows.instanceColor) return
    for (let i = 0; i < hs.length; i++) {
      const L = lightOf(hs[i].ctl, hs[i].axis, sim.t)
      const on = L === 'R' ? 0 : L === 'Y' ? 1 : 2
      for (let k = 0; k < 3; k++) {
        lamps.setColorAt(i * 3 + k, k === on ? LIT[k] : DARK[k])
        glows.setColorAt(i * 3 + k, k === on ? LIT[k] : BLACK)
      }
    }
    lamps.instanceColor.needsUpdate = true
    glows.instanceColor.needsUpdate = true
  })

  return (
    <group>
      {data.geo && <mesh geometry={data.geo} material={mats.frame} />}
      <primitive object={lamps} />
      <primitive object={glows} />
    </group>
  )
}
