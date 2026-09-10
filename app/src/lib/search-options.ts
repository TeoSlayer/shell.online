export type SearchSelectOption = {
  value: string;
  label: string;
  detail?: string;
  keywords?: string;
};

export function filterSearchOptions(options: SearchSelectOption[], query: string): SearchSelectOption[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return options;
  return options.filter((option) =>
    `${option.label} ${option.detail ?? ""} ${option.keywords ?? ""}`
      .toLocaleLowerCase()
      .includes(needle),
  );
}
