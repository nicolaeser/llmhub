import createMiddleware from "next-intl/middleware";
import { type NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionCookie } from "@/lib/auth/cookie";
import {
  APP_LOCALES,
  routePathname,
  shouldHardenTransport,
} from "@/lib/http/public-path";
import { sanitizeReturnPath } from "@/lib/auth/return-path";

const AUTH_PATTERN =
  /^\/account\/(login|register|forgot-password|reset-password)(\/|$)/;
const SETUP_PATTERN = /^\/internal-api\/setup(\/|$)/;

const intlMiddleware = createMiddleware({
  locales: [...APP_LOCALES],
  localeDetection: true,
  localePrefix: "never",
  defaultLocale: "en",
});

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const routePath = routePathname(pathname);
  const cookieValue = req.cookies.get(SESSION_COOKIE)?.value ?? null;
  const signedIn = cookieValue ? (await verifySessionCookie(cookieValue)) !== null : false;
  const isProd = process.env.NODE_ENV === "production";
  const pinTransport = shouldHardenTransport(
    req.nextUrl.hostname,
    req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol,
  );
  const nonce = Buffer.from(
    crypto.getRandomValues(new Uint8Array(16)),
  ).toString("base64url");
  const contentSecurityPolicy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  const forwardedHeaders = new Headers(req.headers);
  forwardedHeaders.set("x-nonce", nonce);
  forwardedHeaders.set("content-security-policy", contentSecurityPolicy);

  let response: NextResponse;

  if (!signedIn && !AUTH_PATTERN.test(routePath) && !SETUP_PATTERN.test(routePath)) {
    const loginUrl = new URL("/account/login", req.url);
    loginUrl.searchParams.set("return", routePath);
    response = NextResponse.redirect(loginUrl);
  } else if (signedIn && AUTH_PATTERN.test(routePath)) {
    const dest =
      sanitizeReturnPath(req.nextUrl.searchParams.get("return")) ?? "/";
    response = NextResponse.redirect(new URL(dest, req.url));
  } else {
    const intlResponse = intlMiddleware(req) as NextResponse;
    const locale =
      intlResponse.headers.get("x-middleware-request-x-next-intl-locale") ||
      req.cookies.get("NEXT_LOCALE")?.value ||
      "en";
    forwardedHeaders.set("x-next-intl-locale", locale);
    response = NextResponse.next({
      request: { headers: forwardedHeaders },
    });
    for (const cookie of intlResponse.cookies.getAll()) {
      response.cookies.set(cookie);
    }
  }

  response = forwardRequestHeaders(response, forwardedHeaders);
  response.headers.set("content-security-policy", contentSecurityPolicy);
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("cross-origin-opener-policy", "same-origin");
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );

  if (isProd && pinTransport) {
    response.headers.set(
      "strict-transport-security",
      "max-age=63072000; includeSubDomains; preload",
    );
  }

  return response;
}

function forwardRequestHeaders(
  response: NextResponse,
  requestHeaders: Headers,
): NextResponse {
  const forwardingResponse = NextResponse.next({
    request: { headers: requestHeaders },
  });
  for (const [name, value] of forwardingResponse.headers.entries()) {
    if (
      name === "x-middleware-override-headers" ||
      name.startsWith("x-middleware-request-")
    ) {
      response.headers.set(name, value);
    }
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|apple-icon|internal-api/(?!setup(?:/|$))|api/|v1/|subscription/|scim/|sso/|.*\\.(?:png|jpg|jpeg|svg|gif|ico|webp|woff2?|txt)).*)",
  ],
};
