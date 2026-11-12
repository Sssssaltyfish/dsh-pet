/**
 * 抛掷的逐帧细分积分：一帧拆成若干子步，避免高速时整帧跨过落地与反弹。
 *
 * 不碰 DOM、rAF 与宠物互撞，只把状态往前积一帧；子步数由 {@link throwSubsteps} 决定。
 * @module dsh-pet/src/client/pet/motion/flight-integrate
 */
import {
  throwBounds,
  throwBoundsIn,
  throwStep,
  throwSubsteps,
  type GravityVector,
  type ThrowState,
} from '../../../shared/physics.ts';
import type { PhysicsParams, Rect } from '../../../shared/types.ts';

/** 一帧积分的产出：状态加两个标志。 */
export type FlightStep = ReturnType<typeof throwStep>;

/** 抛掷边界：由视口与宠物尺寸算出。 */
export type FlightBounds = ReturnType<typeof throwBounds>;

/**
 * 一帧的细分积分。
 *
 * 一帧可能跨过上百 px，不拆会跳过落地与反弹帧，漏掉落地挤压与落定判定。
 *
 * @param state - 本帧起点的飞行状态。
 * @param dt - 本帧时长（秒）。
 * @param bounds - 碰撞边界。
 * @param physics - 物理参数。
 * @param gravity - 本帧重力；缺省竖直向下。
 * @returns 本帧终点的状态，附带是否碰边与是否落定。
 */
export function integrateFlight(
  state: ThrowState,
  dt: number,
  bounds: FlightBounds,
  physics: PhysicsParams,
  gravity?: GravityVector,
): FlightStep {
  const substeps = throwSubsteps(state.vx, state.vy, dt);
  let res = throwStep(state, dt / substeps, bounds, physics, gravity);
  /** 子步里只保留最重的一次撞击：一帧震一下就够了。 */
  let hit = res.hit;
  for (let i = 1; i < substeps && !res.atRest; i++) {
    res = throwStep(res, dt / substeps, bounds, physics, gravity);
    if (res.hit !== null && (hit === null || res.hit.speed > hit.speed)) hit = res.hit;
  }
  return { ...res, hit };
}

/** 体感碰撞空间取可见视口；极窄视口把放不下的轴收在中心。 */
export function sensorBounds(area: Rect, size: number, sideAllow: number): FlightBounds {
  const bounds = throwBoundsIn(area, size, sideAllow);
  if (bounds.minX > bounds.maxX) bounds.minX = bounds.maxX = (bounds.minX + bounds.maxX) / 2;
  if (bounds.minY > bounds.maxY) bounds.minY = bounds.maxY = (bounds.minY + bounds.maxY) / 2;
  return bounds;
}

/** DOMRect 的位置可能因浏览器布局精度有少量偏差；允许贴边后稳定停帧。 */
const EDGE_TOLERANCE_PX = 0.05;

function axisCanMove(position: number, min: number, max: number, force: number): boolean {
  if (position < min - EDGE_TOLERANCE_PX || position > max + EDGE_TOLERANCE_PX) return true;
  return force <= -1 ? position > min + EDGE_TOLERANCE_PX : force >= 1 && position < max - EDGE_TOLERANCE_PX;
}

/** 已贴住的轴或几乎为零的力无需唤醒一帧；视口缩小时仍会把越界的宠物夹回。 */
export function sensorCanMove(at: { x: number; y: number }, b: FlightBounds, g: GravityVector): boolean {
  return axisCanMove(at.x, b.minX, b.maxX, g.gx) || axisCanMove(at.y, b.minY, b.maxY, g.gy);
}

/** 体感使用同一套碰撞求解，但四边封闭，任意方向的重力均可阻止停帧。 */
export function integrateSensorFlight(
  state: ThrowState,
  dt: number,
  bounds: FlightBounds,
  physics: PhysicsParams,
  gravity: GravityVector,
  speedLimit: number,
): FlightStep {
  const fixedX = bounds.minX === bounds.maxX;
  const fixedY = bounds.minY === bounds.maxY;
  const { gx, gy } = gravity;
  const g = { gx: fixedX ? 0 : gx, gy: fixedY ? 0 : gy };
  const confined = { ...physics, ceilingBounce: true };
  let current = {
    x: Math.max(bounds.minX, Math.min(bounds.maxX, state.x)),
    y: Math.max(bounds.minY, Math.min(bounds.maxY, state.y)),
    vx: fixedX ? 0 : state.vx,
    vy: fixedY ? 0 : state.vy,
  };
  const count = Math.max(Math.ceil(dt * 120), throwSubsteps(current.vx, current.vy, dt));
  const stepDt = dt / count;
  const damping = Math.exp(-0.35 * stepDt);
  let result: FlightStep = { ...current, bounced: false, atRest: false, hit: null, contacts: [] };
  let hit: FlightStep['hit'] = null;
  for (let i = 0; i < count; i++) {
    result = throwStep({ ...current, vx: current.vx * damping, vy: current.vy * damping }, stepDt, bounds, confined, g);
    const speed = Math.hypot(result.vx, result.vy);
    const scale = speed > speedLimit ? speedLimit / speed : 1;
    current = { x: result.x, y: result.y, vx: result.vx * scale, vy: result.vy * scale };
    if (result.hit !== null && (hit === null || result.hit.speed > hit.speed)) hit = result.hit;
  }
  // 共享的普通抛掷判定只看碰撞速度；贴着墙时另一轴仍可能被体感推动。
  const atRest = Math.hypot(current.vx, current.vy) < 1 && !sensorCanMove(current, bounds, g);
  return { ...result, ...current, bounced: hit !== null, atRest, hit };
}
