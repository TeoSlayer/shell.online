/**
 * Finding @mentions in a comment.
 *
 * People are mentioned by name, because a name is what a reader sees; the
 * account id never appears in the text. Matching is longest-first so
 * "@Ana Ferreira" wins over "@Ana" when both are in the roster.
 */

export interface Mentionable {
  uid: string;
  name?: string;
  email?: string;
}

interface Handle {
  handle: string;
  uid: string;
  /** A name is what a reader sees, so it wins a tie against an email handle. */
  fromName: boolean;
}

function handlesOf(person: Mentionable): Handle[] {
  const found: Handle[] = [];
  const name = person.name?.trim();
  if (name) found.push({ handle: name, uid: person.uid, fromName: true });
  const local = person.email?.split("@")[0];
  if (local && local.toLowerCase() !== name?.toLowerCase()) {
    found.push({ handle: local, uid: person.uid, fromName: false });
  }
  return found;
}

/*
 * Longest first, so a full name beats a first name. Between two of the same
 * length, the one that is somebody's actual name wins: "@Ana" should reach
 * the person called Ana rather than someone whose address happens to be ana@.
 */
function rankedHandles(people: Mentionable[]): Handle[] {
  return people
    .flatMap(handlesOf)
    .sort((a, b) =>
      b.handle.length - a.handle.length || Number(b.fromName) - Number(a.fromName),
    );
}

/** The text as segments, so a mention can be rendered differently. */
export interface Segment {
  text: string;
  uid?: string;
}

/**
 * The uids mentioned in a body, without duplicates.
 *
 * Derived from the same segmentation the renderer uses, so the people notified
 * are exactly the people shown as mentioned. Scanning each name separately
 * matched "@Ana" inside "@Ana Ferreira" and notified the wrong colleague.
 */
export function findMentions(body: string, people: Mentionable[]): string[] {
  const found = new Set<string>();
  for (const segment of splitMentions(body, people)) {
    if (segment.uid) found.add(segment.uid);
  }
  return [...found];
}

export function splitMentions(body: string, people: Mentionable[]): Segment[] {
  const candidates = rankedHandles(people);
  const segments: Segment[] = [];
  let index = 0;

  while (index < body.length) {
    if (body[index] !== "@") {
      const next = body.indexOf("@", index + 1);
      const end = next < 0 ? body.length : next;
      segments.push({ text: body.slice(index, end) });
      index = end;
      continue;
    }

    const rest = body.slice(index + 1).toLowerCase();
    const match = candidates.find(({ handle }) => {
      const lower = handle.toLowerCase();
      if (!rest.startsWith(lower)) return false;
      const after = rest.charAt(lower.length);
      return !after || !/[a-z0-9._-]/.test(after);
    });

    if (match) {
      segments.push({ text: `@${body.slice(index + 1, index + 1 + match.handle.length)}`, uid: match.uid });
      index += 1 + match.handle.length;
    } else {
      segments.push({ text: "@" });
      index += 1;
    }
  }

  return segments.filter((segment) => segment.text.length > 0);
}
