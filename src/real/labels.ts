/**
 * Real places: signs that carry words or numbers from the map, drawn as US roads have them:
 *  - route shields (Interstate, US route, Texas state highway, Farm-to-Market road...) on posts along numbered roads
 *  - route numbers painted in the lanes of numbered main roads
 *  - green street-name blades on a pole at each junction
 * Each different text gets its own small picture (shared by every sign showing it), made on a canvas the first time it is needed.
 */
import * as THREE from 'three'

type P2 = [number, number]
export type LabelKind = 'shield' | 'blade' | 'paint'
export interface Label {
  kind: LabelKind
  /** what it says (a route as written on the map, e.g. "US 287"; a street name) */
  text: string
  /** where: the middle of the sign, the ground (or road) height under it, and its size (m) */
  x: number
  z: number
  y0: number
  /** height of its middle above y0 (a painted label lies on the road: 0) */
  y: number
  w: number
  h: number
  /** the way its front faces (a blade has two fronts: it reads from both sides); for a painted label, the way to the driver reading it */
  face: P2
}

/* ---------------- what route a ref is ---------------- */
interface Route { kind: 'interstate' | 'us' | 'state' | 'farm' | 'other'; num: string; label: string }
export function routes(ref: string): Route[] {
  return ref.split(';').map((r) => r.trim()).filter(Boolean).slice(0, 3).map((r) => {
    const m = /^(I|IH|Interstate)[\s-]*(\d+[A-Z]?)/i.exec(r)
    if (m) return { kind: 'interstate', num: m[2].toUpperCase(), label: `I-${m[2].toUpperCase()}` }
    const u = /^US[\s-]*(\d+[A-Z]?)/i.exec(r)
    if (u) return { kind: 'us', num: u[1], label: `US ${u[1]}` }
    const st = /^(SH|TX|State Highway|[A-Z]{2}(?=[\s-]*\d))[\s-]*(\d+[A-Z]?)/i.exec(r)
    if (st && !/^(FM|RM|CR)/i.test(r)) return { kind: 'state', num: st[2], label: `SH ${st[2]}` }
    const fm = /^(FM|RM|Farm to Market|Ranch to Market)[\s-]*(\d+)/i.exec(r)
    if (fm) return { kind: 'farm', num: fm[2], label: `FM ${fm[2]}` }
    return { kind: 'other', num: r.replace(/^[A-Za-z]+\s*/, '') || r, label: r }
  })
}

/** a street name as it is printed on a US street-name sign: Lane -> Ln, North -> N... */
export function bladeText(name: string): string {
  const A: Record<string, string> = { Avenue: 'Ave', Boulevard: 'Blvd', Circle: 'Cir', Court: 'Ct', Drive: 'Dr', Freeway: 'Fwy', Highway: 'Hwy', Lane: 'Ln', Parkway: 'Pkwy', Place: 'Pl', Road: 'Rd', Street: 'St', Terrace: 'Ter', Trail: 'Trl', Way: 'Way', Expressway: 'Expy', Square: 'Sq', Loop: 'Loop', Crossing: 'Xing', Point: 'Pt', Cove: 'Cv', Ridge: 'Rdg', Run: 'Run' }
  const D: Record<string, string> = { North: 'N', South: 'S', East: 'E', West: 'W', Northeast: 'NE', Northwest: 'NW', Southeast: 'SE', Southwest: 'SW' }
  const w = name.split(/\s+/)
  return w.map((x, i) => (i === 0 && D[x] ? D[x] : i === w.length - 1 && A[x] ? A[x] : x)).join(' ')
}

/* ---------------- pictures ---------------- */
const cache = new Map<string, THREE.MeshStandardMaterial | THREE.MeshBasicMaterial>()
function canvas(w: number, h: number) { const c = document.createElement('canvas'); c.width = w; c.height = h; return { c, g: c.getContext('2d')! } }
function texture(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}
/** the font that fits `text` in `w` px at most `max` px tall */
function fit(g: CanvasRenderingContext2D, text: string, w: number, max: number, weight = 800) {
  let s = max
  g.font = `${weight} ${s}px Arial, Helvetica, sans-serif`
  while (s > 8 && g.measureText(text).width > w) { s -= 2; g.font = `${weight} ${s}px Arial, Helvetica, sans-serif` }
}
function drawShield(text: string) {
  const r = routes(text)[0] ?? { kind: 'other', num: text, label: text }
  const S = 256
  const { c, g } = canvas(S, S)
  g.textAlign = 'center'; g.textBaseline = 'middle'
  if (r.kind === 'interstate') {
    // red top band, blue body, white outline, in the Interstate shield's shape
    const path = () => { g.beginPath(); g.moveTo(20, 30); g.quadraticCurveTo(70, 52, 128, 22); g.quadraticCurveTo(186, 52, 236, 30); g.lineTo(236, 120); g.quadraticCurveTo(232, 196, 128, 240); g.quadraticCurveTo(24, 196, 20, 120); g.closePath() }
    g.fillStyle = '#fff'; path(); g.fill()
    g.save(); g.translate(128, 132); g.scale(0.9, 0.9); g.translate(-128, -132); g.fillStyle = '#003f87'; path(); g.fill(); g.restore()
    g.fillStyle = '#c4161c'; g.fillRect(36, 40, 184, 44)
    g.fillStyle = '#fff'; g.font = '800 28px Arial, sans-serif'; g.fillText('INTERSTATE', 128, 63, 170)
    fit(g, r.num, 170, 104); g.fillText(r.num, 128, 158)
  } else if (r.kind === 'us') {
    // a white US-route shield with a black border, on a black square
    g.fillStyle = '#111'; g.fillRect(0, 0, S, S)
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(36, 22); g.lineTo(220, 22); g.quadraticCurveTo(222, 60, 238, 84); g.quadraticCurveTo(250, 200, 128, 238); g.quadraticCurveTo(6, 200, 18, 84); g.quadraticCurveTo(34, 60, 36, 22); g.closePath(); g.fill()
    g.fillStyle = '#111'; fit(g, r.num, 170, 110); g.fillText(r.num, 128, 128)
  } else if (r.kind === 'state' || r.kind === 'farm') {
    // Texas: a black square with a white panel (state highway: the outline of Texas is left out; Farm-to-Market: "FARM ROAD" above)
    g.fillStyle = '#111'; g.fillRect(0, 0, S, S)
    g.fillStyle = '#fff'; g.fillRect(14, 14, S - 28, S - 28)
    g.fillStyle = '#111'
    if (r.kind === 'farm') { g.font = '800 30px Arial, sans-serif'; g.fillText('FARM ROAD', 128, 50, 210); fit(g, r.num, 200, 120); g.fillText(r.num, 128, 150) }
    else { g.font = '800 30px Arial, sans-serif'; g.fillText('TEXAS', 128, 50, 210); fit(g, r.num, 200, 120); g.fillText(r.num, 128, 150) }
  } else {
    g.fillStyle = '#fff'; g.fillRect(0, 0, S, S); g.strokeStyle = '#111'; g.lineWidth = 12; g.strokeRect(10, 10, S - 20, S - 20)
    g.fillStyle = '#111'; fit(g, r.label, 210, 90); g.fillText(r.label, 128, 128)
  }
  return c
}
function drawBlade(text: string) {
  const { c, g } = canvas(512, 96)
  g.fillStyle = '#0b6e3a'; g.fillRect(0, 0, 512, 96)
  g.strokeStyle = '#fff'; g.lineWidth = 5; g.strokeRect(6, 6, 500, 84)
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'
  fit(g, text, 470, 62, 700); g.fillText(text, 256, 51)
  return c
}
function drawPaint(text: string) {
  // white letters on nothing (only the letters are painted on the road)
  const { c, g } = canvas(256, 128)
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'
  fit(g, text, 240, 120, 800); g.fillText(text, 128, 68)
  return c
}
/** the material for a label (made once, then shared) */
function material(kind: LabelKind, text: string) {
  const key = `${kind}|${text}`
  let m = cache.get(key)
  if (!m) {
    const c = kind === 'shield' ? drawShield(text) : kind === 'blade' ? drawBlade(text) : drawPaint(text)
    m = kind === 'paint'
      ? new THREE.MeshBasicMaterial({ map: texture(c), transparent: true, alphaTest: 0.35, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })
      : new THREE.MeshStandardMaterial({ map: texture(c), roughness: 0.55, side: kind === 'shield' ? THREE.FrontSide : THREE.DoubleSide })
    cache.set(key, m)
  }
  return m
}
/** throw the pictures away (a new place) */
export function disposeLabels() {
  for (const m of cache.values()) { m.map?.dispose(); m.dispose() }
  cache.clear()
}

/** the labels as meshes: one per different text (they share its picture) */
export function labelMeshes(list: Label[]): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group()
  const geos: THREE.BufferGeometry[] = []
  const byKey = new Map<string, Label[]>()
  for (const l of list) { const k = `${l.kind}|${l.text}`; byKey.set(k, [...(byKey.get(k) ?? []), l]) }
  for (const [key, ls] of byKey) {
    const [kind, ...rest] = key.split('|')
    const text = rest.join('|')
    const pos: number[] = [], uv: number[] = [], nor: number[] = []
    const quad = (p: number[][], n: number[], flipU: boolean) => {
      const u = flipU ? [1, 0, 0, 1] : [0, 1, 1, 0]
      for (const [i, v] of [[0, 0], [1, 0], [2, 1], [0, 0], [2, 1], [3, 1]] as Array<[number, number]>) {
        pos.push(...p[i]); uv.push(u[i], v); nor.push(...n)
      }
    }
    for (const l of ls) {
      const fx = l.face[0], fz = l.face[1]
      const rx = fz, rz = -fx // to the label's right, as you face it
      if (kind === 'paint') {
        // lying on the road: its bottom edge towards the driver reading it (`face` points to the driver), stretched along the road
        const y = l.y0 + 0.03
        const bx = l.x + fx * (l.h / 2), bz = l.z + fz * (l.h / 2) // (the near edge)
        const tx = l.x - fx * (l.h / 2), tz = l.z - fz * (l.h / 2)
        quad([[bx - rx * l.w / 2, y, bz - rz * l.w / 2], [bx + rx * l.w / 2, y, bz + rz * l.w / 2], [tx + rx * l.w / 2, y, tz + rz * l.w / 2], [tx - rx * l.w / 2, y, tz - rz * l.w / 2]], [0, 1, 0], false)
      } else {
        const y = l.y0 + l.y
        const c = (sx: number, sy: number, off: number) => [l.x + rx * sx * l.w / 2 + fx * off, y + sy * l.h / 2, l.z + rz * sx * l.w / 2 + fz * off]
        quad([c(-1, -1, 0.03), c(1, -1, 0.03), c(1, 1, 0.03), c(-1, 1, 0.03)], [fx, 0, fz], false)
        // a blade reads from both sides: its other face, the right way round
        if (kind === 'blade') quad([c(1, -1, -0.03), c(-1, -1, -0.03), c(-1, 1, -0.03), c(1, 1, -0.03)], [-fx, 0, -fz], false)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
    g.computeBoundingSphere()
    geos.push(g)
    const mesh = new THREE.Mesh(g, material(kind as LabelKind, text))
    if (kind === 'paint') mesh.renderOrder = 1
    group.add(mesh)
  }
  return { group, dispose: () => geos.forEach((g) => g.dispose()) }
}
