import { useEffect, useRef } from 'react'

/**
 * A street map to pick where to start: drag to move it, zoom with the wheel, a pinch or the buttons, tap a street to choose it.
 * The map pictures are OpenStreetMap's standard tiles. The parts of the map already downloaded for driving are shaded blue.
 */
interface Props {
  /** where to look (the map moves there whenever this changes) */
  center: { lat: number; lon: number; zoom?: number } | null
  /** the chosen starting point, the destination, and the route between them ([lat, lon] points) */
  marker: { lat: number; lon: number } | null
  dest?: { lat: number; lon: number } | null
  /** which way the car will face at the start (compass degrees), drawn as an arrow from the start pin */
  heading?: number | null
  route?: Array<[number, number]> | null
  /** the downloaded driving tiles ("i,j" of 0.01 degree tiles) */
  tiles: string[]
  onPick: (lat: number, lon: number) => void
}

const TS = 256
const MINZ = 3, MAXZ = 19
const wx = (lon: number, z: number) => ((lon + 180) / 360) * TS * 2 ** z
const wy = (lat: number, z: number) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TS * 2 ** z }
const lonOf = (x: number, z: number) => (x / (TS * 2 ** z)) * 360 - 180
const latOf = (y: number, z: number) => { const n = Math.PI - (2 * Math.PI * y) / (TS * 2 ** z); return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) }

/** map pictures, shared by every map on the page */
const imgs = new Map<string, HTMLImageElement>()

export function MapPicker({ center, marker, heading = null, dest = null, route = null, tiles, onPick }: Props) {
  const cv = useRef<HTMLCanvasElement>(null)
  const view = useRef({ lat: 39.5, lon: -98.35, z: 4 }) // (the whole of the US, until a place is known)
  const props = useRef({ marker, heading, dest, route, tiles, onPick })
  props.current = { marker, heading, dest, route, tiles, onPick }
  const drawRef = useRef<() => void>(() => {})
  const zoomRef = useRef<(dz: number) => void>(() => {})

  // move to a new place
  useEffect(() => {
    if (!center) return
    view.current = { lat: center.lat, lon: center.lon, z: center.zoom ?? Math.max(view.current.z, 16) }
    drawRef.current()
  }, [center?.lat, center?.lon, center?.zoom])
  useEffect(() => { drawRef.current() }, [marker?.lat, marker?.lon, heading, dest?.lat, dest?.lon, route, tiles.join(';')])

  useEffect(() => {
    const c = cv.current!
    const g = c.getContext('2d')!
    let raf = 0
    const draw = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        const W = c.clientWidth, H = c.clientHeight
        if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr) }
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.fillStyle = '#dfe3e8'; g.fillRect(0, 0, W, H)
        const v = view.current
        const tz = Math.max(0, Math.min(MAXZ, Math.floor(v.z))), k = 2 ** (v.z - tz) // (tiles of the zoom below, scaled up a little)
        const cx = wx(v.lon, tz), cy = wy(v.lat, tz)
        const n = 2 ** tz
        const i0 = Math.floor((cx - W / 2 / k) / TS), i1 = Math.floor((cx + W / 2 / k) / TS)
        const j0 = Math.floor((cy - H / 2 / k) / TS), j1 = Math.floor((cy + H / 2 / k) / TS)
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
          if (j < 0 || j >= n) continue
          const ii = ((i % n) + n) % n
          const key = `${tz}/${ii}/${j}`
          let im = imgs.get(key)
          if (!im) {
            im = new Image()
            im.src = `https://tile.openstreetmap.org/${key}.png`
            im.onload = draw
            imgs.set(key, im)
            if (imgs.size > 400) imgs.delete(imgs.keys().next().value as string)
          }
          const x = W / 2 + (i * TS - cx) * k, y = H / 2 + (j * TS - cy) * k
          if (im.complete && im.naturalWidth) g.drawImage(im, x, y, TS * k + 0.5, TS * k + 0.5)
        }
        const P = (lat: number, lon: number): [number, number] => [W / 2 + (wx(lon, v.z) - wx(v.lon, v.z)), H / 2 + (wy(lat, v.z) - wy(v.lat, v.z))]
        // the downloaded driving tiles
        g.fillStyle = 'rgba(37,99,235,.13)'; g.strokeStyle = 'rgba(37,99,235,.55)'; g.lineWidth = 1
        for (const t of props.current.tiles) {
          const [a, b] = t.split(',').map(Number)
          const [x0, y0] = P((a + 1) * 0.01, b * 0.01), [x1, y1] = P(a * 0.01, (b + 1) * 0.01)
          g.fillRect(x0, y0, x1 - x0, y1 - y0); g.strokeRect(x0, y0, x1 - x0, y1 - y0)
        }
        // the route
        const rt = props.current.route
        if (rt && rt.length > 1) {
          g.lineCap = 'round'; g.lineJoin = 'round'
          for (const [w, c] of [[8, '#fff'], [5, '#0b5cff']] as const) {
            g.strokeStyle = c; g.lineWidth = w
            g.beginPath(); rt.forEach(([la, lo], i) => { const [x, y] = P(la, lo); if (i) g.lineTo(x, y); else g.moveTo(x, y) }); g.stroke()
          }
        }
        // the start (green pin) and the destination (red pin)
        const pin = (lat: number, lon: number, col: string, letter: string) => {
          const [x, y] = P(lat, lon)
          g.fillStyle = col; g.strokeStyle = '#fff'; g.lineWidth = 2.5
          g.beginPath(); g.moveTo(x, y); g.bezierCurveTo(x - 11, y - 14, x - 11, y - 30, x, y - 30); g.bezierCurveTo(x + 11, y - 30, x + 11, y - 14, x, y); g.fill(); g.stroke()
          g.fillStyle = '#fff'; g.font = '800 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(letter, x, y - 20)
        }
        const mk = props.current.marker, ds = props.current.dest
        if (ds) pin(ds.lat, ds.lon, '#e11d48', 'B')
        if (mk) {
          // the car's direction: an arrow from the start pin
          const hd = props.current.heading
          if (hd !== null && hd !== undefined) {
            const [x, y] = P(mk.lat, mk.lon)
            const r = (hd * Math.PI) / 180, ux = Math.sin(r), uy = -Math.cos(r), L = 46
            g.lineCap = 'round'
            for (const [w, c] of [[9, '#fff'], [5, '#16a34a']] as const) {
              g.strokeStyle = c; g.lineWidth = w
              g.beginPath(); g.moveTo(x, y); g.lineTo(x + ux * L, y + uy * L); g.stroke()
            }
            const tx = x + ux * (L + 10), ty = y + uy * (L + 10)
            g.fillStyle = '#16a34a'; g.strokeStyle = '#fff'; g.lineWidth = 2
            g.beginPath(); g.moveTo(tx, ty); g.lineTo(tx - ux * 16 - uy * 9, ty - uy * 16 + ux * 9); g.lineTo(tx - ux * 16 + uy * 9, ty - uy * 16 - ux * 9); g.closePath(); g.fill(); g.stroke()
          }
          pin(mk.lat, mk.lon, '#16a34a', 'A')
        }
      })
    }
    drawRef.current = draw

    /** zoom by `dz` keeping the point under (px, py) where it is */
    const zoomAt = (dz: number, px: number, py: number) => {
      const v = view.current
      const W = c.clientWidth, H = c.clientHeight
      const z2 = Math.max(MINZ, Math.min(MAXZ, v.z + dz))
      const mx = wx(v.lon, v.z) + (px - W / 2), my = wy(v.lat, v.z) + (py - H / 2) // the point under the pointer, in world pixels
      const f = 2 ** (z2 - v.z)
      v.lon = lonOf(mx * f - (px - W / 2), z2); v.lat = latOf(my * f - (py - H / 2), z2); v.z = z2
      draw()
    }
    const pan = (dx: number, dy: number) => {
      const v = view.current
      v.lon = lonOf(wx(v.lon, v.z) - dx, v.z)
      v.lat = Math.max(-85, Math.min(85, latOf(wy(v.lat, v.z) - dy, v.z)))
      draw()
    }
    // pointers: one drags, two pinch; a quick tap without moving picks the spot
    const pts = new Map<number, { x: number; y: number }>()
    let tap: { x: number; y: number; t: number; moved: number } | null = null
    let pinch = 0
    const local = (e: PointerEvent) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
    const down = (e: PointerEvent) => {
      c.setPointerCapture(e.pointerId)
      const p = local(e)
      pts.set(e.pointerId, p)
      if (pts.size === 1) tap = { ...p, t: performance.now(), moved: 0 }
      else { tap = null; const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y) }
    }
    const move = (e: PointerEvent) => {
      const prev = pts.get(e.pointerId)
      if (!prev) return
      const p = local(e)
      pts.set(e.pointerId, p)
      if (pts.size === 1) {
        pan(p.x - prev.x, p.y - prev.y)
        if (tap) tap.moved += Math.hypot(p.x - prev.x, p.y - prev.y)
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (pinch > 0 && d > 0) zoomAt(Math.log2(d / pinch), (a.x + b.x) / 2, (a.y + b.y) / 2)
        pinch = d
      }
    }
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return
      pts.delete(e.pointerId)
      if (tap && pts.size === 0 && tap.moved < 6 && performance.now() - tap.t < 600) {
        const v = view.current, W = c.clientWidth, H = c.clientHeight
        props.current.onPick(latOf(wy(v.lat, v.z) + tap.y - H / 2, v.z), lonOf(wx(v.lon, v.z) + tap.x - W / 2, v.z))
      }
      if (pts.size < 2) pinch = 0
      if (pts.size === 0) tap = null
    }
    const wheel = (e: WheelEvent) => { e.preventDefault(); const p = local(e as unknown as PointerEvent); zoomAt(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025), p.x, p.y) }
    c.addEventListener('pointerdown', down)
    c.addEventListener('pointermove', move)
    c.addEventListener('pointerup', up)
    c.addEventListener('pointercancel', up)
    c.addEventListener('wheel', wheel, { passive: false })
    const ro = new ResizeObserver(draw)
    ro.observe(c)
    draw()
    zoomRef.current = (dz) => zoomAt(dz, c.clientWidth / 2, c.clientHeight / 2)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      c.removeEventListener('pointerdown', down)
      c.removeEventListener('pointermove', move)
      c.removeEventListener('pointerup', up)
      c.removeEventListener('pointercancel', up)
      c.removeEventListener('wheel', wheel)
    }
  }, [])

  return (
    <div className="mappick">
      <canvas ref={cv} aria-label="Map: drag to move, zoom with the wheel, a pinch or the buttons, tap a street to start there" />
      <div className="mp-zoom">
        <button type="button" aria-label="Zoom in" onClick={() => zoomRef.current(1)}>+</button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomRef.current(-1)}>−</button>
      </div>
      <span className="mp-credit">© OpenStreetMap contributors</span>
    </div>
  )
}
