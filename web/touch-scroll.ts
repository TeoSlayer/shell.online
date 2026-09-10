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

/** Converts a two-finger pinch into a viewer-local terminal zoom percentage. */
export class TerminalPinchZoomGesture {
  private touchIDs: [number, number] | undefined;
  private startDistance = 0;
  private startZoom = 100;

  constructor(
    private readonly minimumZoom = 50,
    private readonly maximumZoom = 150,
    private readonly threshold = 3,
  ) {}

  start(touches: readonly TouchSample[], zoomPercent: number): void {
    this.reset();
    if (touches.length !== 2) return;
    const distance = touchDistance(touches[0], touches[1]);
    if (distance <= 0) return;
    this.touchIDs = [touches[0].id, touches[1].id];
    this.startDistance = distance;
    this.startZoom = clamp(zoomPercent, this.minimumZoom, this.maximumZoom);
  }

  move(touches: readonly TouchSample[]): number | null {
    if (!this.touchIDs || touches.length !== 2) return null;
    const first = touches.find((touch) => touch.id === this.touchIDs![0]);
    const second = touches.find((touch) => touch.id === this.touchIDs![1]);
    if (!first || !second) return null;
    const distance = touchDistance(first, second);
    if (Math.abs(distance - this.startDistance) < this.threshold) return null;
    return clamp(
      Math.round(this.startZoom * distance / this.startDistance),
      this.minimumZoom,
      this.maximumZoom,
    );
  }

  end(): void {
    this.reset();
  }

  private reset(): void {
    this.touchIDs = undefined;
    this.startDistance = 0;
  }
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

function touchDistance(first: TouchSample, second: TouchSample): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
