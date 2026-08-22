import { describe, expect, it } from "vitest";
import {
  TerminalLineScroller,
  TerminalTouchScrollBridge,
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
