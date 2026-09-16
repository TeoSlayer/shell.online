import { Container, Graphics } from "pixi.js";

/**
 * The Unmade, drawn rather than sprited.
 *
 * Kenney's pack has no insects, so they were dark-tinted soldiers -- which read
 * as "the enemy team" rather than as vermin, and the whole conceit is that
 * these are faults crawling out of the ground. Six legs settles it in a way no
 * amount of tinting could: nothing with six legs is a person.
 *
 * Drawn as a few Graphics per creature rather than one redrawn each frame. The
 * legs are children that rotate, so walking costs six transforms instead of a
 * re-tessellation, which at forty of them on a besieged camp is the difference
 * between free and not.
 */

interface Build {
  /** Body length, front to back. */
  length: number;
  /** How fat it is. */
  girth: number;
  /** How many chunks the body is made of. */
  segments: number;
  body: number;
  shell: number;
  /** Long feelers, for the big ones. */
  antennae: boolean;
  eyes: number;
}

/**
 * One build per kind, so a glance tells you which you are looking at.
 *
 * The colours are all cold, because everything else on this map is warm. That
 * is the same rule the tint followed; what has changed is that it is now
 * carried by a shape as well.
 */
const BUILDS: Record<string, Build> = {
  mite: { length: 15, girth: 10, segments: 1, body: 0x4f8f86, shell: 0x6fd6c0, antennae: false, eyes: 2 },
  crawler: { length: 23, girth: 13, segments: 2, body: 0x3f7f95, shell: 0x63b6cc, antennae: false, eyes: 2 },
  heisenbug: { length: 32, girth: 18, segments: 3, body: 0x5b4b8a, shell: 0x9b86d6, antennae: true, eyes: 4 },
};

export interface Unmade {
  root: Container;
  /** The six of them, rotated as it walks. */
  legs: Graphics[];
}

export function makeUnmade(kind: string): Unmade {
  const build = BUILDS[kind] ?? BUILDS.mite;
  const root = new Container();
  const legs: Graphics[] = [];

  /*
   * Legs first, so the body sits over the joints. Three a side, splayed front
   * to back -- the middle pair square, the outer pairs angled -- because six
   * legs all pointing the same way reads as a centipede.
   */
  for (let index = 0; index < 6; index += 1) {
    const side = index < 3 ? -1 : 1;
    const along = (index % 3) - 1;
    const leg = new Graphics();
    const reach = build.girth * 1.1;
    leg
      .moveTo(0, 0)
      .lineTo(side * reach * 0.6, -build.girth * 0.25)
      .lineTo(side * reach, build.girth * 0.2)
      .stroke({ color: build.body, width: Math.max(2, build.girth * 0.16), cap: "round", join: "round" });
    leg.position.set(along * build.length * 0.26, -build.girth * 0.3);
    root.addChild(leg);
    legs.push(leg);
  }

  const body = new Graphics();
  for (let index = 0; index < build.segments; index += 1) {
    /* Back to front, each a little smaller, so it tapers to the head. */
    const t = build.segments === 1 ? 0 : index / (build.segments - 1);
    const at = build.length * (0.5 - t) * 0.72;
    const size = build.girth * (0.72 + t * 0.28);
    body.ellipse(at, -build.girth * 0.45, size * 0.62, size * 0.5).fill({ color: build.body });
  }
  /* The shell: a lighter cap on the back half, which is what makes it gleam. */
  body
    .ellipse(build.length * 0.1, -build.girth * 0.6, build.girth * 0.5, build.girth * 0.34)
    .fill({ color: build.shell, alpha: 0.75 });
  root.addChild(body);

  const head = new Graphics();
  const nose = -build.length * 0.46;
  head
    .ellipse(nose, -build.girth * 0.5, build.girth * 0.42, build.girth * 0.38)
    .fill({ color: build.body });
  for (let index = 0; index < build.eyes; index += 1) {
    const row = Math.floor(index / 2);
    const side = index % 2 === 0 ? -1 : 1;
    head
      .circle(
        nose - build.girth * 0.08 + row * build.girth * 0.22,
        -build.girth * (0.62 - row * 0.22) + side * build.girth * 0.12,
        Math.max(1.4, build.girth * 0.1),
      )
      .fill({ color: 0xffe9a8 });
  }
  if (build.antennae) {
    for (const side of [-1, 1]) {
      head
        .moveTo(nose, -build.girth * 0.75)
        .lineTo(nose - build.girth * 0.5, -build.girth * (1.2 + 0.1 * side))
        .stroke({ color: build.body, width: 2, cap: "round" });
    }
  }
  root.addChild(head);

  return { root, legs };
}

/**
 * Moves the legs.
 *
 * Alternating tripods, which is how a real insect walks: front and back on one
 * side with the middle of the other, then the reverse. It costs one sine per
 * leg and it is the difference between a bug and a drawing of one being slid
 * across the floor.
 */
export function walkUnmade(unmade: Unmade, phase: number, moving: boolean): void {
  for (let index = 0; index < unmade.legs.length; index += 1) {
    const side = index < 3 ? 0 : 1;
    const along = index % 3;
    /* The tripod an odd leg belongs to: 0 or 1. */
    const tripod = (along + side) % 2;
    const swing = moving ? Math.sin(phase + tripod * Math.PI) * 0.34 : 0;
    unmade.legs[index].rotation = swing;
  }
}
