import { useState } from "react";
import { CLASS_LORE, WORLD } from "../lore/world";
import { buy, fitsClass, REFUSALS, SKINS, swatchFor, type Purse } from "../state/shop";

/**
 * The pedlar at the gate.
 *
 * Everything sold here is cosmetic, and the panel says so in as many words.
 * Somebody deciding whether to spend has a right to know that the decision
 * cannot be made wrongly — and being told plainly is also the honest way to
 * describe a shop that exists in a tool people use for work.
 *
 * Every refusal names its reason. A button that does nothing is the worst
 * possible answer to a press.
 */
export function Shop({
  purse,
  characterClass,
  wearing,
  livery,
  onBuy,
  onWear,
  onBack,
}: {
  purse: Purse;
  characterClass: string;
  wearing: string;
  /** What this player's soldiers are wearing, which is a separate choice. */
  livery: string;
  onBuy: (skinId: string) => void;
  onWear: (skinId: string) => void;
  onBack: () => void;
}) {
  const [refused, setRefused] = useState("");
  const lore = CLASS_LORE[characterClass] ?? CLASS_LORE.terminal;

  return (
    <div className="keep-shop">
      <header className="keep-shop-head">
        <p className="keep-shop-purse">
          <span className="keep-coin" aria-hidden="true">◈</span>
          {purse.marks.toLocaleString()} {WORLD.coin}
        </p>
        <p className="keep-shop-note">
          Cloth and dye only. Nothing here makes the garrison stronger.
        </p>
      </header>

      {refused && (
        <p className="keep-shop-refusal" role="status">
          {refused}
        </p>
      )}

      {/*
        * Two shelves, because the shop sells two different things: what you
        * wear, and what the people who work for you wear. Run together in one
        * list they read as ten interchangeable hats, and buying one and seeing
        * the wrong figure change colour is a small betrayal.
        */}
      {(["hero", "retinue"] as const).map((slot) => (
      <section key={slot} className="keep-shop-shelf">
      <h3 className="keep-shop-shelf-name">
        {slot === "hero" ? "What you wear" : "What your soldiers wear"}
      </h3>
      <ul className="keep-shop-list">
        {SKINS.filter((skin) => skin.wears === slot).map((skin) => {
          const owned = purse.owned.includes(skin.id);
          const worn = (slot === "hero" ? wearing : livery) === skin.id;
          const wearable = fitsClass(skin, characterClass);

          return (
            <li key={skin.id} className="keep-shop-item">
              {/*
                * The swatch is the colour itself, which is the whole product:
                * a skin washes the figure in this and changes nothing else.
                */}
              <span
                className="keep-swatch"
                aria-hidden="true"
                style={{ background: swatchFor(skin.id) }}
              />

              <span className="keep-shop-text">
                <span className="keep-shop-name">{skin.name}</span>
                <span className="keep-shop-blurb">{skin.note}</span>
                <span className="keep-shop-fits">
                  {skin.fits === "any" ? "Fits anyone" : `${CLASS_LORE[skin.fits]?.title ?? skin.fits} only`}
                </span>
              </span>

              {owned ? (
                <button
                  type="button"
                  className="keep-button"
                  disabled={worn || !wearable}
                  onClick={() => onWear(skin.id)}
                  /* Says why it cannot be worn, rather than just being grey. */
                  title={wearable ? undefined : `Not cut for ${lore.title}s`}
                >
                  {worn ? "Worn" : wearable ? "Wear" : "Not yours"}
                </button>
              ) : (
                <button
                  type="button"
                  className="keep-button"
                  onClick={() => {
                    const result = buy(purse, skin.id);
                    if (result.ok) {
                      setRefused("");
                      onBuy(skin.id);
                    } else {
                      setRefused(REFUSALS[result.reason]);
                    }
                  }}
                >
                  {skin.cost} ◈
                </button>
              )}
            </li>
          );
        })}
      </ul>
      </section>
      ))}

      <button type="button" className="keep-button" onClick={onBack}>
        Back
      </button>
    </div>
  );
}
