import { avatarColor, displayName, initials, type Person } from "../lib/people";

export type AvatarSize = "xs" | "sm" | "md" | "lg";

/** One person, everywhere: a solid circle, their colour, their initials. */
export function Avatar({
  person,
  size = "sm",
  title,
}: {
  person: Person | null | undefined;
  size?: AvatarSize;
  title?: string;
}) {
  const label = displayName(person);
  return (
    <span
      className={`avatar avatar-${size}`}
      style={{ background: person ? avatarColor(person.uid) : "var(--faint)" }}
      title={title ?? label}
      aria-hidden="true"
    >
      {initials(person)}
    </span>
  );
}

/** An avatar with the name beside it, the usual way a person is referred to. */
export function PersonChip({
  person,
  size = "sm",
  secondary,
}: {
  person: Person | null | undefined;
  size?: AvatarSize;
  secondary?: string;
}) {
  return (
    <span className="person">
      <Avatar person={person} size={size} />
      <span className="person-text">
        <span className="person-name">{displayName(person)}</span>
        {secondary && <span className="person-secondary">{secondary}</span>}
      </span>
    </span>
  );
}

/** Overlapping avatars for a group, as in a member count. */
export function AvatarStack({ people, max = 4 }: { people: Person[]; max?: number }) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span className="avatar-stack">
      {shown.map((person) => (
        <Avatar key={person.uid} person={person} size="xs" />
      ))}
      {rest > 0 && <span className="avatar avatar-xs avatar-rest">+{rest}</span>}
    </span>
  );
}

/** A compact, explicit summary for a group of people. */
export function PeopleChip({ people }: { people: Person[] }) {
  if (people.length === 0) return <span className="people-empty">Unassigned</span>;
  return (
    <span className="people-chip" title={people.map(displayName).join(", ")}>
      <AvatarStack people={people} max={3} />
      <span>{people.length === 1 ? displayName(people[0]) : `${people.length} people`}</span>
    </span>
  );
}
