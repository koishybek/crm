// Справочник услуг для сотрудника с правом «Справочник услуг» (ТЗ п.5.12): у владельца он в «Настройках».
import { PageHeader } from "../components/ui";
import { CatalogEditor } from "./CatalogEditor";

export default function CatalogScreen() {
  return (
    <>
      <PageHeader title="Справочник услуг" subtitle="Направления, услуги, цены и доля мастера — изменения сразу видны всей команде" />
      <CatalogEditor />
    </>
  );
}
