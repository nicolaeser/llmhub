import type { PasswordPolicyCode } from "@/types/security";

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;
export const PASSWORD_POLICY_CODES: readonly PasswordPolicyCode[] = ["WEAK_PASSWORD", "PASSWORD_GUESSABLE"];

const MIN_DISTINCT_CHARACTERS = 5;

const COMMON_WORDS = new Set([
  "password",
  "passwort",
  "passwd",
  "pass",
  "mypassword",
  "qwerty",
  "qwertz",
  "azerty",
  "qwertyuiop",
  "asdf",
  "asdfgh",
  "asdfghjkl",
  "yxcvbnm",
  "zxcvbn",
  "zxcvbnm",
  "letmein",
  "welcome",
  "willkommen",
  "admin",
  "administrator",
  "root",
  "login",
  "master",
  "iloveyou",
  "love",
  "monkey",
  "dragon",
  "football",
  "fussball",
  "baseball",
  "soccer",
  "sunshine",
  "princess",
  "shadow",
  "superman",
  "batman",
  "trustno",
  "starwars",
  "whatever",
  "freedom",
  "hello",
  "hallo",
  "secret",
  "geheim",
  "changeme",
  "default",
  "test",
  "testing",
  "guest",
  "user",
  "summer",
  "winter",
  "spring",
  "autumn",
  "sommer",
  "hunter",
  "computer",
  "internet",
  "google",
  "llmhub",
  "llm",
  "hub",
  "gateway",
  "openai",
  "chatgpt",
  "anthropic",
  "claude",
]);

const SEQUENCES = [
  "abcdefghijklmnopqrstuvwxyz",
  "qwertyuiopasdfghjklzxcvbnm",
  "qwertzuiopasdfghjklyxcvbnm",
  "azertyuiopqsdfghjklmwxcvbn",
  "01234567890",
];

const SUBSTITUTIONS: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  "$": "s",
  "!": "i",
};

const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

const lettersOf = (value: string) =>
  value
    .toLowerCase()
    .replace(/^[0-9\W_]+|[0-9\W_]+$/g, "")
    .replace(/[0-9@$!]/g, (char) => SUBSTITUTIONS[char] ?? "")
    .replace(/[^a-z]/g, "");

const digitsOf = (value: string) => value.replace(/[^0-9]/g, "");

function isSequential(value: string): boolean {
  if (value.length < 3) return false;
  return SEQUENCES.some(
    (sequence) => sequence.includes(value) || [...sequence].reverse().join("").includes(value),
  );
}

function isRepeated(value: string): boolean {
  return /^(.{1,5})\1+$/.test(value);
}

function containsIdentifier(password: string, identifiers: readonly (string | null | undefined)[]) {
  const haystack = compact(password);
  const letters = lettersOf(password);
  return identifiers.some((identifier) => {
    if (!identifier) return false;
    const [local] = identifier.toLowerCase().split("@");
    const whole = compact(local ?? "");
    const parts = (local ?? "")
      .split(/[^a-z0-9]+/)
      .map(compact)
      .filter((part) => part.length >= 4);
    const candidates = [...(whole.length >= 4 ? [whole] : []), ...parts];
    return candidates.some((candidate) => haystack.includes(candidate) || letters.includes(candidate));
  });
}

function isGuessable(password: string): boolean {
  if (new Set(password.toLowerCase()).size < MIN_DISTINCT_CHARACTERS) return true;
  const whole = compact(password);
  if (isRepeated(whole) || isSequential(whole)) return true;
  const letters = lettersOf(password);
  const digits = digitsOf(password);
  if (COMMON_WORDS.has(letters) || isRepeated(letters) || isSequential(letters)) return true;
  return letters.length <= 2 && (isSequential(digits) || isRepeated(digits));
}

export function passwordPolicyIssue(
  password: string,
  identifiers: readonly (string | null | undefined)[] = [],
): PasswordPolicyCode | null {
  if (
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH ||
    !/[a-zA-Z]/.test(password) ||
    !/[0-9]/.test(password)
  ) {
    return "WEAK_PASSWORD";
  }
  if (isGuessable(password) || containsIdentifier(password, identifiers)) {
    return "PASSWORD_GUESSABLE";
  }
  return null;
}

export function isPasswordPolicyCode(value: unknown): value is PasswordPolicyCode {
  return PASSWORD_POLICY_CODES.includes(value as PasswordPolicyCode);
}
