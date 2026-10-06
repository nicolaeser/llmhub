import type { PIIEntity, Rule } from "@/types/gateway";

export const PII_CATALOG: PIIEntity[] = [
  { id: "CREDIT_CARD", label: "Credit card", category: "Finance", example: "4111 1111 1111 1111", default: true },
  { id: "CRYPTO", label: "Crypto wallet", category: "Finance", example: "bc1q…", default: true },
  { id: "EMAIL_ADDRESS", label: "Email", category: "General", example: "ada@acme.com", default: true },
  { id: "IBAN_CODE", label: "IBAN", category: "Finance", example: "DE89 3704 0044 0532 0130 00", default: true },
  { id: "IP_ADDRESS", label: "IP address", category: "General", example: "8.8.8.8", default: true },
  { id: "PHONE_NUMBER", label: "Phone", category: "General", example: "+1 415 555 2671", default: true },
  { id: "URL", label: "URL", category: "General", example: "https://example.com/secret", default: false },
  { id: "DATE_TIME", label: "Date / time", category: "General", example: "2026-08-21", default: false },
  { id: "MEDICAL_LICENSE", label: "Medical license", category: "Health", example: "AB1234567", default: false },
  { id: "US_SSN", label: "US SSN", category: "USA", example: "123-45-6789", default: true },
  { id: "US_ITIN", label: "US ITIN", category: "USA", example: "912-70-1234", default: true },
  { id: "US_PASSPORT", label: "US passport", category: "USA", example: "A12345678", default: false },
  { id: "US_BANK_NUMBER", label: "US bank account", category: "USA", example: "021000021 123456789", default: false },
  { id: "US_DRIVER_LICENSE", label: "US driver license", category: "USA", example: "D123-4567-8901", default: false },
  { id: "UK_NHS", label: "UK NHS number", category: "UK", example: "943 476 5919", default: false },
  { id: "UK_NINO", label: "UK National Insurance", category: "UK", example: "QQ123456C", default: false },
  { id: "ES_NIF", label: "Spanish NIF", category: "Spain", example: "12345678Z", default: false },
  { id: "ES_NIE", label: "Spanish NIE", category: "Spain", example: "X1234567L", default: false },
  { id: "IT_FISCAL_CODE", label: "Italian fiscal code", category: "Italy", example: "RSSMRA80A01H501U", default: false },
  { id: "IT_VAT_CODE", label: "Italian VAT", category: "Italy", example: "IT12345678901", default: false },
  { id: "PL_PESEL", label: "Polish PESEL", category: "Poland", example: "44051401359", default: false },
  { id: "SG_NRIC_FIN", label: "Singapore NRIC/FIN", category: "Singapore", example: "S1234567D", default: false },
  { id: "AU_ABN", label: "Australian ABN", category: "Australia", example: "51 824 753 556", default: false },
  { id: "AU_ACN", label: "Australian ACN", category: "Australia", example: "000 000 019", default: false },
  { id: "AU_TFN", label: "Australian TFN", category: "Australia", example: "123 456 782", default: false },
  { id: "AU_MEDICARE", label: "Australian Medicare", category: "Australia", example: "2123 45670 1", default: false },
  { id: "IN_PAN", label: "Indian PAN", category: "India", example: "ABCDE1234F", default: false },
  { id: "IN_AADHAAR", label: "Indian Aadhaar", category: "India", example: "1234 5678 9012", default: false },
  { id: "IN_PASSPORT", label: "Indian passport", category: "India", example: "A1234567", default: false },
  { id: "FI_PERSONAL_IDENTITY_CODE", label: "Finnish personal ID", category: "Finland", example: "131052-308T", default: false },
  { id: "JWT", label: "JWT", category: "Credentials", example: "eyJ…", default: true },
  { id: "SECRET", label: "API keys / secrets", category: "Credentials", example: "sk-…", default: true },
];

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SECRET =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|sk-or-v1-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
const SSN = /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
const ITIN = /\b9\d{2}-(?:7\d|8\d|9[0-4])-\d{4}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const IPV4 =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const IPV6 =
  /(?<![\w:.])(?:[A-F0-9]{0,4}:){2,7}(?:\d{1,3}(?:\.\d{1,3}){3}|[A-F0-9]{0,4})(?:%[\w.-]+)?(?![\w:])/gi;
const PHONE_SEP = "[ \\t\\u00A0\\u2000-\\u200D\\u202F\\u205F\\u2060\\u3000\\uFEFF\\-\\u2010-\\u2015./]";
const PHONE = new RegExp(
  `(?<![\\w+])(?:(?:\\+|00)${PHONE_SEP}{0,3})?(?:\\(\\+?\\d{1,5}\\)|\\d+)` +
    `(?:${PHONE_SEP}{1,3}\\d+|${PHONE_SEP}{0,3}\\(\\d{1,5}\\)|(?<=\\))\\d+)*`,
  "g",
);
const NANP = /^(?:1[ .-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[ .-]?[2-9]\d{2}[ .-]?\d{4}$/;
const IBAN =
  /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}\b/g;
const BTC = /\b(?:bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}\b/g;
const CARD = /\b(?:\d[ -]*?){13,19}\b/g;
const URL =
  /\bhttps?:\/\/[^\s<>"']+/gi;
const ISO_DATE =
  /\b(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?)\b/g;
const US_PASSPORT = /\b[A-Z]\d{8}\b/g;
const US_BANK = /\b\d{9}[ \t]+\d{6,17}\b/g;
const US_DL = /\b[A-Z]{1,2}\d{3,6}[- ]?\d{3,5}[- ]?\d{0,5}\b/g;
const MEDICAL = /\b[A-Z]{2}\d{7}\b/g;
const UK_NHS = /\b\d{3} \d{3} \d{4}\b/g;
const UK_NINO = /\b[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]\b/gi;
const ES_NIF = /\b\d{8}[A-Z]\b/g;
const ES_NIE = /\b[XYZ]\d{7}[A-Z]\b/g;
const IT_CF = /\b[A-Z]{6}\d{2}[A-EHLMPRST]\d{2}[A-Z]\d{3}[A-Z]\b/gi;
const IT_VAT = /\bIT\d{11}\b/g;
const PESEL = /\b\d{11}\b/g;
const SG_NRIC = /\b[STFGM]\d{7}[A-Z]\b/g;
const AU_ABN = /\b\d{2} \d{3} \d{3} \d{3}\b/g;
const AU_ACN = /\b\d{3} \d{3} \d{3}\b/g;
const AU_TFN = /\b\d{3} \d{3} \d{3}\b/g;
const AU_MEDICARE = /\b\d{4} \d{5} \d\b/g;
const IN_PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/g;
const IN_AADHAAR = /\b\d{4} \d{4} \d{4}\b/g;
const IN_PASS = /\b[A-Z]\d{7}\b/g;
const FI_HETU = /\b\d{6}[-+A]\d{3}[0-9A-Y]\b/gi;

function luhnOk(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

function isIpv6(raw: string): boolean {
  const addr = raw.split("%")[0] ?? "";
  if (!/\d/.test(addr)) return false;
  const v4 = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (v4 && v4[1]!.split(".").some((octet) => Number(octet) > 255)) return false;
  const head = v4 ? addr.slice(0, -v4[1]!.length) : addr;
  const halves = head.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) =>
    half.replace(/^:|:$/g, "") ? half.replace(/^:|:$/g, "").split(":") : [],
  );
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return false;
  const total = groups.length + (v4 ? 2 : 0);
  return halves.length === 2 ? total >= 1 && total <= 7 : total === 8;
}

function replaceIps(text: string): string {
  return text
    .replace(IPV6, (match) => (isIpv6(match) ? "[IP_ADDRESS]" : match))
    .replace(IPV4, "[IP_ADDRESS]");
}

function isPhone(raw: string): boolean {
  const digits = raw.replace(/\(0\)/g, "").replace(/\D/g, "");
  if (/^\(?\+/.test(raw)) return digits.length >= 7 && digits.length <= 15 && digits[0] !== "0";
  if (raw.startsWith("00")) return digits.length >= 9 && digits.length <= 17 && digits[2] !== "0";
  if (/^\(?0[1-9]/.test(raw)) return digits.length >= 9 && digits.length <= 13;
  return NANP.test(raw);
}

function replacePhones(text: string): string {
  return text.replace(PHONE, (match, offset: number) =>
    /\w/.test(text[offset + match.length] ?? "") || !isPhone(match) ? match : "[PHONE_NUMBER]",
  );
}

function replaceCards(text: string): string {
  return text.replace(CARD, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return match;
    return luhnOk(digits) ? "[CREDIT_CARD]" : match;
  });
}

const RULES: Rule[] = [
  { id: "SECRET", apply: (t) => t.replace(SECRET, "[SECRET]") },
  { id: "JWT", apply: (t) => t.replace(JWT, "[JWT]") },
  { id: "EMAIL_ADDRESS", apply: (t) => t.replace(EMAIL, "[EMAIL_ADDRESS]") },
  { id: "CREDIT_CARD", apply: replaceCards },
  { id: "IBAN_CODE", apply: (t) => t.replace(IBAN, "[IBAN_CODE]") },
  { id: "CRYPTO", apply: (t) => t.replace(BTC, "[CRYPTO]") },
  { id: "IP_ADDRESS", apply: replaceIps },
  { id: "PHONE_NUMBER", apply: replacePhones },
  { id: "US_SSN", apply: (t) => t.replace(SSN, "[US_SSN]") },
  { id: "US_ITIN", apply: (t) => t.replace(ITIN, "[US_ITIN]") },
  { id: "US_PASSPORT", apply: (t) => t.replace(US_PASSPORT, "[US_PASSPORT]") },
  { id: "US_BANK_NUMBER", apply: (t) => t.replace(US_BANK, "[US_BANK_NUMBER]") },
  { id: "US_DRIVER_LICENSE", apply: (t) => t.replace(US_DL, "[US_DRIVER_LICENSE]") },
  { id: "MEDICAL_LICENSE", apply: (t) => t.replace(MEDICAL, "[MEDICAL_LICENSE]") },
  { id: "UK_NHS", apply: (t) => t.replace(UK_NHS, "[UK_NHS]") },
  { id: "UK_NINO", apply: (t) => t.replace(UK_NINO, "[UK_NINO]") },
  { id: "ES_NIF", apply: (t) => t.replace(ES_NIF, "[ES_NIF]") },
  { id: "ES_NIE", apply: (t) => t.replace(ES_NIE, "[ES_NIE]") },
  { id: "IT_FISCAL_CODE", apply: (t) => t.replace(IT_CF, "[IT_FISCAL_CODE]") },
  { id: "IT_VAT_CODE", apply: (t) => t.replace(IT_VAT, "[IT_VAT_CODE]") },
  { id: "PL_PESEL", apply: (t) => t.replace(PESEL, "[PL_PESEL]") },
  { id: "SG_NRIC_FIN", apply: (t) => t.replace(SG_NRIC, "[SG_NRIC_FIN]") },
  { id: "AU_ABN", apply: (t) => t.replace(AU_ABN, "[AU_ABN]") },
  { id: "AU_ACN", apply: (t) => t.replace(AU_ACN, "[AU_ACN]") },
  { id: "AU_TFN", apply: (t) => t.replace(AU_TFN, "[AU_TFN]") },
  { id: "AU_MEDICARE", apply: (t) => t.replace(AU_MEDICARE, "[AU_MEDICARE]") },
  { id: "IN_PAN", apply: (t) => t.replace(IN_PAN, "[IN_PAN]") },
  { id: "IN_AADHAAR", apply: (t) => t.replace(IN_AADHAAR, "[IN_AADHAAR]") },
  { id: "IN_PASSPORT", apply: (t) => t.replace(IN_PASS, "[IN_PASSPORT]") },
  { id: "FI_PERSONAL_IDENTITY_CODE", apply: (t) => t.replace(FI_HETU, "[FI_PERSONAL_IDENTITY_CODE]") },
  { id: "URL", apply: (t) => t.replace(URL, "[URL]") },
  { id: "DATE_TIME", apply: (t) => t.replace(ISO_DATE, "[DATE_TIME]") },
];

export function defaultEntityIds(): string[] {
  return PII_CATALOG.filter((e) => e.default).map((e) => e.id);
}

export function redactPii(text: string, entities?: string[], found?: Set<string>): string {
  const enabled = new Set(
    entities?.length ? entities : defaultEntityIds(),
  );
  let out = text;
  for (const rule of RULES) {
    if (!enabled.has(rule.id)) continue;
    const next = rule.apply(out);
    if (found && next !== out) found.add(rule.id);
    out = next;
  }
  return out;
}

const PLACEHOLDER = new RegExp(`\\[(${PII_CATALOG.map((e) => e.id).join("|")})\\]`, "g");

export function splitPiiPlaceholders(text: string): { text: string; entity: string | null }[] {
  const parts: { text: string; entity: string | null }[] = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start), entity: null });
    parts.push({ text: match[0], entity: match[1] ?? null });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), entity: null });
  return parts;
}

const STRUCTURAL_KEYS = new Set([
  "model",
  "role",
  "type",
  "id",
  "tool_call_id",
  "tool_use_id",
  "call_id",
  "file_id",
  "previous_response_id",
  "signature",
  "thinking",
  "encrypted_content",
  "name",
  "object",
  "url",
  "detail",
  "voice",
  "response_format",
  "encoding_format",
]);

export function isOpaqueText(value: string): boolean {
  return value.startsWith("data:") || (value.length > 512 && /^[A-Za-z0-9+/=\r\n_-]+$/.test(value));
}

export function redactJSON(value: unknown, entities?: string[], key = "", found?: Set<string>): unknown {
  if (typeof value === "string") {
    return STRUCTURAL_KEYS.has(key) || isOpaqueText(value) ? value : redactPii(value, entities, found);
  }
  if (Array.isArray(value)) return value.map((item) => redactJSON(item, entities, key, found));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactJSON(v, entities, k, found);
    return out;
  }
  return value;
}
