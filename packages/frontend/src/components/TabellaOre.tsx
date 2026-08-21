import type { HoursByProjectRow, HoursByUserRow, ProjectEmployeeRow } from '../lib/types';
import { formatHours } from '../lib/format';

// Tabella riepilogo ore con scomposizione per tipo (ordinario/straordinario/notturno/
// festivo/permesso/ferie) + totale + numero registrazioni. Estratta da ReportPage
// (era "TotaleTable", locale a quel file) perché la stessa forma di riga serve anche al
// dettaglio cantiere (ore per dipendente, ProjectEmployeeRow) — terzo uso reale, soglia
// per condividerla (coding-standards.md, DRY). Le tre forme condividono gli stessi 6
// campi di scomposizione per tipo + totalHours + logCount, differiscono solo nel campo
// "nome" (risolto da getName, non hardcoded qui).
export default function TabellaOre<T extends HoursByProjectRow | HoursByUserRow | ProjectEmployeeRow>({
  title,
  rows,
  getName,
}: {
  title: string;
  rows: T[];
  getName: (r: T) => string;
}) {
  const tipi: { key: keyof HoursByProjectRow; label: string }[] = [
    { key: 'ordinary', label: 'Ord.' },
    { key: 'straordinario', label: 'Straord.' },
    { key: 'notturno', label: 'Nott.' },
    { key: 'festivo', label: 'Fest.' },
    { key: 'permesso', label: 'Perm.' },
    { key: 'ferie', label: 'Ferie' },
  ];
  return (
    <div className="card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted">Nessun dato.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left">
                <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Nome</th>
                <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Tot. h</th>
                {tipi.map((t) => (
                  <th key={t.key} className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">
                    {t.label}
                  </th>
                ))}
                <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Reg.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-gray-200 last:border-none hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{getName(r)}</td>
                  <td className="px-4 py-3 text-gray-700">{formatHours(r.totalHours)}</td>
                  {tipi.map((t) => (
                    <td key={t.key} className="px-4 py-3 text-gray-700">
                      {formatHours((r as HoursByProjectRow)[t.key] as string)}
                    </td>
                  ))}
                  <td className="px-4 py-3 text-gray-700">{r.logCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
