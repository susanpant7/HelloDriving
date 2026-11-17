import { useEffect, useRef, useState, type PointerEvent } from 'react'
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
      className={`eye${d.on ? ' on' : ''}`}
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
      <small>{d.on ? (d.x < -50 ? 'Blind L' : d.x > 50 ? 'Blind R' : d.x < -12 ? 'Left' : d.x > 12 ? 'Right' : d.y < -14 ? 'Rear' : 'Look') : 'Look'}</small>
    </div>
  )
}

/** how far the on-screen wheel turns (degrees, each way) for full lock */
const WHEEL_LOCK = 240

/**
 * An on-screen steering wheel: put a finger on it and turn it round, like a real wheel. The car steers as far as you turn it and holds
 * that while your finger stays; let go and it returns to straight. Two quick little nudges the same way ask for a lane change (as a
 * double tap of an arrow key does). When nobody holds it, it shows the car's own wheel (lane assist turning it, or it straightening up).
 */
export function SteerWheel() {
  const ref = useRef<HTMLDivElement>(null)
  const rim = useRef<SVGGElement>(null)
  const [on, setOn] = useState(false)
  const g = useRef({ id: -1, cx: 0, cy: 0, last: 0, deg: 0, t0: 0, peak: 0 })

  // the picture follows the car's wheel every frame (also while it is held: the sim may clamp it)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const d = input.wheel !== null ? input.wheel * WHEEL_LOCK : sim.wheel * WHEEL_LOCK
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
    // pick the wheel up where it is now (if it was still straightening up, the finger catches it there)
    s.deg = sim.wheel * WHEEL_LOCK
    s.t0 = performance.now(); s.peak = 0
    input.wheel = s.deg / WHEEL_LOCK
    setOn(true)
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const s = g.current
    if (e.pointerId !== s.id) return
    // right over the hub the angle jumps about: wait until the finger is a little way out
    if (Math.hypot(e.clientX - s.cx, e.clientY - s.cy) < 10) return
    const a = angle(e)
    let d = a - s.last
    if (d > 180) d -= 360
    else if (d < -180) d += 360
    s.last = a
    s.deg = Math.max(-WHEEL_LOCK, Math.min(WHEEL_LOCK, s.deg + d)) // clockwise (on screen) = right
    if (Math.abs(s.deg) > Math.abs(s.peak)) s.peak = s.deg
    input.wheel = s.deg / WHEEL_LOCK
  }
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const s = g.current
    if (e.pointerId !== s.id) return
    s.id = -1
    input.wheel = null
    setOn(false)
    // a quick small nudge counts as a "tap" that way: two in a row ask for a lane change
    if (performance.now() - s.t0 < 300 && Math.abs(s.peak) > 6 && Math.abs(s.peak) < 70) steerTap(s.peak > 0 ? 1 : -1)
  }

  return (
    <div
      ref={ref}
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
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <g ref={rim} style={{ transformOrigin: '50px 50px' }}>
          <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="9" />
          {/* the spokes: left, right and down, with the hub in the middle */}
          <path d="M9 50 H38 M62 50 H91 M50 62 V91" stroke="currentColor" strokeWidth="7" strokeLinecap="round" />
          <circle cx="50" cy="50" r="13" fill="rgba(255,255,255,.12)" stroke="currentColor" strokeWidth="5" />
          {/* top-centre marker: shows at a glance how far the wheel is turned */}
          <rect x="46" y="4" width="8" height="10" rx="2" fill="#3b82f6" />
        </g>
      </svg>
    </div>
  )
}
