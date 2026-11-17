import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { sim } from '../game/sim'
import { useGame } from '../game/store'
import { REAL } from './load'
import { endDir, halfWidth, laneOffsets, onRealRoad } from './roads'
import { lightOf, signalOf, type Controller } from './signals'

/**
 * The traffic lights of a real place, US style: for each road arriving at a junction with lights, a pole on the far corner with a
 * mast arm over the road and a three-lamp head above each of its lanes, facing the arriving traffic (or, where the far corner is
 * taken by another road, a single head on a pole on the near corner). The lamps are lit from the controllers every frame.
 */
interface Head { x: number; y: number; z: number; yaw: number; ctl: Controller; axis: 0 | 1 }

const LIT = [new THREE.Color('#ff2a1a'), new THREE.Color('#ffb300'), new THREE.Color('#22e06b')]
const DARK = [new THREE.Color('#2b0e0c'), new THREE.Color('#2b230c'), new THREE.Color('#0c2614')]
const POLE = new THREE.Color('#5d6168'), HOUSING = new THREE.Color('#2a2c30')

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
      // the far corner, across the junction
      const fx = j.x + tx * (j.r + 1.5), fz = j.z + tz * (j.r + 1.5)
      let px = fx + rx * (right + 1.6), pz = fz + rz * (right + 1.6)
      if (!onRealRoad(m, px, pz, 0.3)) {
        const H = 6.3
        box(0.24, H, 0.24, px, H / 2, pz, yaw, POLE)
        const far = Math.min(...lats)
        const armLen = right + 1.6 - far + 0.4
        box(armLen, 0.16, 0.16, px - rx * armLen / 2, H - 0.25, pz - rz * armLen / 2, Math.atan2(-rz, rx), POLE) // (the arm's length turned to run across the road)
        for (const l of lats) {
          const hx = fx + rx * l, hz = fz + rz * l
          box(0.4, 1.1, 0.3, hx, H - 0.95, hz, yaw, HOUSING)
          heads.push({ x: hx + d[0] * 0.17, y: H - 0.95, z: hz + d[1] * 0.17, yaw, ctl: sg.ctl, axis: sg.axis })
        }
      } else {
        // the near corner, by the stop line
        px = j.x + d[0] * (j.r + 1.4) + rx * (right + 1.3); pz = j.z + d[1] * (j.r + 1.4) + rz * (right + 1.3)
        if (onRealRoad(m, px, pz, 0.3)) continue
        box(0.2, 3.6, 0.2, px, 1.8, pz, yaw, POLE)
        box(0.4, 1.1, 0.3, px, 3.6, pz, yaw, HOUSING)
        heads.push({ x: px + d[0] * 0.17, y: 3.6, z: pz + d[1] * 0.17, yaw, ctl: sg.ctl, axis: sg.axis })
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
    disc: new THREE.CircleGeometry(0.13, 14),
  }), [])
  const lamps = useMemo(() => {
    const im = new THREE.InstancedMesh(mats.disc, mats.lamp, Math.max(1, data.heads.length * 3))
    const mt = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1)
    data.heads.forEach((h, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), h.yaw)
      for (let k = 0; k < 3; k++) {
        mt.compose(p.set(h.x, h.y + 0.34 - k * 0.34, h.z), q, s)
        im.setMatrixAt(i * 3 + k, mt)
        im.setColorAt(i * 3 + k, DARK[k])
      }
    })
    im.count = data.heads.length * 3
    im.computeBoundingSphere()
    return im
  }, [data, mats])
  useEffect(() => () => { data.geo?.dispose(); lamps.dispose() }, [data, lamps])
  useEffect(() => () => { mats.frame.dispose(); mats.lamp.dispose(); mats.disc.dispose() }, [mats])

  // light the lamps (red top, amber middle, green bottom)
  useFrame(() => {
    const hs = data.heads
    if (!hs.length || !lamps.instanceColor) return
    for (let i = 0; i < hs.length; i++) {
      const L = lightOf(hs[i].ctl, hs[i].axis, sim.t)
      const on = L === 'R' ? 0 : L === 'Y' ? 1 : 2
      for (let k = 0; k < 3; k++) lamps.setColorAt(i * 3 + k, k === on ? LIT[k] : DARK[k])
    }
    lamps.instanceColor.needsUpdate = true
  })

  return (
    <group>
      {data.geo && <mesh geometry={data.geo} material={mats.frame} />}
      <primitive object={lamps} />
    </group>
  )
}
