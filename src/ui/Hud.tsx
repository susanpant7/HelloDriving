import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { gasTapFn, recentreView, setMotionLook, setTiltSteer, steerTap } from '../game/input'
import { MODES, type Mode, fmtDist } from '../game/nav'
import { TRAFFIC_CITY, TRAFFIC_RES, adjustMirror, cruiseStep, toggleCruise, goMenu, input, pauseGame, resumeGame, startGame, toggleSignal, realAhead } from '../game/sim'
import type { RbDiag, RbPath } from '../game/store'
import { HW_TOTAL } from '../highway/traffic'
import { VIEW0, type ViewOffset, setSteerMode, setMirrorLite, setGraphics, setViewOffset, setLookMode, setMode, setMotionSens, setSteerSens, setTraffic, setUnits, useGame } from '../game/store'
import { MapOverlay } from './MapOverlay'
import { EyeControl, SteerWheel } from './TouchPad'
import { PlacePicker } from './PlacePicker'
import { useViewport } from './useViewport'

const Key = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>

const TRAFFIC_LABELS = ['Very light', 'Light', 'Normal', 'Busy', 'Very busy']

/** the ⓘ button beside a setting's name */
function InfoTip({ id, open, onToggle }: { id: string; open: boolean; onToggle: (v: string | null) => void }) {
  return <button type="button" className={`infotip${open ? ' on' : ''}`} aria-label={`About ${id}`} aria-expanded={open} onClick={() => onToggle(open ? null : id)}>i</button>
}
const SETTING_INFO: Record<string, string> = {"Steering": "How you steer on a phone or tablet. Wheel: a small steering wheel at the bottom left; put a finger on it and turn it round, and the car steers as far as you turn it (let go and it returns to straight). Arrows: hold ◀ ▶ to keep turning the wheel. Tilt phone: hold the phone like a steering wheel and turn it; the way you hold it when you start counts as straight (press the centre screen to make the way you hold it now straight). Tilt phone uses the phone's movement, so Phone motion (looking around by moving the phone) is switched off while it is on.", "Speed units": "Shows speeds and limits in miles per hour or kilometres per hour. The rules are the same either way: the limits on the signs and on the centre screen change with this. (Keyboard: U)", "Phone motion": "On: move the phone to look around, like looking through a window: turn it left or right to turn your head, tilt it up for the rear-view mirror. The eye icon still works as well and adds to it. Press the car's centre screen to make wherever the phone points 'straight ahead' again. Turning well to one side counts as a blind-spot check.", "Phone motion sensitivity": "How far your view turns for a given movement of the phone. 1 needs a big movement, 5 only a small one. 3 is the standard. Only used when Phone motion is on.", "Steering sensitivity": "How quickly the steering wheel turns while you hold left or right. Lower is gentler and easier to keep straight; higher turns sharply for tight corners. The wheel returns to straight when you let go.", "Graphics": "How much drawing work each frame does. High: best look (sharpest picture and mirrors, all screen effects, see furthest). Medium: balanced (a little softer, lighter effects, the rear-view mirror refreshes every other frame). Low: smoothest (plain picture, mirrors refresh every other frame, shorter view). Roads, signs, signals, traffic and the rules are the same at every level. The game also lowers the sharpness by itself for a moment if the frame rate drops.", "Mirror detail": "Full: the mirrors show everything, as far back as you can see ahead, at full sharpness. Light: the mirrors only draw about 200 m behind you, skip small road-wear details and are slightly softer; cars, lane markings, signs and lights are still shown. Use Light if the game stutters: it is the setting that gives the most smoothness back.", "Traffic": "How many other cars there are. The same level means different amounts in different places, as in real life: quiet residential streets, busier city roads, and the most on the highway. On the Mixed course it changes as you drive from one district to another. (Keyboard: 1 to 5)"}

/** The settings, in three groups: driving, phone and tablet controls (on a touch screen), and the picture */
function Settings() {
  const [info, setInfo] = useState<string | null>(null)
  const traffic = useGame((s) => s.traffic)
  const units = useGame((s) => s.units)
  const steerSens = useGame((s) => s.steerSens)
  const lookMode = useGame((s) => s.lookMode)
  const steerMode = useGame((s) => s.steerMode)
  const [tiltErr, setTiltErr] = useState(false)
  const motionSens = useGame((s) => s.motionSens)
  const graphics = useGame((s) => s.graphics)
  const mirrorLite = useGame((s) => s.mirrorLite)
  const { touch } = useViewport()
  return (
    <div className="settings">
      {info && (
        <div className="infobox" role="note">
          <div className="infobox-head"><b>{info}</b><button type="button" aria-label="Close" onClick={() => setInfo(null)}>×</button></div>
          <p>{SETTING_INFO[info]}</p>
        </div>
      )}
      <section className="setgroup">
        <h3>Driving</h3>
      <div className="setting">
        <div className="setting-head">
          <span className="setlabel">Speed units<InfoTip id="Speed units" open={info === 'Speed units'} onToggle={setInfo} /></span>
          <Key>U</Key>
        </div>
        <div className="seg" role="group" aria-label="Speed units">
          <button className={units === 'kmh' ? 'on' : ''} onClick={() => setUnits('kmh')}>km/h</button>
          <button className={units === 'mph' ? 'on' : ''} onClick={() => setUnits('mph')}>mph</button>
        </div>
      </div>
      <div className="setting">
        <div className="setting-head">
          <span className="setlabel">Steering sensitivity<InfoTip id="Steering sensitivity" open={info === 'Steering sensitivity'} onToggle={setInfo} /></span>
          <span className="muted">{['Very gentle', 'Gentle', 'Medium', 'Quick', 'Very quick'][steerSens - 1]}</span>
        </div>
        <div className="seg" role="group" aria-label="Steering sensitivity">
          {([1, 2, 3, 4, 5] as const).map((n) => (
            <button key={n} className={steerSens === n ? 'on' : ''} onClick={() => setSteerSens(n)}>{n}</button>
          ))}
        </div>
      </div>
      <div className="setting">
        <div className="setting-head">
          <span className="setlabel">Traffic<InfoTip id="Traffic" open={info === 'Traffic'} onToggle={setInfo} /></span>
          <span className="muted" title="Cars around you at this level, by where you drive">{TRAFFIC_LABELS[traffic - 1]} · about {TRAFFIC_RES[traffic - 1]} cars in a residential area, {TRAFFIC_CITY[traffic - 1]} in the city, {HW_TOTAL[traffic - 1]} on the highway{traffic === 5 ? ' (a traffic jam)' : ''}</span>
          <Key>1</Key><span className="kb-only">–</span><Key>5</Key>
        </div>
        <div className="seg" role="group" aria-label="Traffic level">
          {([1, 2, 3, 4, 5] as const).map((n) => (
            <button key={n} className={traffic === n ? 'on' : ''} onClick={() => setTraffic(n)}>{n}</button>
          ))}
        </div>
      </div>
      </section>
      {touch && (
      <section className="setgroup">
        <h3>Phone and tablet</h3>
      <>
        <div className="setting">
          <div className="setting-head">
            <span className="setlabel">Steering<InfoTip id="Steering" open={info === 'Steering'} onToggle={setInfo} /></span>
            <span className="muted">{tiltErr ? 'Tilt needs the motion sensor: allow it, or pick Wheel / Arrows' : steerMode === 'wheel' ? 'Turn the small wheel with a finger' : steerMode === 'arrows' ? 'Hold ◀ ▶' : 'Turn the phone like a wheel'}</span>
          </div>
          <div className="seg" role="group" aria-label="Steering">
            <button className={steerMode === 'wheel' ? 'on' : ''} onClick={() => { setTiltErr(false); setSteerMode('wheel') }}>Wheel</button>
            <button className={steerMode === 'arrows' ? 'on' : ''} onClick={() => { setTiltErr(false); setSteerMode('arrows') }}>Arrows</button>
            {/* (asked for here, inside the tap: iPhones only allow the motion sensor from a tap) */}
            <button className={steerMode === 'tilt' ? 'on' : ''} onClick={async () => { const ok = await setTiltSteer(true); setTiltErr(!ok); if (ok) setSteerMode('tilt') }}>Tilt phone</button>
          </div>
        </div>
      </>
      <>
        <div className="setting">
          <div className="setting-head">
            <span className="setlabel">Phone motion<InfoTip id="Phone motion" open={info === 'Phone motion'} onToggle={setInfo} /></span>
            <span className="muted">{steerMode === 'tilt' ? 'Off while you steer by tilting the phone' : lookMode === 'motion' ? 'Move the phone to look (the eye icon works too)' : 'Off: look with the eye icon'}</span>
          </div>
          <div className="seg" role="group" aria-label="Phone motion">
            <button className={lookMode === 'eye' ? 'on' : ''} onClick={() => setLookMode('eye')}>Off</button>
            <button className={lookMode === 'motion' ? 'on' : ''} disabled={steerMode === 'tilt'} onClick={async () => { if (await setMotionLook(true)) setLookMode('motion') }}>On</button>
          </div>
        </div>
      </>
      <>
        <div className="setting">
          <div className="setting-head">
            <span className="setlabel">Phone motion sensitivity<InfoTip id="Phone motion sensitivity" open={info === 'Phone motion sensitivity'} onToggle={setInfo} /></span>
            <span className="muted">{lookMode === 'motion' ? ['Very low', 'Low', 'Medium', 'High', 'Very high'][motionSens - 1] : 'Used with Phone motion'}</span>
          </div>
          <div className="seg" role="group" aria-label="Phone motion sensitivity">
            {([1, 2, 3, 4, 5] as const).map((n) => (
              <button key={n} className={motionSens === n ? 'on' : ''} onClick={() => setMotionSens(n)}>{n}</button>
            ))}
          </div>
        </div>
      </>
      </section>
      )}
      <section className="setgroup">
        <h3>Picture</h3>
      <div className="setting">
        <div className="setting-head">
          <span className="setlabel">Graphics<InfoTip id="Graphics" open={info === 'Graphics'} onToggle={setInfo} /></span>
          <span className="muted">{graphics === 'high' ? 'Best look' : graphics === 'medium' ? 'Balanced' : 'Smoothest'}</span>
        </div>
        <div className="seg" role="group" aria-label="Graphics quality">
          {(['high', 'medium', 'low'] as const).map((g) => (
            <button key={g} className={graphics === g ? 'on' : ''} onClick={() => setGraphics(g)}>{g === 'high' ? 'High' : g === 'medium' ? 'Medium' : 'Low'}</button>
          ))}
        </div>
      </div>
      <div className="setting">
        <div className="setting-head">
          <span className="setlabel">Mirror detail<InfoTip id="Mirror detail" open={info === 'Mirror detail'} onToggle={setInfo} /></span>
          <span className="muted">{mirrorLite ? 'Light: smoother; about 200 m behind, no road wear' : 'Full: sharpest, shows everything'}</span>
        </div>
        <div className="seg" role="group" aria-label="Mirror detail">
          <button className={!mirrorLite ? 'on' : ''} onClick={() => setMirrorLite(false)}>Full</button>
          <button className={mirrorLite ? 'on' : ''} onClick={() => setMirrorLite(true)}>Light</button>
        </div>
      </div>
      </section>
    </div>
  )
}

function ControlsList() {
  return (
    <ul className="controls">
      <li><span><Key>↑</Key></span> Accelerator <em>hold to speed up, release to slow down</em></li>
      <li><span><Key>↓</Key></span> Brake / reverse <em>like a real pedal: a tap slows you gently; the longer you hold it, the harder it brakes (firm after about a second, an emergency stop after about two). Once stopped, press it again and hold to back up (R lights on the dashboard); ↑ then stops you and drives forward again</em></li>
      <li><span><Key>←</Key><Key>→</Key></span> Steer <em>hold to turn the wheel at a steady pace (Steering sensitivity in Settings sets how fast); let go and it returns to straight</em></li>
      <li><span><Key>C</Key></span> Cruise control on / off <em>holds the speed you are doing (from about 11 mph); the brake switches it off. A quick double press of ↑ does the same</em></li>
      <li><span><Key>L</Key></span> Lane assist on / off <em>while on, the car keeps itself in the middle of its lane, even round bends and roundabouts ("LANE ASSIST" glows on the dashboard). Steering by hand overrides it; it takes over again when you let go</em></li>
      <li><span><Key>Space</Key></span> View back to your default <em>turns your head back to the road, to the view you set in the pause menu (Set default view)</em></li>
      <li><span><Key>Q</Key><Key>E</Key></span> Left / right indicator <em>press the same one again to switch it off; like a real car, it also switches itself off when the wheel comes back to straight after the turn (or if you steer firmly the other way)</em></li>
      <li><span>Drag</span> Look around <em>press and drag with the mouse, or swipe with two fingers on a trackpad (the view holds, tap to look ahead again); aim at a mirror to check it</em></li>
      <li><span><Key>A</Key><Key>D</Key><Key>W</Key><Key>S</Key></span> Turn your head <em>like the wheel: each press turns it a little and it stays (A left, D right, W up, S down; combine them, e.g. A + W). Double-press A or D to look over that shoulder into the blind spot (about 120°).</em></li>
      <li><span><Key>Esc</Key></span> Pause <span className="gap" /><Key>M</Key> mute</li>
    </ul>
  )
}

/** A button that stays "pressed" while a finger is on it (works with several fingers at once). */
function HoldButton({ label, onDown, onUp, className = '', active = false, children }: { label: string; onDown: () => void; onUp: () => void; className?: string; active?: boolean; children: ReactNode }) {
  const down = (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    onDown()
  }
  const up = () => onUp()
  return (
    <button
      className={`tbtn ${className}${active ? ' on' : ''}`}
      aria-label={label}
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </button>
  )
}

/**
 * On-screen controls for phones and tablets. Left edge: the indicators. Just left of the car's wheel: the eye (slide to look around). Bottom left: steering.
 * Right: VIEW (back to your default view) and LANE (lane assist) at the edge, 40% down; cruise control, brake and gas at the bottom.
 */
const Chev = ({ dir, up, down }: { dir: -1 | 1; up?: boolean; down?: boolean }) => (
  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" style={{ transform: up ? 'rotate(90deg)' : down ? 'rotate(-90deg)' : dir === 1 ? 'scaleX(-1)' : undefined }}>
    <path d="M15 4 7 12l8 8" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
/* ---- button icons (no words on the touch buttons) ---- */
/** VIEW: back to your default view (a crosshair: "aim straight ahead") */
const ViewIcon = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="6.5" />
    <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
    <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
  </svg>
)
/** LANE: a car between two lane lines (the lane-keeping symbol on a real dashboard) */
const LaneIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 22 7.5 2M19.5 22 16.5 2" />
    <path d="M9 17v-4.2l1.1-3.3h3.8l1.1 3.3V17M9 15h6" />
    <path d="M9.4 17v1.6M14.6 17v1.6" />
  </svg>
)
/** CRUISE: a speedometer with its needle */
const CruiseIcon = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4.2 17.5a9 9 0 1 1 15.6 0" />
    <path d="M12 14.5l4.5-4.5" />
    <circle cx="12" cy="14.5" r="1.6" fill="currentColor" stroke="none" />
    <path d="M7 9.5l.9.9M12 6.5v1.3" />
  </svg>
)
/** a pedal: the brake wide and short, the accelerator tall and narrow (as in the car), with rubber ridges */
const PedalIcon = ({ gas }: { gas?: boolean }) => (
  <svg viewBox="0 0 24 24" width={gas ? 22 : 26} height={gas ? 28 : 22} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    {gas ? (
      <>
        <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
        <path d="M10 7h4M10 10.5h4M10 14h4M10 17.5h4" />
      </>
    ) : (
      <>
        <rect x="3" y="6" width="18" height="12" rx="3" />
        <path d="M7.5 10h9M7.5 14h9" />
      </>
    )}
  </svg>
)
/** a button that does its step once when pressed and keeps repeating while it is held */
function RepeatButton({ label, onStep, children }: { label: string; onStep: () => void; children: ReactNode }) {
  const t = useRef(0)
  const stop = () => { clearTimeout(t.current); clearInterval(t.current) }
  useEffect(() => stop, [])
  return (
    <HoldButton label={label} className="cruisestep" onDown={() => { onStep(); stop(); t.current = window.setTimeout(() => { t.current = window.setInterval(onStep, 140) }, 450) }} onUp={stop}>
      {children}
    </HoldButton>
  )
}
const TurnArrow = ({ dir }: { dir: -1 | 1 }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" style={{ transform: dir === 1 ? 'scaleX(-1)' : undefined }}>
    <path d="M10 5 3 12l7 7V15h11V9H10z" fill="currentColor" />
  </svg>
)
function TouchControls() {
  const signal = useGame((s) => s.hud.signal)
  const assist = useGame((s) => s.hud.assist)
  const lookMode = useGame((s) => s.lookMode)
  const steerMode = useGame((s) => s.steerMode)
  const cruise = useGame((s) => s.hud.cruise)
  const units = useGame((s) => s.units)
  useEffect(() => {
    if (lookMode === 'motion' && steerMode !== 'tilt') void setMotionLook(true)
    return () => { void setMotionLook(false) }
  }, [lookMode, steerMode])
  useEffect(() => {
    if (steerMode !== 'tilt') return
    // tilt steering: an iPhone only lets the motion sensor start from a tap, so if it cannot start yet, the next tap starts it
    let live = true
    const retry = () => { if (live) void setTiltSteer(true) }
    void setTiltSteer(true).then((ok) => { if (live && !ok) window.addEventListener('pointerdown', retry, { once: true }) })
    return () => { live = false; window.removeEventListener('pointerdown', retry); void setTiltSteer(false) }
  }, [steerMode])
  const hold = (key: 'up' | 'down') => ({ onDown: () => { input[key] = true }, onUp: () => { input[key] = false } })
  return (
    <div className="touch-controls" onContextMenu={(e) => e.preventDefault()}>
      {/* VIEW and LANE: at the right edge, 40% down  */}
      <div className="midright">
        <button className="tbtn lanekeep viewbtn" aria-label="View: back to your default view" onPointerDown={() => recentreView()}><ViewIcon /></button>
        <button className={`tbtn lanekeep${assist ? ' on' : ''}${assist === 2 ? ' active' : ''}`} aria-pressed={assist > 0} aria-label="Lane assist (tap to switch on or off)" onPointerDown={() => { input.laneToggle = true }}><LaneIcon /></button>
      </div>
      {/* bottom left: the steering (wheel or arrows; none when tilting the phone) */}
      {/* the eye: just left of the car's steering wheel */}
      <EyeControl />
      {/* indicators: at the left edge, 40% of the way down */}
      <div className="pod sigpod sigleft">
        <HoldButton label="Left indicator" className={`sig${signal === -1 ? ' blink' : ''}`} active={signal === -1} onDown={() => toggleSignal(-1)} onUp={() => {}}><TurnArrow dir={-1} /></HoldButton>
        <HoldButton label="Right indicator" className={`sig${signal === 1 ? ' blink' : ''}`} active={signal === 1} onDown={() => toggleSignal(1)} onUp={() => {}}><TurnArrow dir={1} /></HoldButton>
      </div>
      <div className="tleft">
        {steerMode === 'wheel' && <SteerWheel />}
        {steerMode === 'arrows' && (
          <div className="pod steerpod">
            <HoldButton label="Steer left" className="steer" onDown={() => { input.left = true; steerTap(-1) }} onUp={() => { input.left = false }}><Chev dir={-1} /></HoldButton>
            <HoldButton label="Steer right" className="steer" onDown={() => { input.right = true; steerTap(1) }} onUp={() => { input.right = false }}><Chev dir={1} /></HoldButton>
          </div>
        )}
      </div>

      <div className="tgroup center" />

      <div className="tgroup">
        {/* cruise control: on at the speed you are doing (or off); while it is on, ▲ / ▼ change the set speed */}
        {cruise > 0 && (
          <div className="pod cruisepod">
            <RepeatButton label="Cruise speed up" onStep={() => cruiseStep(1)}><Chev dir={1} up /></RepeatButton>
            <RepeatButton label="Cruise speed down" onStep={() => cruiseStep(-1)}><Chev dir={1} down /></RepeatButton>
          </div>
        )}
        <button className={`tbtn cruisebtn${cruise > 0 ? ' on' : ''}`} aria-pressed={cruise > 0} aria-label={cruise > 0 ? 'Cruise control: on (tap to switch off)' : 'Cruise control: tap to hold the speed you are doing'} onPointerDown={(e) => { e.preventDefault(); toggleCruise() }}>
          <CruiseIcon />
          {cruise > 0 && <b>{Math.round(cruise * (units === 'mph' ? 2.23694 : 3.6))}</b>}
        </button>
        <HoldButton label="Brake" className="pedal brake" {...hold('down')}><PedalIcon /></HoldButton>
        <div className="gascol">
          <HoldButton label="Accelerator" className="pedal gas" onDown={() => { input.up = true; gasTapFn() }} onUp={() => { input.up = false }}><PedalIcon gas /></HoldButton>
        </div>
      </div>
    </div>
  )
}

/** Mixed course: a short black card while the scene changes between the town and the highway */
function FadeCard() {
  const fade = useGame((s) => s.fade)
  if (!fade) return null
  return (
    <div key={fade.id} className="fadecard" aria-live="polite">
      <b>{fade.text}</b>
      <span>{fade.sub}</span>
    </div>
  )
}

/**
 * Set your default view, saved for next time.
 *  - one finger (or the mouse): drag to turn and tilt the resting view
 *  - two fingers: drag to move the whole car in the picture (left / right / up / down: your head moves in the seat), pinch to sit
 *    closer to or further from the windscreen
 */
function ViewAdjust() {
  const vo = useGame((s) => s.viewOffset)
  const pts = useRef(new Map<number, { x: number; y: number }>())
  const prev = useRef<{ x: number; y: number; d: number; n: number } | null>(null)
  const clampV = (v: ViewOffset): ViewOffset => ({
    yaw: Math.max(-0.5, Math.min(0.5, v.yaw)), pitch: Math.max(-0.35, Math.min(0.35, v.pitch)),
    x: Math.max(-0.22, Math.min(0.22, v.x)), y: Math.max(-0.14, Math.min(0.14, v.y)), z: Math.max(-0.2, Math.min(0.2, v.z)),
  })
  /** the centre of the fingers, how far apart they are (two fingers) and how many there are */
  const gesture = () => {
    const p = [...pts.current.values()]
    if (!p.length) return null
    if (p.length === 1) return { x: p[0].x, y: p[0].y, d: 0, n: 1 }
    const [a, b] = p
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y), n: 2 }
  }
  const lift = (e: PointerEvent<HTMLDivElement>) => {
    pts.current.delete(e.pointerId)
    prev.current = gesture() // a finger lifted: carry on from the ones still down, without a jump
    if (!pts.current.size) setViewOffset(useGame.getState().viewOffset)
  }
  const pct = (m: number) => Math.round(m * 100)
  return (
    <>
      <div
        className="viewdrag"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
          prev.current = gesture()
        }}
        onPointerMove={(e) => {
          if (!pts.current.has(e.pointerId)) return
          pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
          const g = gesture(), p = prev.current
          prev.current = g
          if (!g || !p || g.n !== p.n) return
          const dx = g.x - p.x, dy = g.y - p.y
          const cur = useGame.getState().viewOffset
          if (g.n === 1) {
            // one finger: drag the view like a picture (drag left to look further right, down to look up)
            setViewOffset(clampV({ ...cur, yaw: cur.yaw + dx * 0.0025, pitch: cur.pitch + dy * 0.0025 }), false)
          } else {
            // two fingers: the car moves with them (drag right and the car slides right in the picture: your head moves left);
            // spreading them brings you closer to the windscreen
            const k = 0.0009
            setViewOffset(clampV({ ...cur, x: cur.x - dx * k, y: cur.y + dy * k, z: cur.z - (g.d - p.d) * 0.0012 }), false)
          }
        }}
        onPointerUp={lift}
        onPointerCancel={lift}
      />
      <div className="adjbar high viewbar">
        <span>One finger: aim your view. Two fingers: move the car in the picture, pinch to sit closer.</span>
        <small className="muted">{Math.round((vo.yaw * 180) / Math.PI)}° · {Math.round((vo.pitch * 180) / Math.PI)}° · seat {pct(vo.x)}/{pct(vo.y)}/{pct(vo.z)} cm</small>
        <button className="secondary" onClick={() => setViewOffset(VIEW0)}>Reset</button>
        <button className="primary" onClick={() => { setViewOffset(useGame.getState().viewOffset); useGame.setState({ viewAdjusting: false }) }}>Done</button>
      </div>
    </>
  )
}

function TouchHelp() {
  return (
    <ul className="controls">
      <li><span><b>Cruise</b></span> The speedometer button, left of the brake: tap while driving to hold the speed you are doing (it shows the set speed); ▲ ▼ next to it change it, hold to change it quickly. Tap again, or brake, to switch it off</li>
      <li><span><b>View</b></span> The crosshair at the right edge: turns your head back to your default view</li>
      <li><span><b>Gas / Brake</b></span> Pedals at the bottom right: the tall green one is the accelerator, the wide red one the brake. Hold the accelerator to speed up, let go to slow down. The brake gets stronger the longer you hold it: tap for a gentle stop. Stopped, press the brake again and hold it to back up; the accelerator then stops you and drives forward again</li>
      <li><span><b>Steer</b></span> Pick how in Settings → Steering. Wheel (bottom left): put a finger on it and turn it round; the car steers as far as you turn it, and it returns to straight when you let go. Arrows: hold ◀ ▶. Tilt phone: turn the phone like a steering wheel (press the centre screen to make the way you hold it now count as straight). With the wheel or arrows, two quick little nudges / taps the same way change lane. Lane assist (the car between two lane lines, right edge, 40% down): tap to switch it on (the car keeps to the middle of its lane; "LANE ASSIST" glows on the dashboard), tap again to switch it off</li>
      <li><span><b>Eye</b></span> Just left of the car's steering wheel: put a thumb on it and slide left or right to turn your head (all the way for the blind spot, up for the rear-view mirror). With Phone motion on in Settings you can also move the phone; press the centre screen to recentre</li>
      <li><span><b>⬅ ➡</b></span> Left edge of the screen: left and right indicator. Tap to switch on, tap again to switch off; like a real car, it also switches itself off when the wheel comes back to straight after the turn</li>
    </ul>
  )
}

/**
 * Before driving: the main page (what to practise, then Drive), the settings page (the gear icon), and for a real place the map
 * page (choose and download the place, then Drive). On a phone these pages work upright as well as sideways.
 */
function MainMenu() {
  const [page, setPage] = useState<'home' | 'settings' | 'map'>('home')
  const mode = useGame((s) => s.mode)
  const { touch } = useViewport()
  const drive = () => (mode === 'real' ? setPage('map') : startGame())
  const back = (
    <button type="button" className="iconbtn" aria-label="Back to the main page" onClick={() => setPage('home')}>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
  )
  return (
    <div className="overlay menu">
      <div className="panel wide page">
        {page === 'home' && (
          <>
            <header className="pagehead home">
              <div>
                <div className="logo">Hello <span>Driving</span></div>
                <p>Learn to drive: lanes, traffic lights, junctions and roundabouts. Check your mirrors, signal, then move. A crash ends the run. Mistakes are flagged as you make them.</p>
              </div>
              <button type="button" className="iconbtn gear" aria-label="Settings" title="Settings" onClick={() => setPage('settings')}>
                <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3.2" />
                  <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
                </svg>
              </button>
            </header>
            <section className="practice">
              <h3>Where do you want to practise?</h3>
              <ModePicker />
            </section>
            <div className="pagefoot">
              <button type="button" className="primary" onClick={drive}>{mode === 'real' ? 'Next: choose the place' : `Drive: ${modeTitle(mode)}`} {!touch && mode !== 'real' && <Key>Enter</Key>}</button>
            </div>
          </>
        )}
        {page === 'settings' && (
          <>
            <header className="pagehead">{back}<h2>Settings</h2></header>
            <Settings />
            <section className="setgroup">
              <h3>Controls</h3>
              {touch ? <TouchHelp /> : <ControlsList />}
            </section>
            <div className="pagefoot"><button type="button" className="primary" onClick={() => setPage('home')}>Done</button></div>
          </>
        )}
        {page === 'map' && <PlacePicker onBack={() => setPage('home')} />}
      </div>
    </div>
  )
}

function ModePicker() {
  const mode = useGame((s) => s.mode)
  return (
    <div className="modes" role="radiogroup" aria-label="Practice">
      {MODES.map((m) => (
        <button key={m.id} role="radio" aria-checked={mode === m.id} className={`mode${mode === m.id ? ' on' : ''}`} onClick={() => setMode(m.id as Mode)}>
          <b>{m.title}</b>
          <span>{m.blurb}</span>
        </button>
      ))}
    </div>
  )
}

const modeTitle = (m: Mode) => MODES.find((x) => x.id === m)?.title ?? ''

/** A small picture of a two-lane roundabout: the correct route (green) and the route you took (red, dashed). You enter from the bottom. */
function RbDiagram({ diag }: { diag: RbDiag }) {
  const path = (p: RbPath) => {
    const inner = p.lane === 'inner'
    const x = inner ? 111 : 129
    const R = inner ? 52 : 70
    const dy = Math.sqrt(R * R - 81)
    const a = `A${R},${R} 0 0 0`
    const start = `M${x},240 L${x},${120 + dy}`
    if (p.turn === 'right') return `${start} ${a} ${120 + dy},129 L240,129`
    if (p.turn === 'straight') return `${start} ${a} ${120 + R},120 ${a} 129,${120 - dy} L129,0`
    if (p.turn === 'left') return `${start} ${a} ${120 + R},120 ${a} 120,${120 - R} ${a} ${120 - dy},111 L0,111`
    return `${start} ${a} ${120 + R},120 ${a} 120,${120 - R} ${a} ${120 - R},120 ${a} 111,${120 + dy} L111,240`
  }
  const open = diag.open ?? (['right', 'straight', 'left', 'back'] as const)
  const ORD = ['1st', '2nd', '3rd', '4th']
  const DIR = { right: 'right', straight: 'straight on', left: 'left', back: 'back the way you came' }
  const no = (t: RbPath['turn']) => Math.max(0, open.indexOf(t)) + 1
  const words = (t: RbPath['turn']) => `${ORD[no(t) - 1]} exit: ${DIR[t]}`
  const has = (t: RbPath['turn']) => open.includes(t)
  const lane = (p: RbPath) => (p.lane === 'either' ? 'either lane' : `${p.lane} lane`)
  return (
    <figure className="rbdiag">
      <svg viewBox="0 0 240 240" width="200" height="200" role="img" aria-label="Roundabout diagram">
        <rect x="102" y="150" width="36" height="90" fill="#59606b" />{has('straight') && <rect x="102" y="0" width="36" height="90" fill="#59606b" />}
        {has('left') && <rect x="0" y="102" width="90" height="36" fill="#59606b" />}{has('right') && <rect x="150" y="102" width="90" height="36" fill="#59606b" />}
        <circle cx="120" cy="120" r="82" fill="#59606b" /><circle cx="120" cy="120" r="61" fill="none" stroke="#fff" strokeWidth="1.5" strokeDasharray="6 6" />
        <circle cx="120" cy="120" r="44" fill="#3f7a4b" />
        {diag.took && <path d={path(diag.took)} fill="none" stroke="#ef4444" strokeWidth="5" strokeDasharray="9 6" strokeLinecap="round" />}
        <path d={path(diag.correct)} fill="none" stroke="#22c55e" strokeWidth="5" strokeLinecap="round" />
        {([['right', 226, 124], ['straight', 124, 14], ['left', 14, 124], ['back', 100, 232]] as const).filter(([t]) => has(t)).map(([t, x, y]) => <text key={t} x={x} y={y} fontSize="16" fontWeight="700" fill="#fff" textAnchor="middle">{no(t)}</text>)}
        <text x="120" y="126" fontSize="12" fill="#fff" textAnchor="middle">you enter ↑</text>
      </svg>
      <figcaption>
        <span className="ok">Correct: {words(diag.correct.turn)}, {lane(diag.correct)}</span>
        {diag.took && <span className="bad">You: {words(diag.took.turn)}, {lane(diag.took)}</span>}
      </figcaption>
    </figure>
  )
}

/**
 * Real places: what is at the end of your road (traffic lights, a STOP or a YIELD sign) and how far, from about 150 m out. For
 * lights it shows the lamp lit now, so you can always tell, even when the lights themselves are small on the screen.
 */
function AheadPanel() {
  const units = useGame((s) => s.units)
  const [a, setA] = useState({ ...realAhead })
  useEffect(() => {
    const id = window.setInterval(() => setA((cur) => (cur.kind === realAhead.kind && cur.light === realAhead.light && Math.abs(cur.dist - realAhead.dist) < 2 && cur.allWay === realAhead.allWay ? cur : { ...realAhead })), 120)
    return () => window.clearInterval(id)
  }, [])
  if (!a.kind) return null
  const dist = fmtDist(a.dist, units)
  return (
    <div className="ahead" role="status" aria-label={a.kind === 'signal' ? `Traffic light ahead: ${a.light === 'R' ? 'red' : a.light === 'Y' ? 'amber' : 'green'}, ${dist}` : `${a.kind === 'stop' ? 'STOP' : 'YIELD'} sign ahead, ${dist}`}>
      {a.kind === 'signal' ? (
        <svg viewBox="0 0 30 74" width="22" height="54" aria-hidden="true">
          <rect x="1" y="1" width="28" height="72" rx="6" fill="#16181c" stroke="#e8c21a" strokeWidth="2" />
          <circle cx="15" cy="15" r="8.5" fill={a.light === 'R' ? '#ff3b2a' : '#3a1512'} />
          <circle cx="15" cy="37" r="8.5" fill={a.light === 'Y' ? '#ffb300' : '#3a3112'} />
          <circle cx="15" cy="59" r="8.5" fill={a.light === 'G' ? '#22e06b' : '#123a1f'} />
        </svg>
      ) : a.kind === 'stop' ? (
        <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
          <path d="M12 1h16l11 11v16L28 39H12L1 28V12z" fill="#fff" /><path d="M12.6 2.5h14.8l10.1 10.1v14.8L27.4 37.5H12.6L2.5 27.4V12.6z" fill="#c4161c" />
          <text x="20" y="24.5" textAnchor="middle" fontSize="11" fontWeight="800" fill="#fff" fontFamily="Arial, sans-serif">STOP</text>
        </svg>
      ) : (
        <svg viewBox="0 0 44 40" width="44" height="40" aria-hidden="true">
          <path d="M2 3h40L22 38z" fill="#c4161c" /><path d="M9 7h26L22 30z" fill="#fff" />
        </svg>
      )}
      <div>
        <b>{a.kind === 'signal' ? (a.light === 'R' ? 'Red light' : a.light === 'Y' ? 'Amber light' : 'Green light') : a.kind === 'stop' ? (a.allWay ? 'All-way STOP' : 'STOP') : 'YIELD'}</b>
        <span>{a.dist < 3 ? 'at the line' : dist}</span>
      </div>
    </div>
  )
}

/** Paused: what you can do (resume, restart, mirrors, view, change practice), and the settings behind the gear icon */
function PausePanel() {
  const [settings, setSettings] = useState(false)
  const mode = useGame((s) => s.mode)
  const errors = useGame((s) => s.hud.errors)
  const { touch } = useViewport()
  if (settings) {
    return (
      <div className="overlay menu">
        <div className="panel wide page">
          <header className="pagehead">
            <button type="button" className="iconbtn" aria-label="Back" onClick={() => setSettings(false)}>
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <h2>Settings</h2>
          </header>
          <Settings />
          <section className="setgroup">
            <h3>Controls</h3>
            {touch ? <TouchHelp /> : <ControlsList />}
          </section>
          <div className="pagefoot"><button type="button" className="primary" onClick={() => setSettings(false)}>Done</button></div>
        </div>
      </div>
    )
  }
  return (
    <div className="overlay">
      <div className="panel pausepanel">
        <button type="button" className="iconbtn gear pausegear" aria-label="Settings" title="Settings" onClick={() => setSettings(true)}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3.2" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
        <h2>Paused</h2>
        <p className="sub">{modeTitle(mode)} · {errors} {errors === 1 ? 'mistake' : 'mistakes'} so far</p>
        <div className="actions">
          <button className="primary" onClick={resumeGame}>Resume <Key>Esc</Key></button>
          <button className="secondary" onClick={() => startGame()}>Restart <Key>R</Key></button>
          <button className="secondary" onClick={() => useGame.setState({ adjusting: true })}>Adjust mirrors</button>
          <button className="secondary" onClick={() => { adjustMirror(null); useGame.setState({ viewAdjusting: true }) }}>Set default view</button>
          <button className="secondary" onClick={goMenu}>Change practice</button>
        </div>
      </div>
    </div>
  )
}

function PlayingHud() {
  const hud = useGame((s) => s.hud)
  const messages = useGame((s) => s.messages)
  const { touch } = useViewport()
  const [help, setHelp] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setHelp(false), 15000)
    return () => clearTimeout(t)
  }, [])
  return (
    <>
      <div className="tl">
        <div className={`pts${hud.score < 0 ? ' neg' : ''}`} title="+2 for every rule followed, −2 for every mistake"><small>POINTS</small><b>{Math.round(hud.score)}</b></div>
        <div className="toasts">
          {messages.map((m) => (
            <div key={m.id} className={`toast ${m.kind}`}>{m.text}</div>
          ))}
        </div>
      </div>

      <div className="tr">
        <button className="icon-btn" onClick={() => startGame()} aria-label="Restart (R)" title="Restart (R)">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 12a7 7 0 1 0 2.2-5.1" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /><path d="M4 4v5h5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button className="icon-btn" onClick={pauseGame} aria-label="Pause (Esc)" title="Pause (Esc)">
          <svg viewBox="0 0 24 24" width="18" height="18"><rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor" /></svg>
        </button>
      </div>

      <MapOverlay />
      <AheadPanel />

      {touch && <TouchControls />}

      <div className={`helpbar${help && !touch ? ' show' : ''}`}>
        <span><Key>↑</Key> go</span>
        <span><Key>↓</Key> brake</span>
        <span><Key>←</Key><Key>→</Key> steer</span>
        <span><Key>Q</Key><Key>E</Key> indicators</span>
        <span><Key>C</Key> cruise</span>
        <span><Key>L</Key> lane assist</span>
        <span><Key>Space</Key> default view</span>
        <span>Drag / 2-finger swipe: look around · tap to look ahead</span>
        <span><Key>Esc</Key> pause</span>
      </div>
    </>
  )
}

export function Hud() {
  const status = useGame((s) => s.status)
  const reason = useGame((s) => s.crashReason)
  const pauseReason = useGame((s) => s.pauseReason)
  const tips = useGame((s) => s.crashTips)
  const diag = useGame((s) => s.crashDiag)
  const finalScore = useGame((s) => s.hud.score)
  const report = useGame((s) => s.report)
  const reportPts = useGame((s) => s.reportPoints)
  const start = startGame
  const adjusting = useGame((s) => s.adjusting)
  const viewAdjusting = useGame((s) => s.viewAdjusting)
  const [adjSel, setAdjSel] = useState<'left' | 'center' | 'right' | null>(null)
  useEffect(() => { if (!adjusting) setAdjSel(null) }, [adjusting])
  const { touch, portrait } = useViewport()

  // phones and tablets play in landscape: pause and ask for a rotation
  useEffect(() => {
    if (touch && portrait && status === 'playing') pauseGame()
  }, [touch, portrait, status])

  return (
    <div className={`hud${touch ? ' touch' : ''}`}>
      <FadeCard />
      {status === 'playing' && <PlayingHud />}
      {touch && portrait && status !== 'menu' && (
        <div className="overlay rotate">
          <div className="panel">
            <svg viewBox="0 0 64 64" width="72" height="72" aria-hidden="true"><rect x="22" y="8" width="20" height="36" rx="4" fill="none" stroke="currentColor" strokeWidth="3" /><path d="M14 48c6 8 22 10 36 0m0 0l-8-1m8 1l1-8" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <h2>Rotate your device</h2>
            <p>DriveMe is played in landscape. Turn your phone or tablet sideways to continue.</p>
          </div>
        </div>
      )}

      {status === 'menu' && <MainMenu />}

      {status === 'paused' && pauseReason === 'offroad' && (
        <div className="overlay warn">
          <div className="panel">
            <div className="badge warn">Stopped</div>
            <h2>You left the road</h2>
            <p>Stay on the pavement. Resume puts you back in your lane, stopped, facing the way you were going.</p>
            <div className="actions">
              <button className="primary" onClick={resumeGame}>Resume on the road <Key>Enter</Key></button>
              <button className="secondary" onClick={start}>Restart <Key>R</Key></button>
            </div>
          </div>
        </div>
      )}

      {status === 'paused' && pauseReason === 'user' && adjusting && (
        <div className={'adjbar ' + (adjSel === 'center' ? 'low' : 'high')}>
          <span>{adjSel ? 'Arrow keys (or drag on the mirror) move its view. Shift = fine steps.' : 'Pick a mirror, then use the arrow keys or drag on it.'}</span>
          {(['left', 'center', 'right'] as const).map((k) => (
            <button key={k} className={'secondary' + (adjSel === k ? ' sel' : '')} onClick={() => { adjustMirror(k); setAdjSel(k) }}>
              {k === 'left' ? 'Left' : k === 'center' ? 'Rear-view' : 'Right'}
            </button>
          ))}
          <button className="primary" onClick={() => { adjustMirror(null); setAdjSel(null); useGame.setState({ adjusting: false }) }}>Done</button>
        </div>
      )}

      {status === 'paused' && pauseReason === 'user' && viewAdjusting && <ViewAdjust />}

      {status === 'paused' && pauseReason === 'user' && !adjusting && !viewAdjusting && <PausePanel />}

      {status === 'crashed' && (
        <div className="overlay danger">
          <div className="panel">
            <div className="badge">Game over</div>
            <h2>You crashed</h2>
            <p className="reason">{reason}</p>
            <p className="finalpts">Points this drive: <b>{Math.round(finalScore)}</b> <span className="muted">(+{reportPts.gained} for rules followed, −{reportPts.lost} for mistakes)</span></p>
            <div className="report">
              <h3>Mistakes this drive</h3>
              {report.length === 0 ? <p className="muted">None: every rule was followed until the end.</p> : (
                <ul>
                  {report.map((r) => <li key={r.text}><span>{r.text}</span>{r.count > 1 && <b>×{r.count}</b>}</li>)}
                </ul>
              )}
            </div>
            {diag && <RbDiagram diag={diag} />}
            {tips.length > 0 && (
              <ul className="tips">
                {tips.map((t) => <li key={t}>{t}</li>)}
              </ul>
            )}
            <div className="actions">
              <button className="primary" onClick={start}>Try again <Key>Enter</Key></button>
              <button className="secondary" onClick={goMenu}>Change practice</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
