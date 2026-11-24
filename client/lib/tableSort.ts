// Every table (class "table") sorts by a click on a column heading: once ascending, again descending, a third
// time back to the page's own order. One listener for the whole app, so every table, present and future, gets it;
// a table opts out with data-nosort. The rows are compared by what the cell shows: numbers and percentages as
// numbers, dates (27 Oct 2026, 02/11/2026, 2026-11-02) as dates, the rest as text (Arabic included), empty last.
// When the page redraws the table (new data, a filter), the chosen order is applied again.

type Dir = 'ascending' | 'descending';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function key(text: string): { n: number } | { s: string } | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || t === '-' || t === '–') return null;
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (m) return { n: Date.UTC(+m[3], +m[2] - 1, +m[1]) };
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return { n: Date.UTC(+m[1], +m[2] - 1, +m[3]) };
  m = /^(\d{1,2}) ([A-Za-z]{3})[a-z]*(?: (\d{4}))?/.exec(t);
  if (m && MONTHS.includes(m[2].toLowerCase())) return { n: Date.UTC(m[3] ? +m[3] : new Date().getUTCFullYear(), MONTHS.indexOf(m[2].toLowerCase()), +m[1]) };
  m = /^[-+]?\d[\d,]*(\.\d+)?\s*%?$/.exec(t);
  if (m) return { n: Number(t.replace(/[,%\s]/g, '')) };
  return { s: t.toLowerCase() };
}

function cellText(row: HTMLTableRowElement, col: number): string {
  const cell = row.cells[col] as HTMLElement | undefined;
  return cell?.dataset.sort ?? cell?.innerText ?? '';
}

const collator = new Intl.Collator(['en', 'ar'], { numeric: true, sensitivity: 'base' });

function apply(table: HTMLTableElement) {
  const col = Number(table.dataset.sortCol);
  const dir = table.dataset.sortDir as Dir | undefined;
  const body = table.tBodies[0];
  if (!body || Number.isNaN(col)) return;
  const rows = [...body.rows];
  // The page's own order, kept to restore it.
  rows.forEach((r, i) => r.dataset.origin ?? (r.dataset.origin = String(i)));
  const sorted = [...rows].sort((a, b) => {
    if (!dir) return Number(a.dataset.origin) - Number(b.dataset.origin);
    // A row spanning the whole table (an empty-state line, "show more") stays where it is: last.
    const fa = a.cells.length === 1 && a.cells[0].colSpan > 1;
    const fb = b.cells.length === 1 && b.cells[0].colSpan > 1;
    if (fa !== fb) return fa ? 1 : -1;
    const ka = key(cellText(a, col));
    const kb = key(cellText(b, col));
    if (!ka || !kb) return !ka && !kb ? 0 : !ka ? 1 : -1;
    const c = 'n' in ka && 'n' in kb ? ka.n - kb.n : collator.compare('s' in ka ? ka.s : String(ka.n), 's' in kb ? kb.s : String(kb.n));
    return dir === 'ascending' ? c : -c;
  });
  if (sorted.every((r, i) => r === rows[i])) return;
  table.dataset.sorting = '1';
  for (const r of sorted) body.appendChild(r);
  delete table.dataset.sorting;
}

const watched = new WeakSet<HTMLTableElement>();

export function installTableSort(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, select, button, a, label')) return;
    const th = target.closest('th') as HTMLTableCellElement | null;
    const table = th?.closest('table.table') as HTMLTableElement | null;
    if (!th || !table || 'nosort' in table.dataset || !th.closest('thead') || !th.innerText.trim()) return;
    const col = th.cellIndex;
    const same = Number(table.dataset.sortCol) === col;
    const next: Dir | undefined = !same ? 'ascending' : table.dataset.sortDir === 'ascending' ? 'descending' : table.dataset.sortDir === 'descending' ? undefined : 'ascending';
    table.dataset.sortCol = String(col);
    if (next) table.dataset.sortDir = next;
    else delete table.dataset.sortDir;
    for (const h of table.tHead?.rows[0]?.cells ?? []) h.removeAttribute('aria-sort');
    if (next) th.setAttribute('aria-sort', next);
    apply(table);
    // The page may redraw the rows (new data, a filter): sort again after it does.
    const body = table.tBodies[0];
    if (body && !watched.has(table)) {
      watched.add(table);
      new MutationObserver(() => {
        if (!table.dataset.sorting) {
          for (const r of body.rows) delete r.dataset.origin;
          apply(table);
        }
      }).observe(body, { childList: true });
    }
  });
}
