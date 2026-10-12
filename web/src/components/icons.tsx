import {
  AirVent,
  Building2,
  Code,
  Droplets,
  Flame,
  Globe,
  Hammer,
  Handshake,
  Heater,
  Microwave,
  Monitor,
  Phone,
  Plug,
  ShowerHead,
  Snowflake,
  Sofa,
  Sparkles,
  Brush,
  UtensilsCrossed,
  Video,
  WashingMachine,
  Refrigerator,
  Wifi,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useId } from "react";
import { APP_NAME, SOURCES, categoryById, serviceById, type ServiceIcon, type Tone } from "../data/catalog";
import type { SourceId } from "../data/types";
import { cn } from "../lib/format";

export function LogoMark({ size = 30 }: { size?: number }) {
  const gid = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFD54F" />
          <stop offset="1" stopColor="#F2A900" />
        </linearGradient>
      </defs>
      <path d="M16 2.5 28 9.5v13L16 29.5 4 22.5v-13z" fill={`url(#${gid})`} />
      <path d="M16 9.2 22 12.7v6.6L16 22.8l-6-3.5v-6.6z" fill="#1c1c1e" />
      <path d="M16 9.2 22 12.7 16 16.2 10 12.7z" fill="#FFE07A" />
    </svg>
  );
}

/** Название в две строки: последнее слово — мелкой подписью («Home Max» / «SERVICE»). */
const NAME_WORDS = APP_NAME.split(" ");
export const BRAND_HEAD = NAME_WORDS.length > 1 ? NAME_WORDS.slice(0, -1).join(" ") : APP_NAME;
const BRAND_TAIL = NAME_WORDS.length > 1 ? NAME_WORDS.at(-1)! : "";

/** onDark — белый текст для тёмного сайдбара. */
export function Logo({ className, onDark }: { className?: string; onDark?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark size={32} />
      <span className="sr-only">{APP_NAME}</span>
      <span className="flex flex-col leading-none" aria-hidden>
        <span className={cn("text-[21px] font-bold tracking-[-0.02em] whitespace-nowrap", onDark ? "text-white" : "text-ink")}>{BRAND_HEAD}</span>
        {BRAND_TAIL && <span className={cn("mt-[3px] text-[10.5px] font-bold tracking-[0.34em] uppercase", onDark ? "text-brand" : "text-brand-ink")}>{BRAND_TAIL}</span>}
      </span>
    </span>
  );
}

// ── Иконки источников ────────────────────────────────────────────────────────

function WhatsAppIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M12 2.2a9.8 9.8 0 0 0-8.4 14.8L2.3 21.7l4.8-1.3A9.8 9.8 0 1 0 12 2.2z" fill="#25D366" />
      <path
        d="M9.1 7.2c-.2-.5-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.3-1.2 1.1-1.2 2.8s1.2 3.2 1.4 3.5c.2.2 2.3 3.6 5.6 4.9 2.8 1.1 3.3.9 3.9.8.6-.1 1.9-.8 2.2-1.5.3-.8.3-1.4.2-1.5-.1-.1-.3-.2-.7-.4l-2.2-1.1c-.3-.1-.5-.2-.7.2l-1 1.2c-.2.2-.4.2-.7.1-.3-.2-1.4-.5-2.6-1.6-1-.9-1.6-1.9-1.8-2.2-.2-.3 0-.5.1-.7l.5-.6.3-.5c.1-.2 0-.4 0-.5l-1.1-2.4z"
        fill="#fff"
      />
    </svg>
  );
}

function TelegramIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="10.5" fill="#2AABEE" />
      <path d="M6 11.7l10.7-4.1c.5-.2.9.1.8.9l-1.8 8.6c-.1.6-.5.8-1 .5l-2.8-2.1-1.3 1.3c-.2.2-.3.3-.6.3l.2-2.8 5.1-4.6c.2-.2 0-.3-.3-.1l-6.3 4-2.7-.9c-.6-.2-.6-.6 0-.9z" fill="#fff" />
    </svg>
  );
}

function InstagramIcon({ size }: { size: number }) {
  const gid = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#FEDA75" />
          <stop offset="0.35" stopColor="#FA7E1E" />
          <stop offset="0.65" stopColor="#D62976" />
          <stop offset="1" stopColor="#4F5BD5" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="20" height="20" rx="6" fill={`url(#${gid})`} />
      <rect x="6.5" y="6.5" width="11" height="11" rx="3.5" fill="none" stroke="#fff" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="2.7" fill="none" stroke="#fff" strokeWidth="1.8" />
      <circle cx="16.4" cy="7.6" r="0.9" fill="#fff" />
    </svg>
  );
}

function OlxIcon({ size }: { size: number }) {
  return (
    <span className="inline-flex items-center font-black leading-none tracking-[-0.06em] text-[#23307a]" style={{ fontSize: size * 0.9, height: size }} aria-hidden>
      olx
    </span>
  );
}

export function SourceIcon({ source, size = 20 }: { source: SourceId; size?: number }) {
  switch (source) {
    case "whatsapp":
      return <WhatsAppIcon size={size} />;
    case "telegram":
      return <TelegramIcon size={size} />;
    case "instagram":
      return <InstagramIcon size={size} />;
    case "olx":
      return <OlxIcon size={size} />;
    case "site":
      return <Globe size={size} className="text-violet" strokeWidth={1.9} aria-hidden />;
    case "phone":
      return <Phone size={size - 2} className="fill-ok text-ok" strokeWidth={1.5} aria-hidden />;
    case "referral":
      return <Handshake size={size} className="text-ok" strokeWidth={1.8} aria-hidden />;
  }
}

export function Source({ source, className }: { source: SourceId; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 whitespace-nowrap", className)}>
      <span className="inline-flex w-[22px] justify-center">
        <SourceIcon source={source} />
      </span>
      {SOURCES[source].label}
    </span>
  );
}

// ── Иконки услуг ─────────────────────────────────────────────────────────────

export const SERVICE_ICON_NAMES = (): ServiceIcon[] => Object.keys(SERVICE_ICONS) as ServiceIcon[];

const SERVICE_ICONS: Record<ServiceIcon, LucideIcon> = {
  snowflake: Snowflake,
  airvent: AirVent,
  washer: WashingMachine,
  fridge: Refrigerator,
  oven: Microwave,
  dishwasher: UtensilsCrossed,
  droplets: Droplets,
  wrench: Wrench,
  faucet: ShowerHead,
  zap: Zap,
  plug: Plug,
  flame: Flame,
  boiler: Heater,
  hammer: Hammer,
  sofa: Sofa,
  sparkles: Sparkles,
  brush: Brush,
  monitor: Monitor,
  wifi: Wifi,
  code: Code,
  intercom: Building2,
  camera: Video,
};

export const TONE_TEXT: Record<Tone, string> = {
  blue: "text-blue",
  yellow: "text-[#c98a00]",
  sky: "text-sky",
  violet: "text-violet",
  amber: "text-warn",
  green: "text-ok",
  red: "text-bad",
  orange: "text-orange",
  gray: "text-muted",
};
export const TONE_SOFT: Record<Tone, string> = {
  blue: "bg-blue-soft text-blue",
  yellow: "bg-[#ffeaa6] text-[#3a2c00]",
  sky: "bg-sky-bg text-sky",
  violet: "bg-violet-bg text-violet",
  amber: "bg-warn-bg text-warn-ink",
  green: "bg-ok-bg text-ok-ink",
  red: "bg-bad-bg text-bad-ink",
  orange: "bg-orange-bg text-orange",
  gray: "bg-slate-bg text-muted",
};

export function ServiceGlyph({ serviceId, size = 20, className }: { serviceId: string; size?: number; className?: string }) {
  const s = serviceById(serviceId);
  const Icon = SERVICE_ICONS[s.icon] ?? Wrench;
  const tone = categoryById(s.category).tone;
  return <Icon size={size} strokeWidth={1.8} className={cn(TONE_TEXT[tone], className)} aria-hidden />;
}

/** Квадратная плитка с иконкой услуги — как в ленте исполнителя. */
export function ServiceTile({ serviceId, size = 56, preview }: { serviceId: string; size?: number; preview?: { icon: ServiceIcon; tone: Tone } }) {
  const s = serviceById(serviceId);
  const Icon = SERVICE_ICONS[preview?.icon ?? s.icon] ?? Wrench;
  const tone = preview?.tone ?? categoryById(s.category).tone;
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-[14px]", TONE_SOFT[tone])} style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.5)} strokeWidth={1.7} aria-hidden />
    </span>
  );
}

export function ServiceLabel({ serviceId, className }: { serviceId: string; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2.5", className)}>
      <ServiceGlyph serviceId={serviceId} />
      <span className="truncate">{serviceById(serviceId).label}</span>
    </span>
  );
}
