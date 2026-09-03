import type { RapportinoSnapshot, SnapshotRiga } from '../../lib/types';
import { formatNumeroRapportino, formatOreDocumento, formatQuantita, TIPI_ORDER } from '../../lib/format';

// Il rapportino come FOGLIO, cioè come lo vede chi lo firma. Un solo componente per tutti
// i punti in cui il documento compare a schermo: la pagina di firma (schermo passato al
// cliente) e l'anteprima dell'operaio, che devono mostrare esattamente la stessa cosa —
// l'operaio non può controllare prima di far firmare se guarda una resa diversa.
//
// Non è un'astrazione preventiva: FirmaPage e PreparaRapportino contenevano la STESSA resa
// duplicata quasi carattere per carattere (elenco righe, badge del tipo, orario, materiali,
// totale per tipo), e le due copie avevano già iniziato a divergere (le note comparivano
// solo in FirmaPage).
//
// La resa segue il PDF (packages/backend/src/modules/rapportini/rapportino.pdf.ts): stesso
// ordine dei blocchi, stesse etichette, stesso formato di numeri e date. Il cliente firma
// su schermo e riceve il PDF via email: se i due non si somigliassero, non riconoscerebbe
// il documento che ha sottoscritto.

/** Dati della firma già apposta. Assenti in anteprima e prima della firma — non c'è un
 * "firmato: false", c'è l'assenza del dato, che è la stessa cosa che vale nel PDF. Il PNG
 * della firma NON arriva mai al frontend (GET /rapportini/:id non lo restituisce): qui si
 * mostrano nome, email e data, l'immagine sta solo nel PDF. */
interface FirmaFoglio {
  nome: string | null;
  email: string | null;
  /** ISO, come tutte le date che arrivano su HTTP. */
  firmatoIl: string | null;
}

interface FoglioRapportinoProps {
  snapshot: RapportinoSnapshot;
  /** `null` quando il documento non esiste ancora (anteprima): la casella N° mostra un
   * trattino. Mai un numero "previsto": è assegnato dal server alla creazione, e uno
   * indovinato qui sarebbe un dato inventato su un documento da firmare. */
  numero: number | null;
  firma?: FirmaFoglio;
}

// Nessuna variante `dark:` in tutto il file, ed è deliberato: questo blocco rappresenta
// CARTA. La cornice della pagina (header, form, bottoni) segue il tema scuro dell'app,
// il foglio no — stessa decisione già presa per il canvas della firma, che si disegna su
// bianco opaco. Al sole un foglio scuro è illeggibile e non somiglia al PDF che il cliente
// riceverà. Per questo ogni colore qui è scritto esplicito e non ereditato.
const CASELLA = 'rounded-lg border border-surface-300 px-3 py-2';
const ETICHETTA = 'block text-[10px] font-semibold uppercase tracking-wide text-surface-500';
const VALORE = 'block text-sm font-semibold text-surface-900';
const BANDA =
  'mt-4 flex items-center justify-between bg-surface-800 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-white';
// Testo secondario a surface-600 e non surface-500: su bianco fa 7,8:1 contro 4,7:1, e
// questo foglio si legge in cantiere, spesso in pieno sole.
const TESTO_SECONDARIO = 'text-surface-600';

// Riga obbligatoria, non decorativa: questo sistema non contiene tariffe né importi, e
// senza dirlo esplicitamente un cliente potrebbe leggere la propria firma come approvazione
// di una somma da pagare. Copia IDENTICA parola per parola di TESTO_LEGALE nel PDF
// (rapportino.pdf.ts): è un vincolo legale, non materiale da impaginazione, e le due copie
// devono restare uguali — il cliente firma questa e riceve quella.
const TESTO_LEGALE =
  'Il presente rapportino attesta esclusivamente QUANTITÀ (ore lavorate e materiali impiegati). ' +
  'Non contiene prezzi, tariffe né importi: la firma non costituisce approvazione di alcuna somma.';

// La fascia oraria compare solo per i tipi in cui "quando" cambia il significato delle ore.
// Per l'ordinario è rumore: è la norma. Copia dichiarata di TIPI_CON_FASCIA nel PDF.
const TIPI_CON_FASCIA = new Set(['straordinario', 'notturno', 'festivo']);

// gg/mm/aaaa come il PDF, non "02 set 2026" di formatDate: le due rese dello stesso giorno
// affiancate (elenco dell'app e documento) devono restare distinguibili a colpo d'occhio
// come "app" e "documento", ed è il documento a dover somigliare alla carta.
function formatDataDocumento(isoDate: string): string {
  const [anno, mese, giorno] = isoDate.split('-');
  return giorno && mese && anno ? `${giorno}/${mese}/${anno}` : isoDate;
}

function formatDataOraDocumento(iso: string): string {
  const valore = new Date(iso);
  if (Number.isNaN(valore.getTime())) return '—';
  const due = (n: number) => String(n).padStart(2, '0');
  return `${due(valore.getDate())}/${due(valore.getMonth() + 1)}/${valore.getFullYear()} ${due(valore.getHours())}:${due(valore.getMinutes())}`;
}

function etichettaCommessa(snapshot: RapportinoSnapshot): string {
  return snapshot.cantiere.code ?? `#${snapshot.cantiere.projectNumber}`;
}

function orarioRiga(riga: SnapshotRiga): string | null {
  if (!riga.oraInizio && !riga.oraFine) return null;
  return `${riga.oraInizio?.slice(0, 5) ?? ''}–${riga.oraFine?.slice(0, 5) ?? ''}`;
}

// Regola volutamente restrittiva, identica a quella del PDF: la fascia si mostra SOLO se
// esiste UNA SOLA riga di quel tipo e ha entrambi gli orari. Con due o più righe dello
// stesso tipo, min(inizio)–max(fine) non è la fascia lavorata — due turni separati
// diventerebbero un blocco continuo, cioè un'informazione falsa su un documento firmato.
function fasciaOraria(righe: SnapshotRiga[], tipo: string): string | null {
  if (!TIPI_CON_FASCIA.has(tipo)) return null;
  const delTipo = righe.filter((riga) => riga.tipo === tipo);
  if (delTipo.length !== 1) return null;
  const riga = delTipo[0];
  if (!riga.oraInizio || !riga.oraFine) return null;
  return `dalle ${riga.oraInizio.slice(0, 5)} alle ${riga.oraFine.slice(0, 5)}`;
}

// Ordine noto prima, poi gli sconosciuti in coda: un tipo che non è nell'elenco corrente
// (snapshot vecchio, enum cambiato nel frattempo) va comunque mostrato — un documento
// firmato non si riscrive per adeguarlo all'oggi.
function tipiOrdinati(perTipo: Record<string, string>): string[] {
  const presenti = Object.keys(perTipo);
  const ordine: string[] = TIPI_ORDER;
  const noti = ordine.filter((tipo) => presenti.includes(tipo));
  const ignoti = presenti.filter((tipo) => !ordine.includes(tipo)).sort();
  return [...noti, ...ignoti];
}

function noteDelDocumento(snapshot: RapportinoSnapshot): string[] {
  return snapshot.righe
    .filter((riga) => riga.note && riga.note.trim().length > 0)
    .map((riga) => `${riga.operaio.nome} — ${riga.note?.trim() ?? ''}`);
}

export default function FoglioRapportino({ snapshot, numero, firma }: FoglioRapportinoProps) {
  const { azienda, cantiere, totali, righe } = snapshot;
  const tipi = tipiOrdinati(totali.perTipo);
  const note = noteDelDocumento(snapshot);

  return (
    <article className="overflow-hidden rounded-xl border border-surface-200 bg-white text-surface-900 shadow-card">
      {/* Barra d'accento al posto del logo: lo slot per un marchio vero resta libero, ma
          `companies` non ha ancora un logo da mostrare e disegnarne uno somigliante
          sarebbe un marchio inventato. Stesso segno grafico della testata del PDF. */}
      <div className="h-1.5 w-full bg-surface-800" />

      <header className="flex items-start justify-between gap-3 px-4 pb-3 pt-4">
        <div className="min-w-0">
          <strong className="block text-lg font-bold leading-tight text-surface-900">{azienda.nome}</strong>
          {azienda.vat && <span className="block text-[11px] text-surface-500">P. IVA e C.F. {azienda.vat}</span>}
        </div>
        {/* Nascosti sotto i 640px: sono dati di identificazione dell'azienda, presenti per
            intero nel PDF che il cliente riceve — su un telefono stretto rubano spazio a
            ciò che il cliente deve davvero leggere prima di firmare. Ogni riga è OMESSA se
            il dato manca: "Tel. —" direbbe che l'azienda non ha telefono, che è diverso
            dal non averlo registrato. */}
        <div className="hidden shrink-0 text-right text-[11px] leading-4 text-surface-600 sm:block">
          {azienda.indirizzo && <span className="block">{azienda.indirizzo}</span>}
          {azienda.telefono && <span className="block">Tel. {azienda.telefono}</span>}
          {azienda.email && <span className="block">{azienda.email}</span>}
        </div>
      </header>

      <div className="border-y-2 border-surface-800 px-4 py-2">
        <h2 className="m-0 text-sm font-bold uppercase tracking-wider text-surface-900">Rapportino di lavoro</h2>
      </div>

      <div className="grid grid-cols-2 gap-2 px-4 pt-3 sm:grid-cols-3">
        <div className={CASELLA}>
          <span className={ETICHETTA}>Data</span>
          <span className={VALORE}>{formatDataDocumento(snapshot.date)}</span>
        </div>
        <div className={CASELLA}>
          <span className={ETICHETTA}>Commessa</span>
          <span className={VALORE}>{etichettaCommessa(snapshot)}</span>
        </div>
        {/* Il numero è l'unico elemento in rosso del foglio, ed è deliberato: è il numero
            pre-stampato del blocco a ricalco, quello con cui il cliente ritrova il
            rapportino. Occupa due colonne sul telefono perché è la casella più larga. */}
        <div className={`${CASELLA} col-span-2 sm:col-span-1`}>
          <span className={ETICHETTA}>{numero == null ? 'N° (assegnato alla conferma)' : 'N°'}</span>
          <span className="block text-base font-bold tabular-nums text-danger-700">
            {numero == null ? '—' : formatNumeroRapportino(numero)}
          </span>
        </div>
      </div>

      <div className="mx-4 mt-2 divide-y divide-surface-200 rounded-lg border border-surface-300">
        <div className="px-3 py-2">
          <span className={ETICHETTA}>Spett.le</span>
          <span className="block text-sm font-bold text-surface-900">{cantiere.clientName ?? '—'}</span>
        </div>
        <div className="px-3 py-2">
          <span className={ETICHETTA}>Cantiere</span>
          <span className="block text-sm text-surface-900">{cantiere.nome}</span>
        </div>
        {/* Quando l'indirizzo manca si mostra il trattino e NON il nome del cantiere: sono
            due informazioni diverse, e riempire il buco con l'altra le renderebbe
            indistinguibili. `?? '—'` copre anche l'`undefined` di uno snapshot v1, che la
            chiave non ce l'ha proprio. */}
        <div className="px-3 py-2">
          <span className={ETICHETTA}>Destinazione</span>
          <span className="block text-sm text-surface-900">{cantiere.indirizzo ?? '—'}</span>
        </div>
      </div>

      {/* Al posto delle caselle da spuntare del cartaceo: le spunte dicono sì/no perché la
          carta non sa contare, `perTipo` dice QUANTO. Stessa posizione, più informazione. */}
      <div className="mx-4 mt-2 rounded-lg border border-surface-200 bg-surface-50 px-3 py-2">
        <span className={ETICHETTA}>Riepilogo ore</span>
        {tipi.length === 0 ? (
          <span className={`block text-sm italic ${TESTO_SECONDARIO}`}>Nessuna ora registrata</span>
        ) : (
          tipi.map((tipo) => {
            const fascia = fasciaOraria(righe, tipo);
            return (
              <div key={tipo} className="py-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-bold uppercase tracking-wide text-surface-900">{tipo}</span>
                  <span className="text-sm font-bold tabular-nums text-surface-900">
                    {formatOreDocumento(totali.perTipo[tipo])}
                  </span>
                </div>
                {fascia && <span className={`block text-[11px] ${TESTO_SECONDARIO}`}>{fascia}</span>}
              </div>
            );
          })
        )}
      </div>

      <div className={BANDA}>
        <span>Lavoro eseguito</span>
        <span>Ore</span>
      </div>
      {/* Una lista di blocchi e non una tabella a quattro colonne: su 360px o si comprimono
          fino a essere illeggibili o introducono lo scorrimento orizzontale, e chi firma non
          si accorge di dover scorrere — firmerebbe senza aver visto una colonna. L'unica
          colonna che conta (le ore) resta a destra e a larghezza fissa, così i numeri
          restano incolonnati. Ordine dello snapshot, mai riordinato: l'ordine è parte di
          ciò che viene firmato. */}
      <div className="divide-y divide-surface-200">
        {righe.map((riga) => {
          const orario = orarioRiga(riga);
          return (
            <div key={riga.timeLogId} className="flex gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <span className="text-sm font-semibold leading-snug text-surface-900">{riga.lavoro.titolo}</span>
                {/* Il tipo si segnala solo quando NON è ordinario: l'ordinario è la norma,
                    e marcarlo riempirebbe la colonna di etichette che non distinguono nulla. */}
                {riga.tipo !== 'ordinario' && (
                  <span className="ml-2 inline-flex rounded bg-surface-200 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-surface-700">
                    {riga.tipo}
                  </span>
                )}
                <span className={`mt-0.5 block text-xs ${TESTO_SECONDARIO}`}>
                  {riga.operaio.nome}
                  {orario ? ` · ${orario}` : ''}
                </span>
                {/* Mai troncata: una descrizione tagliata su un documento firmato è una
                    promessa di contenuto che il cliente non ha visto. */}
                {riga.descrizioneLavoro && (
                  <span className={`mt-1 block text-sm leading-snug ${TESTO_SECONDARIO}`}>{riga.descrizioneLavoro}</span>
                )}
              </div>
              <span className="w-14 shrink-0 text-right text-base font-bold tabular-nums text-surface-900">
                {formatOreDocumento(riga.ore)}
              </span>
            </div>
          );
        })}
      </div>

      {/* TOTALE ORE subito sotto le righe di lavoro, come nel PDF, e non in fondo al foglio:
          è la chiusura dell'elenco firmato: ciò che viene dopo (materiali, note) è un'altra
          cosa e il totale non deve sembrare comprenderla. */}
      <div className="flex items-center justify-between border-t-2 border-surface-800 bg-surface-100 px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-surface-600">Totale ore</span>
        <span className="text-2xl font-bold tabular-nums text-surface-900">
          {formatOreDocumento(totali.oreTotali)}
        </span>
      </div>

      {/* Banda mostrata anche senza materiali: dice che la voce è stata verificata, non
          dimenticata. Il "nessun materiale" è un'informazione, l'assenza della banda no. */}
      <div className={BANDA}>
        <span>Materiali</span>
      </div>
      <div className="divide-y divide-surface-200">
        {totali.materiali.length === 0 ? (
          <p className={`m-0 px-4 py-2.5 text-sm italic ${TESTO_SECONDARIO}`}>Nessun materiale impiegato</p>
        ) : (
          totali.materiali.map((materiale) => (
            // Chiave su nome+unità+codice: è la stessa chiave con cui il backend aggrega i
            // materiali, quindi due voci non possono collidere qui se non collidono là.
            <div
              key={`${materiale.nome}-${materiale.unita}-${materiale.codice ?? ''}`}
              className="flex gap-3 px-4 py-2.5 text-sm"
            >
              {/* formatQuantita e non il valore grezzo: le ore qui sopra passano tutte da
                  formatOreDocumento, e due numeri sullo stesso foglio non possono essere
                  scritti in due modi diversi — "12.5" metri sotto "7,5" ore. Stessa resa
                  del PDF, che per le quantità usa formatQuantitaIt. */}
              <span className="w-20 shrink-0 font-semibold tabular-nums text-surface-900">
                {formatQuantita(materiale.quantita)} {materiale.unita}
              </span>
              <span className="min-w-0 flex-1 text-surface-900">{materiale.nome}</span>
              {/* Il codice si mostra solo dove c'è. A differenza del PDF non serve decidere
                  "colonna sì/colonna no" una volta per documento: qui non c'è una colonna
                  che resti vuota e faccia sembrare perso il dato nelle altre righe. */}
              {materiale.codice && (
                <span className={`shrink-0 text-right text-xs ${TESTO_SECONDARIO}`}>{materiale.codice}</span>
              )}
            </div>
          ))
        )}
      </div>

      {/* Nessuna banda vuota: una sezione NOTE senza note fa sembrare il modulo incompleto. */}
      {note.length > 0 && (
        <>
          <div className={BANDA}>
            <span>Note</span>
          </div>
          <div className="px-4 py-3 text-sm text-surface-900">
            {note.map((riga) => (
              <span key={riga} className="block">
                {riga}
              </span>
            ))}
          </div>
        </>
      )}

      <p className="m-0 border-t border-surface-200 px-4 py-3 text-[11px] italic leading-4 text-surface-500">
        {TESTO_LEGALE}
      </p>

      <div className="grid grid-cols-1 gap-4 border-t border-surface-200 px-4 py-3 sm:grid-cols-2">
        <div>
          <span className={ETICHETTA}>Preparato da</span>
          <span className="block text-sm font-bold text-surface-900">{snapshot.preparatoDa.nome}</span>
          <span className={`block text-xs ${TESTO_SECONDARIO}`}>
            il {formatDataOraDocumento(snapshot.preparatoIl)}
          </span>
        </div>
        <div>
          <span className={ETICHETTA}>Firma del cliente</span>
          {firma ? (
            <>
              <span className="block text-sm font-bold text-surface-900">{firma.nome ?? '—'}</span>
              {firma.email && <span className={`block text-xs ${TESTO_SECONDARIO}`}>{firma.email}</span>}
              {firma.firmatoIl && (
                <span className={`block text-xs ${TESTO_SECONDARIO}`}>
                  Firmato il {formatDataOraDocumento(firma.firmatoIl)}
                </span>
              )}
            </>
          ) : (
            <span className="mt-1 block rounded-lg border border-dashed border-warning-200 bg-warning-50 px-3 py-2 text-xs font-bold uppercase tracking-wide text-warning-700">
              In attesa di firma
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
