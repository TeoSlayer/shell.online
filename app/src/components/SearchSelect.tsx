import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CaretDown, Check, MagnifyingGlass } from "@phosphor-icons/react";
import { filterSearchOptions, type SearchSelectOption } from "../lib/search-options";

/** A native-sized trigger with a richer popover on desktop and sheet on phones. */
export function SearchSelect({
  label,
  value,
  options,
  onChange,
  searchable = true,
  searchPlaceholder = `Search ${label.toLocaleLowerCase()}`,
  align = "left",
}: {
  label: string;
  value: string;
  options: SearchSelectOption[];
  onChange(value: string): void;
  searchable?: boolean;
  searchPlaceholder?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const optionIdPrefix = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];
  const matches = useMemo(() => filterSearchOptions(options, query), [options, query]);

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

  function choose(next: string) {
    onChange(next);
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
      choose(matches[active].value);
    }
  }

  return (
    <div className={`filter-picker filter-picker-${align}`} ref={wrapper}>
      <button
        ref={trigger}
        type="button"
        className="filter-picker-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{selected?.label ?? label}</span>
        <CaretDown size={12} weight="bold" />
      </button>

      {open && (
        <>
          <button
            type="button"
            className="filter-picker-scrim"
            aria-label={`Close ${label.toLocaleLowerCase()} choices`}
            onClick={() => close(true)}
          />
          <div
            ref={popover}
            className="filter-picker-pop"
            role="listbox"
            aria-label={label}
            aria-activedescendant={matches[active] ? `${optionIdPrefix}-${active}` : undefined}
            tabIndex={searchable ? -1 : 0}
            onKeyDown={navigate}
          >
            <div className="filter-picker-head">{label}</div>
            {searchable && (
              <label className="filter-picker-search">
                <MagnifyingGlass size={15} />
                <input
                  ref={search}
                  value={query}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(0);
                  }}
                />
              </label>
            )}
            <ul className="filter-picker-list">
              {matches.length === 0 ? (
                <li className="filter-picker-empty">Nothing matches.</li>
              ) : (
                matches.map((option, index) => (
                  <li key={option.value || "__all"}>
                    <button
                      id={`${optionIdPrefix}-${index}`}
                      type="button"
                      role="option"
                      aria-selected={option.value === value}
                      className={index === active ? "filter-picker-option is-active" : "filter-picker-option"}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => choose(option.value)}
                    >
                      <span className="filter-picker-copy">
                        <b>{option.label}</b>
                        {option.detail && <small>{option.detail}</small>}
                      </span>
                      <span className={option.value === value ? "filter-picker-check is-selected" : "filter-picker-check"}>
                        {option.value === value && <Check size={12} weight="bold" />}
                      </span>
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
