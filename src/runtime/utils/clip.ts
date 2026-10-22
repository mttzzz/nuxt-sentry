/*
 * Обрезка строки без половины суррогатной пары: одинокий суррогат делает JSON-строку невалидной для разбора
 * на сервере Sentry. В ES5-скрипте раннего beacon'а та же обрезка написана отдельно (скрипт не транспилируется).
 */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }
  const cut = text.slice(0, limit)
  const last = cut.codePointAt(limit - 1) ?? 0
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}
