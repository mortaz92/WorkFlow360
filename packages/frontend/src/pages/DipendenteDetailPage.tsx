import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, getCurrentUser } from '../lib/api';
import type { TimeLogTipo, UserRole, UserSummary, UserTimeLogDetail } from '../lib/types';
import { ArrowLeftIcon, ClockIcon, MailIcon, UsersIcon } from '../components/icons';
import { badgeClassForTipo, etichettaCantiere, formatDate, formatHours, TIPI_ORDER, USER_ROLE_LABELS } from '../lib/format';
import { groupTimeLogsByDayAndTask } from '../lib/groupTimeLogs';
import TimeLogEditForm from '../components/TimeLogEditForm';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Select,
  type SelectOption,
} from '../components/ui';

const ROLES: UserRole[] = ['admin', 'project_manager', 'operaio'];

const ROLE_OPTIONS: SelectOption[] = ROLES.map((r) => ({ value: r, label: USER_ROLE_LABELS[r] }));

// Classi ricorrenti del design system, scritte una volta sola invece di ripeterle a ogni
// occorrenza. Volutamente ricopiate da DashboardPage e NON estratte in un modulo condiviso:
// la migrazione grafica delle altre pagine è in corso in parallelo, un file comune va
// introdotto in un unico passaggio di consolidamento quando tutte saranno migrate.
const LINK_DETTAGLIO =
  'flex items-center gap-1 text-sm font-medium text-primary-600 transition-colors hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300';

const ALERT_ERRORE =
  'rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm font-medium text-danger-600 dark:border-danger-800 dark:bg-danger-900/30 dark:text-danger-400';

// La Cronologia ore non usa il componente Table condiviso: ogni gruppo può espandersi in
// una seconda riga con le singole registrazioni (due <tr> per elemento), forma che quel
// componente — una riga per dato — non sa esprimere. La tabella resta quindi scritta a
// mano, ma con gli stessi colori/spaziature di Table per non stonare col resto dell'app.
const INTESTAZIONE_COLONNA = 'px-4 py-3 text-xs font-semibold tracking-wider text-surface-500 uppercase';

const RIGA_TABELLA =
  'border-b border-surface-200 last:border-none hover:bg-surface-50 dark:border-surface-700 dark:hover:bg-surface-900/50';

// KPI tile: etichetta + numero grande. Stessa struttura per tutte e tre le tessere (la
// terza senza icona), quindi scritta una volta sola invece di tre blocchi identici.
function StatTile({ icon, label, value }: { icon?: ReactNode; label: string; value: ReactNode }) {
  return (
    <Card padding="sm" className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-sm font-medium text-surface-500 dark:text-surface-400">
        {icon}
        {label}
      </span>
      <span className="text-3xl font-bold text-surface-900 dark:text-surface-100">{value}</span>
    </Card>
  );
}

export default function DipendenteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<UserTimeLogDetail | null>(null);
  // /users è riservato ad admin (a differenza di /dipendenti, visibile anche a
  // project_manager): questo record — e quindi il form di modifica — esiste solo se
  // chi guarda è admin. Nessuna chiamata a getUserById per un PM: prenderebbe 403.
  const [user, setUser] = useState<UserSummary | null>(null);
  const isAdmin = getCurrentUser()?.role === 'admin';
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Chi vede questa pagina è già admin/PM (getUserTimeLogDetail è riservato a
  // PROJECT_MANAGER_ROLES): a differenza del profilo utente (solo admin), la
  // correzione di una registrazione ore è ammessa anche a un project_manager.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Quale gruppo (data+lavoro) mostra il dettaglio espanso con le singole
  // registrazioni. Chiave "data|taskId", coerente con groupTimeLogsByDayAndTask.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  async function load() {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getUserTimeLogDetail(id);
      setDetail(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore nel caricamento');
      setLoading(false);
      return;
    }
    if (isAdmin) {
      try {
        const userRes = await api.getUserById(id);
        setUser(userRes.user);
      } catch {
        // Non blocca la pagina: le ore restano comunque visibili, solo senza il form
        // di modifica (stesso principio già usato per kpiForbidden in CantiereDetailPage).
        setUser(null);
      }
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const cantieriDiversi = detail ? new Set(detail.timeLogs.map((t) => t.projectId)).size : 0;
  // Raggruppate per data+lavoro (vedi groupTimeLogs.ts): stesso giorno sullo stesso
  // cantiere/lavoro appaiono affiancate invece che su righe separate, richiesto
  // esplicitamente dall'utente (19/08) dopo la verifica visiva della dashboard.
  const groups = useMemo(() => groupTimeLogsByDayAndTask(detail?.timeLogs ?? []), [detail]);
  // Stessa forma già usata (fino a poco fa) nella dashboard: badge per tipo con le ore,
  // spostati qui su richiesta esplicita dell'utente ("come ore per tipo nel dashboard")
  // — lì era diventato rumore in una vista d'insieme, qui è esattamente il dettaglio
  // che serve per capire quante ore di straordinario/notturno/ferie/permesso ha fatto
  // UN dipendente, non solo il totale.
  const hoursByTipo: Record<TimeLogTipo, string> | null = detail
    ? {
        ordinario: detail.ordinary,
        straordinario: detail.straordinario,
        notturno: detail.notturno,
        festivo: detail.festivo,
        permesso: detail.permesso,
        ferie: detail.ferie,
      }
    : null;

  return (
    <div className="flex flex-col gap-6">
      <Link to="/dipendenti" className={`${LINK_DETTAGLIO} w-fit`}>
        <ArrowLeftIcon /> Dipendenti
      </Link>

      {error && (
        <div className={ALERT_ERRORE} role="alert">
          {error}
        </div>
      )}
      {loading && <p className="text-sm text-surface-500 dark:text-surface-400">Caricamento…</p>}

      {detail && (
        <>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="m-0 text-2xl font-semibold text-surface-900 dark:text-surface-100">{detail.userName}</h1>
              {user && <UserEditForm user={user} onSaved={load} />}
            </div>
            <p className="mt-1 flex items-center gap-1 text-sm text-surface-500 dark:text-surface-400">
              <MailIcon className="h-4 w-4" /> {detail.userEmail}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatTile
              icon={<ClockIcon className="h-4 w-4" />}
              label="Ore totali registrate"
              value={formatHours(detail.totalHours)}
            />
            <StatTile icon={<UsersIcon className="h-4 w-4" />} label="Cantieri diversi" value={cantieriDiversi} />
            <StatTile label="Registrazioni" value={detail.logCount} />
          </div>

          {hoursByTipo && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-surface-500 dark:text-surface-400">Ore per tipo:</span>
              {TIPI_ORDER.map((tipo) => (
                <span key={tipo} className={badgeClassForTipo(tipo)}>
                  {tipo} {formatHours(hoursByTipo[tipo])}h
                </span>
              ))}
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Cronologia ore</CardTitle>
            </CardHeader>
            <CardContent>
              {groups.length === 0 ? (
                <EmptyState title="Nessuna ora registrata" icon={<ClockIcon className="h-10 w-10" />} />
              ) : (
                <div className="overflow-x-auto rounded-xl border border-surface-200 bg-white dark:border-surface-700 dark:bg-surface-800">
                  <table className="w-full border-collapse text-sm">
                    <thead className="bg-surface-50 dark:bg-surface-900/50">
                      <tr className="border-b border-surface-200 text-left dark:border-surface-700">
                        <th className={INTESTAZIONE_COLONNA}>Data</th>
                        <th className={INTESTAZIONE_COLONNA}>Cantiere</th>
                        <th className={INTESTAZIONE_COLONNA}>Lavoro</th>
                        <th className={INTESTAZIONE_COLONNA}>Ore per tipo</th>
                        <th className={INTESTAZIONE_COLONNA}>Totale</th>
                        <th className="px-4 py-3 no-print" />
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((g) => {
                        const key = `${g.date}|${g.taskId}`;
                        const isExpanded = expandedKey === key;
                        return (
                          <Fragment key={key}>
                            <tr className={RIGA_TABELLA}>
                              <td className="px-4 py-3 text-surface-700 dark:text-surface-300">{formatDate(g.date)}</td>
                              <td className="px-4 py-3">
                                <Link
                                  to={`/cantieri/${g.projectId}`}
                                  className="font-medium text-primary-600 transition-colors hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
                                >
                                  {etichettaCantiere(g.code, g.projectNumber, g.tipoCommessa)} {g.projectName}
                                </Link>
                              </td>
                              <td className="px-4 py-3 text-surface-700 dark:text-surface-300">{g.taskTitle}</td>
                              <td className="px-4 py-3">
                                <div className="flex flex-wrap gap-1">
                                  {TIPI_ORDER.filter((tipo) => g.hoursByTipo[tipo]).map((tipo) => (
                                    <span key={tipo} className={badgeClassForTipo(tipo)}>
                                      {tipo} {formatHours(g.hoursByTipo[tipo]!)}h
                                    </span>
                                  ))}
                                </div>
                              </td>
                              <td className="px-4 py-3 font-medium text-surface-900 dark:text-surface-100">
                                {formatHours(g.totalHours)}
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
                                <td className="bg-surface-50 px-4 py-3 dark:bg-surface-900/50" colSpan={6}>
                                  <ul className="m-0 flex list-none flex-col gap-2 p-0">
                                    {g.entries.map((t) => (
                                      <li
                                        key={t.id}
                                        className="flex flex-col gap-1.5 rounded-lg border border-surface-200 bg-white p-3 dark:border-surface-700 dark:bg-surface-800"
                                      >
                                        <div className="flex items-center justify-between gap-2">
                                          <span className={badgeClassForTipo(t.tipo)}>{t.tipo}</span>
                                          <span className="font-medium text-surface-900 dark:text-surface-100">
                                            {formatHours(t.hoursWorked)}h
                                          </span>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setEditingId(editingId === t.id ? null : t.id)}
                                          >
                                            {editingId === t.id ? 'Chiudi' : 'Modifica'}
                                          </Button>
                                        </div>
                                        {t.workDescription && (
                                          <span className="text-sm text-surface-500 dark:text-surface-400">
                                            {t.workDescription}
                                          </span>
                                        )}
                                        {editingId === t.id && (
                                          <TimeLogEditForm
                                            timeLog={{ id: t.id, taskId: t.taskId, userId: detail.userId, tipo: t.tipo, hoursWorked: t.hoursWorked, date: t.date }}
                                            onSaved={() => {
                                              setEditingId(null);
                                              setExpandedKey(null);
                                              load();
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
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// Modifica di email/nome/ruolo/attivo — solo admin (vedi isAdmin sopra). Stessa
// disciplina "risincronizza sempre all'apertura/annullamento" già vista in questo
// progetto per TaskRow e ProjectEditForm: evita che "Annulla" non annulli davvero.
function UserEditForm({ user, onSaved }: { user: UserSummary; onSaved: () => void }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(user.email);
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState(user.role);
  const [active, setActive] = useState(user.active);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function syncAndToggle(next: boolean) {
    setEmail(user.email);
    setName(user.name);
    setRole(user.role);
    setActive(user.active);
    setError(null);
    setEditing(next);
  }

  async function save() {
    setError(null);
    setBusy(true);
    try {
      await api.updateUser(user.id, { email, name, role, active });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore nell'aggiornamento del dipendente");
    } finally {
      setBusy(false);
    }
  }

  // Distinta da "Attivo" sopra: quella sospende l'accesso mantenendo nome/email
  // (reversibile, es. aspettativa). Questa cancella davvero i dati personali
  // (anonimizzazione lato server) — non c'è modo di tornare indietro.
  async function removeForever() {
    const sure = confirm(
      `Rimuovere definitivamente ${user.name}?\n\n` +
        "Nome ed email verranno cancellati e sostituiti in modo permanente (l'account " +
        'diventerà "Utente rimosso"). Le ore già registrate restano nello storico in forma ' +
        'anonima, per gli obblighi contabili. Questa azione non si può annullare.',
    );
    if (!sure) return;
    setError(null);
    setBusy(true);
    try {
      await api.deleteUser(user.id);
      navigate('/dipendenti', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore nella rimozione del dipendente');
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => syncAndToggle(true)}>
        Modifica
      </Button>
    );
  }

  return (
    <div className="mt-4 flex w-full basis-full flex-col gap-3 border-t border-surface-200 pt-4 dark:border-surface-700">
      <h3 className="m-0 text-sm font-semibold text-surface-900 dark:text-surface-100">Modifica dipendente</h3>
      {error && (
        <div className={ALERT_ERRORE} role="alert">
          {error}
        </div>
      )}
      <Input id="dip-edit-nome" label="Nome" value={name} onChange={(e) => setName(e.target.value)} required />
      <Input
        id="dip-edit-email"
        label="Email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <Select
        id="dip-edit-ruolo"
        label="Ruolo"
        options={ROLE_OPTIONS}
        value={role}
        onChange={(e) => setRole(e.target.value as UserRole)}
      />
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
          className="h-4 w-4 rounded border-surface-300 text-primary-600 focus:ring-primary-500"
        />
        <span className="text-sm text-surface-600 dark:text-surface-400">Attivo</span>
      </label>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button type="button" variant="primary" loading={busy} onClick={save}>
            Salva
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => syncAndToggle(false)}>
            Annulla
          </Button>
        </div>
        <Button type="button" variant="danger" size="sm" disabled={busy} onClick={removeForever}>
          Rimuovi definitivamente
        </Button>
      </div>
    </div>
  );
}
