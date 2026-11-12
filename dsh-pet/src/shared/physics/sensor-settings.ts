/** 默认值与范围同时供成品配置校验和设置界面使用。 */
import type { PhysicsParams } from '../types.ts';

/** 可配置的浏览器体感参数。 */
export const SENSOR_PHYSICS_SETTINGS = {
  sensorSensitivity: { min: 0.25, max: 4, step: 0.05, defaultValue: 1.6 },
  sensorDamping: { min: 0, max: 8, step: 0.1, defaultValue: 2 },
  shakeThreshold: { min: 4, max: 30, step: 0.5, defaultValue: 10 },
  shakeStrength: { min: 0, max: 4, step: 0.05, defaultValue: 1.2 },
} as const;

/** 体感设置字段名。 */
export type SensorPhysicsKey = keyof typeof SENSOR_PHYSICS_SETTINGS;

/** 缺失的可选字段按默认值使用。 */
export function sensorPhysicsValue(physics: Pick<PhysicsParams, SensorPhysicsKey>, key: SensorPhysicsKey): number {
  return physics[key] ?? SENSOR_PHYSICS_SETTINGS[key].defaultValue;
}

/** 校验可选的体感参数。已有配置可以省略任意一项。 */
export function sensorPhysicsValid(physics: Readonly<Partial<Record<SensorPhysicsKey, unknown>>>): boolean {
  return (Object.keys(SENSOR_PHYSICS_SETTINGS) as SensorPhysicsKey[]).every((key) => {
    const { min, max } = SENSOR_PHYSICS_SETTINGS[key];
    const value = physics[key];
    return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max);
  });
}
