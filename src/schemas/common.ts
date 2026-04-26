/**
 * Reusable Zod schemas.
 */
import { z } from "zod";

export const StoreSlug = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9_-]+$/i, "store slug must be lowercase alphanumeric with - or _")
  .describe("Wafle store slug, e.g. 'gamerland' or 'lensitive'.");

export const StoreId = z.number().int().positive().describe("Wafle internal numeric store id.");

export const Pagination = {
  page: z.number().int().min(1).default(1).describe("1-based page number."),
  per_page: z.number().int().min(1).max(200).default(50).describe("Items per page (1-200)."),
};

export const ISO8601 = z.string().describe("ISO 8601 timestamp, e.g. '2026-04-25T18:00:00Z'.");

export const Money = z.union([z.number(), z.string()]).describe("Money amount as number or numeric string in store currency.");

export const Currency = z.string().length(3).describe("ISO 4217 currency code, e.g. 'ARS', 'USD'.");

export type Pagination = { page: number; per_page: number };
