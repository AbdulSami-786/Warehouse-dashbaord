import { useEffect, useRef } from 'react';
import { api } from './api.js';
import { advanceAvailable, billStates, journalOwed, partyDue } from './calc.js';
import { r2 } from './format.js';

/**
 * A party who holds an advance should never also show money still to pay: the
 * advance is spent on their unpaid bills and journal amounts, oldest first.
 * New bills, new journal entries and new advances already do this when they are
 * saved. This catches what was already on the books before that, and anything
 * else left over, by asking the backend to apply it.
 *
 * `partyIds` limits the check to those parties (one ledger); leave it out to
 * look at everyone (the parties list).
 *
 * Each (party, advance, owing) state is tried once. If the server answers
 * with an error — a user without access, a lost connection — the same state is
 * not retried in a loop; the next change to the books tries again.
 */
export function useAdvanceReconcile(data, refresh, partyIds = null) {
  const tried = useRef(new Set());
  const busy = useRef(false);

  useEffect(() => {
    if (busy.current || !data?.parties?.length) return;
    const states = billStates(data.bills, data);
    const wanted = partyIds ? new Set(partyIds) : null;
    const todo = [];
    for (const p of data.parties) {
      if (wanted && !wanted.has(p.id)) continue;
      const advance = advanceAvailable(p.id, data.partyAdvances);
      if (!(advance > 0.004)) continue;
      const owing = r2(partyDue(p.id, states) + Math.max(0, journalOwed('party', p.id, data)));
      if (!(owing > 0.004)) continue;
      const key = `${p.id}|${advance}|${owing}`;
      if (tried.current.has(key)) continue;
      tried.current.add(key);
      todo.push(p.id);
    }
    if (!todo.length) return;

    busy.current = true;
    (async () => {
      let changed = false;
      for (const id of todo) {
        try {
          const res = await api.reconcileAdvance(id);
          if (res && res.total > 0) changed = true;
        } catch { /* not allowed or offline: left as it is */ }
      }
      busy.current = false;
      if (changed) {
        try { await refresh(); } catch { /* refresh reports its own failure */ }
      }
    })();
  }, [data, refresh, partyIds]);
}
