/** 记录很短一段惯性样本，按动画帧覆盖的时间积分。 */
/** 设备自然方向下的表观加速度，以 g 为单位。 */
export interface SensorForce {
  readonly x: number;
  readonly y: number;
}

/** 标准重力加速度（m/s²）。 */
export const STANDARD_GRAVITY = 9.80665;

/** 单个惯性读数的有效时间（ms）。 */
const INERTIA_MAX_AGE_MS = 80;
const MAX_SAMPLES = 16;

/** 页面共享的短样本历史。多个宠物可读取同一帧，读取不消费样本。 */
export function createInertiaHistory() {
  const samples: Array<{ at: number; force: SensorForce | null }> = [];

  return {
    add(at: number, force: SensorForce | null): void {
      if (samples.length === MAX_SAMPLES) samples.shift();
      samples.push({ at, force });
    },
    clear(): void {
      samples.length = 0;
    },
    read(now: number, from = now): SensorForce | null {
      const latest = samples[samples.length - 1];
      if (!latest) return null;
      if (from >= now) return now - latest.at < INERTIA_MAX_AGE_MS ? latest.force : null;
      let x = 0;
      let y = 0;
      let measured = false;
      let end = now;
      for (let i = samples.length - 1; i >= 0; i--) {
        const sample = samples[i]!;
        const duration = Math.min(end, sample.at + INERTIA_MAX_AGE_MS) - Math.max(from, sample.at);
        if (sample.force && duration > 0) {
          x += sample.force.x * duration;
          y += sample.force.y * duration;
          measured = true;
        }
        end = Math.min(end, sample.at);
        if (end <= from) break;
      }
      return measured ? { x: x / (now - from), y: y / (now - from) } : null;
    },
  };
}
