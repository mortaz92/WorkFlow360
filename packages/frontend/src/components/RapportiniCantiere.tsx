import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { RapportinoListItem } from '../lib/types';
import {
  formatDate,
  formatHours,
  formatNumeroRapportino,
  RAPPORTINO_STATUS_BADGE_VARIANT,
  RAPPORTINO_STATUS_LABELS,
} from '../lib/format';
import { DocumentIcon } from './icons';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Textarea } from './ui';

const PAGE_SIZE = 20;

// Classi ricorrenti, già usate identiche in RegistroCantiere/CantiereDetailPage: restano
// duplicate qui finché non ci sarà un modulo condiviso per gli stili di pagina.
const ALERT_ERRORE =
  'rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm font-medium text-danger-600 dark:border-danger-800 dark:bg-danger-900/30 dark:text-danger-400';

const TESTO_ATTENUATO = 'text-sm text-surface-500 dark:text-surface-400';

const ELENCO = 'm-0 flex list-none flex-col gap-2 p-0';

const RIGA_ELENCO =
  'rounded-lg border border-surface-200 bg-white p-3 dark:border-surface-700 dark:bg-surface-800';

// Elenco rapportini: di UN cantiere quando il chiamante passa projectId (CantiereDetailPage),
// di TUTTA l'azienda quando lo omette (ReportPage — stesso componente, stesso backend:
// GET /rapportini senza filtro projectId restituisce già solo i rapportini dell'azienda
// del token, mai di un'altra). Azioni: riaprire il PDF, rimandare l'email, annullare uno
// non ancora firmato, sbloccare (solo admin, motivo obbligatorio) uno già firmato. Solo
// admin/PM arrivano fin qui — stesso gate (kpiForbidden) già applicato dal chiamante a
// RegistroCantiere, o il gate di ruolo sulla voce "Report" in AppLayout.
export default function RapportiniCantiere({ projectId, isAdmin }: { projectId?: string; isAdmin: boolean }) {
  const [rapportini, setRapportini] = useState<RapportinoListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Un solo bottone "in corso" alla volta, identificato dall'id della riga: evita che due
  // azioni sulla stessa lista si sovrappongano in modo confuso.
  const [busyId, setBusyId] = useState<string | null>(null);

  const [sbloccaId, setSbloccaId] = useState<string | null>(null);
  const [sbloccaReason, setSbloccaReason] = useState('');
  const [sbloccaError, setSbloccaError] = useState<string | null>(null);

  const [annullaId, setAnnullaId] = useState<string | null>(null);
  const [annullaReason, setAnnullaReason] = useState('');
  const [annullaError, setAnnullaError] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  async function load(targetPage: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listRapportini(targetPage, PAGE_SIZE, { projectId });
      setRapportini(res.rapportini);
      setTotal(res.total);
      setPage(res.page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore nel caricamento dei rapportini');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Scaricata come blob (serve l'header Authorization, non è un URL statico apribile con
  // un semplice link): un <a download> sintetico, non window.open — l'attivazione utente
  // del click è già scaduta quando fetch+blob finiscono, e Safari/Firefox bloccherebbero
  // un popup aperto lì, IN SILENZIO (downloadRapportinoPdf non lancia, quindi nessun
  // errore da mostrare: l'apertura semplicemente non succedeva). Nome file generico
  // (rapportino-{id}.pdf): il Content-Disposition col nome vero lo imposta il backend, ma
  // un fetch con header Authorization non lo passa al browser come farebbe un link diretto.
  // Revoca ritardata: il download resta asincrono un istante dopo il click.
  async function apriPdf(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const blob = await api.downloadRapportinoPdf(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rapportino-${id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore nell'apertura del PDF");
    } finally {
      setBusyId(null);
    }
  }

  async function rimandaEmail(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const esito = await api.reinviaEmailRapportino(id);
      if (!esito.emailInviata) {
        setError(`Invio non riuscito verso ${esito.destinatario}.`);
      }
      await load(page);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore nel reinvio dell'email");
    } finally {
      setBusyId(null);
    }
  }

  // Pannello inline invece del semplice confirm() di prima: aprirlo (un clic) e poi
  // confermarlo (un secondo clic su "Conferma annullamento") è già la stessa deliberazione
  // in due passi che dava confirm(), con in più il motivo per l'audit (cancelReason,
  // facoltativo qui — a differenza di quello obbligatorio dello sblocco: annullare un
  // rapportino mai firmato è un'azione ordinaria, non un intervento su un documento
  // sottoscritto).
  function apriAnnulla(id: string) {
    setAnnullaId(id);
    setAnnullaReason('');
    setAnnullaError(null);
  }

  async function confermaAnnulla() {
    if (!annullaId) return;
    setBusyId(annullaId);
    setAnnullaError(null);
    try {
      await api.annullaRapportino(annullaId, annullaReason.trim() || undefined);
      setAnnullaId(null);
      await load(page);
    } catch (err) {
      setAnnullaError(err instanceof Error ? err.message : "Errore nell'annullamento del rapportino");
    } finally {
      setBusyId(null);
    }
  }

  function apriSblocca(id: string) {
    setSbloccaId(id);
    setSbloccaReason('');
    setSbloccaError(null);
  }

  async function confermaSblocca() {
    if (!sbloccaId) return;
    const reason = sbloccaReason.trim();
    if (!reason) return setSbloccaError('Il motivo è obbligatorio per sbloccare un rapportino firmato');
    setBusyId(sbloccaId);
    setSbloccaError(null);
    try {
      await api.sbloccaRapportino(sbloccaId, reason);
      setSbloccaId(null);
      await load(page);
    } catch (err) {
      setSbloccaError(err instanceof Error ? err.message : 'Errore nello sblocco del rapportino');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className="break-inside-avoid">
      <CardHeader>
        <CardTitle>Rapportini</CardTitle>
      </CardHeader>
      <CardContent>
        {error && (
          <div className={ALERT_ERRORE} role="alert">
            {error}
          </div>
        )}
        {loading && <p className={TESTO_ATTENUATO}>Caricamento…</p>}
        {!loading && rapportini.length === 0 && (
          <EmptyState title="Nessun rapportino ancora" icon={<DocumentIcon className="h-10 w-10" />} />
        )}
        {rapportini.length > 0 && (
          <ul className={ELENCO}>
            {rapportini.map((r) => (
              <li key={r.id} className={RIGA_ELENCO}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {/* Il numero PRIMA della data, in font-mono: è l'identificativo con cui
                        il cliente chiama il documento al telefono ("il rapportino 08380"),
                        e in un elenco di più rapportini della stessa giornata è l'unica
                        cosa che li distingue. */}
                    <span className="font-mono text-sm text-surface-500 dark:text-surface-400">
                      {formatNumeroRapportino(r.numero)}
                    </span>
                    <span className="font-medium text-surface-900 dark:text-surface-100">{formatDate(r.date)}</span>
                    <Badge variant={RAPPORTINO_STATUS_BADGE_VARIANT[r.status]}>{RAPPORTINO_STATUS_LABELS[r.status]}</Badge>
                  </div>
                  <span className="text-sm font-semibold text-surface-700 dark:text-surface-300">
                    {formatHours(r.totalHours)}h
                  </span>
                </div>
                {(r.signerName || r.emailSentAt || r.unlockedAt || (r.status === 'firmato' && !r.emailSentAt)) && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-surface-500 dark:text-surface-400">
                    {r.signerName && (
                      <span>
                        Firmato da {r.signerName}
                        {r.signedAt ? ` il ${formatDate(r.signedAt)}` : ''}
                      </span>
                    )}
                    {r.emailSentAt && <span>· Email inviata il {formatDate(r.emailSentAt)}</span>}
                    {/* emailSentAt viene valorizzato dal backend SOLO se l'invio è davvero
                        riuscito: un rapportino firmato senza è indistinguibile, per chi
                        guarda, da "non ancora controllato" — invece qui l'invio è già
                        fallito, e la copia per il cliente non è mai partita. */}
                    {r.status === 'firmato' && !r.emailSentAt && (
                      <span className="text-danger-600 dark:text-danger-400">· Copia NON recapitata al cliente</span>
                    )}
                    {r.unlockedAt && <span>· Sbloccato il {formatDate(r.unlockedAt)}</span>}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" loading={busyId === r.id} onClick={() => apriPdf(r.id)}>
                    Apri PDF
                  </Button>
                  {r.status === 'firmato' && (
                    <Button variant="secondary" size="sm" loading={busyId === r.id} onClick={() => rimandaEmail(r.id)}>
                      Rimanda email
                    </Button>
                  )}
                  {/* Anche per "scaduto": è lo stato PRESENTATO di un rapportino la cui
                      colonna resta 'in_firma' oltre la scadenza (vedi statoPresentato nel
                      backend) — il link non è più firmabile da nessuno, ma le ore restano
                      bloccate finché qualcuno non lo annulla esplicitamente da qui. */}
                  {(r.status === 'in_firma' || r.status === 'scaduto') && (
                    <Button variant="danger" size="sm" loading={busyId === r.id} onClick={() => apriAnnulla(r.id)}>
                      Annulla
                    </Button>
                  )}
                  {isAdmin && r.status === 'firmato' && (
                    <Button variant="ghost" size="sm" onClick={() => apriSblocca(r.id)}>
                      Sblocca
                    </Button>
                  )}
                </div>
                {annullaId === r.id && (
                  <div className="mt-3 flex flex-col gap-2 border-t border-surface-200 pt-3 dark:border-surface-700">
                    {annullaError && (
                      <div className={ALERT_ERRORE} role="alert">
                        {annullaError}
                      </div>
                    )}
                    <p className={TESTO_ATTENUATO}>
                      Il rapportino non è stato firmato dal cliente: annullandolo, le ore di questo giorno tornano
                      modificabili.
                    </p>
                    <Textarea
                      id={`annulla-motivo-${r.id}`}
                      label="Motivo dell'annullamento (facoltativo)"
                      value={annullaReason}
                      onChange={(e) => setAnnullaReason(e.target.value)}
                      rows={2}
                    />
                    <div className="flex gap-2">
                      <Button variant="danger" size="sm" loading={busyId === r.id} onClick={confermaAnnulla}>
                        Conferma annullamento
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busyId === r.id} onClick={() => setAnnullaId(null)}>
                        Annulla
                      </Button>
                    </div>
                  </div>
                )}
                {sbloccaId === r.id && (
                  <div className="mt-3 flex flex-col gap-2 border-t border-surface-200 pt-3 dark:border-surface-700">
                    {sbloccaError && (
                      <div className={ALERT_ERRORE} role="alert">
                        {sbloccaError}
                      </div>
                    )}
                    <Textarea
                      id={`sblocca-motivo-${r.id}`}
                      label="Motivo dello sblocco (obbligatorio)"
                      value={sbloccaReason}
                      onChange={(e) => setSbloccaReason(e.target.value)}
                      rows={2}
                      required
                    />
                    <div className="flex gap-2">
                      <Button variant="primary" size="sm" loading={busyId === r.id} onClick={confermaSblocca}>
                        Conferma sblocco
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busyId === r.id} onClick={() => setSbloccaId(null)}>
                        Annulla
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-surface-200 pt-4 dark:border-surface-700">
            <Button variant="secondary" size="sm" disabled={page <= 1 || loading} onClick={() => load(page - 1)}>
              ← Precedente
            </Button>
            <span className={TESTO_ATTENUATO}>
              Pagina {page} di {totalPages} · {total} rapportini totali
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
