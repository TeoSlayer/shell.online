/**
 * A colour per hero, so you can tell whose company is whose.
 *
 * This exists because of a bug report that turned out not to be a bug. Point
 * and click worked perfectly; what did not work was *seeing* that it had, since
 * one figure among several dozen looks much like another and nothing on the map
 * said which one was yours. The controls were fine and the map was unreadable,
 * which from the other side of the screen is the same complaint.
 *
 * So every hero gets a colour, and the ground they command is washed in it. A
 * company becomes an area rather than a crowd, and your own is the one you can
 * find without reading anything.
 *
 * Derived from the account id rather than assigned, for the same reason camps
 * are: the same person is the same colour on every machine, for everybody
 * looking at the same team, with nothing stored anywhere to disagree about.
 */

/**
 * Hues spread around the wheel, avoiding the greens.
 *
 * The map is grass. A company washed in green is a company you cannot see, so
 * the band from about 70 to 160 degrees is left out -- which is why these are
 * listed rather than computed as `hash % 360`.
 */
const HUES = [212, 28, 320, 262, 8, 186, 44, 292, 166, 340, 234, 62];

/** How far a hero's colour reaches. Wide enough to hold their retinue. */
export const BANNER_RADIUS = 9;

function hashUid(uid: string): number {
  let value = 0;
  for (let index = 0; index < uid.length; index += 1) {
    value = (Math.imul(value, 31) + uid.charCodeAt(index)) | 0;
  }
  return Math.abs(value);
}

/** Hue, saturation and lightness to a packed RGB number. */
function fromHsl(hue: number, saturation: number, lightness: number): number {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  const sector = Math.floor(hue / 60) % 6;
  const [red, green, blue] = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ][sector];
  const to = (value: number) => Math.round((value + match) * 255);
  return (to(red) << 16) | (to(green) << 8) | to(blue);
}

/**
 * The colour of one hero's banner.
 *
 * `order` is their place in the roster, and it breaks ties the same way camps
 * do: two people whose ids happen to hash to the same hue would otherwise be
 * the same colour, which is precisely the thing this is for.
 */
export function bannerFor(uid: string, order = 0): number {
  const hue = HUES[(hashUid(uid) + order) % HUES.length];
  return fromHsl(hue, 0.72, 0.58);
}

/** Every hero's colour at once, so no two in a roster come out the same. */
export function assignBanners(uids: string[]): Map<string, number> {
  const taken = new Set<number>();
  const banners = new Map<string, number>();

  for (const uid of [...uids].sort()) {
    const wanted = hashUid(uid) % HUES.length;
    let slot = wanted;
    for (let probe = 0; probe < HUES.length; probe += 1) {
      const at = (wanted + probe) % HUES.length;
      if (taken.has(at)) continue;
      slot = at;
      break;
    }
    /* More heroes than hues: they share, which beats vanishing. */
    taken.add(slot);
    banners.set(uid, fromHsl(HUES[slot], 0.72, 0.58));
  }

  return banners;
}
