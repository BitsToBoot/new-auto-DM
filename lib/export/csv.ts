/**
 * Escapes a single CSV value according to RFC 4180.
 * Wraps values containing commas, newlines, or quotes in double quotes.
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Formats an array of fields into a standard RFC 4180 CSV row ending in \r\n.
 */
export function formatCsvRow(fields: unknown[]): string {
  return fields.map(escapeCsvField).join(",") + "\r\n";
}
