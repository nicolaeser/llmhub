import { after, NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/prisma";
import { isSameOriginRequest } from "@/lib/auth/request-origin";
import { passwordResetEnabled } from "@/lib/auth/self-service";
import { consumeQuota } from "@/lib/auth/throttle";
import { digest, randomToken } from "@/lib/crypto";
import { env } from "@/lib/env";
import { clientBucket, clientIp } from "@/lib/http/client-ip";
import { fieldErrors, problemResponse } from "@/lib/http/problem";
import { logger } from "@/lib/logging/logger";
import { renderMailHtml } from "@/lib/mail/html";
import { sendMail } from "@/lib/mail/send";
import { readJsonOr } from "@/lib/utils/json";
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
      html: renderMailHtml({
        lang: "en",
        brand: "LLM Hub",
        title: "Reset your password",
        intro: "Use the button below to choose a new password for your LLM Hub account.",
        action: { label: "Reset password", href: url.toString() },
        paragraphs: [`If the button does not work, open this link: ${url}`],
        footer: "This link expires in one hour. If you did not ask for a reset, ignore this e-mail.",
      }),
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
  const body = forgotPasswordSchema.safeParse(await readJsonOr(req, {}));
  if (!body.success) {
    return problemResponse(req, "VALIDATION", { errors: fieldErrors(body.error) });
  }
  const email = body.data.email.toLowerCase();
  const client = clientBucket(clientIp(req.headers));
  const allowed =
    (await consumeQuota(`reset-ip:${client}`, 10, HOUR_MS)) &&
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
