import { useGame, type Graphics } from './store'

/**
 * What each graphics level does. Mirrors are the biggest cost (each one draws the whole scene again), then the full-screen effects,
 * then the resolution. Roads, signs, signals and traffic are the same at every level: only how they are drawn changes.
 */
export interface Quality {
  /** render resolution: the most device pixels per screen pixel */
  dpr: number
  /** full-screen effects: 'full' (ambient occlusion, grain, vignette, anti-aliasing), 'light' (colour grade and anti-aliasing), 'none' */
  fx: 'full' | 'light' | 'none'
  /** mirror pictures: size relative to the mirror on screen, largest size, and whether the side / rear mirrors refresh every other frame */
  mirrorScale: number
  mirrorMax: number
  sideAlt: boolean
  rearAlt: boolean
  /** the mirrors also show the scenery (trees, houses, buildings), as real mirrors do */
  mirrorScenery: boolean
  /** how far you can see (m), and where the haze starts */
  far: number
  fogNear: number
  /** trees nearer than this are drawn in 3D; further ones as flat pictures */
  treeNear: number
}
export const QUALITY: Record<Graphics, Quality> = {
  // (high renders at the screen's full pixel density, e.g. 2x on a Retina display: anything less is upscaled and looks soft)
  high: { dpr: 2, fx: 'full', mirrorScale: 2, mirrorMax: 3200, sideAlt: false, rearAlt: false, mirrorScenery: true, far: 560, fogNear: 380, treeNear: 120 },
  medium: { dpr: 1.5, fx: 'light', mirrorScale: 1.6, mirrorMax: 2200, sideAlt: false, rearAlt: true, mirrorScenery: false, far: 440, fogNear: 290, treeNear: 85 },
  low: { dpr: 1, fx: 'none', mirrorScale: 1.15, mirrorMax: 1200, sideAlt: true, rearAlt: true, mirrorScenery: false, far: 320, fogNear: 190, treeNear: 55 },
}
/** the current level's settings (read every frame: changing the setting takes effect at once) */
export const quality = () => QUALITY[useGame.getState().graphics]
/** Automatic quality: when the frame rate drops, the resolution and the mirror pictures are scaled down a little (0.6 .. 1), and back up
 *  again when there is room. It works within the chosen graphics level. */
export const autoQ = { scale: 1 }
