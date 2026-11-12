/**
 * 抛掷飞行（src/client/pet/motion/flight.ts）的契约测试：起飞后逐帧写 DOM 与提交实时位置、
 * 落定才提交收尾位置、停飞取消帧且迟到的帧不写、速度只在飞行中有效。
 * 用假 rAF / performance.now 驱动，位置断言读写入的 style 与提交记录。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PHYSICS } from '../../../shared/physics/constants.ts';
import type { GravityVector, PetCollisionSlot } from '../../../shared/physics.ts';
import type { PhysicsParams } from '../../../shared/types.ts';
import { createFlight, type FlightDeps } from './flight.ts';

const viewport = { width: 1000, height: 500 };
const metrics = { size: 200, halfW: 100, halfH: 56.25, sideAllow: 62.5, bottomPad: 10 };

/** 假根节点：只留被写的四个 style 字段与包围盒。 */
function fakeRoot() {
  return {
    style: { left: '', top: '', right: '', bottom: '' },
    getBoundingClientRect: () => ({ x: 400, y: 100, left: 400, top: 100 }),
  } as unknown as HTMLDivElement;
}

/** 装假时钟与 rAF。 */
function withFakeFrames() {
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  const previousNow = performance.now;
  let now = 0;
  let pending: Array<{ id: number; cb: () => void }> = [];
  let seq = 0;
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (cb: () => void) => {
    const id = ++seq;
    pending.push({ id, cb });
    return id;
  };
  (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = (id: number) => {
    pending = pending.filter((entry) => entry.id !== id);
  };
  performance.now = () => now;
  return {
    tick(ms: number): void {
      now += ms;
      const due = pending;
      pending = [];
      for (const entry of due) entry.cb();
    },
    get queued(): number {
      return pending.length;
    },
    restore(): void {
      (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = previousRaf;
      (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = previousCancel;
      performance.now = previousNow;
    },
  };
}

/** 造一套依赖：记录提交的位置、落地挤压与被写的盒子；可指定 id、共享站场与物理参数。 */
function harness(
  opts: {
    petId?: string;
    arena?: { slots: Record<string, PetCollisionSlot> };
    physics?: PhysicsParams;
    gravity?: FlightDeps['gravity'];
    sensorViewport?: FlightDeps['sensorViewport'];
  } = {},
) {
  const root = fakeRoot();
  const live: Array<{ rx: number; ry: number }> = [];
  const finals: Array<{ rx: number; ry: number }> = [];
  const landings: number[] = [];
  const arena = opts.arena ?? { slots: {} };
  const physics = opts.physics ?? DEFAULT_PHYSICS;
  let box: { x: number; y: number } | null = null;
  const deps: FlightDeps = {
    root: () => root,
    metrics: () => metrics,
    viewport: () => viewport,
    physics: () => physics,
    arena: () => arena,
    petId: opts.petId ?? 'main',
    setBox: (next) => {
      box = next;
    },
    commitLive: (center) => live.push(center),
    commitFinal: (center) => finals.push(center),
    onLanding: (impactVy) => landings.push(impactVy),
    ...(opts.gravity && { gravity: opts.gravity }),
    ...(opts.sensorViewport && { sensorViewport: opts.sensorViewport }),
  };
  return { flight: createFlight(deps), root, live, finals, landings, box: () => box };
}

describe('createFlight —— 飞行与落定', () => {
  test('起飞即排帧，首帧写 DOM 与实时位置', () => {
    const frames = withFakeFrames();
    try {
      const { flight, root, live } = harness();
      flight.start(400, 100, 0, 0);
      assert.equal(flight.isFlying(), true);
      assert.equal(frames.queued, 1);
      frames.tick(16);
      assert.notEqual(root.style.left, '', '飞行中应写 left');
      assert.equal(root.style.right, 'auto');
      assert.equal(live.length, 1);
    } finally {
      frames.restore();
    }
  });

  test('落定只提交一次收尾位置，且停止排帧', () => {
    const frames = withFakeFrames();
    try {
      const { flight, finals } = harness();
      // 从贴地高度静止起飞：第一帧就该判定落地静止。
      flight.start(400, 500 - metrics.halfH * 2, 0, 0);
      for (let i = 0; i < 200 && frames.queued > 0; i++) frames.tick(16);
      assert.equal(finals.length, 1, '收尾位置只提交一次');
      assert.equal(flight.isFlying(), false);
      assert.equal(frames.queued, 0);
    } finally {
      frames.restore();
    }
  });

  test('落定位置在盒子边界内：不会飞出视口底部', () => {
    const frames = withFakeFrames();
    try {
      const { flight, finals } = harness();
      flight.start(400, 100, 900, 900);
      for (let i = 0; i < 800 && frames.queued > 0; i++) frames.tick(16);
      const last = finals[finals.length - 1];
      assert.ok(last !== undefined, '应已落定');
      const boxHeight = (metrics.size * 9) / 16;
      const y = last.ry * viewport.height - metrics.halfH;
      assert.ok(y <= viewport.height - boxHeight + 1e-6, `落定 y 应在边界内：${y}`);
      assert.ok(last.rx >= 0 && last.rx <= 1, `横向比例应归一化：${last.rx}`);
    } finally {
      frames.restore();
    }
  });

  test('每次落地都带正的冲击速度，落定后不再追加', () => {
    const frames = withFakeFrames();
    try {
      const { flight, landings } = harness();
      flight.start(400, 100, 0, 0);
      for (let i = 0; i < 800 && frames.queued > 0; i++) frames.tick(16);
      assert.ok(landings.length >= 1, '至少应压一次首帧');
      for (const impact of landings) assert.ok(impact > 0, `冲击速度应为正：${impact}`);
      const settled = landings.length;
      frames.tick(16);
      assert.equal(landings.length, settled, '落定后不再触发');
    } finally {
      frames.restore();
    }
  });
});

describe('createFlight —— 速度与停飞', () => {
  test('速度只在飞行中有效，飞完归零', () => {
    const frames = withFakeFrames();
    try {
      const { flight } = harness();
      assert.deepEqual(flight.velocity(), { vx: 0, vy: 0 });
      flight.start(400, 100, 300, -200);
      frames.tick(16);
      const vel = flight.velocity();
      assert.ok(vel.vx !== 0 || vel.vy !== 0, '飞行中应能读到速度');
      for (let i = 0; i < 400 && frames.queued > 0; i++) frames.tick(16);
      assert.deepEqual(flight.velocity(), { vx: 0, vy: 0 });
    } finally {
      frames.restore();
    }
  });

  test('停飞取消帧：位置与提交都冻结在停飞那一刻', () => {
    const frames = withFakeFrames();
    try {
      const { flight, root, live } = harness();
      flight.start(400, 100, 300, 0);
      frames.tick(16);
      const leftBeforeStop = root.style.left;
      const liveBeforeStop = live.length;

      flight.stop();
      assert.equal(flight.isFlying(), false);
      assert.equal(frames.queued, 0, '停飞后不应还有排队的帧');
      frames.tick(16);
      assert.equal(root.style.left, leftBeforeStop);
      assert.equal(live.length, liveBeforeStop);
    } finally {
      frames.restore();
    }
  });
});

describe('createFlight —— 外部写入速度', () => {
  test('setVelocity 是改写：给的是绝对速度，不叠加自身速度', () => {
    const frames = withFakeFrames();
    try {
      const { flight } = harness();
      flight.setVelocity(500, 0); // 没在跑：无效果
      assert.deepEqual(flight.velocity(), { vx: 0, vy: 0 });

      flight.start(400, 100, 300, 0);
      frames.tick(16);
      assert.equal(Math.round(flight.velocity().vx), 300);
      flight.setVelocity(500, 0);
      assert.equal(Math.round(flight.velocity().vx), 500, '应改写为 500 而不是 300+500');
    } finally {
      frames.restore();
    }
  });

  test('impulse 是叠加：只对已经在跑的宠物生效', () => {
    const frames = withFakeFrames();
    try {
      const { flight } = harness();
      flight.impulse(400, 0); // 没在跑：忽略，起不起飞由卡片装配决定
      assert.equal(flight.isFlying(), false);
      assert.deepEqual(flight.velocity(), { vx: 0, vy: 0 });

      flight.start(400, 100, 100, 0);
      frames.tick(16);
      flight.impulse(200, 0);
      assert.ok(flight.velocity().vx > 250, `冲量应加进速度：${flight.velocity().vx}`);
    } finally {
      frames.restore();
    }
  });
});

describe('createFlight —— 两只互撞不放大速度', () => {
  test('对撞后双方速率不超过入射速率，连跑多帧也不增长', () => {
    const frames = withFakeFrames();
    try {
      const arena = { slots: {} as Record<string, PetCollisionSlot> };
      // 零重力：只验水平对撞，别把落地竖直速度算进峰值。
      const physics: PhysicsParams = { ...DEFAULT_PHYSICS, gravity: 0, petCollision: true };
      const a = harness({ petId: 'a', arena, physics });
      const b = harness({ petId: 'b', arena, physics });
      const register = (petId: string, target: ReturnType<typeof harness>): void => {
        arena.slots[petId] = {
          size: metrics.size,
          bottomPad: metrics.bottomPad,
          getBox: () => target.box(),
          getVel: () => target.flight.velocity(),
          applyVelocity: (vx, vy) => target.flight.setVelocity(vx, vy),
        };
      };
      register('a', a);
      register('b', b);

      a.flight.start(300, 100, 600, 0);
      b.flight.start(500, 100, -600, 0);
      let peak = 0;
      for (let i = 0; i < 24; i++) {
        frames.tick(16);
        for (const flight of [a.flight, b.flight]) {
          const vel = flight.velocity();
          peak = Math.max(peak, Math.hypot(vel.vx, vel.vy));
        }
      }
      assert.ok(peak <= 601, `碰撞不应放大速度：峰值 ${peak}`);
    } finally {
      frames.restore();
    }
  });
});

describe('createFlight —— 体感飞行', () => {
  test('已有普通抛掷接受体感重力，读数消失后恢复向下重力', () => {
    const frames = withFakeFrames();
    try {
      let gravity: GravityVector | null = { gx: 800, gy: -800 };
      const { flight, box } = harness({ gravity: () => gravity });
      flight.start(400, 100, 0, 0);
      frames.tick(16);
      assert.ok(box()!.x > 400 && box()!.y < 100);
      const vy = flight.velocity().vy;
      gravity = null;
      frames.tick(16);
      assert.ok(flight.velocity().vy > vy);
      assert.equal(flight.isFlying(), true);
    } finally {
      frames.restore();
    }
  });

  test('键盘与视口偏移改变碰撞范围，顶部封闭，贴边时停帧', () => {
    const frames = withFakeFrames();
    try {
      const visible = { x: 20, y: 0, width: 900, height: 400 };
      const { flight, box, finals } = harness({
        physics: { ...DEFAULT_PHYSICS, ceilingBounce: false },
        gravity: () => ({ gx: 0, gy: -1200 }),
        sensorViewport: () => visible,
      });
      assert.equal(
        flight.startHeld(() => {}),
        true,
      );
      frames.tick(16);
      visible.y = 40;
      for (let i = 0; i < 180 && frames.queued > 0; i++) {
        frames.tick(16);
        assert.ok(box()!.y >= 40);
      }
      assert.equal(box()!.y, 40);
      assert.equal(finals.length, 1);
      assert.equal(frames.queued, 0);
    } finally {
      frames.restore();
    }
  });

  test('从新渲染位置起步；视口缩得比宠物还窄时夹到中线', () => {
    const frames = withFakeFrames();
    try {
      const { flight, box, root } = harness({
        gravity: () => ({ gx: 600, gy: 0 }),
        sensorViewport: () => ({ x: 15, y: 0, width: 25, height: 400 }),
      });
      root.getBoundingClientRect = () => ({ x: 66, y: 45, left: 66, top: 45 }) as DOMRect;
      assert.equal(
        flight.startHeld(() => {}),
        true,
      );
      frames.tick(16);
      assert.deepEqual(box(), { x: 15 + (25 - metrics.size) / 2, y: 45 });
      assert.equal(frames.queued, 0);
    } finally {
      frames.restore();
    }
  });

  test('失去读数后不继续施加旧惯性，保留速度并恢复普通重力', () => {
    const frames = withFakeFrames();
    try {
      let gravity: GravityVector | null = { gx: 500, gy: 0 };
      const { flight, root } = harness({ gravity: () => gravity });
      assert.equal(
        flight.startHeld(() => {}),
        true,
      );
      frames.tick(16);
      const vx = flight.velocity().vx;
      const before = Number.parseFloat(root.style.left);
      gravity = null;
      frames.tick(16);
      assert.ok(Number.parseFloat(root.style.left) > before);
      assert.ok(flight.velocity().vx < vx);
      assert.ok(flight.velocity().vy > 0);
    } finally {
      frames.restore();
    }
  });

  test('物理上推手机时宠物贴地，刹停的反向惯性使它自然离地', () => {
    const frames = withFakeFrames();
    try {
      let gravity: GravityVector = { gx: 0, gy: 4900 };
      const { flight, box, root } = harness({ gravity: () => gravity });
      const ground = viewport.height - metrics.halfH * 2;
      root.getBoundingClientRect = () => ({ x: 400, y: ground, left: 400, top: ground }) as DOMRect;
      assert.equal(
        flight.startHeld(() => {}),
        false,
      );
      assert.equal(frames.queued, 0);

      gravity = { gx: 0, gy: -2200 };
      assert.equal(
        flight.startHeld(() => {}),
        true,
      );
      frames.tick(16);
      const natural = flight.velocity().vy;
      assert.ok(natural < 0 && box()!.y < ground);

      assert.equal(
        flight.boostUp(700, () => assert.fail('已有飞行不应重置位置')),
        true,
      );
      assert.equal(flight.velocity().vy, natural - 700);
      assert.equal(flight.velocity().vx, 0);
      frames.tick(16);
      assert.ok(box()!.y < ground - 10);
    } finally {
      frames.restore();
    }
  });

  test('静止时唤醒到首帧之间的短脉冲仍可推动宠物', () => {
    const frames = withFakeFrames();
    try {
      const { flight, box } = harness({
        gravity: (from = 0, now = 0) => (from === 0 && now >= 4 ? { gx: 600, gy: 0 } : null),
      });
      frames.tick(16);
      assert.equal(
        flight.startHeld(() => {}, 0),
        true,
      );
      frames.tick(16);
      assert.ok(box()!.x > 400);
      assert.ok(flight.velocity().vx > 0);
    } finally {
      frames.restore();
    }
  });

  test('水平晃动贴地滑行，无人工法向速度', () => {
    const frames = withFakeFrames();
    try {
      const { flight, root, box } = harness({ gravity: () => ({ gx: 1800, gy: 1400 }) });
      const ground = viewport.height - metrics.halfH * 2;
      root.getBoundingClientRect = () => ({ x: 400, y: ground, left: 400, top: ground }) as DOMRect;
      assert.equal(
        flight.startHeld(() => {}),
        true,
      );
      for (let i = 0; i < 10; i++) frames.tick(16);
      assert.ok(box()!.x > 410);
      assert.equal(box()!.y, ground);
      assert.equal(flight.velocity().vy, 0);
    } finally {
      frames.restore();
    }
  });

  test('提高体感阻尼让同样的速度更快衰减', () => {
    const frames = withFakeFrames();
    try {
      const run = (sensorDamping: number) => {
        const { flight, root } = harness({ physics: { ...DEFAULT_PHYSICS, gravity: 0, sensorDamping } });
        root.getBoundingClientRect = () => ({ x: 400, y: 250, left: 400, top: 250 }) as DOMRect;
        assert.equal(
          flight.boostUp(500, () => {}),
          true,
        );
        for (let i = 0; i < 10; i++) frames.tick(16);
        const speed = -flight.velocity().vy;
        flight.stop();
        return speed;
      };
      assert.equal(run(0), 500);
      assert.ok(run(2) < 375);
      assert.ok(run(8) < 175);
    } finally {
      frames.restore();
    }
  });
});
