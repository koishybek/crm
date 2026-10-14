// Компания вошедшего пользователя (ТЗ §2.5, §24): тариф, модули, «С чего начать», экран «Платформа».
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { convex, run, type Result } from "./convex";
import type { Plan, PlatformFee, TenantInfo, TenantModule } from "./plans";

/** undefined — грузится, null — не вошёл. */
export function useTenant(): TenantInfo | null | undefined {
  return useQuery(api.tenants.current);
}

/** Модуль включён у компании; undefined — ещё неизвестно. */
export function useModule(module: TenantModule): boolean | undefined {
  const t = useTenant();
  return t === undefined ? undefined : !!t && t.modules.includes(module);
}

export const renameCompany = (name: string) => run(convex.mutation(api.tenants.rename, { name }));
export const dismissOnboarding = () => run(convex.mutation(api.tenants.dismissOnboarding, {}));

export interface SignupInput {
  company: string;
  ownerName: string;
  login: string;
  password: string;
  city: string;
  consent: boolean;
  website: string;
  startedAt: number;
}
export const registerCompany = (input: SignupInput): Promise<Result<{ login: string; slug: string }>> => run(convex.action(api.tenants.register, input));

export interface PlatformChange {
  slug: string;
  plan?: Plan;
  modules?: TenantModule[];
  status?: "active" | "suspended";
  platformFee?: PlatformFee | null;
}
export const updateTenant = (change: PlatformChange) => run(convex.mutation(api.platform.update, change));
