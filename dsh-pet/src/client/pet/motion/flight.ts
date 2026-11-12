/**
 * 抛掷飞行：重力积分、边缘反弹、落地摩擦与宠物互撞，飞行中只改 DOM 位置，落定后才提交归一化中心。
 * 不负责起点与初速（拖拽松手、抛掷指令、被撞起飞各自决定），也不负责落地挤压的动画本身。
 * 依赖注入的取值函数；rAF 句柄与运动状态由本模块持有，跨渲染存活。
 * 不变量：每帧先积分、再结算互撞、最后写 DOM；互撞只写结算后的绝对速度，落定那一帧才调 commitFinal。
 * @module dsh-pet/src/client/pet/motion/flight
 */
import { throwBounds, type GravityVector, type PetCollisionSlot, type ThrowState } from '../../../shared/physics.ts';
import {
  integrateFlight,
  integrateSensorFlight,
  sensorBounds,
  sensorCanMove,
  sensorKickVelocity,
} from './flight-integrate.ts';
import { boxToRatio } from './geometry.ts';
import { createPetCollision, type PetCollisionResolver } from './pet-collision.ts';
import type { BoxPoint, Center, Viewport } from './geometry.ts';
import type { PhysicsParams, Rect } from '../../../shared/types.ts';

/** 飞行需要的当帧几何（px）。 */
export interface FlightMetrics {
  /** 宠物宽度。 */
  size: number;
  /** 盒半宽。 */
  halfW: number;
  /** 盒半高。 */
  halfH: number;
  /** 身体相对视频盒左右各留的透明边。 */
  sideAllow: number;
  /** 舞台脚底垫高：互撞用的身体框按它上移。 */
  bottomPad: number;
}

/** 本帧撞击：撞的是哪条边（或宠物）与撞前速度。 */
export interface FlightImpact {
  /** 撞击对象；`pet` = 撞到另一只宠物。 */
  kind: 'left' | 'right' | 'ceiling' | 'floor' | 'pet';
  /** 撞击前的法向速度绝对值（px/s）。 */
  speed: number;
}

/** 飞行驱动的依赖：全部用取值函数，避免捕获渲染期的快照。 */
export interface FlightDeps {
  /** 宠物根节点；`null` 表示还没挂载。 */
  root(): HTMLDivElement | null;
  /** 当帧几何。 */
  metrics(): FlightMetrics;
  /** 当前视口尺寸。 */
  viewport(): Viewport;
  /** 该宠物的物理参数。 */
  physics(): PhysicsParams;
  /** 宠物间碰撞站场。 */
  arena(): { slots: Record<string, PetCollisionSlot> };
  /** 本宠物 id：碰撞时用来跳过自己。 */
  petId: string;
  /** 写回包围盒位置（每帧调用）。 */
  setBox(box: BoxPoint): void;
  /** 每帧写回归一化中心：刷新或重渲染时按它重排位置，不能用 React 状态（会慢一拍）。 */
  commitLive(center: Center): void;
  /** 落定后提交归一化中心，交给 React 收尾。 */
  commitFinal(center: Center): void;
  /** 落地挤压：入参是本帧落地前的竖直速度（冲击速度）。 */
  onLanding(impactVy: number): void;
  /** 本帧发生撞击（撞边或撞宠）：触觉反馈用；一帧最多回调一次，取本帧最重的那次。 */
  onImpact?(impact: FlightImpact): void;
  /** 体感重力；暂无有效数据或被交互暂停时返回 null。 */
  gravity?(): GravityVector | null;
  /** 可见视口的边界（布局坐标）；体感飞行逐帧读取。 */
  sensorViewport?(): Rect;
}

/** 飞行驱动：一个宠物一个实例。 */
export interface Flight {
  /**
   * 从给定左上角与初速起飞（抛掷模式：重力恒竖直向下，贴地低速即落定）。
   *
   * @param px - 包围盒左边缘（px）。
   * @param py - 包围盒上边缘（px）。
   * @param vx - 水平初速（px/s）。
   * @param vy - 竖直初速（px/s）。
   */
  start(px: number, py: number, vx: number, vy: number): void;
  /** 有体感重力且当前位置能移动时起步，返回是否接管了位置。 */
  startHeld(takeOver: () => void): boolean;
  /** 从当前位置加上摇晃冲量。贴边时向可见区域弹出。 */
  shake(kick: Pick<ThrowState, 'vx' | 'vy'>, takeOver: () => void): boolean;
  /** 结束体感飞行并保留最后一次写入的落点。 */
  settleHeld(): void;
  /**
   * 改写当前速度：碰撞结算给的是绝对速度，不是增量。
   *
   * @param vx - 水平速度（px/s）。
   * @param vy - 竖直速度（px/s）。
   */
  setVelocity(vx: number, vy: number): void;
  /**
   * 叠加一个冲量（摇一摇）；没在跑时忽略——起不起飞、以什么模式起飞由调用方决定。
   *
   * @param dvx - 横向冲量（px/s）。
   * @param dvy - 纵向冲量（px/s）。
   */
  impulse(dvx: number, dvy: number): void;
  /** 停飞：取消在跑的帧并清空运动状态。 */
  stop(): void;
  /** 是否在跑（抛掷与常驻都算）。 */
  isFlying(): boolean;
  /** 最近一帧的速度；没在跑时为 0。 */
  velocity(): { vx: number; vy: number };
}

/** 常驻模式的速度上限（px/s）：传感器重力会持续加速，留一个硬天花板兜底。 */
const MAX_SENSOR_SPEED = 6000;

/**
 * 造飞行驱动。
 *
 * @param deps - 取几何、写位置与落地回调。
 * @returns 可反复调用的驱动。
 */
export function createFlight(deps: FlightDeps): Flight {
  /** 在跑的 rAF；`null` = 没在跑。 */
  let frame: number | null = null;
  /** 世代号：起飞或停飞 +1，迟到的帧据此自弃。 */
  let token = 0;
  /** 最近一帧的状态；`null` = 没在跑。帧间它与帧内的 `current` 是同一个对象，改速度就是改下一刻的输入。 */
  let state: ThrowState | null = null;

  /** 倾斜起步依赖持续读数。摇晃一旦起飞即可用普通重力飞完。 */
  let mode: 'ordinary' | 'tilt' | 'shake' = 'ordinary';

  /** 互撞结算：规则在 pet-collision，这里只把撞击转成触觉回调。 */
  const resolveCollisions: PetCollisionResolver = createPetCollision({
    arena: deps.arena,
    petId: deps.petId,
    onPetImpact: (speed) => deps.onImpact?.({ kind: 'pet', speed }),
  });

  const stop = (): void => {
    token++;
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    state = null;
    mode = 'ordinary';
  };

  const start = (px: number, py: number, vx: number, vy: number): void => {
    mode = 'ordinary';
    run(px, py, vx, vy);
  };

  const currentSensorBounds = (metrics: FlightMetrics) => {
    const viewport = deps.viewport();
    const area = deps.sensorViewport?.() ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
    return sensorBounds(area, metrics.size, metrics.sideAllow);
  };

  const startHeld = (takeOver: () => void): boolean => {
    if (frame !== null) return false;
    const gravity = deps.gravity?.();
    if (!gravity) return false;
    // CSS 角落、Home 和视口变化会重排，历史盒位置未必就是当前渲染位置。
    const rect = deps.root()?.getBoundingClientRect();
    if (!rect || !sensorCanMove(rect, currentSensorBounds(deps.metrics()), gravity)) return false;
    takeOver();
    mode = 'tilt';
    run(rect.left, rect.top, 0, 0);
    return true;
  };

  const shake = (kick: Pick<ThrowState, 'vx' | 'vy'>, takeOver: () => void): boolean => {
    const rect = state ?? deps.root()?.getBoundingClientRect();
    if (!rect) return false;
    const current = state ?? { x: rect.x, y: rect.y, vx: 0, vy: 0 };
    const velocity = sensorKickVelocity(current, currentSensorBounds(deps.metrics()), kick, MAX_SENSOR_SPEED);
    if (velocity.vx === 0 && velocity.vy === 0) return false;
    mode = 'shake';
    if (state) {
      setVelocity(velocity.vx, velocity.vy);
    } else {
      takeOver();
      run(current.x, current.y, velocity.vx, velocity.vy);
    }
    return true;
  };

  const settleHeld = (): void => {
    if (mode === 'ordinary') return;
    if (state !== null) {
      const { halfW, halfH } = deps.metrics();
      deps.commitFinal(boxToRatio(state, deps.viewport(), { w: halfW, h: halfH }));
    }
    stop();
  };

  /**
   * 改写当前速度：碰撞结算给的是绝对速度，不是增量。
   *
   * @param vx - 水平速度（px/s）。
   * @param vy - 竖直速度（px/s）。
   */
  const setVelocity = (vx: number, vy: number): void => {
    if (state === null) return;
    state.vx = vx;
    state.vy = vy;
  };

  /**
   * 叠加一个冲量（摇一摇）：只在已经在跑时有效——没在跑时由调用方按抛掷起飞。
   *
   * @param dvx - 横向冲量（px/s）。
   * @param dvy - 纵向冲量（px/s）。
   */
  const impulse = (dvx: number, dvy: number): void => {
    if (state === null) return;
    state.vx += dvx;
    state.vy += dvy;
  };

  const run = (px: number, py: number, vx: number, vy: number): void => {
    if (frame !== null) cancelAnimationFrame(frame);
    const own = ++token;
    let current: ThrowState = { x: px, y: py, vx, vy };
    state = current;
    let last = performance.now();
    let prevGrounded = false; // 落地挤压只在空中到地面的转换帧触发一次。
    const rootEl = deps.root();

    /** 写回本帧位置：DOM、包围盒与归一化中心（后者供重渲染时按它重排）。 */
    const commitPose = (at: ThrowState, metrics: FlightMetrics, viewport: Viewport): Center => {
      if (rootEl) {
        rootEl.style.left = at.x + 'px';
        rootEl.style.top = at.y + 'px';
        rootEl.style.right = 'auto';
        rootEl.style.bottom = 'auto';
      }
      deps.setBox({ x: at.x, y: at.y });
      const center = boxToRatio(at, viewport, { w: metrics.halfW, h: metrics.halfH });
      deps.commitLive(center);
      return center;
    };

    const step = (): void => {
      if (token !== own) return;
      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      const gravity = deps.gravity?.();
      if (mode === 'tilt' && !gravity) {
        settleHeld();
        return;
      }
      const metrics = deps.metrics();
      const viewport = deps.viewport();
      const physics = deps.physics();
      const sensorFlight = Boolean(gravity) || mode === 'shake';
      const bounds = sensorFlight
        ? currentSensorBounds(metrics)
        : throwBounds({ W: viewport.width, H: viewport.height, size: metrics.size, sideAllow: metrics.sideAllow });
      const fallingVy = current.vy; // 本帧积分前的竖直速度，即落地冲击速度。
      const res = sensorFlight
        ? integrateSensorFlight(
            current,
            dt,
            bounds,
            physics,
            gravity ?? { gx: 0, gy: physics.gravity },
            MAX_SENSOR_SPEED,
          )
        : integrateFlight(current, dt, bounds, physics);
      if (res.hit !== null) deps.onImpact?.({ kind: res.hit.edge, speed: res.hit.speed });
      const integrated: ThrowState = { x: res.x, y: res.y, vx: res.vx, vy: res.vy };
      current = integrated;
      if (physics.petCollision) current = resolveCollisions(current, metrics);
      // 被撞过就不在当帧判落定：积分结果已经代表不了当前位置了。
      const disturbed = current !== integrated;
      if (sensorFlight) {
        const speed = Math.hypot(current.vx, current.vy);
        if (speed > MAX_SENSOR_SPEED) {
          const k = MAX_SENSOR_SPEED / speed;
          current = { ...current, vx: current.vx * k, vy: current.vy * k };
        }
      }
      state = current;
      const center = commitPose(current, metrics, viewport);
      // 落地挤压：只在空中到地面的转换帧触发，力度随冲击速度。
      const grounded = current.y >= bounds.maxY - 1;
      if (res.bounced && grounded && !prevGrounded) deps.onLanding(fallingVy);
      prevGrounded = grounded;
      if (res.atRest && !disturbed) {
        deps.commitFinal(center);
        stop();
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  return {
    impulse,
    isFlying: () => frame !== null,
    setVelocity,
    settleHeld,
    shake,
    start,
    startHeld,
    stop,
    velocity: () => (frame !== null && state !== null ? { vx: state.vx, vy: state.vy } : { vx: 0, vy: 0 }),
  };
}
