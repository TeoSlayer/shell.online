import { useEffect, useRef } from "react";

/**
 * The figure a skin actually dresses, drawn at the size you would see it.
 *
 * The shop used to show a colour swatch, which is honest -- a skin *is* one
 * number multiplied over a sprite -- but it is not what anybody is buying. A
 * square of #c96a92 tells you nothing about what your own wright looks like
 * wearing it, and the whole product here is how the figure reads on the map.
 *
 * So this draws the same sprite the renderer draws, from the same atlas, tinted
 * the same way. Multiply, then the sprite again as a mask to put the
 * transparency back, which is what Pixi's `tint` does and the reason the two
 * agree. If they were computed differently the shop would be lying about the
 * goods.
 *
 * Nearest-neighbour on the way up. Kenney's units are 33 pixels tall and this
 * shows them at four times that; smoothed, they come out as a blur of a
 * soldier rather than a soldier.
 */

interface Frame {
  frame: { x: number; y: number; w: number; h: number };
}

/**
 * The atlas, fetched once for the whole shop rather than once per item.
 *
 * A module-level promise rather than state: there are a dozen portraits on
 * screen and they all want the same two files, and twelve components each
 * starting their own fetch is twelve requests for one picture.
 */
let atlas: Promise<{ frames: Record<string, Frame>; image: HTMLImageElement }> | undefined;

function load() {
  atlas ??= (async () => {
    const [sheet, image] = await Promise.all([
      fetch("/game/medieval-rts.json").then((response) => response.json()),
      new Promise<HTMLImageElement>((resolve, reject) => {
        const picture = new Image();
        picture.onload = () => resolve(picture);
        picture.onerror = reject;
        picture.src = "/game/medieval-rts.png";
      }),
    ]);
    return { frames: (sheet.frames ?? sheet) as Record<string, Frame>, image };
  })();
  return atlas;
}

export function SkinPortrait({
  unit,
  tint,
  label,
  scale = 4,
}: {
  /** The atlas frame to draw, e.g. `Unit_05`. */
  unit: string;
  /** The skin's colour, as the renderer would multiply it. */
  tint: number;
  /** What a reader who cannot see the picture is told instead. */
  label: string;
  scale?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let live = true;
    load()
      .then(({ frames, image }) => {
        const node = canvas.current;
        const cut = frames[unit];
        if (!live || !node || !cut) return;

        const { x, y, w, h } = cut.frame;
        node.width = w * scale;
        node.height = h * scale;

        const ctx = node.getContext("2d");
        if (!ctx) return;
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, node.width, node.height);
        ctx.drawImage(image, x, y, w, h, 0, 0, node.width, node.height);

        /* The tint, exactly as the renderer applies it. */
        ctx.globalCompositeOperation = "multiply";
        ctx.fillStyle = `#${tint.toString(16).padStart(6, "0")}`;
        ctx.fillRect(0, 0, node.width, node.height);

        /* And the sprite again, to give the transparency back. */
        ctx.globalCompositeOperation = "destination-in";
        ctx.drawImage(image, x, y, w, h, 0, 0, node.width, node.height);
        ctx.globalCompositeOperation = "source-over";
      })
      .catch(() => {
        /*
         * A shop with no pictures in it is still a shop. The name, the line of
         * lore and the price are all beside it, so a failed sprite sheet costs
         * the picture and not the ability to spend.
         */
      });
    return () => {
      live = false;
    };
  }, [unit, tint, scale]);

  return <canvas ref={canvas} className="keep-shop-portrait" role="img" aria-label={label} />;
}
