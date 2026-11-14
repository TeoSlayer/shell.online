import { useId } from "react";
import "./WorkshopCameraControls.css";

export interface WorkshopCameraControlsProps {
  /** Exact camera scale from the renderer; 1 is shown as 1×. */
  zoom: number;
  minZoom: number;
  maxZoom: number;
  /** Ownership/area availability comes from the parent, never from the viewer alone. */
  myAreaState: "available" | "unknown" | "unassigned";
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitTeam: () => void;
  onFocusMyArea: () => void;
  onResetView: () => void;
  /** Describe the pan input actually implemented by the renderer. */
  panHint: string;
  /** Omit when the renderer has no minimap. */
  minimap?: {
    visible: boolean;
    onVisibleChange: (visible: boolean) => void;
  };
}

/** Native controls only. The parent owns camera geometry, input and all state. */
export function WorkshopCameraControls({
  zoom,
  minZoom,
  maxZoom,
  myAreaState,
  onZoomIn,
  onZoomOut,
  onFitTeam,
  onFocusMyArea,
  onResetView,
  panHint,
  minimap,
}: WorkshopCameraControlsProps) {
  const panHintId = useId();
  const areaHintId = useId();
  const hasZoom = Number.isFinite(zoom) && zoom > 0;
  const hasLimits = hasZoom && Number.isFinite(minZoom) && Number.isFinite(maxZoom) &&
    minZoom > 0 && maxZoom >= minZoom;
  const areaHint = myAreaState === "unknown"
    ? "Your area is not known yet."
    : myAreaState === "unassigned" ? "No area is assigned to you." : undefined;

  return (
    <div className="workshop-camera" role="group" aria-label="Map camera controls" aria-describedby={panHintId}>
      <div className="workshop-camera__controls">
        <button type="button" onClick={onFitTeam}>Fit team</button>
        <button
          type="button"
          onClick={onFocusMyArea}
          disabled={myAreaState !== "available"}
          aria-describedby={areaHint ? areaHintId : undefined}
        >
          Focus my area
        </button>
        <div className="workshop-camera__zoom" role="group" aria-label="Map zoom">
          <button type="button" aria-label="Zoom out" onClick={onZoomOut} disabled={!hasLimits || zoom <= minZoom}>
            <span aria-hidden="true">−</span>
          </button>
          <output aria-label={hasZoom ? `Current zoom ${zoom} times` : "Zoom unavailable"} aria-live="off" data-zoom={hasZoom ? zoom : undefined}>
            {hasZoom ? `${zoom}×` : "Unavailable"}
          </output>
          <button type="button" aria-label="Zoom in" onClick={onZoomIn} disabled={!hasLimits || zoom >= maxZoom}>
            <span aria-hidden="true">+</span>
          </button>
        </div>
        <button type="button" onClick={onResetView}>Reset view</button>
        {minimap && (
          <button type="button" aria-pressed={minimap.visible} onClick={() => minimap.onVisibleChange(!minimap.visible)}>
            Minimap
          </button>
        )}
      </div>
      <p className="workshop-camera__hint" id={panHintId}>{panHint}</p>
      {areaHint && <p className="workshop-camera__hint" id={areaHintId}>{areaHint}</p>}
    </div>
  );
}
