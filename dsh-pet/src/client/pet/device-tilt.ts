/** 设置页的浏览器传感器授权。 */
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
