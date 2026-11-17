/**
 * Mapillary (Meta): traffic lights and road signs found automatically in street-level photos. OpenStreetMap often has no traffic
 * lights, stop signs or speed limits for suburban streets; where people have driven with a camera, Mapillary has seen them.
 *
 * Only the kinds of object the game uses are asked for (a tile's worth is a couple of kilobytes). Needs a free client token in
 * .env.local (VITE_MAPILLARY_TOKEN); without one, nothing is asked and the game uses OpenStreetMap alone.
 */

export interface Seen {
  type: 'mly'
  id: string
  /** what it is */
  kind: 'light' | 'stop' | 'yield' | 'limit'
  /** a speed limit's number (mph) */
  mph?: number
  lat: number
  lon: number
}

const TOKEN = import.meta.env.VITE_MAPILLARY_TOKEN ?? ''
export const hasMapillary = () => !!TOKEN

// the object names Mapillary uses (its taxonomy: traffic lights by shape; signs by country style g1, g2, g3...)
const LIGHTS = ['general-upright', 'general-upright-side', 'general-upright-front', 'general-horizontal', 'general-horizontal-front', 'general-single'].map((s) => `object--traffic-light--${s}`)
const STOPS = ['g1', 'g2', 'g3'].map((g) => `regulatory--stop--${g}`)
const YIELDS = ['g1', 'g2', 'g3'].map((g) => `regulatory--yield--${g}`)
const LIMITS: string[] = []
for (let v = 5; v <= 85; v += 5) for (const g of ['g1', 'g2', 'g3']) LIMITS.push(`regulatory--maximum-speed-limit-${v}--${g}`)

/** what Mapillary has seen in a box (degrees); [] if there is no token or it cannot be reached */
export async function seenIn(lat0: number, lon0: number, lat1: number, lon1: number): Promise<{ list: Seen[]; text: string } | null> {
  if (!TOKEN) return null
  const u = new URL('https://graph.mapillary.com/map_features')
  u.searchParams.set('access_token', TOKEN)
  u.searchParams.set('fields', 'id,object_value,geometry')
  u.searchParams.set('bbox', `${lon0.toFixed(5)},${lat0.toFixed(5)},${lon1.toFixed(5)},${lat1.toFixed(5)}`)
  u.searchParams.set('object_values', [...LIGHTS, ...STOPS, ...YIELDS, ...LIMITS].join(','))
  const ac = new AbortController(), to = setTimeout(() => ac.abort(), 20000)
  try {
    const r = await fetch(u, { signal: ac.signal })
    if (!r.ok) return null
    const text = await r.text()
    return { list: parse(text), text }
  } catch { return null } finally { clearTimeout(to) }
}
/** Mapillary's answer -> the things the game uses */
export function parse(text: string): Seen[] {
  const out: Seen[] = []
  try {
    const d = JSON.parse(text) as { data?: Array<{ id: string; object_value: string; geometry?: { coordinates?: [number, number] } }> }
    for (const f of d.data ?? []) {
      const c = f.geometry?.coordinates
      if (!c) continue
      const v = f.object_value
      const kind = v.startsWith('object--traffic-light') ? 'light' : v.startsWith('regulatory--stop') ? 'stop' : v.startsWith('regulatory--yield') ? 'yield' : v.startsWith('regulatory--maximum-speed-limit') ? 'limit' : null
      if (!kind) continue
      const mph = kind === 'limit' ? Number(/limit-(\d+)/.exec(v)?.[1]) || undefined : undefined
      out.push({ type: 'mly', id: f.id, kind, mph, lat: c[1], lon: c[0] })
    }
  } catch { /* not what we expected: nothing seen */ }
  return out
}
