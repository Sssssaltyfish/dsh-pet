/** 用采样时间验证上推手势的方向、积分和上限。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PhysicsParams } from '../../shared/types.ts';
import { createUpwardFlick, type FlickSample } from './device-shake.ts';

const physics = { throwPower: 1 };
const sample = (at: number, y: number, x = 0, screenAngle = 0): FlickSample => ({ at, x, y, screenAngle });

function push(
  times: number[],
  y: number,
  end: number,
  config: Pick<PhysicsParams, 'throwPower' | 'shakeStrength' | 'shakeThreshold'> = physics,
): number {
  const flick = createUpwardFlick();
  for (const at of times) assert.equal(flick.sample(sample(at, y), config), 0);
  return flick.sample(sample(end, -y), config);
}

test('向上加速段完成后只给一次冲量，同样的积分不依赖采样分段', () => {
  const uniform = push([0, 20, 40, 60, 80], -30, 100);
  const irregular = push([0, 17, 41, 69, 90], -30, 100);
  assert.ok(Math.abs(uniform - 1080) < 1e-9);
  assert.ok(Math.abs(uniform - irregular) < 1e-9);
  assert.ok(push([0, 20, 40], -30, 60) < uniform);
});

test('短噪声、单点尖峰、水平晃动和持续加速都不产生上推冲量', () => {
  assert.equal(push([0, 5, 10], -45, 15), 0);
  assert.equal(push([0], -45, 40), 0);
  assert.equal(push([0, 30, 60], -3, 90), 0);
  assert.equal(push([0, 40, 80, 120, 160, 200, 240, 280], -45, 320), 0);
  const horizontal = createUpwardFlick();
  for (let i = 0; i < 10; i++) {
    assert.equal(horizontal.sample(sample(i * 16, -12, i % 2 ? -40 : 40), physics), 0);
  }
  assert.equal(horizontal.sample(sample(160, 0), physics), 0);
});

test('缺失读数、间隔太长或屏幕换向不会补完旧手势', () => {
  const flick = createUpwardFlick();
  assert.equal(flick.sample(sample(0, -40), physics), 0);
  assert.equal(flick.sample(sample(35, -40), physics), 0);
  assert.equal(flick.sample(null, physics), 0);
  assert.equal(flick.sample(sample(50, 40), physics), 0);
  assert.equal(flick.sample(sample(90, -40), physics), 0);
  assert.equal(flick.sample(sample(120, -40), physics), 0);
  assert.equal(flick.sample(sample(190, 40), physics), 0);
  assert.equal(flick.sample(sample(200, -40), physics), 0);
  assert.equal(flick.sample(sample(220, -40), physics), 0);
  assert.equal(flick.sample(sample(240, 40, 0, 90), physics), 0);
});

test('阈值、力度和零力度开关只控制上推辅助', () => {
  const times = [0, 20, 40, 60, 80];
  assert.equal(push(times, -24, 100, { ...physics, shakeThreshold: 25 }), 0);
  assert.equal(push(times, -24, 100, { ...physics, shakeStrength: 0 }), 0);
  assert.ok(Math.abs(push(times, -24, 100, { ...physics, shakeStrength: 0.5 }) - 360) < 1e-9);
  assert.equal(push(times, -100, 100, { ...physics, shakeStrength: 4 }), 1200);
});
