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
import type * as aiMatch from "../aiMatch.js";
import type * as analytics from "../analytics.js";
import type * as apiKeys from "../apiKeys.js";
import type * as audit from "../audit.js";
import type * as auth from "../auth.js";
import type * as autoAssign from "../autoAssign.js";
import type * as backup from "../backup.js";
import type * as board from "../board.js";
import type * as bot from "../bot.js";
import type * as calls from "../calls.js";
import type * as campaigns from "../campaigns.js";
import type * as catalog from "../catalog.js";
import type * as channels_olx from "../channels/olx.js";
import type * as channels_whatsapp from "../channels/whatsapp.js";
import type * as clientNotify from "../clientNotify.js";
import type * as clientRecords from "../clientRecords.js";
import type * as clients from "../clients.js";
import type * as crons from "../crons.js";
import type * as digest from "../digest.js";
import type * as districts from "../districts.js";
import type * as email from "../email.js";
import type * as env from "../env.js";
import type * as escalations from "../escalations.js";
import type * as executorApp from "../executorApp.js";
import type * as executorRates from "../executorRates.js";
import type * as executorStats from "../executorStats.js";
import type * as executors from "../executors.js";
import type * as exports from "../exports.js";
import type * as files from "../files.js";
import type * as finance from "../finance.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as imports from "../imports.js";
import type * as inbox from "../inbox.js";
import type * as leads from "../leads.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_chat from "../lib/chat.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_defaultPrices from "../lib/defaultPrices.js";
import type * as lib_districts from "../lib/districts.js";
import type * as lib_domain from "../lib/domain.js";
import type * as lib_dto from "../lib/dto.js";
import type * as lib_escalation from "../lib/escalation.js";
import type * as lib_exportRows from "../lib/exportRows.js";
import type * as lib_feed from "../lib/feed.js";
import type * as lib_files from "../lib/files.js";
import type * as lib_health from "../lib/health.js";
import type * as lib_httpUtil from "../lib/httpUtil.js";
import type * as lib_intake from "../lib/intake.js";
import type * as lib_limits from "../lib/limits.js";
import type * as lib_load from "../lib/load.js";
import type * as lib_login from "../lib/login.js";
import type * as lib_mail from "../lib/mail.js";
import type * as lib_matching from "../lib/matching.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_olx from "../lib/olx.js";
import type * as lib_olxApi from "../lib/olxApi.js";
import type * as lib_openapi from "../lib/openapi.js";
import type * as lib_orderArchive from "../lib/orderArchive.js";
import type * as lib_outbound from "../lib/outbound.js";
import type * as lib_phone from "../lib/phone.js";
import type * as lib_privacy from "../lib/privacy.js";
import type * as lib_rateLimit from "../lib/rateLimit.js";
import type * as lib_rates from "../lib/rates.js";
import type * as lib_safeFetch from "../lib/safeFetch.js";
import type * as lib_secretBox from "../lib/secretBox.js";
import type * as lib_stats from "../lib/stats.js";
import type * as lib_stats90 from "../lib/stats90.js";
import type * as lib_statsRead from "../lib/statsRead.js";
import type * as lib_tg from "../lib/tg.js";
import type * as lib_webhookEvents from "../lib/webhookEvents.js";
import type * as lib_whatsapp from "../lib/whatsapp.js";
import type * as maintenance from "../maintenance.js";
import type * as metrics from "../metrics.js";
import type * as notifications from "../notifications.js";
import type * as orderClientChat from "../orderClientChat.js";
import type * as orders from "../orders.js";
import type * as payouts from "../payouts.js";
import type * as permissions from "../permissions.js";
import type * as publicApi from "../publicApi.js";
import type * as receivables from "../receivables.js";
import type * as reminders from "../reminders.js";
import type * as reviews from "../reviews.js";
import type * as search from "../search.js";
import type * as seed from "../seed.js";
import type * as site from "../site.js";
import type * as stats from "../stats.js";
import type * as telegram from "../telegram.js";
import type * as users from "../users.js";
import type * as webhooks from "../webhooks.js";
import type * as worker from "../worker.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ai: typeof ai;
  aiCheck: typeof aiCheck;
  aiMatch: typeof aiMatch;
  analytics: typeof analytics;
  apiKeys: typeof apiKeys;
  audit: typeof audit;
  auth: typeof auth;
  autoAssign: typeof autoAssign;
  backup: typeof backup;
  board: typeof board;
  bot: typeof bot;
  calls: typeof calls;
  campaigns: typeof campaigns;
  catalog: typeof catalog;
  "channels/olx": typeof channels_olx;
  "channels/whatsapp": typeof channels_whatsapp;
  clientNotify: typeof clientNotify;
  clientRecords: typeof clientRecords;
  clients: typeof clients;
  crons: typeof crons;
  digest: typeof digest;
  districts: typeof districts;
  email: typeof email;
  env: typeof env;
  escalations: typeof escalations;
  executorApp: typeof executorApp;
  executorRates: typeof executorRates;
  executorStats: typeof executorStats;
  executors: typeof executors;
  exports: typeof exports;
  files: typeof files;
  finance: typeof finance;
  health: typeof health;
  http: typeof http;
  imports: typeof imports;
  inbox: typeof inbox;
  leads: typeof leads;
  "lib/access": typeof lib_access;
  "lib/audit": typeof lib_audit;
  "lib/chat": typeof lib_chat;
  "lib/crypto": typeof lib_crypto;
  "lib/defaultPrices": typeof lib_defaultPrices;
  "lib/districts": typeof lib_districts;
  "lib/domain": typeof lib_domain;
  "lib/dto": typeof lib_dto;
  "lib/escalation": typeof lib_escalation;
  "lib/exportRows": typeof lib_exportRows;
  "lib/feed": typeof lib_feed;
  "lib/files": typeof lib_files;
  "lib/health": typeof lib_health;
  "lib/httpUtil": typeof lib_httpUtil;
  "lib/intake": typeof lib_intake;
  "lib/limits": typeof lib_limits;
  "lib/load": typeof lib_load;
  "lib/login": typeof lib_login;
  "lib/mail": typeof lib_mail;
  "lib/matching": typeof lib_matching;
  "lib/money": typeof lib_money;
  "lib/olx": typeof lib_olx;
  "lib/olxApi": typeof lib_olxApi;
  "lib/openapi": typeof lib_openapi;
  "lib/orderArchive": typeof lib_orderArchive;
  "lib/outbound": typeof lib_outbound;
  "lib/phone": typeof lib_phone;
  "lib/privacy": typeof lib_privacy;
  "lib/rateLimit": typeof lib_rateLimit;
  "lib/rates": typeof lib_rates;
  "lib/safeFetch": typeof lib_safeFetch;
  "lib/secretBox": typeof lib_secretBox;
  "lib/stats": typeof lib_stats;
  "lib/stats90": typeof lib_stats90;
  "lib/statsRead": typeof lib_statsRead;
  "lib/tg": typeof lib_tg;
  "lib/webhookEvents": typeof lib_webhookEvents;
  "lib/whatsapp": typeof lib_whatsapp;
  maintenance: typeof maintenance;
  metrics: typeof metrics;
  notifications: typeof notifications;
  orderClientChat: typeof orderClientChat;
  orders: typeof orders;
  payouts: typeof payouts;
  permissions: typeof permissions;
  publicApi: typeof publicApi;
  receivables: typeof receivables;
  reminders: typeof reminders;
  reviews: typeof reviews;
  search: typeof search;
  seed: typeof seed;
  site: typeof site;
  stats: typeof stats;
  telegram: typeof telegram;
  users: typeof users;
  webhooks: typeof webhooks;
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
