import { after, NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";
import { isSameOriginRequest } from "@/lib/auth/request-origin";
import { passwordResetEnabled } from "@/lib/auth/self-service";
import { consumeQuota } from "@/lib/auth/throttle";
import { digest, randomToken } from "@/lib/crypto";
import { env } from "@/lib/env";
import { clientIp } from "@/lib/http/api";
import { fieldErrors, problemResponse } from "@/lib/http/problem";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail/send";
import { forgotPasswordSchema } from "@/schemas/auth";

const HOUR_MS = 60 * 60 * 1000;
const TOKEN_TTL_MS = HOUR_MS;

const errorLabel = (err: unknown) =>
  err instanceof Error
    ? "code" in err && typeof err.code === "string"
      ? err.code
      : err.name
    : "unknown";

async function sendResetLink(email: string) {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, blocked: true },
  });
  if (!user || user.blocked) return;
  const token = randomToken();
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
    prisma.passwordResetToken.create({
      data: { userId: user.id, hash: digest(token), expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
    }),
  ]);
  const url = new URL(`/account/reset-password?token=${token}`, env.NEXT_PUBLIC_APP_URL);
  try {
    const result = await sendMail({
      to: user.email,
      subject: "Reset your LLM Hub password",
      text: `Reset your password:\n${url}\n\nThis link expires in one hour.`,
    });
    if (!result.sent) logger.info("auth.reset_token.mail_skipped", { userId: user.id });
  } catch (err) {
    logger.info("auth.reset_token.mail_failed", {
      userId: user.id,
      error: errorLabel(err),
    });
  }
}

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req.headers, env.NEXT_PUBLIC_APP_URL)) {
    return problemResponse(req, "FORBIDDEN");
  }
  if (!passwordResetEnabled()) {
    return problemResponse(req, "RESET_DISABLED");
  }
  const body = forgotPasswordSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return problemResponse(req, "VALIDATION", { errors: fieldErrors(body.error) });
  }
  const email = body.data.email.toLowerCase();
  const ip = clientIp(req.headers) || "unknown";
  const allowed =
    (await consumeQuota(`reset-ip:${ip}`, 10, HOUR_MS)) &&
    (await consumeQuota(`reset:${digest(email)}`, 3, HOUR_MS));
  if (!allowed) {
    return problemResponse(req, "RATE_LIMITED");
  }
  after(() =>
    sendResetLink(email).catch((err) =>
      logger.error("auth.reset_token.failed", { err: errorLabel(err) }),
    ),
  );
  return NextResponse.json({ ok: true });
}
