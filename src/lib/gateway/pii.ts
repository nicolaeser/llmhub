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
  { id: "DE_TAX_ID", label: "German tax ID", category: "Germany", example: "12 345 678 995", default: false },
  { id: "DE_TAX_NUMBER", label: "German tax number", category: "Germany", example: "12/345/67890", default: false },
  { id: "DE_VAT_ID", label: "German VAT ID", category: "Germany", example: "DE123456788", default: false },
  { id: "DE_SOCIAL_SECURITY", label: "German pension insurance number", category: "Germany", example: "12 010180 M 013", default: false },
  { id: "DE_HEALTH_INSURANCE", label: "German health insurance number", category: "Germany", example: "A123456780", default: false },
  { id: "DE_ID_CARD", label: "German ID card", category: "Germany", example: "T220001293", default: false },
  { id: "DE_PASSPORT", label: "German passport", category: "Germany", example: "C01X00T478", default: false },
  { id: "AT_SOCIAL_SECURITY", label: "Austrian social insurance number", category: "Austria", example: "1237 010180", default: false },
  { id: "AT_VAT_ID", label: "Austrian VAT ID", category: "Austria", example: "ATU12345675", default: false },
  { id: "CH_AHV", label: "Swiss AHV number", category: "Switzerland", example: "756.1234.5678.97", default: false },
  { id: "CH_UID", label: "Swiss business ID", category: "Switzerland", example: "CHE-123.456.788", default: false },
  { id: "JWT", label: "JWT", category: "Credentials", example: "eyJ…", default: true },
  { id: "SECRET", label: "API keys / secrets", category: "Credentials", example: "sk-…", default: true },
  { id: "PRIVATE_KEY", label: "Private key", category: "Credentials", example: "-----BEGIN PRIVATE KEY-----", default: true },
  { id: "CONNECTION_STRING", label: "Connection string / DB URL", category: "Credentials", example: "postgres://user:pass@db/app", default: true },
  { id: "ENV_SECRET", label: "Env / config secret", category: "Credentials", example: "DB_PASSWORD=…", default: true },
];

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SECRET_TOKENS = [
  "sk-(?=[\\w.-]{8,})[\\w-]+(?:\\.[\\w-]+)*",
  "(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}",
  "whsec_[A-Za-z0-9+/=]{20,}",
  "(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}",
  "gh[pousr]_[A-Za-z0-9]{20,}",
  "github_pat_[A-Za-z0-9_]{22,}",
  "glpat-[A-Za-z0-9_-]{20,}",
  "xox[abeprs]-[A-Za-z0-9-]{10,}",
  "xapp-[A-Za-z0-9-]{10,}",
  "AIza[0-9A-Za-z_-]{35}",
  "GOCSPX-[A-Za-z0-9_-]{20,}",
  "ya29\\.[A-Za-z0-9_-]{20,}",
  "hf_[A-Za-z0-9]{30,}",
  "npm_[A-Za-z0-9]{36}",
  "pypi-[A-Za-z0-9_-]{50,}",
  "SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}",
  "SK[0-9a-f]{32}",
  "key-[0-9a-f]{32}",
  "[0-9a-f]{32}-us\\d{1,2}",
  "shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}",
  "dop_v1_[a-f0-9]{64}",
  "dapi[0-9a-f]{32}",
  "gsk_[A-Za-z0-9]{40,}",
  "xai-[A-Za-z0-9]{40,}",
  "pplx-[A-Za-z0-9]{40,}",
  "r8_[A-Za-z0-9]{30,}",
  "ntn_[A-Za-z0-9]{40,}",
  "secret_[A-Za-z0-9]{43}",
  "lin_api_[A-Za-z0-9]{40}",
  "hv[sb]\\.[A-Za-z0-9_-]{20,}",
  "dp\\.pt\\.[A-Za-z0-9]{40,}",
  "PMAK-[a-f0-9]{24}-[a-f0-9]{34}",
  "ATATT3[A-Za-z0-9_=-]{100,}",
  "sntrys_[A-Za-z0-9+/=_-]{50,}",
  "sbp_[a-f0-9]{40}",
  "\\d{8,10}:AA[A-Za-z0-9_-]{33}",
  "https://hooks\\.slack\\.com/(?:services|workflows|triggers)/[A-Za-z0-9/_-]+",
  "https://(?:ptb\\.|canary\\.)?discord(?:app)?\\.com/api/webhooks/\\d+/[A-Za-z0-9_-]+",
];
const SECRET = new RegExp(`(?<![\\w-])(?:${SECRET_TOKENS.join("|")})(?![\\w-])`, "g");
const BEARER = /\bBearer[ \t]+([A-Za-z0-9._~+/-]{16,}=*)/g;
const BASIC_AUTH = /\b(Authorization:[ \t]*Basic[ \t]+)[A-Za-z0-9+/]{8,}={0,2}/gi;
const PRIVATE_KEY =
  /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|(?=["'`]|$))/g;
const CREDENTIAL_URL =
  /(?<![\w.+\-/:])(?:jdbc:)?[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@"'<>]*:[^\s/?#@"'<>]+@[^\s"'<>]+/gi;
const QUERY_CREDENTIAL_URL =
  /(?<![\w.+\-/:])(?:jdbc:)?[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]{0,2048}?[?&;](?:password|passwd|pwd|pass|sslpassword|secret|client_secret|token|access_token|auth_token|api_key|api-key|apikey|sig)=[^\s"'<>&;]+[^\s"'<>]*/gi;
const ORACLE_URL = /\bjdbc:oracle:[a-z]+:[^\s/@"'<>]+\/[^\s@"'<>]+@[^\s"'<>]+/gi;
const KEY_VALUE_CONNECTION =
  /(?<![\w-])[A-Za-z]\w{0,63}[ \t]*=[^;\r\n"']{0,256}(?:;[ \t]*[A-Za-z]\w{0,63}(?: [A-Z]\w{0,63}){0,3}[ \t]*=[^;\r\n"']{0,256})+;?/g;
const KEY_VALUE_CREDENTIAL =
  /(?:^|;)[ \t]*(?:password|pwd|accountkey|sharedaccesskey|sharedaccesssignature)[ \t]*=[ \t]*[^;\s]/i;
const ASSIGNMENT =
  /(?<![\w.])([A-Za-z_][\w.-]{0,63})(["']?[ \t]*(?::=|[:=])(?![=>:])[ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s"',;}\]]+)/g;
const SECRET_NAME_WORDS = new Set([
  "password",
  "passwd",
  "pass",
  "pwd",
  "secret",
  "token",
  "passphrase",
  "credential",
  "credentials",
  "apikey",
]);
const SECRET_KEY_QUALIFIERS = new Set([
  "api",
  "access",
  "secret",
  "private",
  "auth",
  "client",
  "encryption",
  "signing",
  "master",
  "service",
  "account",
  "license",
  "app",
  "webhook",
  "session",
  "hmac",
  "jwt",
  "ssh",
  "deploy",
]);
const VALUE_REFERENCE = /^(?:\$|<|%|\[|\{\{)|\$\{/;
const TRIVIAL_VALUE = /^(?:\*+|x+|\.+|-+|true|false|null|none|nil|undefined|yes|no|on|off|\d{1,5})$/i;
const TYPE_WORD =
  /^(?:string|str|number|int|integer|float|bool|boolean|bytes|any|unknown|object|optional|required|text|varchar|secretstr)$/i;
const CODE_VALUE = /[()[\]{}<>]|^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const LINE_INDENT = /[ \t]*(?:-[ \t]+)?["']?$/;
const LINE_END = /[ \t]*(?:\r?\n|$)/y;
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
const EVM_ADDRESS = /\b0x[a-fA-F0-9]{40}\b/g;
const BECH32_ADDRESS =
  /\b(?:(?:ltc1|cosmos1)[02-9ac-hj-np-z]{38,60}|addr1[02-9ac-hj-np-z]{50,110}|bitcoincash:[qp][02-9ac-hj-np-z]{41})\b/g;
const BASE58_ADDRESS =
  /\b(?:[LM][1-9A-HJ-NP-Za-km-z]{26,33}|D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{32}|T[1-9A-HJ-NP-Za-km-z]{33}|r[1-9A-HJ-NP-Za-km-z]{24,34}|[48][0-9AB][1-9A-HJ-NP-Za-km-z]{93})\b/g;
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
const DE_TAX_ID = /(?<![\w+]|\+[\d ]{0,20})[1-9]\d(?:[ ]?\d{3}){3}(?!\w)/g;
const DE_TAX_NUMBER = /(?<![\w/])\d{2,3}\/\d{3,4}\/\d{4,5}(?![\w/])/g;
const DE_VAT = /\bDE[ ]?\d{3}[ ]?\d{3}[ ]?\d{3}\b/g;
const DE_PENSION =
  /\b\d{2}[ ]?(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])\d{2}[ ]?[A-Z][ ]?\d{2}[ ]?\d\b/g;
const DE_HEALTH = /\b[A-Z]\d{9}\b/g;
const DE_ID_CARD = /\b[LMNPRTVWXY][CFGHJKLMNPRTVWXYZ\d]{8}\d?\b/g;
const DE_PASSPORT = /\b[CFGHJK][CFGHJKLMNPRTVWXYZ\d]{8}\d?\b/g;
const AT_SVNR = /\b[1-9]\d{3}[ ]?(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])\d{2}\b/g;
const AT_VAT = /\bATU[ ]?\d{8}\b/g;
const CH_AHV = /\b756[. ]?\d{4}[. ]?\d{4}[. ]?\d{2}\b/g;
const CH_UID = /\bCHE[- ]?\d{3}[. ]?\d{3}[. ]?\d{3}\b/g;

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

function replaceValid(text: string, pattern: RegExp, id: string, valid: (match: string) => boolean): string {
  return text.replace(pattern, (match) => (valid(match) ? `[${id}]` : match));
}

function keepTrailingPunctuation(match: string, id: string): string {
  const trail = /[.,;:!?)\]}]+$/.exec(match)?.[0] ?? "";
  return `[${id}]${trail}`;
}

function replaceSecrets(text: string): string {
  return text
    .replace(SECRET, "[SECRET]")
    .replace(BEARER, (match, token: string) =>
      /\d/.test(token) || token.length >= 32 ? match.replace(token, "[SECRET]") : match,
    )
    .replace(BASIC_AUTH, "$1[SECRET]");
}

function replaceConnections(text: string): string {
  return text
    .replace(ORACLE_URL, (match) => keepTrailingPunctuation(match, "CONNECTION_STRING"))
    .replace(CREDENTIAL_URL, (match) => keepTrailingPunctuation(match, "CONNECTION_STRING"))
    .replace(QUERY_CREDENTIAL_URL, (match) => keepTrailingPunctuation(match, "CONNECTION_STRING"))
    .replace(KEY_VALUE_CONNECTION, (match) =>
      KEY_VALUE_CREDENTIAL.test(match) ? keepTrailingPunctuation(match, "CONNECTION_STRING") : match,
    );
}

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isTokenLike(value: string): boolean {
  return value.length >= 20 && /^[\w-]+$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value);
}

function isSecretName(name: string, value: string): boolean {
  if (/^PWD$/i.test(name)) return false;
  const words = nameWords(name);
  const last = words.at(-1) ?? "";
  if (SECRET_NAME_WORDS.has(last)) return true;
  return last === "key" && (SECRET_KEY_QUALIFIERS.has(words.at(-2) ?? "") || isTokenLike(value));
}

function looksLikeSecret(value: string): boolean {
  return value.length >= 6 && /[\d\W_]/.test(value);
}

function isLineStart(text: string, offset: number): boolean {
  const indent = LINE_INDENT.exec(text.slice(Math.max(0, offset - 64), offset))?.[0] ?? "";
  const start = offset - indent.length;
  return start === 0 || text[start - 1] === "\n";
}

function isLineEnd(text: string, end: number): boolean {
  LINE_END.lastIndex = end;
  return LINE_END.test(text);
}

function replaceAssignments(text: string): string {
  return text.replace(
    ASSIGNMENT,
    (match, name: string, assign: string, value: string, offset: number) => {
      const quote = /^["']/.test(value) ? value[0]! : "";
      const trail = quote ? "" : (/[.!?:]+$/.exec(value)?.[0] ?? "");
      const inner = quote ? value.slice(1, -1) : value.slice(0, value.length - trail.length);
      if (!inner || VALUE_REFERENCE.test(inner) || TRIVIAL_VALUE.test(inner)) return match;
      if (!isSecretName(name, inner) || TYPE_WORD.test(inner)) return match;
      if (!quote && CODE_VALUE.test(inner)) return match;
      const envStyle = assign === "=";
      const yamlStyle =
        assign.trim() === ":" && isLineStart(text, offset) && isLineEnd(text, offset + match.length);
      if (!quote && !envStyle && !yamlStyle && !looksLikeSecret(inner)) return match;
      return `${name}${assign}${quote}[ENV_SECRET]${quote}${trail}`;
    },
  );
}

function hasBase58Mix(value: string): boolean {
  return /\d/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value);
}

function replaceCrypto(text: string): string {
  return text
    .replace(BTC, "[CRYPTO]")
    .replace(EVM_ADDRESS, "[CRYPTO]")
    .replace(BECH32_ADDRESS, "[CRYPTO]")
    .replace(BASE58_ADDRESS, (match) => (hasBase58Mix(match) ? "[CRYPTO]" : match));
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

function digitSum(value: number): number {
  return Math.floor(value / 10) + (value % 10);
}

function mod11x10(digits: string): number {
  let product = 10;
  for (const char of digits) {
    const sum = (Number(char) + product) % 10 || 10;
    product = (sum * 2) % 11;
  }
  return (11 - product) % 10;
}

function isDeTaxId(raw: string): boolean {
  const digits = digitsOf(raw);
  if (digits.length !== 11) return false;
  const head = digits.slice(0, 10);
  const counts = new Map<string, number>();
  for (const char of head) counts.set(char, (counts.get(char) ?? 0) + 1);
  const repeated = [...counts.values()].filter((count) => count > 1);
  if (repeated.length !== 1 || repeated[0]! > 3 || /(\d)\1\1/.test(head)) return false;
  return mod11x10(head) === Number(digits[10]);
}

function isDeTaxNumber(raw: string): boolean {
  const length = digitsOf(raw).length;
  return length === 10 || length === 11;
}

function isDeVatId(raw: string): boolean {
  const digits = digitsOf(raw);
  return mod11x10(digits.slice(0, 8)) === Number(digits[8]);
}

function isDePensionNumber(raw: string): boolean {
  const compact = raw.replace(/ /g, "");
  const letter = String(compact.charCodeAt(8) - 64).padStart(2, "0");
  const digits = `${compact.slice(0, 8)}${letter}${compact.slice(9, 11)}`;
  const weights = [2, 1, 2, 5, 7, 1, 2, 1, 2, 1, 2, 1];
  const sum = weights.reduce((acc, weight, i) => acc + digitSum(weight * Number(digits[i])), 0);
  return sum % 10 === Number(compact[11]);
}

function isDeHealthInsuranceNumber(raw: string): boolean {
  const digits = `${String(raw.charCodeAt(0) - 64).padStart(2, "0")}${raw.slice(1, 9)}`;
  const sum = [...digits].reduce((acc, char, i) => acc + digitSum(Number(char) * (i % 2 ? 2 : 1)), 0);
  return sum % 10 === Number(raw[9]);
}

function icaoCheckDigit(value: string): number {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    sum += (/\d/.test(char) ? Number(char) : char.charCodeAt(0) - 55) * weights[i % 3]!;
  }
  return sum % 10;
}

function isDeDocumentNumber(raw: string): boolean {
  if (!/\d/.test(raw)) return false;
  return raw.length === 9 || icaoCheckDigit(raw.slice(0, 9)) === Number(raw[9]);
}

function isAtSocialSecurityNumber(raw: string): boolean {
  const digits = digitsOf(raw);
  const weights = [3, 7, 9, 0, 5, 8, 4, 2, 1, 6];
  const check = weights.reduce((acc, weight, i) => acc + weight * Number(digits[i]), 0) % 11;
  return check !== 10 && check === Number(digits[3]);
}

function isAtVatId(raw: string): boolean {
  const digits = digitsOf(raw);
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += digitSum(Number(digits[i]) * (i % 2 ? 2 : 1));
  return (10 - ((sum + 4) % 10)) % 10 === Number(digits[7]);
}

function isChAhv(raw: string): boolean {
  const digits = digitsOf(raw);
  const sum = [...digits.slice(0, 12)].reduce((acc, char, i) => acc + Number(char) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(digits[12]);
}

function isChUid(raw: string): boolean {
  const digits = digitsOf(raw);
  const weights = [5, 4, 3, 2, 7, 6, 5, 4];
  const rest = weights.reduce((acc, weight, i) => acc + weight * Number(digits[i]), 0) % 11;
  const check = rest === 0 ? 0 : 11 - rest;
  return check !== 10 && check === Number(digits[8]);
}

const RULES: Rule[] = [
  { id: "PRIVATE_KEY", apply: (t) => t.replace(PRIVATE_KEY, "[PRIVATE_KEY]") },
  { id: "CONNECTION_STRING", apply: replaceConnections },
  { id: "JWT", apply: (t) => t.replace(JWT, "[JWT]") },
  { id: "SECRET", apply: replaceSecrets },
  { id: "ENV_SECRET", apply: replaceAssignments },
  { id: "EMAIL_ADDRESS", apply: (t) => t.replace(EMAIL, "[EMAIL_ADDRESS]") },
  { id: "DE_TAX_ID", apply: (t) => replaceValid(t, DE_TAX_ID, "DE_TAX_ID", isDeTaxId) },
  { id: "DE_TAX_NUMBER", apply: (t) => replaceValid(t, DE_TAX_NUMBER, "DE_TAX_NUMBER", isDeTaxNumber) },
  { id: "DE_VAT_ID", apply: (t) => replaceValid(t, DE_VAT, "DE_VAT_ID", isDeVatId) },
  { id: "DE_SOCIAL_SECURITY", apply: (t) => replaceValid(t, DE_PENSION, "DE_SOCIAL_SECURITY", isDePensionNumber) },
  {
    id: "DE_HEALTH_INSURANCE",
    apply: (t) => replaceValid(t, DE_HEALTH, "DE_HEALTH_INSURANCE", isDeHealthInsuranceNumber),
  },
  { id: "DE_ID_CARD", apply: (t) => replaceValid(t, DE_ID_CARD, "DE_ID_CARD", isDeDocumentNumber) },
  { id: "DE_PASSPORT", apply: (t) => replaceValid(t, DE_PASSPORT, "DE_PASSPORT", isDeDocumentNumber) },
  {
    id: "AT_SOCIAL_SECURITY",
    apply: (t) => replaceValid(t, AT_SVNR, "AT_SOCIAL_SECURITY", isAtSocialSecurityNumber),
  },
  { id: "AT_VAT_ID", apply: (t) => replaceValid(t, AT_VAT, "AT_VAT_ID", isAtVatId) },
  { id: "CH_AHV", apply: (t) => replaceValid(t, CH_AHV, "CH_AHV", isChAhv) },
  { id: "CH_UID", apply: (t) => replaceValid(t, CH_UID, "CH_UID", isChUid) },
  { id: "CREDIT_CARD", apply: replaceCards },
  { id: "IBAN_CODE", apply: (t) => t.replace(IBAN, "[IBAN_CODE]") },
  { id: "CRYPTO", apply: replaceCrypto },
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

export function skipsScan(key: string, value: string): boolean {
  return STRUCTURAL_KEYS.has(key) || isOpaqueText(value);
}

export function redactJSON(value: unknown, entities?: string[], key = "", found?: Set<string>): unknown {
  if (typeof value === "string") {
    return skipsScan(key, value) ? value : redactPii(value, entities, found);
  }
  if (Array.isArray(value)) return value.map((item) => redactJSON(item, entities, key, found));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactJSON(v, entities, k, found);
    return out;
  }
  return value;
}
