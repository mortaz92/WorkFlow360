import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, getCurrentUser } from '../lib/api';
import type { TimeLogTipo, UserRole, UserSummary, UserTimeLogDetail } from '../lib/types';
import { ArrowLeftIcon, ClockIcon, MailIcon, UsersIcon } from '../components/icons';
import { badgeClassForTipo, etichettaCantiere, formatDate, formatHours, TIPI_ORDER, USER_ROLE_LABELS } from '../lib/format';
import { groupTimeLogsByDayAndTask } from '../lib/groupTimeLogs';
import TimeLogEditForm from '../components/TimeLogEditForm';

const ROLES: UserRole[] = ['admin', 'project_manager', 'operaio'];

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
      <Link to="/dipendenti" className="list-link w-fit">
        <ArrowLeftIcon /> Dipendenti
      </Link>

      {error && <div className="alert">{error}</div>}
      {loading && <p className="muted">Caricamento…</p>}

      {detail && (
        <>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="m-0 text-2xl font-semibold text-gray-900">{detail.userName}</h1>
              {user && <UserEditForm user={user} onSaved={load} />}
            </div>
            <p className="mt-1 flex items-center gap-1 text-sm text-gray-500">
              <MailIcon className="h-4 w-4" /> {detail.userEmail}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="stat-tile">
              <span className="stat-label">
                <ClockIcon className="h-4 w-4" /> Ore totali registrate
              </span>
              <span className="stat-value">{formatHours(detail.totalHours)}</span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">
                <UsersIcon className="h-4 w-4" /> Cantieri diversi
              </span>
              <span className="stat-value">{cantieriDiversi}</span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">Registrazioni</span>
              <span className="stat-value">{detail.logCount}</span>
            </div>
          </div>

          {hoursByTipo && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-gray-500">Ore per tipo:</span>
              {TIPI_ORDER.map((tipo) => (
                <span key={tipo} className={badgeClassForTipo(tipo)}>
                  {tipo} {formatHours(hoursByTipo[tipo])}h
                </span>
              ))}
            </div>
          )}

          <section className="card">
            <h2>Cronologia ore</h2>
            {groups.length === 0 ? (
              <p className="muted">Nessuna ora registrata.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50 text-left">
                      <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Data</th>
                      <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Cantiere</th>
                      <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Lavoro</th>
                      <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Ore per tipo</th>
                      <th className="px-4 py-3 text-xs font-semibold tracking-wide text-gray-500 uppercase">Totale</th>
                      <th className="px-4 py-3 no-print" />
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => {
                      const key = `${g.date}|${g.taskId}`;
                      const isExpanded = expandedKey === key;
                      return (
                        <Fragment key={key}>
                          <tr className="border-b border-gray-200 last:border-none hover:bg-gray-50">
                            <td className="px-4 py-3 text-gray-700">{formatDate(g.date)}</td>
                            <td className="px-4 py-3">
                              <Link to={`/cantieri/${g.projectId}`} className="font-medium text-blue-600 hover:text-blue-700">
                                {etichettaCantiere(g.code, g.projectNumber, g.tipoCommessa)} {g.projectName}
                              </Link>
                            </td>
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
                            <td className="px-4 py-3 text-right no-print">
                              <button
                                type="button"
                                className="btn-ghost px-2"
                                onClick={() => setExpandedKey(isExpanded ? null : key)}
                              >
                                {isExpanded ? 'Chiudi' : g.entries.length > 1 ? `Dettaglio (${g.entries.length})` : 'Dettaglio'}
                              </button>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="border-b border-gray-200 last:border-none no-print">
                              <td className="bg-gray-50 px-4 py-3" colSpan={6}>
                                <ul className="flex flex-col gap-2">
                                  {g.entries.map((t) => (
                                    <li key={t.id} className="flex flex-col gap-1.5 rounded-md border border-gray-200 bg-white p-3">
                                      <div className="flex items-center justify-between gap-2">
                                        <span className={badgeClassForTipo(t.tipo)}>{t.tipo}</span>
                                        <span className="font-medium text-gray-900">{formatHours(t.hoursWorked)}h</span>
                                        <button
                                          type="button"
                                          className="btn-ghost px-2"
                                          onClick={() => setEditingId(editingId === t.id ? null : t.id)}
                                        >
                                          {editingId === t.id ? 'Chiudi' : 'Modifica'}
                                        </button>
                                      </div>
                                      {t.workDescription && <span className="muted text-sm">{t.workDescription}</span>}
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
          </section>
        </>
      )}
    </div>
  );
}

// Modifica di email/nome/ruolo/attivo — solo admin (vedi isAdmin sopra). Stessa
// disciplina "risincronizza sempre all'apertura/annullamento" già vista in questo
// progetto per TaskRow e ProjectEditForm: evita che "Annulla" non annulli davvero.
function UserEditForm({ user, onSaved }: { user: UserSummary; onSaved: () => void }) {
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

  if (!editing) {
    return (
      <button type="button" className="btn-ghost" onClick={() => syncAndToggle(true)}>
        Modifica
      </button>
    );
  }

  return (
    <div className="inline-form w-full basis-full">
      <h3>Modifica dipendente</h3>
      {error && <div className="alert">{error}</div>}
      <label htmlFor="dip-edit-nome">Nome</label>
      <input id="dip-edit-nome" className="field" value={name} onChange={(e) => setName(e.target.value)} required />
      <label htmlFor="dip-edit-email">Email</label>
      <input
        id="dip-edit-email"
        className="field"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <label htmlFor="dip-edit-ruolo">Ruolo</label>
      <select id="dip-edit-ruolo" className="field" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {USER_ROLE_LABELS[r]}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Attivo
      </label>
      <div className="flex gap-2">
        <button className="btn-primary" disabled={busy} type="button" onClick={save}>
          {busy ? '…' : 'Salva'}
        </button>
        <button className="btn-ghost" disabled={busy} type="button" onClick={() => syncAndToggle(false)}>
          Annulla
        </button>
      </div>
    </div>
  );
}
