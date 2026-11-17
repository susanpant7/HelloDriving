import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { wheelScreen } from '../game/cabinConfig'
import { setEyeLook, steerTap } from '../game/input'
import { input, sim } from '../game/sim'

const MAX_YAW = 2.1 // rad: how far the head can turn: right round (about 120 degrees) to look into the blind spot over your shoulder
const MAX_UP = 0.9
const REACH = 64 // px of thumb travel for the full turn

/**
 * An eye: put your thumb on it and slide it sideways to turn your head (left / right), up to look up at the rear-view mirror.
 * Let go and your head returns to the road.
 */
export function EyeControl() {
  const ref = useRef<HTMLDivElement>(null)
  const [d, setD] = useState({ x: 0, y: 0, on: false })
  const origin = useRef({ x: 0, y: 0 })
  // it sits just left of the car's steering wheel (where the wheel is in your resting forward view, so it does not move as you look round)
  useEffect(() => {
    let raf = 0, lx = NaN, ly = NaN
    const tick = () => {
      const el = ref.current
      if (el && wheelScreen.ok) {
        const w = el.offsetWidth, h = el.offsetHeight
        const x = Math.max(8, Math.min(window.innerWidth - w - 8, wheelScreen.left - w - 10))
        const y = Math.max(8, Math.min(window.innerHeight - h - 8, wheelScreen.y - h / 2))
        if (Math.abs(x - lx) > 0.5 || Math.abs(y - ly) > 0.5) { lx = x; ly = y; el.style.left = `${x}px`; el.style.top = `${y}px`; el.style.visibility = '' }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const dx = Math.max(-REACH, Math.min(REACH, e.clientX - origin.current.x))
    const dy = Math.max(-REACH, Math.min(REACH * 0.4, e.clientY - origin.current.y))
    // sliding left turns the head left (the view swings to the left of the car)
    setEyeLook(true, (-dx / REACH) * MAX_YAW, dy < 0 ? (-dy / REACH) * MAX_UP : 0)
    setD({ x: dx, y: dy, on: true })
  }
  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const r = e.currentTarget.getBoundingClientRect()
    origin.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    move(e)
  }
  const up = () => {
    setEyeLook(false) // eyes back on the road (phone motion, if on, still turns the head)
    setD({ x: 0, y: 0, on: false })
  }
  useEffect(() => up, [])

  return (
    <div
      ref={ref}
      className={`eye anchored${d.on ? ' on' : ''}`}
      style={{ visibility: 'hidden' }}
      role="slider"
      aria-label="Look around: slide left or right to turn your head"
      onPointerDown={down}
      onPointerMove={(e) => d.on && move(e)}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg viewBox="0 0 100 64" aria-hidden="true">
        <path d="M4 32 C20 8 80 8 96 32 C80 56 20 56 4 32 Z" fill="rgba(255,255,255,.1)" stroke="currentColor" strokeWidth="4" strokeLinejoin="round" />
        <circle cx={50 + (d.x / REACH) * 20} cy={32 + (d.y / REACH) * 10} r="13" fill="currentColor" />
        <circle cx={50 + (d.x / REACH) * 20 + 4} cy={32 + (d.y / REACH) * 10 - 4} r="4" fill="#0e131c" />
      </svg>
    </div>
  )
}

/** how far the small wheel turns (degrees, each way) for full lock */
const WHEEL_LOCK = 240

/**
 * Steering: a small copy of the car's own steering wheel (bottom left). Put a finger on it and turn it round: the car steers as far as
 * you turn it and holds that while your finger stays; let go and it returns to straight. Two quick little nudges the same way ask for
 * a lane change (like a double tap of an arrow key). When nobody holds it, it shows the car's wheel (lane assist turning it, say).
 */
export function SteerWheel() {
  const rim = useRef<SVGGElement>(null)
  const [on, setOn] = useState(false)
  const g = useRef({ id: -1, cx: 0, cy: 0, last: 0, deg: 0, t0: 0, peak: 0 })

  // the picture follows the car's wheel every frame
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const d = (input.wheel ?? sim.wheel) * WHEEL_LOCK
      if (rim.current) rim.current.style.transform = `rotate(${d.toFixed(1)}deg)`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); input.wheel = null }
  }, [])

  const angle = (e: PointerEvent<HTMLDivElement>) => (Math.atan2(e.clientY - g.current.cy, e.clientX - g.current.cx) * 180) / Math.PI
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (g.current.id !== -1) return // one finger turns it
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const r = e.currentTarget.getBoundingClientRect()
    const s = g.current
    s.id = e.pointerId; s.cx = r.left + r.width / 2; s.cy = r.top + r.height / 2
    s.last = angle(e)
    s.deg = sim.wheel * WHEEL_LOCK // pick it up where it is (if it was still straightening up, the finger catches it there)
    s.t0 = performance.now(); s.peak = 0
    input.wheel = s.deg / WHEEL_LOCK
    setOn(true)
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const s = g.current
    if (e.pointerId !== s.id) return
    if (Math.hypot(e.clientX - s.cx, e.clientY - s.cy) < 8) return // right over the hub the angle jumps about
    const a = angle(e)
    let d = a - s.last
    if (d > 180) d -= 360
    else if (d < -180) d += 360
    s.last = a
    s.deg = Math.max(-WHEEL_LOCK, Math.min(WHEEL_LOCK, s.deg + d)) // clockwise = right
    if (Math.abs(s.deg) > Math.abs(s.peak)) s.peak = s.deg
    input.wheel = s.deg / WHEEL_LOCK
  }
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const s = g.current
    if (e.pointerId !== s.id) return
    s.id = -1
    input.wheel = null
    setOn(false)
    if (performance.now() - s.t0 < 300 && Math.abs(s.peak) > 6 && Math.abs(s.peak) < 70) steerTap(s.peak > 0 ? 1 : -1)
  }

  return (
    <div
      className={`swheel${on ? ' on' : ''}`}
      role="slider"
      aria-label="Steering wheel: put a finger on it and turn it round to steer; let go and it returns to straight"
      aria-valuemin={-1}
      aria-valuemax={1}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* drawn like the car's own wheel: a thick dark leather rim, three spokes (left, right and a split lower one) with a silver
          trim, and a padded hub */}
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          <radialGradient id="sw-rim" cx="50%" cy="40%" r="60%">
            <stop offset="0" stopColor="#3a3d44" />
            <stop offset="1" stopColor="#141519" />
          </radialGradient>
          <linearGradient id="sw-spoke" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3b3e45" />
            <stop offset="1" stopColor="#1c1e22" />
          </linearGradient>
        </defs>
        <g ref={rim} style={{ transformOrigin: '50px 50px' }}>
          <circle cx="50" cy="50" r="42" fill="none" stroke="url(#sw-rim)" strokeWidth="10" />
          <circle cx="50" cy="50" r="46.6" fill="none" stroke="rgba(255,255,255,.14)" strokeWidth="0.8" />
          <circle cx="50" cy="50" r="37.4" fill="none" stroke="rgba(0,0,0,.5)" strokeWidth="0.8" />
          {/* side spokes */}
          <path d="M9 46 L33 43 Q37 50 33 58 L10 56 Z" fill="url(#sw-spoke)" />
          <path d="M91 46 L67 43 Q63 50 67 58 L90 56 Z" fill="url(#sw-spoke)" />
          <path d="M12 47.5 L32 45.5" stroke="#a7adb6" strokeWidth="1.1" strokeLinecap="round" />
          <path d="M88 47.5 L68 45.5" stroke="#a7adb6" strokeWidth="1.1" strokeLinecap="round" />
          {/* split lower spoke */}
          <path d="M40 60 L36 88 L44 89 L46 62 Z M60 60 L64 88 L56 89 L54 62 Z" fill="url(#sw-spoke)" />
          {/* hub */}
          <rect x="31" y="36" width="38" height="28" rx="12" fill="#26282d" stroke="#0f1013" strokeWidth="1.2" />
          <rect x="34" y="38.5" width="32" height="23" rx="10" fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="0.8" />
          <ellipse cx="50" cy="50" rx="7" ry="4.6" fill="none" stroke="#b9bfc8" strokeWidth="1.3" />
        </g>
      </svg>
    </div>
  )
}

