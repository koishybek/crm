// Адаптеры облачных АТС по провайдеру.
import type { PbxProvider } from "../../../src/data/pbx";
import { binotel } from "./binotel";
import { kcell } from "./kcell";
import { onlinepbx } from "./onlinepbx";
import type { PbxAdapter } from "./types";
import { zadarma } from "./zadarma";

export const PBX_ADAPTERS: Record<PbxProvider, PbxAdapter> = { kcell, binotel, zadarma, onlinepbx };
