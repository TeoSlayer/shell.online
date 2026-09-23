import { useSyncExternalStore } from "react";
import { getAppearance, parseAppearance, setAppearance, subscribeAppearance } from "../lib/appearance";

export function AppearancePicker() {
  const value = useSyncExternalStore(subscribeAppearance, getAppearance, () => "system");
  return (
    <section className="account-appearance" id="appearance" aria-labelledby="appearance-title">
      <div>
        <h2 id="appearance-title">Appearance</h2>
        <p>Choose the look of this app, including your terminals. Saved in this browser.</p>
      </div>
      <label>
        <span className="visually-hidden">Color theme</span>
        <select aria-label="Color theme" value={value} onChange={event => setAppearance(parseAppearance(event.target.value))}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
    </section>
  );
}
