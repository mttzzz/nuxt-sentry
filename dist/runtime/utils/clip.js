export function clip(text, limit) {
  if (text.length <= limit) {
    return text;
  }
  const cut = text.slice(0, limit);
  const last = cut.codePointAt(limit - 1) ?? 0;
  return last >= 55296 && last <= 56319 ? cut.slice(0, -1) : cut;
}
