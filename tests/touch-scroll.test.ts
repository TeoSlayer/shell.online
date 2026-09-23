import { describe, expect, it } from "vitest";
import {
  TerminalLineScroller,
  TerminalPinchZoomGesture,
  TerminalTouchScrollBridge,
  TouchFling,
  TouchWheelGesture,
  type TouchSample,
  type TouchWheelDelta,
} from "../web/touch-scroll";

const touch = (y: number, x = 100, id = 1): TouchSample => ({ id, x, y });

describe("terminal touch scrolling", () => {
  it("turns a vertical finger gesture into consecutive xterm wheel events", () => {
    const gesture = new TouchWheelGesture();
    gesture.start([touch(400)]);

    expect(gesture.move([touch(397)])).toBeNull();
    expect(gesture.move([touch(380)])).toEqual({ deltaY: 20, x: 100, y: 380 });
    expect(gesture.move([touch(355)])).toEqual({ deltaY: 25, x: 100, y: 355 });
    expect(gesture.move([touch(390)])).toEqual({ deltaY: -35, x: 100, y: 390 });
  });

  it("does not turn a tap or horizontal gesture into terminal scroll", () => {
    const gesture = new TouchWheelGesture();
    gesture.start([touch(400)]);
    expect(gesture.move([touch(397, 102)])).toBeNull();
    expect(gesture.move([touch(398, 120)])).toBeNull();
    expect(gesture.move([touch(360, 122)])).toBeNull();
  });

  it("stops the gesture on touch end or a second finger", () => {
    const gesture = new TouchWheelGesture();
    gesture.start([touch(400)]);
    expect(gesture.move([touch(380)])).not.toBeNull();
    expect(gesture.move([touch(370), touch(390, 120, 2)])).toBeNull();
    expect(gesture.move([touch(350)])).toBeNull();
    gesture.end();
    expect(gesture.move([touch(350)])).toBeNull();
  });

  it("emits deltas through the full gesture bridge", () => {
    const wheels: TouchWheelDelta[] = [];
    const bridge = new TerminalTouchScrollBridge((wheel) => wheels.push(wheel));
    bridge.start([touch(400)]);

    expect(bridge.move([touch(397)])).toBe(false);
    expect(bridge.move([touch(370)])).toBe(true);
    expect(bridge.move([touch(390)])).toBe(true);
    expect(wheels).toEqual([
      { deltaY: 30, x: 100, y: 370 },
      { deltaY: -20, x: 100, y: 390 },
    ]);
  });

  it("moves terminal scrollback through the complete touch path", () => {
    let viewportY = 206;
    const lineScroller = new TerminalLineScroller(
      () => 20,
      (lines) => { viewportY += lines; },
    );
    const bridge = new TerminalTouchScrollBridge((wheel) => {
      lineScroller.scrollPixels(wheel.deltaY);
    });

    bridge.start([touch(240)]);
    expect(bridge.move([touch(380)])).toBe(true);
    bridge.end();
    expect(viewportY).toBe(199);

    lineScroller.reset();
    bridge.start([touch(380)]);
    expect(bridge.move([touch(240)])).toBe(true);
    bridge.end();
    expect(viewportY).toBe(206);
  });
});

describe("terminal pinch zoom", () => {
  it("scales from the zoom active when the second finger lands", () => {
    const gesture = new TerminalPinchZoomGesture();
    gesture.start([touch(100, 100, 1), touch(100, 200, 2)], 80);

    expect(gesture.move([touch(100, 100, 1), touch(100, 202, 2)])).toBeNull();
    expect(gesture.move([touch(100, 100, 1), touch(100, 250, 2)])).toBe(120);
    expect(gesture.move([touch(100, 100, 1), touch(100, 175, 2)])).toBe(60);
  });

  it("clamps zoom and tracks the original two fingers", () => {
    const gesture = new TerminalPinchZoomGesture();
    gesture.start([touch(100, 100, 4), touch(100, 200, 9)], 100);

    expect(gesture.move([touch(100, 100, 4), touch(100, 400, 9)])).toBe(150);
    expect(gesture.move([touch(100, 100, 4), touch(100, 110, 9)])).toBe(50);
    expect(gesture.move([touch(100, 100, 4), touch(100, 200, 7)])).toBeNull();
    gesture.end();
    expect(gesture.move([touch(100, 100, 4), touch(100, 250, 9)])).toBeNull();
  });
});

describe("terminal touch fling", () => {
  it("coasts in the flick's direction and comes to rest", () => {
    const fling = new TouchFling();
    fling.begin(0);
    fling.track(20, 10);
    fling.track(20, 20);
    fling.track(20, 30);
    expect(fling.release(30)).toBe(true);

    let travelled = 0;
    let at = 30;
    for (let frame = 0; frame < 400 && fling.active; frame++) travelled += fling.step((at += 16));
    expect(fling.active).toBe(false);
    // 2px/ms decaying over a 325ms time constant: about 650px, all forwards.
    expect(travelled).toBeGreaterThan(500);
    expect(travelled).toBeLessThan(700);
  });

  it("measures a flick the browser delivered as one coalesced move", () => {
    const fling = new TouchFling();
    fling.begin(0);
    fling.track(-135, 100);
    expect(fling.release(101)).toBe(true);
    expect(fling.step(117)).toBeCloseTo(-1.35 * 16, 5);
  });

  it("does not coast after the finger was held still", () => {
    const fling = new TouchFling();
    fling.begin(0);
    fling.track(30, 10);
    fling.track(30, 20);
    fling.track(0, 170);
    expect(fling.release(175)).toBe(false);
    expect(fling.step(191)).toBe(0);
  });

  it("does not coast from a slow drag, and stops when touched again", () => {
    const slow = new TouchFling();
    slow.begin(0);
    slow.track(-2, 16);
    slow.track(-2, 32);
    slow.track(-2, 48);
    expect(slow.release(48)).toBe(false);

    const fast = new TouchFling();
    fast.begin(0);
    fast.track(-40, 10);
    fast.track(-40, 20);
    expect(fast.release(20)).toBe(true);
    expect(fast.step(36)).toBeLessThan(0);
    fast.begin(40);
    expect(fast.active).toBe(false);
    expect(fast.step(56)).toBe(0);
  });
});
