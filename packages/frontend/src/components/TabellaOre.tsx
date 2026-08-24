import type { ReactNode } from 'react';
import type { HoursByProjectRow, HoursByUserRow, ProjectEmployeeRow } from '../lib/types';
import { formatHours } from '../lib/format';
import { ClockIcon } from './icons';
import { Card, CardContent, CardHeader, CardTitle, EmptyState, Table, type Column } from './ui';

// Le tre forme di riga accettate condividono gli stessi 6 campi di scomposizione per
// tipo + totalHours + logCount, e differiscono solo nel campo "nome" (risolto da
// getName, non hardcoded qui).
type RigaOre = HoursByProjectRow | HoursByUserRow | ProjectEmployeeRow;

const TIPI_ORA: { key: keyof HoursByProjectRow; label: string }[] = [
  { key: 'ordinary', label: 'Ord.' },
  { key: 'straordinario', label: 'Straord.' },
  { key: 'notturno', label: 'Nott.' },
  { key: 'festivo', label: 'Fest.' },
  { key: 'permesso', label: 'Perm.' },
  { key: 'ferie', label: 'Ferie' },
];

// Chiave React presa dall'identità della riga (cantiere o utente) e non dall'indice: le
// tre forme non hanno un campo id con lo stesso nome, quindi vanno distinte qui — la
// firma di keyExtractor riceve solo la riga, non la sua posizione.
function chiaveRiga(r: RigaOre): string {
  return 'projectId' in r ? r.projectId : r.userId;
}

// Il colore attenuato va sullo <span> interno e non sulla cella: la <td> del componente
// Table porta già un text-* proprio, e due utility dello stesso tipo sullo stesso
// elemento si contendono la precedenza in base all'ordine del CSS generato.
function ValoreSecondario({ children }: { children: ReactNode }) {
  return <span className="text-surface-600 dark:text-surface-400">{children}</span>;
}

// Tabella riepilogo ore con scomposizione per tipo (ordinario/straordinario/notturno/
// festivo/permesso/ferie) + totale + numero registrazioni. Estratta da ReportPage
// (era "TotaleTable", locale a quel file) perché la stessa forma di riga serve anche al
// dettaglio cantiere (ore per dipendente, ProjectEmployeeRow) — terzo uso reale, soglia
// per condividerla (coding-standards.md, DRY).
export default function TabellaOre<T extends RigaOre>({
  title,
  rows,
  getName,
}: {
  title: string;
  rows: T[];
  getName: (r: T) => string;
}) {
  const colonne: Column<T>[] = [
    {
      key: 'nome',
      header: 'Nome',
      className: 'font-medium',
      render: (r) => getName(r),
    },
    {
      key: 'totale',
      header: 'Tot. h',
      className: 'font-semibold',
      render: (r) => formatHours(r.totalHours),
    },
    ...TIPI_ORA.map(
      (t): Column<T> => ({
        key: t.key,
        header: t.label,
        render: (r) => <ValoreSecondario>{formatHours((r as HoursByProjectRow)[t.key] as string)}</ValoreSecondario>,
      }),
    ),
    {
      key: 'registrazioni',
      header: 'Reg.',
      render: (r) => <ValoreSecondario>{r.logCount}</ValoreSecondario>,
    },
  ];

  // break-inside-avoid: la vecchia classe .card portava con sé una regola @media print
  // che impediva a una tabella di spezzarsi a metà tra due pagine. Report e Archivio si
  // stampano davvero ("Stampa / Scarica PDF"), quindi quel comportamento va conservato
  // esplicitamente ora che la card è un componente e non più quella classe.
  return (
    <Card className="break-inside-avoid">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState title="Nessun dato" icon={<ClockIcon className="h-10 w-10" />} />
        ) : (
          <Table columns={colonne} data={rows} keyExtractor={chiaveRiga} caption={title} />
        )}
      </CardContent>
    </Card>
  );
}
