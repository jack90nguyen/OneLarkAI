export function log(message: string, ...rest: unknown[]): void {
  const time = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" });
  console.log(`[${time}] ${message}`, ...rest);
}
