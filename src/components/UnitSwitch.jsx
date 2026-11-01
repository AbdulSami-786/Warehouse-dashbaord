import { useState } from 'react';
import { qty } from '../lib/format.js';
import { unitFactor } from '../lib/calc.js';

/** Base unit plus the alternate one (bag, carton…) when the item has a usable conversion. */
export const unitsOf = (item) => (item.altUnit && Number(item.conversionRate) > 0 ? [item.baseUnit, item.altUnit] : [item.baseUnit]);

/** Unit chips for an item; clicking one shows that row's stock in it. */
export function UnitSwitch({ item, unit, onPick }) {
  const units = unitsOf(item);
  if (units.length < 2) return <span>{item.baseUnit}</span>;
  return (
    <span className="chips" style={{ display: 'inline-flex', gap: 4 }}>
      {units.map((u) => (
        <button
          key={u}
          type="button"
          className={`chip ${u === unit ? 'chip-active' : ''}`}
          title={u === item.baseUnit ? `Show in ${u}` : `Show in ${u} (1 ${u} = ${item.conversionRate} ${item.baseUnit})`}
          style={{ padding: '0 8px', fontSize: 12 }}
          onClick={(e) => { e.stopPropagation(); onPick(item.id, u); }}
        >
          {u}
        </button>
      ))}
    </span>
  );
}

/**
 * The unit each item's stock is shown in (defaults to its base unit). Stock
 * itself is always kept in base units; this only changes how it reads.
 */
export function useUnitPick() {
  const [picked, setPicked] = useState({});
  const pickUnit = (id, u) => setPicked((p) => ({ ...p, [id]: u }));
  const unitOf = (item) => (unitsOf(item).includes(picked[item.id]) ? picked[item.id] : item.baseUnit);
  const showQty = (item, v) => qty(v / unitFactor(item, unitOf(item)));
  return { pickUnit, unitOf, showQty };
}
