export const money = (n: number | null | undefined, currency = "NGN") => {
  const v = typeof n === "number" ? n : 0;
  try {
    return new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
};

export const num = (n: number | null | undefined) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(n ?? 0);

// Every date the app shows is day/month/year. A bare "yyyy-mm-dd" column value
// is read as a local calendar date -- new Date("2026-10-28") would be UTC
// midnight and can land on the previous day once converted to local time.
const toDate = (v: string | Date): Date =>
  v instanceof Date ? v : /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : new Date(v);

const pad = (n: number) => String(n).padStart(2, "0");

export const fmtDate = (v: string | Date | null | undefined, empty = "—") => {
  if (!v) return empty;
  const d = toDate(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
};

export const fmtDateTime = (v: string | Date | null | undefined, empty = "—") => {
  if (!v) return empty;
  const d = toDate(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Report exports pass column values straight from the database, so ISO dates
// ("2026-10-28", "2026-10-28T09:15:00+00:00") are converted here; anything else
// is returned unchanged.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
export const fmtIfDate = (v: unknown): unknown =>
  typeof v !== "string"
    ? v
    : ISO_DATE.test(v)
      ? fmtDate(v)
      : ISO_DATETIME.test(v)
        ? fmtDateTime(v)
        : v;
