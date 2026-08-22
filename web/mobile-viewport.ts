export interface MobileViewportState {
  width: number;
  height: number;
  keyboardOpen: boolean;
  orientationChanged: boolean;
}

export interface TerminalTypography {
  fontSize: number;
  lineHeight: number;
}

/** Tracks the software keyboard without delaying visual viewport updates. */
export class MobileViewportTracker {
  private width = 0;
  private baselineHeight = 0;
  private keyboardIsOpen = false;

  get keyboardOpen(): boolean {
    return this.keyboardIsOpen;
  }

  reset(): void {
    this.width = 0;
    this.baselineHeight = 0;
    this.keyboardIsOpen = false;
  }

  observe(width: number, height: number): MobileViewportState {
    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));
    const previousWidth = this.width;
    const orientationChanged = previousWidth > 0 && Math.abs(nextWidth - previousWidth)
      > Math.max(80, previousWidth * 0.2);

    if (previousWidth === 0 || this.baselineHeight === 0) {
      this.baselineHeight = nextHeight;
    } else if (orientationChanged) {
      // After a quarter turn, the old width closely approximates the new
      // unobscured height even if the keyboard remains visible.
      this.baselineHeight = Math.max(nextHeight, previousWidth);
    } else if (!this.keyboardIsOpen || nextHeight > this.baselineHeight) {
      this.baselineHeight = Math.max(this.baselineHeight, nextHeight);
    }

    this.width = nextWidth;
    const keyboardThreshold = Math.max(140, this.baselineHeight * 0.2);
    this.keyboardIsOpen = this.baselineHeight - nextHeight > keyboardThreshold;
    if (!this.keyboardIsOpen) {
      this.baselineHeight = Math.max(this.baselineHeight, nextHeight);
    }

    return {
      width: nextWidth,
      height: nextHeight,
      keyboardOpen: this.keyboardIsOpen,
      orientationChanged,
    };
  }
}

/** Uses the limited keyboard viewport for rows and columns instead of chrome. */
export function terminalTypography(
  compact: boolean,
  keyboardOpen: boolean,
  viewportWidth: number,
  viewportHeight: number,
): TerminalTypography {
  if (!compact) return { fontSize: 14, lineHeight: 1.18 };
  if (!keyboardOpen) return { fontSize: 13, lineHeight: 1.18 };
  if (viewportWidth <= 360 || viewportHeight <= 430) {
    return { fontSize: 8, lineHeight: 1.08 };
  }
  return { fontSize: 8.5, lineHeight: 1.1 };
}
