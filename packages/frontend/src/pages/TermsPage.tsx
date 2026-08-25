import { Link } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui';
import { BuildingIcon } from '../components/icons';

// Stessa logica di bozza-non-validata di PrivacyPage.tsx — vedi il commento lì per il
// perché. Duplicato deliberatamente invece di condiviso: due pagine non giustificano
// ancora un'astrazione comune (soglia del progetto: almeno 3 casi reali).
const BOZZA_NON_VALIDATA = true;

function Placeholder({ children }: { children: string }) {
  return (
    <span className="rounded bg-warning-100 px-1.5 py-0.5 font-mono text-sm font-semibold text-warning-800 dark:bg-warning-900/40 dark:text-warning-300">
      [DA COMPLETARE: {children}]
    </span>
  );
}

export default function TermsPage() {
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
            <CardTitle className="text-2xl">Termini di servizio</CardTitle>
            <CardDescription>Ultimo aggiornamento: <Placeholder>data di pubblicazione</Placeholder></CardDescription>
          </CardHeader>

          <CardContent className="flex flex-col gap-6 text-sm leading-relaxed text-surface-700 dark:text-surface-300">
            {BOZZA_NON_VALIDATA && (
              <div
                className="rounded-lg border border-warning-300 bg-warning-50 px-4 py-3 text-sm font-medium text-warning-800 dark:border-warning-700 dark:bg-warning-900/30 dark:text-warning-200"
                role="alert"
              >
                <strong>Bozza non ancora validata.</strong> Testo scritto per colmare l'assenza totale di
                termini di servizio. Va fatto rivedere da un avvocato prima di essere usato con clienti reali,
                specialmente le clausole di responsabilità e di cessazione del servizio.
              </div>
            )}

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">1. Oggetto</h2>
              <p>
                Questi termini regolano l'uso di WorkFlow360, un software per la gestione di cantieri, personale
                e ore lavorate, fornito da <Placeholder>ragione sociale del fornitore</Placeholder> ("il
                Fornitore") all'azienda cliente ("il Cliente") che vi ha registrato un account.
              </p>
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">2. Account e responsabilità del Cliente</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>Gli account utente sono creati e gestiti dal Cliente tramite i propri amministratori.</li>
                <li>Il Cliente è responsabile della veridicità dei dati inseriti (ore lavorate, anagrafica dei dipendenti) e di informare i propri dipendenti sul trattamento dei loro dati secondo l'informativa privacy applicabile.</li>
                <li>Il Cliente è responsabile della custodia delle credenziali dei propri utenti e deve comunicare tempestivamente al Fornitore ogni sospetto accesso non autorizzato.</li>
                <li>Ogni account amministratore può gestire al massimo <Placeholder>verificare il numero attuale nel prodotto</Placeholder> account con permessi di amministrazione.</li>
              </ul>
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">3. Licenza d'uso</h2>
              <p>
                Il Fornitore concede al Cliente una licenza non esclusiva, non trasferibile, limitata alla
                durata del rapporto contrattuale, per l'utilizzo del software secondo le finalità previste.
                Il Cliente non può cedere l'accesso a terzi non autorizzati né tentare di decompilare o
                ottenere il codice sorgente del software.
              </p>
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">4. Disponibilità del servizio</h2>
              <p>
                Il Fornitore si impegna a mantenere il servizio disponibile con la massima diligenza, ma non
                garantisce un livello di servizio (SLA) formale in questa fase del prodotto —
                <Placeholder>definire un SLA se e quando il prodotto viene venduto commercialmente</Placeholder>.
                Interruzioni programmate per manutenzione saranno comunicate quando possibile con ragionevole
                anticipo.
              </p>
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">5. Dati e backup</h2>
              <p>
                Il Fornitore adotta misure ragionevoli per la protezione e la conservazione dei dati inseriti
                dal Cliente, inclusi backup <Placeholder>indicare la frequenza reale dei backup attivi al momento della firma</Placeholder>.
                Il Cliente è invitato a valutare, in base alla criticità dei propri dati, l'adeguatezza del
                piano di backup in uso.
              </p>
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">6. Limitazione di responsabilità</h2>
              <p>
                Salvo quanto diversamente previsto da norme inderogabili di legge, il Fornitore non è
                responsabile per danni indiretti, perdita di profitto o di dati derivanti dall'uso o
                dall'impossibilità di uso del servizio, nei limiti massimi consentiti dalla legge applicabile.
                <Placeholder>far verificare questa clausola a un avvocato — la limitazione di responsabilità
                ha regole specifiche e non può escludere colpa grave o dolo</Placeholder>
              </p>
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">7. Sospensione e cessazione</h2>
              <p>
                Il Fornitore può sospendere l'accesso in caso di mancato pagamento (quando applicabile) o di
                uso del servizio in violazione di questi termini o della legge. Alla cessazione del rapporto,
                il Cliente può richiedere l'esportazione dei propri dati entro <Placeholder>definire il
                periodo di grazia per l'esportazione dati, es. 30 giorni</Placeholder> dalla cessazione, dopo
                il quale i dati potranno essere cancellati.
              </p>
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">8. Modifiche ai termini</h2>
              <p>
                Il Fornitore può aggiornare questi termini; le modifiche sostanziali saranno comunicate al
                Cliente con ragionevole anticipo prima dell'entrata in vigore.
              </p>
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">9. Legge applicabile e foro competente</h2>
              <p>
                Questi termini sono regolati dalla legge italiana. Per ogni controversia è competente il Foro
                di <Placeholder>città del foro competente</Placeholder>, salvo diversa inderogabile disposizione
                di legge (es. foro del consumatore, se applicabile).
              </p>
            </section>

            <section>
              <h2 className="mb-2 text-base font-semibold text-surface-900 dark:text-surface-100">10. Contatti</h2>
              <p>Per domande su questi termini: <Placeholder>contatto del Fornitore</Placeholder>.</p>
            </section>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
