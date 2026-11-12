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
import type { FlickSample } from './device-shake.ts';
import { createInertiaHistory, STANDARD_GRAVITY, type SensorForce } from './device-motion.ts';
import { GRAVITY } from '../../shared/physics/constants.ts';

/** 菜单读取的授权与采样状态。 */
export type SensorStatus = 'off' | 'requesting' | 'waiting' | 'active' | 'denied' | 'unavailable' | 'paused';

export type { SensorForce } from './device-motion.ts';

/** 分开的屏幕平面重力与惯性读数，向右和向下为正，单位为 g。 */
export interface SensorReading {
  readonly gravity: SensorForce | null;
  readonly inertia: SensorForce | null;
}

type SensorListener = (motion?: FlickSample | null) => void;

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
  /** 读取当前重力与帧区间内的平均惯性。时间使用 performance.now()（ms）。 */
  read(from?: number, now?: number): SensorReading | null;
}

const MOTION_MAX_AGE_MS = 1000;
const WAIT_MS = 2000;
const FILTER_MS = 45;
const MOTION_NOISE_G = 0.015;
const GRAVITY_FILTER_MS = 220;
const MAX_FORCE = 3;
const RAD = Math.PI / 180;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function screenAngle(env: SensorEnvironment): number {
  const degrees = env.screen?.orientation?.angle ?? env.orientation;
  return finite(degrees) ? degrees : 0;
}

function projectToScreen({ x, y }: SensorForce, degrees: number): SensorForce {
  const angle = degrees * RAD;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: x * c + y * s, y: -x * s + y * c };
}

function apparentForce(x: number, y: number, maxForce: number): SensorForce {
  // 加速度计静置时读到支撑力。惯性与重力取反，同时把设备 Y 轴换成 CSS 向下为正。
  const scale = Math.max(STANDARD_GRAVITY, Math.hypot(x, y) / maxForce);
  return { x: -x / scale, y: y / scale };
}

function limitInertia({ x, y }: SensorForce): SensorForce {
  const magnitude = Math.hypot(x, y);
  if (magnitude < MOTION_NOISE_G) return { x: 0, y: 0 };
  const scale = Math.max(1, magnitude / 6);
  return { x: x / scale, y: y / scale };
}

function filterForce(next: SensorForce, previous: SensorForce | null, dt: number, decayMs = FILTER_MS): SensorForce {
  if (previous === null || dt >= MOTION_MAX_AGE_MS) return next;
  const alpha = -Math.expm1(-Math.max(0, dt) / decayMs);
  return { x: previous.x + (next.x - previous.x) * alpha, y: previous.y + (next.y - previous.y) * alpha };
}

function scaleForce(force: SensorForce, acceleration: number, sensitivity: number): GravityVector {
  const magnitude = Math.hypot(force.x, force.y);
  const gain = Math.min(sensitivity, magnitude > 0 ? MAX_FORCE / magnitude : sensitivity);
  return { gx: force.x * gain * acceleration, gy: force.y * gain * acceleration };
}

/** 把姿态重力与平面惯性相加。关闭倾斜时使用普通向下重力。 */
export function sensorAcceleration(reading: SensorReading, physics: PhysicsParams): GravityVector | null {
  const gravity = physics.tiltGravity !== false ? reading.gravity : null;
  const inertia = physics.shakeThrow !== false ? reading.inertia : null;
  if (!gravity && (!inertia || (inertia.x === 0 && inertia.y === 0))) return null;
  const sensitivity = sensorPhysicsValue(physics, 'sensorSensitivity');
  const weight = gravity ? scaleForce(gravity, physics.gravity, sensitivity) : { gx: 0, gy: physics.gravity };
  const movement = inertia ? scaleForce(inertia, GRAVITY, sensitivity) : { gx: 0, gy: 0 };
  return { gx: weight.gx + movement.gx, gy: weight.gy + movement.gy };
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
  let measuredGravity: SensorForce | null = null;
  let estimatedGravity: SensorForce | null = null;
  const inertia = createInertiaHistory();
  let lastMotion = -Infinity;

  const publish = (motion?: FlickSample | null): void => {
    for (const listener of listeners) listener(motion);
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
    measuredGravity = estimatedGravity = null;
    inertia.clear();
    refresh();
    publish();
  };

  const onMotion = (event: Event): void => {
    if (!listening || env.document.hidden) return;
    const { acceleration: linear, accelerationIncludingGravity: total } = event as DeviceMotionEvent;
    const full = total && finite(total.x) && finite(total.y) ? { x: total.x, y: total.y, z: total.z } : null;
    const pure = linear && finite(linear.x) && finite(linear.y) ? { x: linear.x, y: linear.y } : null;
    const now = env.performance.now();
    if (!full && !pure) {
      if (lastMotion !== -Infinity) {
        inertia.add(now, null);
        publish(null);
      }
      return;
    }
    const dt = now - lastMotion;
    measuredGravity =
      full && pure ? filterForce(apparentForce(full.x - pure.x, full.y - pure.y, 1), measuredGravity, dt) : null;
    if (full && !pure && !orientation) {
      const magnitude = Math.hypot(full.x, full.y, finite(full.z) ? full.z : 0);
      // 初始估算仅用平面分量。后续只用接近 1g 的样本校正，避免把晃动当重力。
      if (!estimatedGravity || Math.abs(magnitude - STANDARD_GRAVITY) <= 2) {
        estimatedGravity = filterForce(apparentForce(full.x, full.y, 1), estimatedGravity, dt, GRAVITY_FILTER_MS);
      }
    }
    const gravity = measuredGravity ?? orientation ?? estimatedGravity;
    if (pure) {
      inertia.add(now, limitInertia(apparentForce(pure.x, pure.y, 6)));
    } else if (full && gravity) {
      const combined = apparentForce(full.x, full.y, 6);
      inertia.add(now, limitInertia({ x: combined.x - gravity.x, y: combined.y - gravity.y }));
    }
    if (status !== 'active') clearTimer();
    lastMotion = now;
    timer ??= env.setTimeout(expireMotion, MOTION_MAX_AGE_MS);
    status = 'active';
    const angle = screenAngle(env);
    // 手势使用手机本身的运动方向。物理惯性使用相反方向。
    publish(pure ? { ...projectToScreen({ x: pure.x, y: -pure.y }, angle), at: now, screenAngle: angle } : null);
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
    measuredGravity = estimatedGravity = orientation = null;
    inertia.clear();
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
    read(from, now = env.performance.now()) {
      if (!listening || env.document.hidden) return null;
      const gravity =
        now - lastMotion < MOTION_MAX_AGE_MS ? (measuredGravity ?? orientation ?? estimatedGravity) : orientation;
      const movement = inertia.read(now, from);
      if (!gravity && !movement) return null;
      const angle = screenAngle(env);
      return {
        gravity: gravity && projectToScreen(gravity, angle),
        inertia: movement && projectToScreen(movement, angle),
      };
    },
  };
}
