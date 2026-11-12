/** 设置页的传感器授权与仅开启摇一摇时的冲量换算。 */
/** 摇一摇触发阈值（m/s²，不含重力）：低于它不算摇。 */
export const SHAKE_THRESHOLD = 18;

/** 摇一摇去重窗口（ms）：一次甩动只给一个冲量。 */
export const SHAKE_COOLDOWN_MS = 300;

/** 摇一摇基准：3600 px/s 起，随加速度线性加码，封顶 4800。 */
const SHAKE_BASE_SPEED = 3600;
const SHAKE_GAIN = 160;
const SHAKE_MAX_BONUS = 4800;

/** 摇一摇冲量（px/s）。 */
export interface ShakeVector {
  readonly vx: number;
  readonly vy: number;
}

/**
 * 摇一摇 → 初速度：方向取甩动方向（屏幕坐标的横向/纵向加速度），力度按基准 × `throwPower`。
 *
 * @param ax - 横向加速度（m/s²）；可能含重力，那正是 {@link SHAKE_THRESHOLD} 的判定口径。
 * @param ay - 纵向加速度（m/s²）。
 * @param az - 垂直加速度（m/s²）：参与阈值判定——只有它能让"纯前后抖"也够得上一次甩动。
 * @param throwPower - 配置里的总力度倍率；`1` 即基准力度。
 * @returns 初速度；加速度不足阈值或横向/纵向都为 0（方向不可用）时返回 `null`。
 */
export function shakeImpulse(ax: number, ay: number, az: number, throwPower: number): ShakeVector | null {
  const mag = Math.hypot(ax, ay, az);
  if (!Number.isFinite(mag) || mag < SHAKE_THRESHOLD) return null;
  const lateral = Math.hypot(ax, ay);
  if (lateral < 1e-6) return null;
  const speed = (SHAKE_BASE_SPEED + Math.min(SHAKE_MAX_BONUS, mag * SHAKE_GAIN)) * Math.max(0, throwPower);
  return { vx: (ax / lateral) * speed, vy: (ay / lateral) * speed };
}

/**
 * 请求一个传感器的浏览器权限；调用时仍须处于用户手势内。
 * 没有 requestPermission 方法的浏览器会在订阅时按页面权限派发事件。
 */
export async function askSensorPermission(ctor: unknown): Promise<boolean> {
  if (ctor == null) return false;
  try {
    const fn = (ctor as { requestPermission?: () => Promise<string> }).requestPermission;
    return typeof fn !== 'function' || (await fn.call(ctor)) === 'granted';
  } catch {
    return false;
  }
}

/** 本次要申请授权的传感器种类：只问真正要用的那一个事件。 */
export interface MotionSensorKinds {
  /** 倾斜（deviceorientation）。 */
  readonly tilt: boolean;
  /** 摇一摇（devicemotion）。 */
  readonly shake: boolean;
}

/**
 * 请求传感器权限（iOS 13+ 必需，且必须在用户手势里调用）；只申请本次要用的种类。
 *
 * @param kinds - 需要授权的种类；两个都关时什么都不问，直接 resolve `true`。
 * @returns 全部申请成功（或环境本来就不需要授权）时为 `true`；任一种被拒、或该事件类型在此上下文里不存在
 *  （非安全上下文，HTTP 下两个全局类型都没有）时为 `false`。
 */
export async function requestMotionPermission(kinds: MotionSensorKinds): Promise<boolean> {
  const granted = await Promise.all([
    !kinds.tilt || askSensorPermission(globalThis.DeviceOrientationEvent),
    !kinds.shake || askSensorPermission(globalThis.DeviceMotionEvent),
  ]);
  return granted.every(Boolean);
}
