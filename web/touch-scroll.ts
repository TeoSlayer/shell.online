export interface TouchSample {
  id: number;
  x: number;
  y: number;
}

export interface TouchWheelDelta {
  deltaY: number;
  x: number;
  y: number;
}

/** Accumulates pixel movement into whole terminal rows without losing small pans. */
export class TerminalLineScroller {
  private lineRemainder = 0;

  constructor(
    private readonly readCellHeight: () => number,
    private readonly scrollLines: (lines: number) => void,
  ) {}

  scrollPixels(deltaY: number): void {
    this.lineRemainder += deltaY / Math.max(this.readCellHeight(), 1);
    const lines = Math.trunc(this.lineRemainder);
    if (lines === 0) return;
    this.scrollLines(lines);
    this.lineRemainder -= lines;
  }

  reset(): void {
    this.lineRemainder = 0;
  }
}

/** Converts a one-finger pan into wheel deltas for xterm's custom viewport. */
export class TouchWheelGesture {
  private touchID: number | undefined;
  private startX = 0;
  private startY = 0;
  private lastY = 0;
  private axis: "vertical" | "horizontal" | undefined;

  constructor(private readonly threshold = 6) {}

  start(touches: readonly TouchSample[]): void {
    this.reset();
    if (touches.length !== 1) return;
    const touch = touches[0];
    this.touchID = touch.id;
    this.startX = touch.x;
    this.startY = touch.y;
    this.lastY = touch.y;
  }

  move(touches: readonly TouchSample[]): TouchWheelDelta | null {
    if (this.touchID === undefined) return null;
    if (touches.length !== 1) {
      this.reset();
      return null;
    }
    const touch = touches.find((candidate) => candidate.id === this.touchID);
    if (!touch) {
      this.reset();
      return null;
    }

    if (!this.axis) {
      const totalX = touch.x - this.startX;
      const totalY = touch.y - this.startY;
      if (Math.hypot(totalX, totalY) < this.threshold) return null;
      this.axis = Math.abs(totalY) >= Math.abs(totalX) ? "vertical" : "horizontal";
    }
    if (this.axis !== "vertical") return null;

    const fingerDeltaY = touch.y - this.lastY;
    this.lastY = touch.y;
    return {
      // Native wheel direction is opposite the finger's movement.
      deltaY: -fingerDeltaY,
      x: touch.x,
      y: touch.y,
    };
  }

  end(): void {
    this.reset();
  }

  private reset(): void {
    this.touchID = undefined;
    this.axis = undefined;
  }
}

/** Owns the full touch-to-wheel path used by the terminal event listeners. */
export class TerminalTouchScrollBridge {
  private readonly gesture = new TouchWheelGesture();

  constructor(private readonly emitWheel: (wheel: TouchWheelDelta) => void) {}

  start(touches: readonly TouchSample[]): void {
    this.gesture.start(touches);
  }

  move(touches: readonly TouchSample[]): boolean {
    const wheel = this.gesture.move(touches);
    if (!wheel) return false;
    this.emitWheel(wheel);
    return true;
  }

  end(): void {
    this.gesture.end();
  }
}
