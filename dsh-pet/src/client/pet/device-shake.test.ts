/** 验证普通握持、剧烈摇晃、屏幕法线弹跳及冲量配置。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleShake, shakeImpulse, STANDARD_GRAVITY } from './device-shake.ts';

const defaultPhysics = { throwPower: 1 };

test('只提供含重力读数时，转动静置的重力向量不会触发摇晃', () => {
  const spin = { alpha: 700, beta: 400, gamma: null };
  for (const total of [
    { x: 0, y: 0, z: STANDARD_GRAVITY },
    { x: -STANDARD_GRAVITY, y: 0, z: 0 },
    { x: 0, y: STANDARD_GRAVITY, z: 0 },
    { x: STANDARD_GRAVITY / Math.SQRT2, y: 0, z: STANDARD_GRAVITY / Math.SQRT2 },
  ]) {
    const sample = sampleShake(null, total, spin);
    assert.ok(!sample || !shakeImpulse(sample, { ...defaultPhysics, shakeThreshold: 4 }));
  }
  assert.equal(sampleShake(null, { x: null, y: null, z: null }, spin), null);
});

test('线性读数优先。很强的屏幕法线加速度即使缺横纵轴也能向上发射', () => {
  const total = { x: -60, y: 0, z: STANDARD_GRAVITY };
  const stationary = sampleShake({ x: 0, y: 0, z: 0 }, total, null);
  assert.equal(stationary, null);
  for (const z of [-30, 30]) {
    const sample = sampleShake({ x: null, y: null, z }, total, null);
    assert.ok(sample);
    const kick = shakeImpulse(sample, defaultPhysics);
    assert.equal(kick?.vx, 0);
    assert.ok(kick && kick.vy < -1600);
  }
});

test('含重力设备仍能识别剧烈晃动并保留方向', () => {
  const sample = sampleShake(null, { x: -34, y: 12, z: STANDARD_GRAVITY }, null);
  assert.ok(sample);
  const kick = shakeImpulse(sample, defaultPhysics);
  assert.ok(kick && kick.vx > 1500);
});

test('转速只增强已有的平移。阈值、摇晃力度和总力度独立生效', () => {
  const small = { x: 8, y: 0, z: 0, rotation: 0 };
  assert.equal(shakeImpulse(small, defaultPhysics), null);
  assert.ok(shakeImpulse(small, { ...defaultPhysics, shakeThreshold: 6 }));
  assert.ok(shakeImpulse({ ...small, rotation: 300 }, defaultPhysics));
  assert.equal(shakeImpulse({ ...small, x: 0, rotation: 500 }, defaultPhysics), null);
  const sample = { ...small, x: 16, rotation: 0 };
  const kick = shakeImpulse(sample, { throwPower: 1, shakeStrength: 1 });
  const twice = shakeImpulse(sample, { throwPower: 1, shakeStrength: 2 });
  const doubledThrow = shakeImpulse(sample, { throwPower: 2, shakeStrength: 1 });
  assert.ok(kick && twice);
  assert.equal(twice.vx, kick.vx * 2);
  assert.deepEqual(doubledThrow, twice);
  assert.equal(shakeImpulse(sample, { ...defaultPhysics, shakeThreshold: 20 }), null);
  assert.equal(Math.hypot(...Object.values(shakeImpulse({ ...sample, x: 1000 }, defaultPhysics)!)), 3200);
});
