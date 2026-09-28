import { createHash, randomBytes, randomUUID } from "node:crypto";

export type RandomSource = () => number;

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

/** 测试可注入随机源的短 ID（幂等键等场景）。 */
export function shortId(rand: RandomSource = Math.random): string {
  return randomBytes(8).toString("hex") + Math.floor(rand() * 1e6).toString(16);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
