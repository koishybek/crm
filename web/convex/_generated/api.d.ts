/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai from "../ai.js";
import type * as aiCheck from "../aiCheck.js";
import type * as auth from "../auth.js";
import type * as bot from "../bot.js";
import type * as calls from "../calls.js";
import type * as catalog from "../catalog.js";
import type * as clients from "../clients.js";
import type * as crons from "../crons.js";
import type * as digest from "../digest.js";
import type * as env from "../env.js";
import type * as executors from "../executors.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as imports from "../imports.js";
import type * as leads from "../leads.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_domain from "../lib/domain.js";
import type * as lib_dto from "../lib/dto.js";
import type * as lib_health from "../lib/health.js";
import type * as lib_login from "../lib/login.js";
import type * as lib_rateLimit from "../lib/rateLimit.js";
import type * as lib_tg from "../lib/tg.js";
import type * as metrics from "../metrics.js";
import type * as notifications from "../notifications.js";
import type * as orders from "../orders.js";
import type * as reminders from "../reminders.js";
import type * as search from "../search.js";
import type * as seed from "../seed.js";
import type * as telegram from "../telegram.js";
import type * as users from "../users.js";
import type * as worker from "../worker.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ai: typeof ai;
  aiCheck: typeof aiCheck;
  auth: typeof auth;
  bot: typeof bot;
  calls: typeof calls;
  catalog: typeof catalog;
  clients: typeof clients;
  crons: typeof crons;
  digest: typeof digest;
  env: typeof env;
  executors: typeof executors;
  health: typeof health;
  http: typeof http;
  imports: typeof imports;
  leads: typeof leads;
  "lib/access": typeof lib_access;
  "lib/audit": typeof lib_audit;
  "lib/domain": typeof lib_domain;
  "lib/dto": typeof lib_dto;
  "lib/health": typeof lib_health;
  "lib/login": typeof lib_login;
  "lib/rateLimit": typeof lib_rateLimit;
  "lib/tg": typeof lib_tg;
  metrics: typeof metrics;
  notifications: typeof notifications;
  orders: typeof orders;
  reminders: typeof reminders;
  search: typeof search;
  seed: typeof seed;
  telegram: typeof telegram;
  users: typeof users;
  worker: typeof worker;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
