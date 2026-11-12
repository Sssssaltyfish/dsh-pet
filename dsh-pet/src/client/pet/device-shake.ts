/** 从真实平面加速度识别短促上推手势。惯性本身由飞行循环独立积分。 */
import { sensorPhysicsValue } from '../../shared/physics/sensor-settings.ts';
import type { PhysicsParams } from '../../shared/types.ts';

/** 手机的实际加速度（m/s²），屏幕坐标向右、向下为正。 */
export interface FlickSample {
  readonly x: number;
  readonly y: number;
  readonly at: number;
  readonly screenAngle: number;
}

type FlickConfig = Pick<PhysicsParams, 'shakeThreshold' | 'shakeStrength' | 'throwPower'>;

const MIN_LOBE_MS = 25;
const MAX_LOBE_MS = 220;
const MAX_SAMPLE_GAP_MS = 65;
const MIN_DELTA_SPEED = 0.35;
const MAX_ACCELERATION = 45;
const PIXELS_PER_METRE = 300;
const MAX_BOOST_SPEED = 1200;
const FLICK_COOLDOWN_MS = 280;

/** 手势只在完整的向上加速段结束时返回一次向上的速度增量（px/s）。 */
export function createUpwardFlick() {
  let previous: FlickSample | null = null;
  let startedAt: number | null = null;
  let deltaSpeed = 0;
  let upwardSamples = 0;
  let blocked = false;
  let lastBoost = -Infinity;

  const clearLobe = (): void => {
    startedAt = null;
    deltaSpeed = 0;
    upwardSamples = 0;
    blocked = false;
  };

  return {
    reset(): void {
      previous = null;
      clearLobe();
      lastBoost = -Infinity;
    },
    sample(current: FlickSample | null, physics: FlickConfig): number {
      const strength = sensorPhysicsValue(physics, 'shakeStrength');
      const before = previous;
      previous = current;
      if (!current || strength === 0) {
        clearLobe();
        return 0;
      }
      const gap = before ? current.at - before.at : Infinity;
      const continuous = before && gap > 0 && gap <= MAX_SAMPLE_GAP_MS && current.screenAngle === before.screenAngle;
      if (!continuous) clearLobe();
      const threshold = sensorPhysicsValue(physics, 'shakeThreshold');
      const up = -current.y;
      const upward = up >= threshold && up >= Math.abs(current.x);
      if (startedAt === null) {
        if (upward && !blocked) {
          startedAt = current.at;
          upwardSamples = 1;
        } else if (!upward) blocked = false;
        return 0;
      }
      const elapsed = current.at - startedAt;
      if (!continuous || elapsed > MAX_LOBE_MS) {
        clearLobe();
        blocked = upward;
        return 0;
      }
      // 用上一份样本覆盖它到下一份样本之间的时长。没有下一份读数就不会凭空完成手势。
      deltaSpeed += (Math.min(-before.y, MAX_ACCELERATION) * gap) / 1000;
      if (upward) {
        upwardSamples++;
        return 0;
      }
      const boost =
        upwardSamples >= 2 &&
        elapsed >= MIN_LOBE_MS &&
        deltaSpeed >= MIN_DELTA_SPEED &&
        current.at - lastBoost >= FLICK_COOLDOWN_MS
          ? Math.min(MAX_BOOST_SPEED, deltaSpeed * PIXELS_PER_METRE * strength * physics.throwPower)
          : 0;
      if (boost > 0) lastBoost = current.at;
      clearLobe();
      return boost;
    },
  };
}
