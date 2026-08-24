import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { ProjectTimelineEntry } from '../lib/types';
import { badgeClassForTipo, formatDate, formatHours, TIPI_ORDER } from '../lib/format';
import { groupTimelineByDayUserTask } from '../lib/groupTimeLogs';
import TimeLogEditForm from './TimeLogEditForm';
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState } from './ui';
import { ClockIcon } from './icons';

const PAGE_SIZE = 20;

// Classi ricorrenti del design system, scritte una volta sola invece di ripeterle in
// ogni cella. Le stesse stringhe sono già in CantiereDetailPage: restano duplicate
// finché non ci sarà un modulo condiviso per gli stili di pagina.
const ALERT_ERRORE =
  'rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm font-medium text-danger-600 dark:border-danger-800 dark:bg-danger-900/30 dark:text-danger-400';

const TESTO_ATTENUATO = 'text-sm text-surface-500 dark:text-surface-400';

// Intestazione e celle ricalcano quelle del componente condiviso Table (ui/Table.tsx):
// questa tabella NON può usarlo perché ha righe espandibili (una <tr> di dettaglio in
// più sotto quella cliccata), forma che Table non prevede — le classi sono allineate a
// mano perché le due tabelle restino identiche a vedersi.
const INTESTAZIONE_COLONNA =
  'px-4 py-3 text-left text-xs font-semibold tracking-wider text-surface-500 uppercase';

const RIGA_TABELLA =
  'border-b border-surface-200 last:border-none hover:bg-surface-50 dark:border-surface-700 dark:hover:bg-surface-900/50';

const CELLA = 'px-4 py-3 text-surface-700 dark:text-surface-300';

const CELLA_EVIDENZIATA = 'px-4 py-3 font-medium text-surface-900 dark:text-surface-100';

// Colore proprio invece di CELLA + un secondo text-*: due utility dello stesso tipo
// sullo stesso elemento si contendono la precedenza in base all'ordine del CSS
// generato, non a quello scritto nel className.
const CELLA_ATTENUATA = 'px-4 py-3 text-surface-500 dark:text-surface-400';

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
    // break-inside-avoid: la vecchia classe .card portava con sé questa regola di stampa
    // (vedi @media print in index.css), che il componente Card non ha.
    <Card className="break-inside-avoid">
      <CardHeader>
        <CardTitle>Registro cronologico</CardTitle>
      </CardHeader>
      <CardContent>
        {error && (
          <div className={ALERT_ERRORE} role="alert">
            {error}
          </div>
        )}
        {loading && <p className={TESTO_ATTENUATO}>Caricamento…</p>}
        {!loading && entries.length === 0 && (
          <EmptyState title="Nessuna registrazione ancora" icon={<ClockIcon className="h-10 w-10" />} />
        )}
        {entries.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-surface-200 bg-white dark:border-surface-700 dark:bg-surface-800">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-surface-50 dark:bg-surface-900/50">
                <tr className="border-b border-surface-200 dark:border-surface-700">
                  <th className={INTESTAZIONE_COLONNA}>Data</th>
                  <th className={INTESTAZIONE_COLONNA}>Dipendente</th>
                  <th className={INTESTAZIONE_COLONNA}>Lavoro</th>
                  <th className={INTESTAZIONE_COLONNA}>Ore per tipo</th>
                  <th className={INTESTAZIONE_COLONNA}>Totale</th>
                  <th className={INTESTAZIONE_COLONNA}>Materiali</th>
                  <th className="px-4 py-3 no-print" />
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const key = `${g.date}|${g.userId}|${g.taskId}`;
                  const isExpanded = expandedKey === key;
                  return (
                    <Fragment key={key}>
                      <tr className={RIGA_TABELLA}>
                        <td className={CELLA}>{formatDate(g.date)}</td>
                        <td className={CELLA_EVIDENZIATA}>{g.userName}</td>
                        <td className={CELLA}>{g.taskTitle}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {TIPI_ORDER.filter((tipo) => g.hoursByTipo[tipo]).map((tipo) => (
                              <span key={tipo} className={badgeClassForTipo(tipo)}>
                                {tipo} {formatHours(g.hoursByTipo[tipo]!)}h
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className={CELLA_EVIDENZIATA}>{formatHours(g.totalHours)}</td>
                        <td className={CELLA_ATTENUATA}>
                          {g.materials.length > 0 ? g.materials.map((m) => `${m.name} ${m.quantity}${m.unit}`).join(', ') : '—'}
                        </td>
                        <td className="px-4 py-3 text-right no-print">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setExpandedKey(isExpanded ? null : key)}
                          >
                            {isExpanded ? 'Chiudi' : g.entries.length > 1 ? `Dettaglio (${g.entries.length})` : 'Dettaglio'}
                          </Button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="border-b border-surface-200 last:border-none no-print dark:border-surface-700">
                          <td className="bg-surface-50 px-4 py-3 dark:bg-surface-900/50" colSpan={7}>
                            <ul className="m-0 flex list-none flex-col gap-2 p-0">
                              {g.entries.map((e) => (
                                <li
                                  key={e.id}
                                  className="flex flex-col gap-1.5 rounded-lg border border-surface-200 bg-white p-3 dark:border-surface-700 dark:bg-surface-800"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className={badgeClassForTipo(e.tipo)}>{e.tipo}</span>
                                    <span className="font-medium text-surface-900 dark:text-surface-100">
                                      {formatHours(e.hoursWorked)}h
                                    </span>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setEditingId(editingId === e.id ? null : e.id)}
                                    >
                                      {editingId === e.id ? 'Chiudi' : 'Modifica'}
                                    </Button>
                                  </div>
                                  {e.workDescription && <span className={TESTO_ATTENUATO}>{e.workDescription}</span>}
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
          <div className="mt-4 flex items-center justify-between border-t border-surface-200 pt-4 dark:border-surface-700">
            <Button variant="secondary" size="sm" disabled={page <= 1 || loading} onClick={() => load(page - 1)}>
              ← Precedente
            </Button>
            {/* Dichiarato esplicitamente, non lasciato intuire: la vista (e un'eventuale
                stampa) copre solo la pagina corrente, non l'intero registro. */}
            <span className={TESTO_ATTENUATO}>
              Pagina {page} di {totalPages} · {total} registrazioni totali
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= totalPages || loading}
              onClick={() => load(page + 1)}
            >
              Successiva →
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
