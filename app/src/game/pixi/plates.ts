import { Container, Graphics, Text } from "pixi.js";
import type { Actor } from "../world/sim";
import { sigilFor, type Sigils } from "./sigils";

/**
 * What stands above somebody's head.
 *
 * A hero carries a shield with their initials on it, their name, a health bar
 * and a mana bar. A soldier carries its class and the name of the session it
 * is. Both are built once and then only have their numbers moved, because a
 * Text object rebuilt on a tick uploads a new texture and that is the fastest
 * way to make a Pixi scene stutter.
 *
 * All of it scales *against* the zoom rather than with it. A plate that scales
 * with the map is illegible zoomed out, which is exactly when you most need to
 * know which of these distant figures is you; scaling the other way keeps it
 * roughly a constant size on screen, and a little larger than that at the far
 * end so it stays readable when the figure under it is six pixels tall.
 */

/** Two initials from a name: "Ada Lovelace" is AL, "ada" is AD. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * How much of a hero's company is at work.
 *
 * This is what the blue bar shows, and it is a read-out like everything else:
 * the share of that person's sessions doing something rather than sitting at a
 * prompt. It is not a resource, it cannot be spent, and nothing in the game
 * consumes it -- calling it mana is the skin's word for "how much is in
 * flight", and the panel behind it says so in plain terms.
 */
export function atWork(actor: Actor, all: Actor[]): number {
  if (actor.role !== "hero") return 0;
  const theirs = all.filter(
    (other) => other.role === "soldier" && other.heroUid === actor.heroUid,
  );
  if (theirs.length === 0) return 0;
  const busy = theirs.filter((other) => other.work !== "idle").length;
  return busy / theirs.length;
}

const FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";

export interface Plate {
  root: Container;
  /**
   * How tall the board is.
   *
   * Handed back so the caller can hang it by its bottom edge. Plates sit above
   * the head, and a container positioned by its top would push the board
   * further down the taller it got -- so a hero, whose board is the tallest,
   * would be the one whose name covered them.
   */
  height: number;
  /** Redrawn only when a number actually changes. See `Bars.set`. */
  bars?: Bars;
}

/**
 * The two bars under a hero's name.
 *
 * Held as their own object with a memory of what they were last drawn at, so
 * that the common case -- nothing changed this frame -- costs a comparison
 * rather than a re-tessellation.
 */
export class Bars {
  private readonly shape = new Graphics();
  private lastHealth = -1;
  private lastWork = -1;

  constructor(
    parent: Container,
    private readonly width: number,
    private readonly y: number,
  ) {
    parent.addChild(this.shape);
  }

  set(health: number, work: number): void {
    if (Math.abs(health - this.lastHealth) < 0.01 && Math.abs(work - this.lastWork) < 0.01) return;
    this.lastHealth = health;
    this.lastWork = work;

    const { width, y } = this;
    this.shape.clear();
    /* Both bars get a full-width trough, so an empty one is still legible. */
    this.shape.rect(-width / 2, y, width, 7).fill({ color: 0x1a1008, alpha: 0.9 });
    this.shape.rect(-width / 2, y + 9, width, 7).fill({ color: 0x1a1008, alpha: 0.9 });
    if (health > 0) {
      this.shape
        .rect(-width / 2 + 1.5, y + 1.5, (width - 3) * health, 4)
        .fill({ color: health > 0.35 ? 0x8fd05a : 0xd4553f });
    }
    if (work > 0) {
      this.shape
        .rect(-width / 2 + 1.5, y + 10.5, (width - 3) * work, 4)
        .fill({ color: 0x5aa8f0 });
    }
  }

  destroy(): void {
    this.shape.destroy();
  }
}

/**
 * The rim on your own hero's board.
 *
 * Turquoise, and nothing else on the map is. The company ring already says
 * which ground is yours, but a ring is on the floor and the board is where the
 * eye goes -- so at a glance across a country with four companies on it, this
 * is the thing that answers "which one am I".
 *
 * It is a second signal, not the only one: your hero is also the one the view
 * opens on, the one the HUD names, and the only one that answers a click.
 */
const YOURS_RIM = 0x3fd9c8;

/** A hero's plate: shield, initials, name, health, and work in flight. */
export function heroPlate(actor: Actor, yours: boolean): Plate {
  const root = new Container();

  const name = new Text({
    text: actor.name.length > 20 ? `${actor.name.slice(0, 19)}…` : actor.name,
    style: {
      fontFamily: FONT,
      fontSize: 19,
      fontWeight: "700",
      fill: yours ? YOURS_RIM : 0xf0c04a,
    },
  });
  name.anchor.set(0, 0);

  const SHIELD = 34;
  const BARS = 18;
  const board = new Graphics();
  const width = Math.max(SHIELD + 12 + name.width + 10, 110);
  const height = SHIELD + 12 + BARS;

  board
    .rect(-width / 2, 0, width, height)
    .fill({ color: 0x241d15, alpha: 0.9 })
    .stroke({ color: yours ? YOURS_RIM : 0xe8b44a, width: yours ? 3 : 2, alignment: 1 });

  /*
   * The shield: a pointed pentagon rather than a rectangle, because a rectangle
   * with letters in it is a label, and the job of this is to be a device
   * somebody picks out at a glance from across the country.
   */
  const left = -width / 2 + 6;
  board
    .poly([
      left, 6,
      left + SHIELD, 6,
      left + SHIELD, 6 + SHIELD * 0.6,
      left + SHIELD / 2, 6 + SHIELD,
      left, 6 + SHIELD * 0.6,
    ])
    .fill({ color: yours ? YOURS_RIM : 0xe8b44a })
    .stroke({ color: 0x241d15, width: 2, alignment: 0 });

  const initials = new Text({
    text: initialsOf(actor.name),
    style: { fontFamily: FONT, fontSize: 17, fontWeight: "700", fill: 0x241d15 },
  });
  initials.anchor.set(0.5, 0.5);
  initials.position.set(left + SHIELD / 2, 6 + SHIELD * 0.44);

  name.position.set(left + SHIELD + 10, 10);

  root.addChild(board, initials, name);
  const bars = new Bars(root, width - 12, SHIELD + 10);

  return { root, height, bars };
}

/**
 * A soldier's plate: its class as a sigil, and which session it is.
 *
 * The class used to be spelled out -- "ARTIFICER", "BEASTMASTER" -- which is a
 * lot of letters to say the same five things over and over, and at a camp with
 * a dozen soldiers in it the words were most of what was on screen. A mark says
 * it in one glance and a quarter of the width, and it is the same mark the
 * session list uses, so the two agree about what a tool looks like.
 */
export function soldierPlate(actor: Actor, sigils: Sigils): Plate {
  const root = new Container();

  const name = new Text({
    text: actor.name.length > 24 ? `${actor.name.slice(0, 23)}…` : actor.name,
    style: { fontFamily: FONT, fontSize: 16, fill: 0xf0d9a8 },
  });
  name.anchor.set(0, 0.5);

  const PAD = 6;
  const SIGIL = 22;
  const WORK_MARK = 16;
  const width = SIGIL + WORK_MARK + PAD * 4 + name.width;
  const height = SIGIL + PAD;

  const board = new Graphics();
  board
    .rect(-width / 2, 0, width, height)
    .fill({ color: 0x241d15, alpha: 0.85 })
    .stroke({ color: 0xc9a06a, width: 1, alignment: 1 });

  const badge = sigilFor(actor.kind, sigils, SIGIL);
  badge.position.set(-width / 2 + PAD + SIGIL / 2, height / 2);
  name.position.set(-width / 2 + PAD * 2 + SIGIL, height / 2);

  /*
   * The class sigil says what is running; this small pixel mark says what the
   * session is doing. Fixing is a red cross, building a gold hammer, and a
   * waiting prompt two quiet bars. That keeps all three operational states
   * visible even when labels are too small to read.
   */
  const work = new Graphics();
  if (actor.work === "bug") {
    work.moveTo(-5, -5).lineTo(5, 5).moveTo(5, -5).lineTo(-5, 5)
      .stroke({ color: 0xe35d4f, width: 3 });
  } else if (actor.work === "feature") {
    work.rect(-5, -5, 10, 7).fill({ color: 0xe8b44a });
    work.rect(-1.5, 2, 3, 7).fill({ color: 0xe8b44a });
  } else {
    work.rect(-5, -5, 3, 10).fill({ color: 0x91a0ad });
    work.rect(2, -5, 3, 10).fill({ color: 0x91a0ad });
  }
  work.position.set(width / 2 - PAD - WORK_MARK / 2, height / 2);

  root.addChild(board, badge, name, work);
  return { root, height };
}
