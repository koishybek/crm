// Расходы на рекламные кампании (ТЗ п.28.5) — редактор в карточке «Кампании».
import { api } from "../../convex/_generated/api";
import { convex, run } from "./convex";

export const saveCampaignSpend = (month: string, items: { campaign: string; amount: number }[]) => run(convex.mutation(api.campaigns.setSpend, { month, items }));
