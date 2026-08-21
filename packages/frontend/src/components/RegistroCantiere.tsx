import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { ProjectTimelineEntry } from '../lib/types';
import { badgeClassForTipo, formatDate, formatHours, TIPI_ORDER } from '../lib/format';
import { groupTimelineByDayUserTask } from '../lib/groupTimeLogs';
import TimeLogEditForm from './TimeLogEditForm';

const PAGE_SIZE = 20;

// Registro cronologico dettagliato di un cantiere (Archivio, punto 7b): ogni ora
// registrata, chi l'ha fatta, per quale lavoro, con quali materiali — non solo il
// riepilogo aggregato già mostrato più sopra nella pagina. Componente a sé (non solo
// markup inline in CantiereDetailPage) perché lo stesso registro serve sia lì sia dalla
// pagina Archivio: decisione del 18/08 che sostituisce quella del 10/08 (solo pagina
// separata) — l'utente ha scelto di volerlo anche nel dettaglio di un cantiere attivo.
export default function RegistroCantiere({ projectId }: { projectId: string }) {
  const [entries, setEntries] = useState<ProjectTimelineEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Una sola riga in modifica alla volta: aprirne una chiude eventualmente l'altra,
  // evita N form aperti insieme con N liste di cantieri/dipendenti caricate a vuoto.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Quale gruppo (data+dipendente+lavoro) mostra il dettaglio espanso con le singole
  // registrazioni. Chiave "data|userId|taskId", coerente con groupTimelineByDayUserTask.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  // Raggruppate per data+dipendente+lavoro: stesso giorno, sullo stesso lavoro, dello
  // stesso dipendente appaiono affiancate (badge colorati per tipo + totale) invece che
  // su righe separate — stessa richiesta esplicita dell'utente già applicata alla
  // Cronologia ore del dipendente (vedi groupTimeLogs.ts), estesa qui il 20/08.
  const groups = useMemo(() => groupTimelineByDayUserTask(entries), [entries]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  async function load(targetPage: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getProjectTimeline(projectId, { page: targetPage, limit: PAGE_SIZE });
      setEntries(res.entries);
      setTotal(res.total);
      setPage(res.page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore nel caricamento del registro');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  return (
    <section className="card">
      <h2>Registro cronologico</h2>
      {error && <div className="alert">{error}</div>}
      {loading && <p className="muted">Caricamento…</p>}
      {!loading && entries.length === 0 && <p className="muted">Nessuna registrazione ancora.</p>}
      {entries.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left">
                <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Data</th>
                <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Dipendente</th>
                <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Lavoro</th>
                <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Ore per tipo</th>
                <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Totale</th>
                <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Materiali</th>
                <th className="px-4 py-3 no-print" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const key = `${g.date}|${g.userId}|${g.taskId}`;
                const isExpanded = expandedKey === key;
                return (
                  <Fragment key={key}>
                    <tr className="border-b border-gray-200 last:border-none hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-700">{formatDate(g.date)}</td>
                      <td className="px-4 py-3 font-medium text-gray-900">{g.userName}</td>
                      <td className="px-4 py-3 text-gray-700">{g.taskTitle}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {TIPI_ORDER.filter((tipo) => g.hoursByTipo[tipo]).map((tipo) => (
                            <span key={tipo} className={badgeClassForTipo(tipo)}>
                              {tipo} {formatHours(g.hoursByTipo[tipo]!)}h
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900">{formatHours(g.totalHours)}</td>
                      <td className="px-4 py-3 text-gray-500">
                        {g.materials.length > 0 ? g.materials.map((m) => `${m.name} ${m.quantity}${m.unit}`).join(', ') : '—'}
                      </td>
                      <td className="px-4 py-3 text-right no-print">
                        <button type="button" className="btn-ghost px-2" onClick={() => setExpandedKey(isExpanded ? null : key)}>
                          {isExpanded ? 'Chiudi' : g.entries.length > 1 ? `Dettaglio (${g.entries.length})` : 'Dettaglio'}
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-b border-gray-200 last:border-none no-print">
                        <td className="bg-gray-50 px-4 py-3" colSpan={7}>
                          <ul className="flex flex-col gap-2">
                            {g.entries.map((e) => (
                              <li key={e.id} className="flex flex-col gap-1.5 rounded-md border border-gray-200 bg-white p-3">
                                <div className="flex items-center justify-between gap-2">
                                  <span className={badgeClassForTipo(e.tipo)}>{e.tipo}</span>
                                  <span className="font-medium text-gray-900">{formatHours(e.hoursWorked)}h</span>
                                  <button
                                    type="button"
                                    className="btn-ghost px-2"
                                    onClick={() => setEditingId(editingId === e.id ? null : e.id)}
                                  >
                                    {editingId === e.id ? 'Chiudi' : 'Modifica'}
                                  </button>
                                </div>
                                {e.workDescription && <span className="muted text-sm">{e.workDescription}</span>}
                                {editingId === e.id && (
                                  <TimeLogEditForm
                                    timeLog={{ id: e.id, taskId: e.taskId, userId: e.userId, tipo: e.tipo, hoursWorked: e.hoursWorked, date: e.date }}
                                    onSaved={() => {
                                      setEditingId(null);
                                      setExpandedKey(null);
                                      load(page);
                                    }}
                                  />
                                )}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-4">
          <button className="btn-secondary" disabled={page <= 1 || loading} onClick={() => load(page - 1)}>
            ← Precedente
          </button>
          {/* Dichiarato esplicitamente, non lasciato intuire: la vista (e un'eventuale
              stampa) copre solo la pagina corrente, non l'intero registro. */}
          <span className="muted">
            Pagina {page} di {totalPages} · {total} registrazioni totali
          </span>
          <button className="btn-secondary" disabled={page >= totalPages || loading} onClick={() => load(page + 1)}>
            Successiva →
          </button>
        </div>
      )}
    </section>
  );
}
