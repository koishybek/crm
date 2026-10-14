// Права сотрудника поверх роли (ТЗ п.5.12, п.26.2): владелец включает и выключает их в окне «Доступ». Действуют сразу —
// каждая функция читает права из базы при вызове (lib/access.ts: can, requirePerm), изменение пишется в журнал.
import { ConvexError, v } from "convex/values";
import { internalQuery, mutation } from "./_generated/server";
import { can, currentUser, OWNER, requireRole } from "./lib/access";
import { audit } from "./lib/audit";
import { notify } from "./lib/domain";
import { permission } from "./schema";
import { ROLE_LABEL } from "../src/data/catalog";
import { isRoleDefault, PERMISSION_INFO, PERMISSIONS, permissionFits, permissionsOf, type Permission } from "../src/data/permissions";
import { shortName } from "../src/lib/format";

/** Есть ли право у вызвавшего — для действий (action), где нет ctx.db. */
export const _viewerCan = internalQuery({
  args: { permission },
  handler: async (ctx, a): Promise<boolean> => can(await currentUser(ctx), a.permission),
});

const labels = (ps: readonly Permission[]) => ps.map((p) => `«${PERMISSION_INFO[p].label}»`).join(", ");

/**
 * Задать права сотрудника. null — вернуть умолчания роли. Совпали с умолчаниями — в базе не храним: тогда при смене
 * роли права пойдут за ней. Владельцу права не настраиваются (он видит всё), мастеру — тоже (у него свой кабинет).
 */
export const set = mutation({
  args: { userId: v.id("users"), permissions: v.union(v.array(permission), v.null()) },
  handler: async (ctx, { userId, permissions }) => {
    const me = await requireRole(ctx, OWNER);
    if (userId === me._id) throw new ConvexError("Свои права менять нельзя");
    const u = await ctx.db.get(userId);
    if (!u?.role) throw new ConvexError("Пользователь не найден");
    if (u.role === "owner") throw new ConvexError("Владелец видит всё — права ему не настраиваются");
    if (u.role === "executor") throw new ConvexError("У исполнителя свой кабинет — права сотрудника ему не выдаются");
    const role = u.role;
    const wanted = permissions === null ? null : [...new Set(permissions)];
    if (wanted) {
      const misfit = wanted.find((p) => !permissionFits(p, role));
      if (misfit) throw new ConvexError(`Право «${PERMISSION_INFO[misfit].label}» роли «${ROLE_LABEL[role]}» не выдаётся`);
      for (const p of wanted) {
        const needs = PERMISSION_INFO[p].needs;
        if (needs && !wanted.includes(needs)) throw new ConvexError(`Право «${PERMISSION_INFO[p].label}» работает только вместе с «${PERMISSION_INFO[needs].label}»`);
      }
    }
    const next = wanted === null || isRoleDefault(role, wanted) ? undefined : PERMISSIONS.filter((p) => wanted.includes(p));
    const before = permissionsOf(u);
    const after = permissionsOf({ role, permissions: next });
    const added = after.filter((p) => !before.includes(p));
    const removed = before.filter((p) => !after.includes(p));
    if (!added.length && !removed.length && (u.permissions === undefined) === (next === undefined)) return;

    await ctx.db.patch(userId, { permissions: next });
    const parts = [...(added.length ? [`выданы ${labels(added)}`] : []), ...(removed.length ? [`сняты ${labels(removed)}`] : [])];
    if (next === undefined) parts.push(`права по умолчанию для роли «${ROLE_LABEL[role]}»`);
    await audit(ctx, me, "user.permissions", `${shortName(u.name || u.email || "без имени")}: ${parts.join("; ")}`, {
      entityId: userId,
      meta: { role, from: before, to: after, custom: next !== undefined },
    });
    await notify(ctx, [userId], `Владелец изменил ваши права: ${parts.join("; ")}`, { tone: "info" });
  },
});
