import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { Project, RapportinoSnapshot, TimeLogTipo } from '../lib/types';
import { badgeClassForTipo, etichettaCantiere, formatDate, formatHours } from '../lib/format';
import { DocumentIcon } from './icons';
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Input, Select, type SelectOption } from './ui';

// Stesse classi ricorrenti già duplicate in OperaioPage/FirmaPage/RapportiniCantiere:
// restano duplicate qui finché non ci sarà un modulo condiviso per gli stili di pagina
// (stesso commento, identico, già presente in RapportiniCantiere.tsx).
const ALERT_ERRORE =
  'rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm font-medium text-danger-600 dark:border-danger-800 dark:bg-danger-900/30 dark:text-danger-400';

const TESTO_ATTENUATO = 'text-sm text-surface-500 dark:text-surface-400';

const ELENCO = 'm-0 flex list-none flex-col gap-2 p-0';

const RIGA_ELENCO =
  'rounded-lg border border-surface-200 bg-white p-3 transition-shadow hover:shadow-card dark:border-surface-700 dark:bg-surface-800';

// Data in fuso LOCALE, non UTC (stessa ragione di isoDate in OperaioPage.tsx:
// toISOString() sposterebbe il giorno tra mezzanotte e le 1-2 di notte in Italia).
function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface PreparaRapportinoProps {
  /** Cantiere fisso: quando presente niente tendina di selezione (uso in
   * CantiereDetailPage, dove il cantiere è già noto dal contesto della pagina). */
  projectId?: string;
  /** Cantieri tra cui scegliere quando `projectId` è assente (uso in OperaioPage, dove
   * l'operaio sceglie tra più cantieri a consuntivo). Ignorato se `projectId` è presente. */
  projects?: Project[];
  /** Dove tornare da FirmaPage dopo la firma o l'annullamento (navigate state.returnTo). */
  returnTo: string;
}

// Prepara un rapportino (anteprima + creazione) e apre subito la pagina di firma sullo
// stesso dispositivo. Condiviso tra OperaioPage (operaio, cantiere a scelta) e
// CantiereDetailPage (admin/PM, cantiere già noto dal contesto): unico punto che chiama
// GET /rapportini/anteprima e POST /rapportini, invece di due copie che potrebbero divergere.
export default function PreparaRapportino({ projectId, projects, returnTo }: PreparaRapportinoProps) {
  const navigate = useNavigate();
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [date, setDate] = useState(isoDate(new Date()));
  const [preview, setPreview] = useState<RapportinoSnapshot | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const effectiveProjectId = projectId ?? selectedProjectId;
  const projectOptions: SelectOption[] = (projects ?? []).map((p) => ({
    value: p.id,
    label: `${etichettaCantiere(p.code, p.projectNumber, p.tipoCommessa)} · ${p.name}`,
  }));

  // Seleziona il primo cantiere disponibile appena la lista arriva, solo in modalità
  // tendina (projectId assente). Tocca la selezione solo se vuota: non deve scavalcare
  // una scelta già fatta da chi usa la pagina.
  useEffect(() => {
    if (!projectId && !selectedProjectId && projects?.[0]) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projectId, projects, selectedProjectId]);

  // Anteprima automatica al cambio di cantiere/data: GET /rapportini/anteprima non salva
  // nulla, è sicuro richiamarla ad ogni cambio.
  useEffect(() => {
    if (!effectiveProjectId || !date) return;
    let cancelled = false;
    setPreviewLoading(true);
    setError(null);
    api
      .previewRapportino(effectiveProjectId, date)
      .then((res) => {
        if (!cancelled) setPreview(res.anteprima);
      })
      .catch((err) => {
        if (cancelled) return;
        setPreview(null);
        setError(err instanceof Error ? err.message : "Errore nel caricamento dell'anteprima");
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveProjectId, date]);

  // Crea il rapportino e porta subito alla schermata di firma, passando il token SOLO in
  // memoria (state della navigazione): è l'unica volta in cui il backend lo restituisce
  // (vedi commento su CreatedRapportino in lib/types.ts) — mai in localStorage o nell'URL.
  // rapportinoId viaggia nello stesso state, insieme a returnTo: FirmaPage lo userà per
  // sapere dove tornare dopo la firma/l'annullamento, indipendentemente da chi l'ha aperta.
  async function prepareRapportino() {
    if (!effectiveProjectId) return;
    setError(null);
    setCreating(true);
    try {
      const { rapportino, signingToken, expiresAt } = await api.createRapportino({
        projectId: effectiveProjectId,
        date,
      });
      navigate(`/firma/${rapportino.id}`, {
        state: { signingToken, expiresAt, rapportinoId: rapportino.id, returnTo },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Errore nella preparazione del rapportino');
    } finally {
      setCreating(false);
    }
  }

  if (!projectId && (projects ?? []).length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Prepara il rapportino</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState title="Nessun cantiere a consuntivo" icon={<DocumentIcon className="h-10 w-10" />} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Prepara il rapportino</CardTitle>
      </CardHeader>
      <CardContent>
        {error && (
          <div className={`${ALERT_ERRORE} mb-4`} role="alert">
            {error}
          </div>
        )}
        <div className="flex flex-col gap-4">
          {!projectId && (
            <Select
              id="rap-cantiere"
              label="Cantiere"
              size="lg"
              options={projectOptions}
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              required
            />
          )}
          <Input
            id="rap-data"
            label="Data"
            size="lg"
            type="date"
            className="dark:[color-scheme:dark]"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />

          {previewLoading && <p className={TESTO_ATTENUATO}>Caricamento anteprima…</p>}

          {!previewLoading && preview && (
            <div className="flex flex-col gap-3 rounded-lg border border-surface-200 bg-surface-50 p-3 dark:border-surface-700 dark:bg-surface-900/50">
              <div className="flex items-center justify-between gap-2">
                <strong className="text-surface-900 dark:text-surface-100">{preview.cantiere.nome}</strong>
                <span className={TESTO_ATTENUATO}>{formatDate(preview.date)}</span>
              </div>

              {preview.righe.length === 0 ? (
                <p className={TESTO_ATTENUATO}>
                  Nessuna ora registrata su questo cantiere in questa data: non c'è ancora niente da far firmare.
                </p>
              ) : (
                <>
                  <ul className={ELENCO}>
                    {preview.righe.map((riga) => (
                      <li key={riga.timeLogId} className={`${RIGA_ELENCO} flex flex-col gap-1`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-surface-900 dark:text-surface-100">
                            {riga.operaio.nome} · {riga.lavoro.titolo}
                          </span>
                          <span className={badgeClassForTipo(riga.tipo as TimeLogTipo)}>
                            {riga.tipo} {formatHours(riga.ore)}h
                          </span>
                        </div>
                        {(riga.oraInizio || riga.oraFine) && (
                          <span className={TESTO_ATTENUATO}>
                            {riga.oraInizio ? `dalle ${riga.oraInizio.slice(0, 5)}` : ''}
                            {riga.oraFine ? ` alle ${riga.oraFine.slice(0, 5)}` : ''}
                          </span>
                        )}
                        {riga.descrizioneLavoro && <span className={TESTO_ATTENUATO}>{riga.descrizioneLavoro}</span>}
                        {riga.materiali.length > 0 && (
                          <span className={TESTO_ATTENUATO}>
                            {riga.materiali.map((m) => `${m.nome} ${m.quantita}${m.unita}`).join(', ')}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>

                  <div className="flex flex-wrap items-center gap-2 border-t border-surface-200 pt-3 dark:border-surface-700">
                    <span className="text-sm font-semibold text-surface-900 dark:text-surface-100">
                      Totale {formatHours(preview.totali.oreTotali)}h
                    </span>
                    {Object.entries(preview.totali.perTipo).map(([tipo, ore]) => (
                      <span key={tipo} className={badgeClassForTipo(tipo as TimeLogTipo)}>
                        {tipo} {formatHours(ore)}h
                      </span>
                    ))}
                  </div>
                  {preview.totali.materiali.length > 0 && (
                    <p className={TESTO_ATTENUATO}>
                      Materiali: {preview.totali.materiali.map((m) => `${m.nome} ${m.quantita}${m.unita}`).join(', ')}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          <Button
            type="button"
            variant="primary"
            size="lg"
            fullWidth
            loading={creating}
            disabled={previewLoading || !preview || preview.righe.length === 0}
            onClick={prepareRapportino}
          >
            Prepara e fai firmare al cliente
          </Button>
          <p className={TESTO_ATTENUATO}>
            Dopo aver premuto il pulsante passa il telefono al cliente: la pagina di firma si apre subito, qui,
            sullo stesso dispositivo — al cliente non arriva nessun link.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
