// «Маршрут»: 2ГИС или Яндекс Карты (обычные https-ссылки — работают и без связи с нашим сервером).
// Выбор можно запомнить: дальше «Маршрут» сразу открывает нужные карты, сменить — в профиле.
import { Copy, MapPinned, Navigation, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "../../data/store";
import { MAP_APPS, type MapApp } from "../../data/workerLinks";
import { useWorkerPrefs } from "../../data/workerPrefs";
import { cn } from "../../lib/format";
import { MUTED, WButton } from "./kit";
import { Sheet } from "./Sheet";

export async function copyAddress(city: string, address: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(`${city}, ${address}`);
    toast("Адрес скопирован");
  } catch {
    toast("Не получилось скопировать — выделите адрес вручную", "bad");
  }
}

const APP_ICON: Record<MapApp, LucideIcon> = { "2gis": MapPinned, yandex: Navigation };

export function MapSheet({ city, address, onClose }: { city: string; address: string; onClose: () => void }) {
  const setMapApp = useWorkerPrefs((s) => s.setMapApp);
  const [remember, setRemember] = useState(true);
  return (
    <Sheet open onClose={onClose} title="Открыть маршрут">
      <p className={cn("text-[15px]", MUTED)}>
        {city}, {address}
      </p>
      <div className="mt-3 flex flex-col gap-2">
        {(Object.keys(MAP_APPS) as MapApp[]).map((app) => {
          const Icon = APP_ICON[app];
          return (
            <a
              key={app}
              href={MAP_APPS[app].url(city, address)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                if (remember) setMapApp(app);
                onClose();
              }}
              className="flex min-h-14 items-center gap-3 rounded-[12px] border border-[#cfc9bc] px-4 text-[16px] font-semibold text-ink active:bg-[#f4f2ec]"
            >
              <Icon size={22} aria-hidden />
              {MAP_APPS[app].label}
            </a>
          );
        })}
        <WButton variant="secondary" icon={Copy} full className="min-h-14 justify-start" onClick={() => void copyAddress(city, address).then(onClose)}>
          Скопировать адрес
        </WButton>
      </div>
      <label className="mt-4 flex min-h-12 cursor-pointer items-center gap-3 text-[15px] text-ink">
        <input type="checkbox" className="h-5 w-5 accent-[#141414]" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Запомнить выбор
      </label>
    </Sheet>
  );
}

/** Кнопка «Маршрут»: запомненные карты — сразу ссылкой, иначе шторка выбора. */
export function useRoute(city: string, address: string | undefined) {
  const mapApp = useWorkerPrefs((s) => s.mapApp);
  const [open, setOpen] = useState(false);
  const href = address && mapApp ? MAP_APPS[mapApp].url(city, address) : undefined;
  return {
    available: !!address,
    href,
    open: () => setOpen(true),
    sheet: open && address ? <MapSheet city={city} address={address} onClose={() => setOpen(false)} /> : null,
  };
}
