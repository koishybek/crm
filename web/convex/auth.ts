import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import { normalizeLogin } from "./lib/login";

/**
 * Вход только по логину и паролю, которые выдаёт владелец. Регистрации с сайта нет:
 * аккаунт с паролем создаёт админское действие (users.createStaff / executors.create) через createAccount.
 */
const LoginPassword = Password({
  profile(params) {
    if (params.flow !== "signIn") throw new ConvexError("Аккаунты создаёт владелец компании");
    return { email: normalizeLogin(String(params.email ?? "")) };
  },
  validatePasswordRequirements(password: string) {
    if (password.length < 8) throw new ConvexError("Пароль — минимум 8 символов");
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [LoginPassword],
  callbacks: {
    /** Аккаунт привязываем только к заранее созданному пользователю — так самому «зарегистрироваться» нельзя. */
    async createOrUpdateUser(ctx, args) {
      if (args.existingUserId) return args.existingUserId;
      const db = (ctx as unknown as MutationCtx).db;
      const login = normalizeLogin(String(args.profile.email ?? ""));
      const user = await db
        .query("users")
        .withIndex("email", (q) => q.eq("email", login))
        .unique();
      if (!user) throw new ConvexError("Пользователь не найден");
      return user._id;
    },
  },
});
