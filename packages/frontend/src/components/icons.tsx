// Icone SVG minime, disegnate a mano con forme geometriche di base (non copiate da una
// libreria): l'app usa 8-10 icone in tutto, importare una libreria intera (es.
// lucide-react, ~200kb) per così poche non è giustificato (vedi coding-standards.md,
// "nessuna nuova dipendenza senza motivazione esplicita"). Tutte ereditano il colore dal
// testo (stroke="currentColor") e la dimensione dalla classe passata (default 20x20).

interface IconProps {
  className?: string;
}

const BASE_PROPS = {
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function CalendarIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <rect x="3" y="4" width="14" height="13" rx="1.5" />
      <line x1="3" y1="8" x2="17" y2="8" />
      <line x1="6.5" y1="2.5" x2="6.5" y2="5.5" />
      <line x1="13.5" y1="2.5" x2="13.5" y2="5.5" />
    </svg>
  );
}

export function UsersIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <circle cx="7.5" cy="7" r="2.5" />
      <path d="M3 16c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" />
      <circle cx="14" cy="7.5" r="2" />
      <path d="M12.5 9.2c2 .2 3.5 1.6 3.5 3.8" />
    </svg>
  );
}

export function PackageIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <path d="M10 2.5 17 6v8l-7 3.5L3 14V6l7-3.5Z" />
      <path d="M3 6l7 3.5L17 6" />
      <line x1="10" y1="9.5" x2="10" y2="17.5" />
    </svg>
  );
}

export function ClockIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="7" />
      <line x1="10" y1="6" x2="10" y2="10" />
      <line x1="10" y1="10" x2="13" y2="12" />
    </svg>
  );
}

export function ArrowRightIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <line x1="3" y1="10" x2="16" y2="10" />
      <path d="M11 5l5.5 5-5.5 5" />
    </svg>
  );
}

export function ArrowLeftIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <line x1="17" y1="10" x2="4" y2="10" />
      <path d="M9 5L3.5 10 9 15" />
    </svg>
  );
}

export function PrinterIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <rect x="5" y="2.5" width="10" height="5" />
      <rect x="2.5" y="7.5" width="15" height="7" rx="1" />
      <rect x="5" y="11.5" width="10" height="6" />
    </svg>
  );
}

export function CheckCircleIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M6.7 10.2l2.2 2.2 4.4-4.8" />
    </svg>
  );
}

export function MailIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <rect x="2.5" y="4.5" width="15" height="11" rx="1.5" />
      <path d="M3 5.5l7 5.5 7-5.5" />
    </svg>
  );
}

export function AlertCircleIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" />
      <line x1="10" y1="6.5" x2="10" y2="10.5" />
      <circle cx="10" cy="13.3" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function HomeIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <path d="M3 9.5 10 3.5l7 6v6.5a1 1 0 0 1-1 1h-3.5v-5h-5v5H4a1 1 0 0 1-1-1V9.5Z" />
    </svg>
  );
}

// Sagoma a tetto spiovente asimmetrico + gancio: riconoscibile come gru da
// cantiere anche a 20px, disegnata prendendo come riferimento visivo
// un'immagine generata con Higgsfield (richiesta dell'utente 10/08), poi
// semplificata togliendo il traliccio a X (illeggibile a icona piccola).
export function CraneIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <path d="M10 3L17 6.5M10 3L4.5 5.5M10 4V17M6.5 17H13.5" />
      <line x1="14" y1="6.2" x2="14" y2="9" />
      <circle cx="14" cy="9.6" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function DocumentIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <path d="M5.5 2.5h6l3 3v11.5a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-13.5a1 1 0 0 1 1-1Z" />
      <path d="M11.5 2.5v3h3" />
      <line x1="7" y1="10.5" x2="13" y2="10.5" />
      <line x1="7" y1="13.5" x2="13" y2="13.5" />
    </svg>
  );
}

export function GearIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 3.3v2M10 14.7v2M16.7 10h-2M5.3 10h-2M14.7 5.3l-1.4 1.4M6.7 13.3l-1.4 1.4M14.7 14.7l-1.4-1.4M6.7 6.7 5.3 5.3" />
    </svg>
  );
}

export function LogoutIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <path d="M8 17H4.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1H8" />
      <path d="M13 14l4-4-4-4" />
      <line x1="17" y1="10" x2="7.5" y2="10" />
    </svg>
  );
}

export function SearchIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.5" />
      <line x1="16.5" y1="16.5" x2="12.6" y2="12.6" />
    </svg>
  );
}

export function BellIcon({ className = 'h-5 w-5' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <path d="M5 8.5a5 5 0 0 1 10 0c0 3.5 1.2 4.8 1.5 5.5H3.5C3.8 13.3 5 12 5 8.5Z" />
      <path d="M8.2 16.5a1.8 1.8 0 0 0 3.6 0" />
    </svg>
  );
}

export function ChevronRightIcon({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={className} aria-hidden="true">
      <path d="M7.5 4.5 13 10l-5.5 5.5" />
    </svg>
  );
}
