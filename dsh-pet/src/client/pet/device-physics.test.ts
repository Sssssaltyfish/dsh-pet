/** 体感输入的授权、换轴与页面生命周期测试。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDevicePhysics, type SensorEnvironment, type SensorForce } from './device-physics.ts';

const G = 9.80665;

class TrackedTarget extends EventTarget {
  private readonly registered = new Map<string, Set<EventListenerOrEventListenerObject>>();

  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null): void {
    if (callback === null) return;
    const set = this.registered.get(type) ?? new Set();
    this.registered.set(type, set);
    set.add(callback);
    super.addEventListener(type, callback);
  }

  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null): void {
    if (callback === null) return;
    this.registered.get(type)?.delete(callback);
    super.removeEventListener(type, callback);
  }

  count(type: string): number {
    return this.registered.get(type)?.size ?? 0;
  }
}

function fixture(overrides: Partial<SensorEnvironment> = {}) {
  const window = new TrackedTarget();
  const document = Object.assign(new TrackedTarget(), { hidden: false });
  const orientation = Object.assign(new TrackedTarget(), { angle: 0 });
  const visualViewport = new TrackedTarget();
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const controller = createDevicePhysics({
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    isSecureContext: true,
    DeviceMotionEvent: {},
    DeviceOrientationEvent: {},
    document,
    performance: { now: () => now },
    screen: { orientation },
    visualViewport,
    setTimeout(callback, delay) {
      const id = ++sequence;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    ...overrides,
  });
  return {
    window,
    document,
    orientation,
    visualViewport,
    controller,
    timers,
    advance(ms: number) {
      const end = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
    motion(total: unknown, acceleration: unknown = null) {
      window.dispatchEvent(
        Object.assign(new Event('devicemotion'), { accelerationIncludingGravity: total, acceleration }),
      );
    },
    tilt(beta: number | null, gamma: number | null) {
      window.dispatchEvent(Object.assign(new Event('deviceorientation'), { beta, gamma }));
    },
    hide(hidden: boolean) {
      document.hidden = hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

function force(actual: SensorForce | null, x: number, y: number): void {
  assert.ok(actual);
  assert.ok(Math.abs(actual.x - x) < 1e-9, `x: ${actual.x} ≠ ${x}`);
  assert.ok(Math.abs(actual.y - y) < 1e-9, `y: ${actual.y} ≠ ${y}`);
}

function pendingPermission() {
  let resolve!: (state: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('正向物理投影：手机竖立和右边放低时，两种传感器给同方向的力；旋转后按屏幕坐标换轴', async () => {
  const f = fixture();
  await f.controller.enable();
  f.tilt(90, 0);
  force(f.controller.read(true), 0, 1);
  f.motion({ x: 0, y: G });
  force(f.controller.read(true), 0, 1);

  f.advance(1000);
  f.tilt(60, 30);
  const down = Math.sqrt(3) / 2;
  force(f.controller.read(true), 0.25, down);
  f.motion({ x: -G * 0.25, y: G * down });
  force(f.controller.read(true), 0.25, down);
  for (const [angle, x, y] of [
    [90, down, -0.25],
    [180, -0.25, -down],
    [270, -down, 0.25],
  ] as const) {
    f.orientation.angle = angle;
    force(f.controller.read(true), x, y);
  }
});

test('无有效读数时保持原物理；运动过期后改用静置姿态', async () => {
  const f = fixture();
  await f.controller.enable();
  f.motion({ x: null, y: 0 });
  f.motion({ x: NaN, y: 1 }, { x: Infinity, y: 0 });
  f.tilt(null, 0);
  assert.equal(f.controller.read(true), null);
  f.advance(2000);
  assert.equal(f.controller.status, 'unavailable');

  f.tilt(30, 0);
  f.motion({ x: -G, y: 0 });
  assert.equal(f.controller.status, 'active');
  force(f.controller.read(true), 1, 0);
  f.advance(1000);
  force(f.controller.read(true), 0, 0.5);
  f.advance(20_000);
  force(f.controller.read(true), 0, 0.5);
  f.tilt(null, 0);
  assert.equal(f.controller.read(true), null);
  assert.equal(f.controller.status, 'unavailable');
});

test('独立配置倾斜与惯性；缺含重力读数时合成姿态和线性惯性', async () => {
  const f = fixture();
  await f.controller.enable();
  f.tilt(30, 0);
  f.motion({ x: -G, y: G / 2 }, { x: -G, y: 0 });
  force(f.controller.read(true), 1, 0.5);
  force(f.controller.read(false), 0, 0.5);

  f.motion(null, { x: G, y: 0 });
  force(f.controller.read(true), -1, 0.5);
  force(f.controller.read(false), 0, 0.5);
});

test('两项权限同步申请；取消和重开复用待完成的授权；允许其中一项也可运行', async () => {
  const motion = pendingPermission();
  const asked: string[] = [];
  const f = fixture({
    DeviceMotionEvent: { requestPermission: () => (asked.push('motion'), motion.promise) },
    DeviceOrientationEvent: { requestPermission: async () => (asked.push('orientation'), 'granted') },
  });
  const first = f.controller.enable();
  assert.deepEqual(asked, ['motion', 'orientation']);
  f.controller.disable();
  const second = f.controller.enable();
  assert.deepEqual(asked, ['motion', 'orientation']);
  motion.resolve('denied');
  await Promise.all([first, second]);
  assert.equal(f.window.count('deviceorientation'), 1);
  assert.equal(f.window.count('devicemotion'), 0);
  f.tilt(-90, 0);
  force(f.controller.read(true), 0, -1);
});

test('拒绝授权可重试；卸载后晚到的授权不能重新挂监听', async () => {
  let retries = 0;
  const answer = pendingPermission();
  const f = fixture({
    DeviceMotionEvent: undefined,
    DeviceOrientationEvent: {
      requestPermission: () => (retries++ === 0 ? Promise.reject(new Error('denied')) : answer.promise),
    },
  });
  await f.controller.enable();
  assert.equal(f.controller.status, 'denied');
  assert.equal(f.controller.enabled, false);

  const retry = f.controller.enable();
  f.controller.dispose();
  answer.resolve('granted');
  await retry;
  assert.equal(f.controller.status, 'off');
  assert.equal(f.document.count('visibilitychange'), 0);
  assert.equal(f.window.count('deviceorientation'), 0);
});

test('宠物共享监听；隐藏、关闭和卸载清理所有数据和监听', async () => {
  const f = fixture();
  let changesA = 0;
  let changesB = 0;
  const off = f.controller.subscribe(() => changesA++);
  f.controller.subscribe(() => changesB++);
  await f.controller.enable();
  await f.controller.enable();
  assert.equal(f.window.count('devicemotion'), 1);
  assert.equal(f.window.count('deviceorientation'), 1);
  f.tilt(30, 0);
  assert.equal(changesA, changesB);
  f.hide(true);
  assert.equal(f.controller.status, 'paused');
  assert.equal(f.controller.read(true), null);
  assert.equal(f.window.count('devicemotion'), 0);
  assert.equal(f.orientation.count('change'), 0);
  assert.equal(f.visualViewport.count('resize'), 0);
  assert.equal(f.timers.size, 0);
  f.tilt(45, 10);

  off();
  f.hide(false);
  assert.equal(f.controller.status, 'waiting');
  assert.equal(f.controller.read(true), null);
  f.tilt(45, 10);
  assert.equal(changesB, changesA + 2);
  f.controller.disable();
  assert.equal(f.document.count('visibilitychange'), 0);
  assert.equal(f.window.count('resize'), 0);
  assert.equal(f.window.count('deviceorientation'), 0);
  assert.equal(f.timers.size, 0);

  await f.controller.enable();
  f.controller.dispose();
  assert.equal(f.document.count('visibilitychange'), 0);
  assert.equal(f.window.count('devicemotion'), 0);
  assert.equal(f.timers.size, 0);
});

test('非安全上下文不会请求传感器权限', async () => {
  const f = fixture({
    isSecureContext: false,
    DeviceMotionEvent: { requestPermission: () => assert.fail('非安全上下文不应申请权限') },
  });
  await f.controller.enable();
  assert.equal(f.controller.status, 'unavailable');
  assert.equal(f.controller.enabled, false);
  assert.equal(f.window.count('devicemotion'), 0);
});
