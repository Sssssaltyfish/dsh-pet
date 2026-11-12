/**
 * 浏览器体感输入：全页共用一个授权与监听周期，向宠物分发屏幕平面内的读数。
 * 开关只作用于本页；可见时接收读数，隐藏、关闭或卸载时释放监听并清空缓存。
 * 运动读数有时效，姿态读数可以在设备保持同一倾角时继续使用。
 * @module dsh-pet/src/client/pet/device-physics
 */
import { sensorPhysicsValue } from '../../shared/physics/sensor-settings.ts';
import type { GravityVector } from '../../shared/physics.ts';
import type { PhysicsParams } from '../../shared/types.ts';
import { askSensorPermission } from './device-tilt.ts';
import { sampleShake, STANDARD_GRAVITY, type ShakeSample } from './device-shake.ts';

/** 菜单读取的授权与采样状态。 */
export type SensorStatus = 'off' | 'requesting' | 'waiting' | 'active' | 'denied' | 'unavailable' | 'paused';

/** 屏幕平面内的力，以标准重力为单位，向右和向下为正。 */
export interface SensorForce {
  readonly x: number;
  readonly y: number;
}

type SensorListener = (shake?: ShakeSample | null) => void;

/** 传感器和视口使用的浏览器接口；测试注入自己的事件目标与时钟。 */
export interface SensorEnvironment extends Pick<EventTarget, 'addEventListener' | 'removeEventListener'> {
  readonly isSecureContext: boolean;
  readonly DeviceMotionEvent?: unknown;
  readonly DeviceOrientationEvent?: unknown;
  readonly document: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
  readonly performance: Pick<Performance, 'now'>;
  readonly screen?: {
    orientation?: Pick<ScreenOrientation, 'angle' | 'addEventListener' | 'removeEventListener'>;
  };
  readonly orientation?: number;
  readonly visualViewport?: Pick<VisualViewport, 'addEventListener' | 'removeEventListener'> | null;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
}

/** 页面体感开关、只读采样接口及订阅。 */
export interface DevicePhysics {
  readonly status: SensorStatus;
  readonly enabled: boolean;
  enable(): Promise<void>;
  disable(): void;
  dispose(): void;
  subscribe(listener: SensorListener): () => void;
  /** 返回最新的有效力。惯性必须已启用，且采样时刻不早于 motionSince（单调时钟，ms）。 */
  read(includeInertia: boolean, motionSince?: number): SensorForce | null;
}

const MOTION_MAX_AGE_MS = 1000;
const WAIT_MS = 2000;
const FILTER_MS = 45;
const GRAVITY_FILTER_MS = 220;
const MAX_FORCE = 3;
const RAD = Math.PI / 180;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function projectToScreen({ x, y }: SensorForce, env: SensorEnvironment): SensorForce {
  const degrees = env.screen?.orientation?.angle ?? env.orientation;
  const angle = (finite(degrees) ? degrees : 0) * RAD;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: x * c + y * s, y: -x * s + y * c };
}

function apparentForce(x: number, y: number, maxForce = MAX_FORCE): SensorForce {
  // 加速度计静置时读到向上的支撑力，惯性与重力均取反；CSS 的 Y 轴也取反。
  const scale = Math.max(STANDARD_GRAVITY, Math.hypot(x, y) / maxForce);
  return { x: -x / scale, y: y / scale };
}

function filterForce(next: SensorForce, previous: SensorForce | null, dt: number, decayMs = FILTER_MS): SensorForce {
  if (previous === null || dt >= MOTION_MAX_AGE_MS) return next;
  const alpha = -Math.expm1(-Math.max(0, dt) / decayMs);
  return { x: previous.x + (next.x - previous.x) * alpha, y: previous.y + (next.y - previous.y) * alpha };
}

/** 用体感灵敏度把读数映射为加速度，将有效力限制在三个重力单位内。 */
export function scaleSensorGravity(
  force: SensorForce,
  physics: Pick<PhysicsParams, 'gravity' | 'sensorSensitivity'>,
): GravityVector {
  const magnitude = Math.hypot(force.x, force.y);
  const sensitivity = sensorPhysicsValue(physics, 'sensorSensitivity');
  const gain = Math.min(sensitivity, magnitude > 0 ? MAX_FORCE / magnitude : sensitivity);
  return { gx: force.x * gain * physics.gravity, gy: force.y * gain * physics.gravity };
}

/** 创建一个可由菜单点击开启的页面体感控制器。 */
export function createDevicePhysics(env: SensorEnvironment = window): DevicePhysics {
  const listeners = new Set<SensorListener>();
  let status: SensorStatus = 'off';
  let enabled = false;
  let disposed = false;
  let generation = 0;
  let allowed: readonly [motion: boolean, orientation: boolean] | null = null;
  let asking: Promise<readonly [boolean, boolean]> | null = null;
  let pending: Promise<void> | null = null;
  let listening = false;
  let timer: number | undefined;
  let orientation: SensorForce | null = null;
  let motion: SensorForce | null = null;
  let gravity: SensorForce | null = null;
  let inertia: SensorForce | null = null;
  let lastMotion = -Infinity;

  const publish = (shake?: ShakeSample | null): void => {
    for (const listener of listeners) listener(shake);
  };
  const onViewport = (): void => publish();
  const clearTimer = (): void => {
    if (timer !== undefined) env.clearTimeout(timer);
    timer = undefined;
  };
  const refresh = (): void => {
    status = orientation || env.performance.now() - lastMotion < MOTION_MAX_AGE_MS ? 'active' : 'unavailable';
  };
  const expireMotion = (): void => {
    const remaining = MOTION_MAX_AGE_MS - (env.performance.now() - lastMotion);
    if (remaining > 0) {
      timer = env.setTimeout(expireMotion, remaining);
      return;
    }
    timer = undefined;
    motion = gravity = inertia = null;
    refresh();
    publish();
  };

  const onMotion = (event: Event): void => {
    if (!listening || env.document.hidden) return;
    const { acceleration: linear, accelerationIncludingGravity: total, rotationRate } = event as DeviceMotionEvent;
    const full = total && finite(total.x) && finite(total.y) ? { x: total.x, y: total.y, z: total.z } : null;
    const pure = linear && finite(linear.x) && finite(linear.y) ? { x: linear.x, y: linear.y } : null;
    const shake = sampleShake(linear, total, rotationRate);
    if (!full && !pure && !shake) return;
    const now = env.performance.now();
    const dt = now - lastMotion;
    motion = full ? filterForce(apparentForce(full.x, full.y), motion, dt) : null;
    inertia = !full && pure ? filterForce(apparentForce(pure.x, pure.y), inertia, dt) : null;
    if (full && pure) {
      gravity = filterForce(apparentForce(full.x - pure.x, full.y - pure.y, 1), gravity, dt);
    } else if (orientation || !full) {
      gravity = null;
    } else if (Math.hypot(full.x, full.y, full.z ?? 0) <= STANDARD_GRAVITY + 4) {
      // 只有含重力读数时，慢速跟踪重力。剧烈晃动的读数不参与这份估算。
      gravity = filterForce(apparentForce(full.x, full.y, 1), gravity, dt, GRAVITY_FILTER_MS);
    }
    if (status !== 'active') clearTimer();
    lastMotion = now;
    timer ??= env.setTimeout(expireMotion, MOTION_MAX_AGE_MS);
    status = 'active';
    publish(shake ? { ...shake, ...projectToScreen(shake, env) } : null);
  };

  const onOrientation = (event: Event): void => {
    if (!listening || env.document.hidden) return;
    const { beta, gamma } = event as DeviceOrientationEvent;
    if (!finite(beta) || !finite(gamma)) {
      if (orientation !== null) {
        orientation = null;
        refresh();
        publish();
      }
      return;
    }
    // Device Orientation 的 Z-X'-Y'' 顺序使横向重力同时受 beta 与 gamma 影响。
    orientation = { x: Math.cos(beta * RAD) * Math.sin(gamma * RAD), y: Math.sin(beta * RAD) };
    status = 'active';
    if (env.performance.now() - lastMotion >= MOTION_MAX_AGE_MS) clearTimer();
    publish();
  };

  const detach = (): void => {
    if (listening) {
      env.removeEventListener('devicemotion', onMotion);
      env.removeEventListener('deviceorientation', onOrientation);
      env.removeEventListener('resize', onViewport);
      env.removeEventListener('orientationchange', onViewport);
      env.screen?.orientation?.removeEventListener('change', onViewport);
      env.visualViewport?.removeEventListener('resize', onViewport);
      env.visualViewport?.removeEventListener('scroll', onViewport);
    }
    listening = false;
    clearTimer();
    motion = gravity = inertia = orientation = null;
    lastMotion = -Infinity;
  };

  const updateVisibility = (): void => {
    if (!enabled || allowed === null) return;
    if (env.document.hidden) {
      detach();
      status = 'paused';
      publish();
      return;
    }
    if (listening) return;
    listening = true;
    if (allowed[0]) env.addEventListener('devicemotion', onMotion);
    if (allowed[1]) env.addEventListener('deviceorientation', onOrientation);
    env.addEventListener('resize', onViewport);
    env.addEventListener('orientationchange', onViewport);
    env.screen?.orientation?.addEventListener('change', onViewport);
    env.visualViewport?.addEventListener('resize', onViewport);
    env.visualViewport?.addEventListener('scroll', onViewport);
    status = 'waiting';
    timer = env.setTimeout(expireMotion, WAIT_MS);
    publish();
  };

  const disable = (): void => {
    generation++;
    enabled = false;
    allowed = pending = null;
    detach();
    env.document.removeEventListener('visibilitychange', updateVisibility);
    status = 'off';
    publish();
  };

  return {
    get status() {
      return status;
    },
    get enabled() {
      return enabled;
    },
    enable() {
      if (disposed || enabled) return pending ?? Promise.resolve();
      if (!env.isSecureContext || (!env.DeviceMotionEvent && !env.DeviceOrientationEvent)) {
        status = 'unavailable';
        publish();
        return Promise.resolve();
      }
      enabled = true;
      status = 'requesting';
      const own = ++generation;
      // 同一点击中发起两次申请；重新开启时复用浏览器尚未完成的申请。
      asking ??= Promise.all([
        askSensorPermission(env.DeviceMotionEvent),
        askSensorPermission(env.DeviceOrientationEvent),
      ]).finally(() => {
        asking = null;
      });
      pending = asking.then((answer) => {
        if (own !== generation) return;
        pending = null;
        if (!answer[0] && !answer[1]) {
          enabled = false;
          status = 'denied';
          publish();
          return;
        }
        allowed = answer;
        env.document.addEventListener('visibilitychange', updateVisibility);
        updateVisibility();
      });
      publish();
      return pending;
    },
    disable,
    dispose() {
      disposed = true;
      disable();
      listeners.clear();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read(includeInertia, motionSince = -Infinity) {
      if (!listening || env.document.hidden) return null;
      const fresh = env.performance.now() - lastMotion < MOTION_MAX_AGE_MS;
      if (!fresh) return orientation && projectToScreen(orientation, env);
      const useInertia = includeInertia && lastMotion >= motionSince;
      if (useInertia && inertia) {
        const x = (orientation?.x ?? 0) + inertia.x;
        const y = (orientation?.y ?? 0) + inertia.y;
        const scale = Math.max(1, Math.hypot(x, y) / MAX_FORCE);
        return projectToScreen({ x: x / scale, y: y / scale }, env);
      }
      const force = useInertia ? (motion ?? orientation) : (gravity ?? orientation);
      return force && projectToScreen(force, env);
    },
  };
}
