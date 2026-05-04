export function pathParam(raw: string | string[] | undefined): string | undefined {
  if (raw == null) return undefined;
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === undefined || v === "" ? undefined : v;
}
