import { useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, Check, MagnifyingGlass } from "@phosphor-icons/react";
import { Avatar } from "./Avatar";
import { displayName, type Person } from "../lib/people";

interface PersonPickerProps<T extends Person> {
  people: T[];
  value?: string;
  onChange(uid: string): void;
  disabled?: boolean;
  label: string;
  /** Shown on the trigger when nobody is selected. */
  placeholder?: string;
  align?: "left" | "right";
}

/**
 * Choosing a person from a roster.
 *
 * A search box appears once the list is long enough to need one, so a small
 * team gets a plain list and a large one stays usable. Selection is the
 * person, shown as they are shown everywhere else.
 */
export function PersonPicker<T extends Person>({
  people,
  value,
  onChange,
  disabled,
  label,
  placeholder = "Unassigned",
  align = "left",
}: PersonPickerProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const selected = people.find((person) => person.uid === value);
  const searchable = people.length > 6;

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return people;
    return people.filter((person) =>
      `${displayName(person)} ${person.email ?? ""}`.toLowerCase().includes(needle),
    );
  }, [people, query]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    if (searchable) search.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, searchable]);

  function choose(uid: string) {
    onChange(uid);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className={`picker picker-${align}`} ref={wrapper}>
      <button
        type="button"
        className="picker-trigger"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
      >
        {selected ? (
          <>
            <Avatar person={selected} size="xs" />
            <span className="picker-label">{displayName(selected)}</span>
          </>
        ) : (
          <span className="picker-label picker-empty">{placeholder}</span>
        )}
        <CaretDown size={12} weight="bold" className="picker-caret" />
      </button>

      {open && (
        <div className="picker-pop" role="listbox" aria-label={label}>
          {searchable && (
            <div className="picker-search">
              <MagnifyingGlass size={14} />
              <input
                ref={search}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActive((current) => Math.min(current + 1, matches.length - 1));
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActive((current) => Math.max(current - 1, 0));
                  } else if (event.key === "Enter" && matches[active]) {
                    event.preventDefault();
                    choose(matches[active].uid);
                  }
                }}
                placeholder="Search people"
                aria-label="Search people"
              />
            </div>
          )}

          <ul className="picker-list">
            {matches.length === 0 ? (
              <li className="picker-none">Nobody matches that.</li>
            ) : (
              matches.map((person, index) => (
                <li key={person.uid}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={person.uid === value}
                    className={index === active && searchable ? "picker-item is-active" : "picker-item"}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(person.uid)}
                  >
                    <Avatar person={person} size="sm" />
                    <span className="picker-item-text">
                      <span className="picker-item-name">{displayName(person)}</span>
                      {person.email && <span className="picker-item-mail">{person.email}</span>}
                    </span>
                    {person.uid === value && <Check size={14} weight="bold" />}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
