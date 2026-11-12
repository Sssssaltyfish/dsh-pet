/** 将运动事件的平移与旋转读数换算为有上限的摇晃冲量。 */
import { sensorPhysicsValue } from '../../shared/physics/sensor-settings.ts';
import type { PhysicsParams } from '../../shared/types.ts';

/** 标准重力加速度（m/s²）。 */
export const STANDARD_GRAVITY = 9.80665;

/** 每只宠物两次摇晃冲量之间的最短间隔（ms）。 */
export const SHAKE_COOLDOWN_MS = 300;

/** 冲量后暂时只采纳重力，避免同一次摇晃又作为连续惯性叠加（ms）。 */
export const SHAKE_INERTIA_PAUSE_MS = 180;

/** 屏幕坐标中的表观加速度（m/s²）及设备转动速率（度/s）。 */
export interface ShakeSample {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotation: number;
}

/** 摇晃冲量（px/s）。 */
export interface ShakeVector {
  readonly vx: number;
  readonly vy: number;
}

type Axis = number | null;
type Acceleration = { readonly x: Axis; readonly y: Axis; readonly z: Axis };
type Rotation = { readonly alpha: Axis; readonly beta: Axis; readonly gamma: Axis };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const finiteOrZero = (value: unknown): number => (finite(value) ? value : 0);

function readAcceleration(raw: Acceleration | null | undefined) {
  if (!raw || ![raw.x, raw.y, raw.z].some(finite)) return null;
  return { x: finiteOrZero(raw.x), y: finiteOrZero(raw.y), z: finiteOrZero(raw.z) };
}

/** 线性加速度优先。含重力读数只用超过 1g 的部分触发摇晃，静态转向不会发射。 */
export function sampleShake(
  linear: Acceleration | null,
  total: Acceleration | null,
  rotation: Rotation | null,
): ShakeSample | null {
  const pure = readAcceleration(linear);
  const combined = pure ?? readAcceleration(total);
  if (!combined) return null;
  const magnitude = Math.hypot(combined.x, combined.y, combined.z);
  if (!Number.isFinite(magnitude) || magnitude === 0) return null;
  const gain = pure ? 1 : Math.max(0, 1 - STANDARD_GRAVITY / magnitude);
  if (gain === 0) return null;
  const spin = Math.hypot(finiteOrZero(rotation?.alpha), finiteOrZero(rotation?.beta), finiteOrZero(rotation?.gamma));
  return { x: -combined.x * gain, y: combined.y * gain, z: combined.z * gain, rotation: spin };
}

type ShakeConfig = Pick<PhysicsParams, 'shakeThreshold' | 'shakeStrength' | 'throwPower'>;

/** 以平面运动为主，沿屏幕法线的摇晃转换为向上弹跳。 */
export function shakeImpulse(sample: ShakeSample, physics: ShakeConfig): ShakeVector | null {
  const magnitude = Math.hypot(sample.x, sample.y, sample.z);
  if (!Number.isFinite(magnitude) || magnitude === 0) return null;
  const threshold = sensorPhysicsValue(physics, 'shakeThreshold');
  // 转动只增强同时测得的平移，避免原地转手机或传感器噪声单独触发。
  const rotationBonus = Math.min(6, Math.max(0, finiteOrZero(sample.rotation) - 80) * 0.025);
  const strength = magnitude + rotationBonus * Math.min(1, magnitude / threshold);
  if (strength < threshold) return null;
  const x = sample.x / magnitude;
  const y = sample.y / magnitude - (Math.abs(sample.z) / magnitude) * 0.75;
  const planar = Math.hypot(x, y);
  const speed = Math.min(
    3200,
    (300 + (strength - threshold) * 65) * sensorPhysicsValue(physics, 'shakeStrength') * physics.throwPower,
  );
  if (planar < 0.05) return { vx: 0, vy: -speed };
  return { vx: x === 0 ? 0 : (x / planar) * speed, vy: (y / planar) * speed };
}
