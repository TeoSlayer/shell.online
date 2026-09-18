/**
 * A way out of the map that does not need a wheel or two hands.
 *
 * The camera had three ways to move and a phone has one of them: drag works,
 * the wheel does not exist, and pinch is a two-handed gesture on a device most
 * people hold in one -- undiscoverable besides, since nothing on screen said
 * it was there. So the map opened at whatever zoom it opened at and stayed
 * there, which is the complaint this exists to answer.
 *
 * Buttons rather than a slider: a slider is a drag, and a drag on this screen
 * is how you move the camera. Three presses, each one a whole thing that
 * happens.
 */
export interface ZoomControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Pulls all the way back, to the whole country at once. */
  onFit: () => void;
  /** Whether each direction has anywhere left to go. */
  atOut: boolean;
  atIn: boolean;
}

export function ZoomControls({ onZoomIn, onZoomOut, onFit, atOut, atIn }: ZoomControlsProps) {
  return (
    /*
     * A group with a name, so a screen reader announces what these three
     * buttons are for rather than reading out "plus, minus, map".
     */
    <div className="keep-zoom" role="group" aria-label="Zoom the map">
      <button
        type="button"
        className="keep-button keep-zoom-button"
        onClick={onZoomIn}
        disabled={atIn}
        aria-label="Zoom in"
      >
        <span aria-hidden="true">+</span>
      </button>
      <button
        type="button"
        className="keep-button keep-zoom-button"
        onClick={onZoomOut}
        disabled={atOut}
        aria-label="Zoom out"
      >
        {/* A true minus sign; a hyphen at this size reads as a speck. */}
        <span aria-hidden="true">−</span>
      </button>
      <button
        type="button"
        className="keep-button keep-zoom-button"
        onClick={onFit}
        disabled={atOut}
        aria-label="Show the whole country"
      >
        <span aria-hidden="true">⤢</span>
      </button>
    </div>
  );
}
