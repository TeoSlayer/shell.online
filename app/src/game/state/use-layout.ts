import { useEffect, useState } from "react";
import { layoutFor, type Layout } from "./layout";

/**
 * Which shape of screen this is, kept up to date.
 *
 * Watched rather than read once, because the answer changes: a phone is turned
 * over, a window is dragged narrow, a tablet is docked to half the screen. The
 * interface that arrived at the old answer and never revisited it is the one
 * that was full size on a handset held sideways.
 *
 * Read here and given to the components as a prop, rather than each of them
 * asking. One listener, one answer, no chance of two parts of the HUD
 * disagreeing about what they are being drawn on.
 */
function read(): Layout {
  if (typeof window === "undefined") return "room";
  return layoutFor({
    width: window.innerWidth,
    height: window.innerHeight,
    coarse: window.matchMedia?.("(pointer: coarse)").matches ?? false,
  });
}

export function useLayout(): Layout {
  const [layout, setLayout] = useState<Layout>(read);

  useEffect(() => {
    const onChange = () => setLayout(read());
    window.addEventListener("resize", onChange);
    /*
     * A rotation on iOS resizes the window a beat *after* it fires
     * `orientationchange`, and some browsers fire only one of the two. Both
     * are listened for and the answer is recomputed rather than toggled, so
     * hearing about the same rotation twice costs nothing.
     */
    window.addEventListener("orientationchange", onChange);
    const coarse = window.matchMedia?.("(pointer: coarse)");
    coarse?.addEventListener("change", onChange);
    return () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("orientationchange", onChange);
      coarse?.removeEventListener("change", onChange);
    };
  }, []);

  return layout;
}
