// Команда: роль и направления сотрудника — меняет владелец (ТЗ п.4, п.5 «Администрирование: роли, права»).
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { convex, run, type Result } from "./convex";
import type { CategoryId, Role } from "./types";

/** Роли, которые владелец назначает сотрудникам; исполнителей заводят в «Исполнителях». */
export type StaffRole = Exclude<Role, "executor">;

export const updateAccess = (userId: string, role: StaffRole, categories: CategoryId[]): Promise<Result<null>> =>
  run(convex.mutation(api.users.updateAccess, { userId: userId as Id<"users">, role, categories: role === "manager" ? categories : undefined }));
