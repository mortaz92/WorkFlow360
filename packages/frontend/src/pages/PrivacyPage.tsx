import { Link } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui';
import { BuildingIcon } from '../components/icons';

// BOZZA scritta per colmare un vuoto reale (nessuna informativa esisteva), non un testo
// legale finito: i placeholder [DA COMPLETARE] sono dati che nessuno ha mai fornito
// (ragione sociale, indirizzo, DPO) e vanno riempiti PRIMA della pubblicazione. L'intero
// documento va fatto rivedere da un avvocato/consulente privacy prima di andare online:
// gestendo ore lavorate di dipendenti, un'informativa sbagliata è un rischio concreto,
// non burocratico. Il banner sotto resta finché qualcuno non lo toglie deliberatamente
// dopo la revisione — meglio un avviso di troppo che un testo non validato spacciato per definitivo.
const BOZZA_NON_VALIDATA = true;

function Placeholder({ children }: { children: string }) {
  return (
    <span className="rounded bg-warning-100 px-1.5 py-0.5 font-mono text-sm font-semibold text-warning-800 dark:bg-warning-900/40 dark:text-warning-300">
      [DA COMPLETARE: {children}]
    </span>
  );
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-surface-50 p-4 py-10 dark:bg-surface-950">
      <div className="mx-auto max-w-3xl">
        <Link
          to="/login"
          className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
        >
          <BuildingIcon className="h-4 w-4" /> WorkFlow360
        </Link>

        <Card variant="elevated">
          <CardHeader>
            <CardTitle className="text-2xl">Informativa sulla privacy</CardTitle>
            <CardDescription>Ultimo aggiornamento: <Placeholder>data di pubblicazione</Placeholder></CardDescription>
          </CardHeader>

          <CardContent className="flex flex-col gap-6 text-sm leading-relaxed text-surface-700 dark:text-surface-300">
            {BOZZA_NON_VALIDATA && (
              <div
                className="rounded-lg border border-warning-300 bg-warning-50 px-4 py-3 text-sm font-medium text-warning-800 dark:border-warning-700 dark:bg-warning-900/30 dark:text-warning-200"
                role="alert"
              >
                <strong>Bozza non ancora validata.</strong> Questo testo è un punto di partenza scritto per
                colmare l'assenza totale di un'informativa privacy. Prima di pubblicarlo o di usarlo con
                clienti reali va fatto rivedere da un avvocato o consulente privacy, che deve anche verificare
                se il tracciamento delle ore lavorate per cantiere richiede un accordo sindacale o
                l'autorizzazione dell'Ispettorato del Lavoro ai sensi dell'art. 4 dello Statuto dei Lavoratori
                — una questione distinta da questa informativa, che questo testo da solo non risolve.
              </div>
            )}

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">1. Titolare del trattamento</h2>
              <p>
                Il titolare del trattamento dei dati dei dipendenti è l'azienda cliente che utilizza WorkFlow360
                per gestire i propri cantieri e il proprio personale — non il fornitore del software. Per
                l'azienda che ti ha dato accesso a questo sistema:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>Ragione sociale: <Placeholder>ragione sociale dell'azienda cliente</Placeholder></li>
                <li>Sede legale: <Placeholder>indirizzo</Placeholder></li>
                <li>Partita IVA / Codice Fiscale: <Placeholder>P.IVA</Placeholder></li>
                <li>Contatto per esercitare i diritti privacy: <Placeholder>email o riferimento</Placeholder></li>
              </ul>
              <p className="mt-2">
                Chi fornisce e ospita il software (<Placeholder>ragione sociale del fornitore, se diversa dall'azienda cliente</Placeholder>)
                agisce come responsabile del trattamento per conto dell'azienda cliente, secondo un accordo
                separato (art. 28 GDPR) — <Placeholder>collegamento all'accordo, se esiste</Placeholder>.
              </p>
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">2. Quali dati raccogliamo</h2>
              <p>Per il funzionamento del sistema trattiamo questi dati, e solo questi:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>Dati identificativi: nome, indirizzo email aziendale, ruolo (amministratore, capocantiere/project manager, operaio).</li>
                <li>Dati di lavoro: ore lavorate, cantiere e task associati, tipo di ora (ordinaria, straordinaria, notturna, festiva, permesso, ferie), eventuali correzioni con chi le ha effettuate e quando.</li>
                <li>Dati tecnici di accesso: data e ora di login, indirizzo IP al momento dell'accesso (per la sicurezza dell'account, non per il monitoraggio dell'attività).</li>
                <li>Password: mai conservata in chiaro, solo in forma crittograficamente non reversibile (hash).</li>
              </ul>
              <p className="mt-2">Non raccogliamo geolocalizzazione GPS, foto, dati biometrici o contenuti di comunicazioni private.</p>
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">3. Perché li trattiamo</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>Gestione del rapporto di lavoro e calcolo delle ore lavorate — base giuridica: esecuzione del contratto di lavoro e obblighi di legge (adempimenti contabili e retributivi).</li>
                <li>Sicurezza dell'accesso al sistema (prevenzione di accessi non autorizzati) — base giuridica: legittimo interesse.</li>
                <li>Eventuali comunicazioni relative al servizio (es. email di reimpostazione password) — base giuridica: esecuzione del contratto.</li>
              </ul>
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">4. Per quanto tempo li conserviamo</h2>
              <p>
                I dati restano nel sistema per la durata del rapporto di lavoro e per il periodo successivo
                richiesto dagli obblighi contabili, fiscali e retributivi (in Italia, tipicamente fino a 10 anni
                per i documenti amministrativo-contabili — <Placeholder>verificare il periodo esatto con un consulente del lavoro/commercialista</Placeholder>).
                Alla cessazione del rapporto, su richiesta, i dati identificativi possono essere resi anonimi
                mantenendo le sole ore lavorate in forma aggregata, necessarie per la contabilità (vedi punto 6).
              </p>
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">5. Con chi condividiamo i dati</h2>
              <p>I dati non vengono venduti né ceduti a terzi per scopi commerciali. Sono trattati da:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li><strong>Render</strong> (Render Services, Inc.) — ospita il database e il server dell'applicazione.</li>
                <li><strong>Resend</strong> — invia le email di reimpostazione password, quando richieste.</li>
                <li><Placeholder>eventuali altri fornitori tecnici in uso</Placeholder></li>
              </ul>
              <p className="mt-2">
                Se questi fornitori trattano dati fuori dallo Spazio Economico Europeo, il trasferimento deve
                avvenire con garanzie adeguate (es. clausole contrattuali standard) — <Placeholder>verificare la
                regione dei server usata per questo deployment specifico e le garanzie contrattuali dei fornitori</Placeholder>.
              </p>
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">6. I tuoi diritti</h2>
              <p>In qualsiasi momento puoi chiedere al titolare del trattamento (punto 1) di:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>Accedere ai tuoi dati e ottenerne una copia.</li>
                <li>Correggere dati inesatti o incompleti.</li>
                <li>Ottenere la cancellazione dei tuoi dati identificativi (nome ed email vengono resi anonimi; le ore lavorate restano in forma anonima per gli obblighi di legge di cui al punto 4).</li>
                <li>Opporti al trattamento o richiederne la limitazione, nei casi previsti dalla legge.</li>
                <li>Ricevere i tuoi dati in un formato strutturato (portabilità).</li>
                <li>Proporre reclamo al Garante per la protezione dei dati personali (<a href="https://www.garanteprivacy.it" className="text-primary-600 underline dark:text-primary-400">garanteprivacy.it</a>).</li>
              </ul>
              <p className="mt-2">Per esercitare questi diritti, scrivi a: <Placeholder>contatto privacy</Placeholder>.</p>
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">7. Sicurezza</h2>
              <p>
                Le password sono protette con hashing crittografico, le connessioni al sistema avvengono in
                HTTPS e l'accesso ai dati è limitato agli utenti autorizzati della tua azienda. Ogni modifica
                significativa ai dati (es. correzioni di ore) è tracciata con data, autore e contenuto della
                modifica.
              </p>
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">8. Modifiche a questa informativa</h2>
              <p>
                Questa informativa può essere aggiornata; la data in cima al documento indica l'ultima
                revisione. In caso di modifiche sostanziali, l'azienda cliente ne darà comunicazione ai propri
                dipendenti.
              </p>
            </section>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
