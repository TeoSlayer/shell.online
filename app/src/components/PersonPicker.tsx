import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CaretDown, Check, MagnifyingGlass } from "@phosphor-icons/react";
import { Avatar, AvatarStack } from "./Avatar";
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
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const optionIdPrefix = useId();

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
    const onPointer = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    if (searchable) search.current?.focus(); else popover.current?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, searchable]);

  function close(returnFocus = false) {
    setOpen(false);
    setQuery("");
    setActive(0);
    if (returnFocus) requestAnimationFrame(() => trigger.current?.focus());
  }

  function choose(uid: string) {
    onChange(uid);
    close(true);
  }

  function navigate(event: ReactKeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, matches.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(matches.length - 1, 0));
    } else if (event.key === "Enter" && matches[active]) {
      event.preventDefault();
      choose(matches[active].uid);
    }
  }

  return (
    <div className={`picker picker-${align}`} ref={wrapper}>
      <button
        ref={trigger}
        type="button"
        className="picker-trigger"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
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
        <>
          <button
            type="button"
            className="picker-scrim"
            aria-label={`Close ${label.toLocaleLowerCase()} choices`}
            onClick={() => close(true)}
          />
          <div
            ref={popover}
            className="picker-pop"
            role="listbox"
            aria-label={label}
            aria-activedescendant={matches[active] ? `${optionIdPrefix}-${active}` : undefined}
            tabIndex={searchable ? -1 : 0}
            onKeyDown={navigate}
          >
            <div className="picker-head">{label}</div>
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
                      id={`${optionIdPrefix}-${index}`}
                      type="button"
                      role="option"
                      aria-selected={person.uid === value}
                      className={index === active ? "picker-item is-active" : "picker-item"}
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
        </>
      )}
    </div>
  );
}

interface MultiPersonPickerProps<T extends Person> {
  people: T[];
  values: string[];
  onChange(uids: string[]): void;
  disabled?: boolean;
  label: string;
  align?: "left" | "right";
}

/** Multi-assignment with immediate saves: every tick is the whole operation. */
export function MultiPersonPicker<T extends Person>({
  people,
  values,
  onChange,
  disabled,
  label,
  align = "left",
}: MultiPersonPickerProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const optionIdPrefix = useId();
  const selectedIds = new Set(values);
  const selected = people.filter((person) => selectedIds.has(person.uid));
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
    const close = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    if (searchable) search.current?.focus(); else popover.current?.focus();
    return () => {
      document.removeEventListener("pointerdown", close);
    };
  }, [open, searchable]);

  function close(returnFocus = false) {
    setOpen(false);
    setQuery("");
    setActive(0);
    if (returnFocus) requestAnimationFrame(() => trigger.current?.focus());
  }

  function toggle(uid: string) {
    onChange(selectedIds.has(uid) ? values.filter((value) => value !== uid) : [...values, uid]);
  }

  function navigate(event: ReactKeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, matches.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(matches.length - 1, 0));
    } else if (event.key === "Enter" && matches[active]) {
      event.preventDefault();
      toggle(matches[active].uid);
    }
  }

  return (
    <div className={`picker picker-${align}`} ref={wrapper}>
      <button
        ref={trigger}
        type="button"
        className="picker-trigger picker-trigger-multi"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {selected.length ? <AvatarStack people={selected} max={3} /> : null}
        <span className={selected.length ? "picker-label" : "picker-label picker-empty"}>
          {selected.length === 0
            ? "Unassigned"
            : selected.length === 1
              ? displayName(selected[0])
              : `${selected.length} people`}
        </span>
        <CaretDown size={12} weight="bold" className="picker-caret" />
      </button>

      {open && (
        <>
        <button
          type="button"
          className="picker-scrim"
          aria-label={`Close ${label.toLocaleLowerCase()} choices`}
          onClick={() => close(true)}
        />
        <div
          ref={popover}
          className="picker-pop"
          role="listbox"
          aria-label={label}
          aria-multiselectable="true"
          aria-activedescendant={matches[active] ? `${optionIdPrefix}-${active}` : undefined}
          tabIndex={searchable ? -1 : 0}
          onKeyDown={navigate}
        >
          <div className="picker-head">{label}</div>
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
                placeholder="Search people"
                aria-label="Search people"
              />
            </div>
          )}

          <ul className="picker-list">
            {matches.length === 0 ? (
              <li className="picker-none">Nobody matches that.</li>
            ) : (
              matches.map((person, index) => {
                const checked = selectedIds.has(person.uid);
                return (
                  <li key={person.uid}>
                    <button
                      id={`${optionIdPrefix}-${index}`}
                      type="button"
                      role="option"
                      aria-selected={checked}
                      className={index === active ? "picker-item is-active" : "picker-item"}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => toggle(person.uid)}
                    >
                      <Avatar person={person} size="sm" />
                      <span className="picker-item-text">
                        <span className="picker-item-name">{displayName(person)}</span>
                        {person.email && <span className="picker-item-mail">{person.email}</span>}
                      </span>
                      <span className={checked ? "picker-check is-checked" : "picker-check"}>
                        {checked && <Check size={12} weight="bold" />}
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
        </>
      )}
    </div>
  );
}
