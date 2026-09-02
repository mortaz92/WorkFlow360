import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { PublicRapportino, TimeLogTipo } from '../lib/types';
import { badgeClassForTipo, formatDate, formatHours, RAPPORTINO_STATUS_LABELS } from '../lib/format';
import { ArrowLeftIcon, CheckCircleIcon } from '../components/icons';
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '../components/ui';

// Classi ricorrenti, scritte una volta sola invece di ripeterle — stessi valori già
// usati in OperaioPage: le due pagine restano visivamente coerenti anche se il cliente
// vede questa subito dopo aver visto l'operaio usare l'altra sullo stesso telefono.
const ALERT_ERRORE =
  'rounded-lg border border-danger-200 bg-danger-50 px-3 py-2.5 text-sm font-medium text-danger-600 dark:border-danger-800 dark:bg-danger-900/30 dark:text-danger-400';

const TESTO_ATTENUATO = 'text-sm text-surface-500 dark:text-surface-400';

const ELENCO = 'm-0 flex list-none flex-col gap-2 p-0';

const RIGA_ELENCO =
  'rounded-lg border border-surface-200 bg-white p-3 dark:border-surface-700 dark:bg-surface-800';

const ETICHETTA_CAMPO = 'block text-sm font-medium text-surface-700 dark:text-surface-300';

// Altezza fissa del riquadro firma in pixel CSS: ragionevole per un pollice su
// smartphone, indipendente dalla larghezza (che invece segue il contenitore).
const CANVAS_HEIGHT = 200;

interface SigningState {
  signingToken?: string;
  expiresAt?: string;
  /** Passato insieme a signingToken alla creazione (vedi PreparaRapportino), non riletto
   * qui: la firma usa `id` da useParams, già uguale a questo valore per costruzione. */
  rapportinoId?: string;
  /** Dove tornare dopo la firma o l'annullamento: '/operaio' se ha preparato il
   * rapportino un operaio, '/rapportini' se admin/PM dalla pagina "Rapportini clienti",
   * '/cantieri/{id}' se admin/PM da CantiereDetailPage. Assente su link aperti senza
   * questo state (vecchi bookmark) — fallback a '/operaio'. */
  returnTo?: string;
}

export default function FirmaPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  // Restituito UNA SOLA VOLTA da POST /rapportini, mai recuperabile dopo (in database
  // esiste solo il suo hash): se manca — pagina ricaricata, tasto indietro, link aperto a
  // mano — non c'è alcun modo di "ritrovarlo", per design. Vedi vincolo architetturale
  // nel piano della feature.
  const signingToken = (location.state as SigningState | null)?.signingToken;
  const returnTo = (location.state as SigningState | null)?.returnTo ?? '/operaio';
  // Il testo del bottone deve dire dove si torna davvero, non sempre "alla registrazione
  // ore": le destinazioni oggi sono '/operaio', '/rapportini' e '/cantieri/{id}'.
  const returnLabel =
    returnTo === '/operaio'
      ? 'Torna alla registrazione ore'
      : returnTo === '/rapportini'
        ? 'Torna ai rapportini'
        : 'Torna al cantiere';

  const [rapportino, setRapportino] = useState<PublicRapportino | null>(null);
  const [loadingRapportino, setLoadingRapportino] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [firmatarioNome, setFirmatarioNome] = useState('');
  const [firmatarioEmail, setFirmatarioEmail] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [signEsito, setSignEsito] = useState<{ emailInviata: boolean } | null>(null);

  const [annullaError, setAnnullaError] = useState<string | null>(null);
  const [annullando, setAnnullando] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasSizeRef = useRef({ width: 0, height: CANVAS_HEIGHT });
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [hasSignature, setHasSignature] = useState(false);

  // L'anteprima (nome cantiere, righe, totali) viene sempre da GET /rapportini/:id,
  // autenticato: funziona perché l'operaio ha ancora la sua sessione attiva su questo
  // stesso dispositivo — il cliente non si logga mai, non gli serve per vedere qui sopra.
  useEffect(() => {
    if (!id) return;
    setLoadingRapportino(true);
    setLoadError(null);
    api
      .getRapportino(id)
      .then((res) => setRapportino(res.rapportino))
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Errore nel caricamento del rapportino'))
      .finally(() => setLoadingRapportino(false));
  }, [id]);

  // Il riquadro di firma prende dimensione solo una volta che il contenitore ha una
  // larghezza reale (dopo il caricamento del rapportino, quando la pagina ha finito di
  // ricomporsi) — prima sarebbe 0 e il canvas risulterebbe invisibile.
  useEffect(() => {
    if (!rapportino || signEsito) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    function ridimensiona() {
      if (!canvas || !container) return;
      const width = container.clientWidth;
      const height = CANVAS_HEIGHT;
      canvasSizeRef.current = { width, height };
      // Tetto a 2x: il backend rifiuta un PNG di firma oltre 2000×1000px (validaFirmaPng
      // nel service), e su uno schermo ad alta densità (devicePixelRatio 3 o più, comune
      // su smartphone recenti) un riquadro largo quanto lo schermo avrebbe superato quel
      // limite proprio mentre il cliente ha il dito sopra — 2x resta ben oltre la
      // risoluzione utile per un tratto di penna in un PDF.
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(ratio, ratio);
      // Sfondo bianco esplicito, indipendente dal tema chiaro/scuro dell'app: è un
      // riquadro "carta", non un componente del design system — e canvas.toDataURL
      // esporterebbe altrimenti uno sfondo trasparente, poco leggibile una volta stampato
      // nel PDF che arriva al cliente via email.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#1e293b';
    }

    ridimensiona();

    // Ruotare il telefono a firma già iniziata cambia la larghezza del contenitore:
    // impostare canvas.width/height per riadattarsi azzera SEMPRE il contenuto disegnato
    // (comportamento nativo del canvas, non un bug di questo codice). Senza avvisare,
    // l'operaio o il cliente vedrebbero il bottone "Firma e invia copia" ancora abilitato
    // e finirebbero per inviare un PNG bianco senza accorgersene — da qui il reset di
    // hasSignature e l'avviso.
    let primaConsegna = true;
    const observer = new ResizeObserver(() => {
      if (primaConsegna) {
        // ResizeObserver consegna sempre una prima notifica per la dimensione iniziale,
        // appena osservato: non è una rotazione, va ignorata o l'avviso comparirebbe
        // anche quando la firma non è mai stata toccata.
        primaConsegna = false;
        return;
      }
      ridimensiona();
      setHasSignature(false);
      setFormError('Lo schermo è cambiato dimensione: la firma è stata cancellata, rifalla.');
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [rapportino, signEsito]);

  function getPoint(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    // Un palmo appoggiato o un secondo dito mentre si firma genera un pointer non
    // primario: seguirlo sovrascriverebbe lastPointRef e produrrebbe una riga retta
    // indesiderata in mezzo alla firma vera.
    if (!e.isPrimary) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    const point = getPoint(e);
    lastPointRef.current = point;

    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) {
      // Un tocco singolo (giù/su senza trascinamento, es. un puntino di firma) non passa
      // mai da handlePointerMove: senza disegnare qui, il bottone di invio resterebbe
      // disabilitato senza che nessuno capisca perché. ctx.fillStyle è rimasto '#ffffff'
      // dall'inizializzazione dello sfondo, quindi si usa strokeStyle (il colore del
      // tratto) — un fill naive disegnerebbe bianco su bianco, invisibile.
      ctx.save();
      ctx.fillStyle = ctx.strokeStyle as string;
      ctx.beginPath();
      ctx.arc(point.x, point.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    setHasSignature(true);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!e.isPrimary) return;
    if (!drawingRef.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    const last = lastPointRef.current;
    const point = getPoint(e);
    if (ctx && last) {
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      setHasSignature(true);
    }
    lastPointRef.current = point;
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!e.isPrimary) return;
    drawingRef.current = false;
    lastPointRef.current = null;
  }

  function clearSignature() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { width, height } = canvasSizeRef.current;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    setHasSignature(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!signingToken || !id) return;
    const trimmedNome = firmatarioNome.trim();
    const trimmedEmail = firmatarioEmail.trim();
    if (!trimmedNome) return setFormError('Inserisci il nome di chi firma');
    if (!trimmedEmail) return setFormError("Inserisci l'email a cui inviare la copia");
    if (!hasSignature) return setFormError('Serve la firma nel riquadro qui sopra');
    const canvas = canvasRef.current;
    if (!canvas) return;

    setSubmitting(true);
    try {
      // rapportinoId (= id dell'URL) inoltrato insieme al token: il backend verifica che
      // combacino, chiudendo lo scarto tra l'anteprima mostrata qui (letta dall'id) e il
      // rapportino che il token firma davvero (vedi commento su firmaRapportino in api.ts).
      const esito = await api.firmaRapportino(
        signingToken,
        trimmedNome,
        trimmedEmail,
        canvas.toDataURL('image/png'),
        id,
      );
      setSignEsito(esito);
    } catch (err) {
      // Il backend risponde sempre con lo stesso messaggio generico per token
      // invalido/scaduto/già usato (sicurezza voluta, non un bug): mostrato così com'è,
      // senza provare a distinguere i casi che il server stesso non distingue.
      setFormError(err instanceof ApiError ? err.message : 'Errore durante l\'invio della firma. Riprova.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAnnulla() {
    if (!id) return;
    // Testo neutro rispetto al contesto: questa funzione è richiamata sia dalla schermata
    // normale (il cliente è lì e rifiuta di firmare) sia da quella di sessione persa (il
    // token non c'è più) — in entrambi i casi il cliente non ha firmato, ed è l'unico
    // fatto che il messaggio deve affermare.
    const confermato = confirm('Annullare questo rapportino? Il cliente non ha firmato.');
    if (!confermato) return;
    setAnnullaError(null);
    setAnnullando(true);
    try {
      // Motivo fisso per l'audit (cancelReason nel backend): qui non c'è un pannello per
      // scriverlo a mano, a differenza di RapportiniCantiere (uso admin/PM).
      await api.annullaRapportino(id, 'Il cliente non ha firmato');
      navigate(returnTo, { replace: true, state: { rapportinoAnnullato: true } });
    } catch (err) {
      setAnnullaError(err instanceof Error ? err.message : "Errore nell'annullamento del rapportino");
      setAnnullando(false);
    }
  }

  // Nessun modo di "recuperare" il token: non esiste per design (il DB ha solo l'hash).
  // L'unica via d'uscita reale è annullare questo rapportino (sotto) — un nuovo tentativo
  // di prepararne uno sullo stesso cantiere/giorno verrebbe altrimenti rifiutato dal
  // backend (indice UNIQUE) finché quello vecchio resta in attesa di firma, per tutta la
  // durata di RAPPORTINO_SIGN_EXPIRES_IN (15 minuti di default).
  if (!signingToken) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-50 p-4 dark:bg-surface-950">
        <Card variant="elevated" className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Sessione di firma non più disponibile</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className={TESTO_ATTENUATO}>
              Questa pagina si può aprire solo subito dopo aver preparato il rapportino, dallo stesso telefono. Se
              l'hai ricaricata o sei tornato indietro, il link di firma non è più utilizzabile: annulla questo
              rapportino qui sotto per poterne preparare subito uno nuovo, sullo stesso cantiere e la stessa data.
            </p>
            {annullaError && (
              <div className={ALERT_ERRORE} role="alert">
                {annullaError}
              </div>
            )}
            <Button variant="danger" size="lg" fullWidth loading={annullando} onClick={handleAnnulla}>
              Annulla questo rapportino e ricomincia
            </Button>
            <Button
              variant="secondary"
              size="lg"
              fullWidth
              disabled={annullando}
              onClick={() => navigate(returnTo, { replace: true })}
            >
              {returnLabel}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (signEsito) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-50 p-4 dark:bg-surface-950">
        <Card variant="elevated" className="w-full max-w-md">
          <CardContent className="flex flex-col items-center gap-4 py-6 text-center">
            <CheckCircleIcon className="h-12 w-12 text-success-600 dark:text-success-400" />
            <h1 className="m-0 text-xl font-semibold text-surface-900 dark:text-surface-100">Firma registrata</h1>
            {signEsito.emailInviata ? (
              <p className={TESTO_ATTENUATO}>Copia inviata a {firmatarioEmail.trim()}.</p>
            ) : (
              <div className={ALERT_ERRORE} role="alert">
                Firma registrata, ma l'invio della copia via email non è riuscito — l'azienda potrà comunque
                recuperare il PDF.
              </div>
            )}
            <Button variant="primary" size="lg" fullWidth onClick={() => navigate(returnTo, { replace: true })}>
              {returnLabel}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-50 dark:bg-surface-950">
      {/* Nessuna sidebar né header dell'app: schermo intero pensato per essere messo in
          mano al cliente, che non deve vedere alcuna traccia di navigazione interna. */}
      <header className="sticky top-0 z-10 border-b border-surface-200 bg-white px-4 py-3 dark:border-surface-700 dark:bg-surface-900">
        <strong className="text-lg font-semibold text-surface-900 dark:text-white">Firma del rapportino</strong>
      </header>

      <main className="mx-auto flex max-w-xl flex-col gap-4 p-4">
        {loadError && (
          <div className={ALERT_ERRORE} role="alert">
            {loadError}
          </div>
        )}
        {loadingRapportino && <p className={TESTO_ATTENUATO}>Caricamento…</p>}

        {rapportino && (
          <>
            {rapportino.status !== 'in_firma' && (
              <div className={ALERT_ERRORE} role="alert">
                Questo rapportino non è più in attesa di firma (stato: {RAPPORTINO_STATUS_LABELS[rapportino.status]}).
              </div>
            )}

            <Card>
              <CardHeader>
                <CardTitle>
                  {rapportino.snapshot.cantiere.nome}
                  {rapportino.snapshot.cantiere.clientName ? ` · ${rapportino.snapshot.cantiere.clientName}` : ''}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <span className={TESTO_ATTENUATO}>{formatDate(rapportino.snapshot.date)}</span>

                <ul className={ELENCO}>
                  {rapportino.snapshot.righe.map((riga) => (
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
                      {riga.note && <span className={TESTO_ATTENUATO}>Note: {riga.note}</span>}
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
                    Totale {formatHours(rapportino.snapshot.totali.oreTotali)}h
                  </span>
                  {Object.entries(rapportino.snapshot.totali.perTipo).map(([tipo, ore]) => (
                    <span key={tipo} className={badgeClassForTipo(tipo as TimeLogTipo)}>
                      {tipo} {formatHours(ore)}h
                    </span>
                  ))}
                </div>
                {rapportino.snapshot.totali.materiali.length > 0 && (
                  <p className={TESTO_ATTENUATO}>
                    Materiali:{' '}
                    {rapportino.snapshot.totali.materiali.map((m) => `${m.nome} ${m.quantita}${m.unita}`).join(', ')}
                  </p>
                )}
              </CardContent>
            </Card>

            {rapportino.status === 'in_firma' && (
              <Card>
                <CardHeader>
                  <CardTitle>Firma del cliente</CardTitle>
                </CardHeader>
                <CardContent>
                  {formError && (
                    <div className={`${ALERT_ERRORE} mb-4`} role="alert">
                      {formError}
                    </div>
                  )}
                  <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
                    {/* autoComplete="off" su entrambi: lo stesso telefono (dell'operaio) fa
                        firmare clienti diversi più volte nella giornata — senza, il browser
                        proporrebbe in autocompletamento nome/email del cliente PRECEDENTE,
                        un dato personale di terzi mostrato a un altro terzo. */}
                    <Input
                      id="firma-nome"
                      label="Nome di chi firma"
                      size="lg"
                      placeholder="Nome e cognome"
                      autoComplete="off"
                      value={firmatarioNome}
                      onChange={(e) => setFirmatarioNome(e.target.value)}
                      required
                    />
                    <Input
                      id="firma-email"
                      label="Email (per ricevere la copia firmata)"
                      type="email"
                      size="lg"
                      placeholder="nome@esempio.it"
                      autoComplete="off"
                      value={firmatarioEmail}
                      onChange={(e) => setFirmatarioEmail(e.target.value)}
                      required
                    />

                    <div className="flex flex-col gap-2">
                      <span className={ETICHETTA_CAMPO}>Firma</span>
                      <div ref={containerRef} className="w-full">
                        <canvas
                          ref={canvasRef}
                          className="w-full touch-none rounded-lg border border-surface-300 dark:border-surface-600"
                          onPointerDown={handlePointerDown}
                          onPointerMove={handlePointerMove}
                          onPointerUp={handlePointerUp}
                          onPointerLeave={handlePointerUp}
                          onPointerCancel={handlePointerUp}
                          aria-label="Riquadro per la firma col dito o con lo stilo"
                        />
                      </div>
                      <Button type="button" variant="ghost" onClick={clearSignature} disabled={!hasSignature}>
                        Cancella firma
                      </Button>
                    </div>

                    <div className="flex flex-col gap-2">
                      <Button
                        type="submit"
                        variant="primary"
                        size="lg"
                        fullWidth
                        loading={submitting}
                        disabled={!hasSignature || annullando || submitting}
                      >
                        Firma e invia copia
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        size="lg"
                        fullWidth
                        loading={annullando}
                        disabled={submitting}
                        onClick={handleAnnulla}
                        leftIcon={<ArrowLeftIcon className="h-4 w-4" />}
                      >
                        Il cliente non firma
                      </Button>
                      {annullaError && (
                        <div className={ALERT_ERRORE} role="alert">
                          {annullaError}
                        </div>
                      )}
                    </div>
                  </form>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </main>
    </div>
  );
}
