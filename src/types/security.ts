export type SecondFactorMethod = "TOTP" | "RECOVERY" | "PASSKEY";

export type SessionFactor = SecondFactorMethod | "SSO";

export type ChallengePurpose = "VERIFY" | "ENROLL" | "PASSWORD";

export type SecondFactorProof = { method: "totp" | "recovery"; code: string };

export type LoginChallengeRecord = {
  id: string;
  userId: string;
  purpose: string;
  factor: string | null;
  attempts: number;
  webauthnChallenge: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  user: {
    id: string;
    email: string;
    username: string;
    blocked: boolean;
    mustChangePassword: boolean;
  };
};

export type LoginMethod = "totp" | "recovery" | "passkey";

export type LoginStep =
  | { step: null }
  | { step: "verify"; methods: LoginMethod[]; expiresAt: string }
  | { step: "enroll"; expiresAt: string }
  | { step: "password"; expiresAt: string };

export type LoginResult =
  | Exclude<LoginStep, { step: null }>
  | {
      step: "done";
      method: SecondFactorMethod;
      recoveryCodesRemaining: number | null;
    };

export type LoginFlowStep = LoginStep | LoginResult;

export type LoginContext = {
  step: LoginStep;
  ssoEnabled: boolean;
  passkeysEnabled: boolean;
  registrationEnabled: boolean;
  passwordResetEnabled: boolean;
};

export type TotpEnrollment = {
  secret: string;
  uri: string;
  qrDataUrl: string;
  expiresAt: string;
};

export type EnrollmentConfirmation = {
  recoveryCodes: string[];
  next: LoginResult;
};

export type SecurityEventAction =
  | "2fa.enrolled"
  | "2fa.replaced"
  | "2fa.recovery_regenerated"
  | "2fa.recovery_used"
  | "2fa.locked"
  | "2fa.reset"
  | "password.changed"
  | "password.reset"
  | "password.change_required"
  | "sessions.revoked"
  | "passkey.added"
  | "passkey.removed"
  | "role.changed"
  | "account.blocked"
  | "account.unblocked"
  | "management_key.created"
  | "management_key.revoked";

type SecurityEventActor = "self" | "user" | "system";

export type SecurityEventView = {
  id: string;
  action: SecurityEventAction;
  actor: SecurityEventActor;
  actorName: string | null;
  createdAt: string;
};

export type PasskeyView = {
  id: string;
  name: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};

export type SessionView = {
  id: string;
  current: boolean;
  secondFactor: SessionFactor | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastActive: string;
  expiresAt: string;
};

export type SecurityOverview = {
  user: {
    username: string;
    email: string;
    isOwner: boolean;
    roleName: string | null;
    roleTemplateKey: string | null;
  };
  password: { changedAt: string | null };
  twoFactor: {
    enabledAt: string | null;
    recoveryCodesRemaining: number;
    recoveryCodesTotal: number;
  };
  passkeys: PasskeyView[];
  passkeysAvailable: boolean;
  sessions: SessionView[];
  events: SecurityEventView[];
};

export type PasswordPolicyCode = "WEAK_PASSWORD" | "PASSWORD_GUESSABLE";

export type AttemptLimit = {
  key: string;
  limit: number;
  windowMs: number;
};

export type RequestWindow = {
  count: number;
  resetAt: number;
};

export type AuthCleanupResult = {
  sessions: number;
  challenges: number;
  ceremonies: number;
  enrollments: number;
};
