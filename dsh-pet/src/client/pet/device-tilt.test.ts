/** 设置页请求浏览器传感器权限的回归测试。 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { requestMotionPermission } from './device-tilt.ts';

/** 临时装上假的传感器构造器（模拟 iOS 13+ 的 requestPermission）；返回撤销函数。 */
function stubSensorGlobals(stubs: Record<string, unknown>): () => void {
  const previous = new Map<string, unknown>();
  for (const [key, value] of Object.entries(stubs)) {
    previous.set(key, Reflect.get(globalThis, key));
    Reflect.set(globalThis, key, value);
  }
  return () => {
    for (const [key, value] of previous) Reflect.set(globalThis, key, value);
  };
}

/** 造一个会记录被问过哪种、并返回指定结果的假构造器。 */
function fakeCtor(label: string, asked: string[], answer: string): { requestPermission: () => Promise<string> } {
  return {
    requestPermission: async () => {
      asked.push(label);
      return answer;
    },
  };
}

describe('requestMotionPermission —— 只问用得上的种类', () => {
  test('只开倾斜：只申请 deviceorientation', async () => {
    const asked: string[] = [];
    const restore = stubSensorGlobals({
      DeviceOrientationEvent: fakeCtor('tilt', asked, 'granted'),
      DeviceMotionEvent: fakeCtor('shake', asked, 'granted'),
    });
    try {
      assert.equal(await requestMotionPermission({ tilt: true, shake: false }), true);
      assert.deepEqual(asked, ['tilt']);
    } finally {
      restore();
    }
  });

  test('只开摇一摇：只申请 devicemotion', async () => {
    const asked: string[] = [];
    const restore = stubSensorGlobals({
      DeviceOrientationEvent: fakeCtor('tilt', asked, 'granted'),
      DeviceMotionEvent: fakeCtor('shake', asked, 'granted'),
    });
    try {
      assert.equal(await requestMotionPermission({ tilt: false, shake: true }), true);
      assert.deepEqual(asked, ['shake']);
    } finally {
      restore();
    }
  });

  test('两个都关：不申请任何权限，直接成功', async () => {
    const asked: string[] = [];
    const restore = stubSensorGlobals({
      DeviceOrientationEvent: fakeCtor('tilt', asked, 'denied'),
      DeviceMotionEvent: fakeCtor('shake', asked, 'denied'),
    });
    try {
      assert.equal(await requestMotionPermission({ tilt: false, shake: false }), true);
      assert.deepEqual(asked, []);
    } finally {
      restore();
    }
  });

  test('任一种被拒 → false', async () => {
    const asked: string[] = [];
    const restore = stubSensorGlobals({
      DeviceOrientationEvent: fakeCtor('tilt', asked, 'granted'),
      DeviceMotionEvent: fakeCtor('shake', asked, 'denied'),
    });
    try {
      assert.equal(await requestMotionPermission({ tilt: true, shake: true }), false);
      assert.deepEqual(asked, ['tilt', 'shake'], '两种都要问过再下结论');
    } finally {
      restore();
    }
  });

  test('事件类型不存在（HTTP 非安全上下文）→ false', async () => {
    const restore = stubSensorGlobals({ DeviceOrientationEvent: undefined, DeviceMotionEvent: undefined });
    try {
      assert.equal(await requestMotionPermission({ tilt: true, shake: true }), false);
    } finally {
      restore();
    }
  });
});
