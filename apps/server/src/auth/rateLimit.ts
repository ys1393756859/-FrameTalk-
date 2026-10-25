/** 登录失败内存限流：同一邮箱连续失败锁定（阈值/时长在后台"系统设置-安全"可调） */
const attempts = new Map<string, { count: number; lockedUntil: number }>();

export function checkLocked(email: string, limit = 5, lockMinutes = 10): boolean {
  const rec = attempts.get(email);
  if (!rec) return false;
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) return true;
  if (rec.lockedUntil && rec.lockedUntil <= Date.now()) attempts.delete(email);
  void limit; void lockMinutes;
  return false;
}

export function recordFailure(email: string, limit = 5, lockMinutes = 10) {
  const rec = attempts.get(email) ?? { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= limit) {
    rec.lockedUntil = Date.now() + lockMinutes * 60 * 1000;
    rec.count = 0;
  }
  attempts.set(email, rec);
}

export function clearFailures(email: string) {
  attempts.delete(email);
}
