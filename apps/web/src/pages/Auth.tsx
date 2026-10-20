import {
  credentialIssue,
  HUB_SIGN_IN_REFUSAL_CODES,
  HUB_SSO_ACCESS_DENIED,
  type HubSignInRefusalCode,
  hubRefusalCallbackError,
  readBoundedJsonResponse,
  type SignInContinueResponse,
  type SsoCallbackError,
  signupRequiresEmailVerification,
} from "@cortexai-agent-hub/core";
import { Button, Input, Label } from "@cortexai-agent-hub/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth";
import type { AuthCapabilities } from "../lib/auth-capabilities";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { desktopBridge } from "../lib/desktop";
import { clearSpaceSelection } from "../lib/rpc";
import { runSsoFlow } from "../lib/sso-flow";
import { authErrorText, credentialIssueText } from "../lib/user-error";
import { WelcomePage } from "./Welcome";

type AuthMode = "in" | "up" | "forgot";
type SignInStep =
  | "email"
  | Exclude<SignInContinueResponse["next"], "redirect">
  | "desktop_sso_unavailable";

const fieldClass =
  "mt-2 h-12 rounded-xl px-4 text-base focus-visible:border-brand focus-visible:ring-brand/30 md:text-base";
export const submitClass =
  "mt-3 h-12 w-full rounded-xl bg-brand text-base font-semibold text-brand-foreground hover:bg-brand/90 focus-visible:border-brand focus-visible:ring-brand/40";
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;

export function AuthPage({ mode: requestedMode }: { mode: AuthMode | "entry" }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const hubUnavailable = t`Sign-in is temporarily unavailable, CortexAI Hub can't be reached`;
  const ssoErrors: Record<SsoCallbackError, string> = {
    sso_expired: t`Your sign-in expired. Try again.`,
    sso_failed: t`Microsoft sign-in didn't finish. Try again, or ask your admin for access.`,
    hub_unavailable: hubUnavailable,
    hub_config_invalid: hubUnavailable,
    hub_config_restart_required: hubUnavailable,
    tenant_disabled: hubUnavailable,
    hub_credential_invalid: hubUnavailable,
    hub_not_configured: hubUnavailable,
    hub_access_denied: t`Ask your admin for access`,
  };
  /** Fixed copy for a sign-in Hub policy refused (CAAH-36), or undefined. */
  const hubRefusal = (code: unknown) =>
    HUB_SIGN_IN_REFUSAL_CODES.includes(code as HubSignInRefusalCode)
      ? ssoErrors[hubRefusalCallbackError(code as HubSignInRefusalCode)]
      : undefined;
  const [error, setError] = useState<string | null>(() => {
    const code = searchParams.get("error");
    if (!code) return null;
    // Unknown codes stay silent: the query string is attacker-controlled.
    return Object.hasOwn(ssoErrors, code)
      ? ssoErrors[code as SsoCallbackError]
      : authErrorText({ code }, "") || null;
  });
  const [pending, setPending] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  // Signup triggers a session refresh that remounts the anonymous auth page.
  const sent = resetSent || searchParams.get("verify") === "email";
  const [reset, setReset] = useState<AuthCapabilities | null>(null);
  const hubMode = reset?.mode === "hub";
  const mode = hubMode || requestedMode === "entry" ? "in" : requestedMode;
  // Hub mode always signs in with an email first, then Hub picks the method.
  const passwordForm = Boolean(reset?.passwordAuth || hubMode);
  const [capabilityError, setCapabilityError] = useState(false);
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const [step, setStep] = useState<SignInStep>("email");
  const signInStep = mode === "in" ? step : null;
  const signInUnavailable =
    signInStep === "sso_unavailable" ||
    signInStep === "other_sso_unavailable" ||
    signInStep === "desktop_sso_unavailable";
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const passwordFieldId = mode === "in" ? "current-password" : "new-password";
  const title = sent ? (
    <Trans>Check your email</Trans>
  ) : mode === "in" ? (
    <Trans>Sign in to CortexAI Agent Hub</Trans>
  ) : mode === "up" ? (
    <Trans>Create your CortexAI Agent Hub</Trans>
  ) : (
    <Trans>Reset your password</Trans>
  );

  useEffect(() => {
    setReset(null);
    setCapabilityError(false);
    let active = true;
    void fetchAuthCapabilities()
      .then((capabilities) => {
        if (active) setReset(capabilities);
      })
      .catch(() => {
        if (active) setCapabilityError(true);
      });
    return () => {
      // Do not abort on unmount: a guard redirect that bounces through this
      // page only mounts it for a render or two, and the cancelled fetch then
      // surfaces as a failed request. `active` drops the result; the request
      // keeps its own time bound.
      active = false;
    };
  }, [mode, capabilityAttempt]);

  useEffect(() => {
    if (signInStep === "password") passwordRef.current?.focus();
  }, [signInStep]);

  function changeEmail() {
    setStep("email");
    setPassword("");
    setError(null);
    emailRef.current?.focus();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (signInUnavailable || !passwordForm) return;
    const issue = credentialIssue({
      email,
      password: mode === "forgot" || signInStep === "email" ? undefined : password,
    });
    if (issue) {
      setError(credentialIssueText(issue));
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (signInStep === "email") {
        const response = await fetch("/api/auth/hub/sign-in/continue", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: email.trim() }),
        });
        if (response.status === 403 || response.status === 503) {
          const refusal = await readBoundedJsonResponse<{ code?: unknown }>(
            response,
            MAX_AUTH_RESPONSE_BYTES,
          ).catch(() => undefined);
          setError(
            hubRefusal(refusal?.code) ??
              (refusal?.code === HUB_SSO_ACCESS_DENIED
                ? ssoErrors.sso_failed
                : t`Could not continue`),
          );
          return;
        }
        const result = response.ok
          ? await readBoundedJsonResponse<SignInContinueResponse>(response, MAX_AUTH_RESPONSE_BYTES)
          : undefined;
        const next = result?.next;
        if (result?.next === "redirect") {
          // Electron hands off-origin navigation to the system browser, which
          // cannot complete an app sign-in, so desktop SSO waits for CAAH-44.
          if (desktopBridge()) setStep("desktop_sso_unavailable");
          else if (URL.canParse(result.url) && new URL(result.url).protocol === "https:")
            window.location.assign(result.url);
          else setError(t`Could not continue`);
        } else if (
          next === "password" ||
          next === "sso_unavailable" ||
          next === "other_sso_unavailable"
        )
          setStep(next);
        else setError(t`Could not continue`);
        return;
      }
      if (hubMode) {
        const response = await fetch("/api/auth/hub/sign-in", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: email.trim(), password }),
        });
        if (!response.ok) {
          const body = await readBoundedJsonResponse<{ code?: string }>(
            response,
            MAX_AUTH_RESPONSE_BYTES,
          );
          setError(
            hubRefusal(body.code) ??
              (body.code === "HUB_IDP_UNSUPPORTED"
                ? t`This organization’s sign-in method is not supported yet`
                : t`Could not sign in through CortexAI Hub`),
          );
          return;
        }
        clearSpaceSelection();
        window.location.assign("/app");
        return;
      }
      if (mode === "forgot") {
        if (!reset?.passwordReset || !reset.resetUrl) {
          setError(t`Password recovery is not configured for this server`);
          return;
        }
        const result = await authClient.requestPasswordReset({
          email: email.trim(),
          redirectTo: reset.resetUrl,
        });
        if (result.error) {
          setError(authErrorText(result.error, t`Could not send reset email`));
          return;
        }
        setResetSent(true);
        return;
      }
      const trimmedEmail = email.trim();
      const result =
        mode === "up"
          ? await authClient.signUp.email({
              email: trimmedEmail,
              password,
              name: name || trimmedEmail.split("@")[0] || "User",
            })
          : await authClient.signIn.email({ email: trimmedEmail, password });
      if (result.error) {
        setError(authErrorText(result.error, t`Could not continue`));
        return;
      }
      if (mode === "up" && signupRequiresEmailVerification(result.data)) {
        setSearchParams({ verify: "email" });
        return;
      }
      clearSpaceSelection();
      navigate(
        mode === "up"
          ? "/onboarding"
          : searchParams.get("next") === "/integrations/setup"
            ? "/integrations/setup"
            : "/app",
      );
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  async function signInWithSso() {
    setError(null);
    try {
      const result = await runSsoFlow(
        (disableRedirect, callbackURL) =>
          authClient.signIn.social({
            disableRedirect,
            provider: "oidc",
            newUserCallbackURL: callbackURL("/onboarding"),
            callbackURL: callbackURL(
              searchParams.get("next") === "/integrations/setup" ? "/integrations/setup" : "/app",
            ),
            errorCallbackURL: callbackURL("/sign-in"),
          }),
        ["/app", "/onboarding", "/integrations/setup", "/sign-in"],
      );
      if (result.error) setError(authErrorText(result.error, t`Could not continue`));
    } catch {
      setError(t`Could not continue`);
    }
  }

  if (requestedMode === "entry" && reset) {
    return reset.mode === "hub" ? <Navigate to="/sign-in" replace /> : <WelcomePage />;
  }

  if (!reset) {
    return (
      <AuthFrame onSubmit={(event) => event.preventDefault()} title={title}>
        {capabilityError ? (
          <div role="alert" className="w-full text-center">
            <p>
              <Trans>Could not load sign-in options</Trans>
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCapabilityAttempt((attempt) => attempt + 1)}
            >
              <Trans>Retry</Trans>
            </Button>
          </div>
        ) : (
          <Button disabled className={submitClass}>
            <Trans>Loading…</Trans>
          </Button>
        )}
      </AuthFrame>
    );
  }

  return (
    <AuthFrame onSubmit={submit} title={title}>
      {sent ? (
        <div className="w-full text-center">
          <Link to="/sign-in" className="font-medium text-foreground">
            <Trans>Back to sign in</Trans>
          </Link>
        </div>
      ) : !passwordForm ? (
        <>
          {reset.sso && mode !== "forgot" ? (
            <Button
              type="button"
              disabled={pending}
              className={submitClass}
              onClick={() => void signInWithSso()}
            >
              <Trans>Continue with {reset.sso.name}</Trans>
            </Button>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <>
          {mode === "up" ? (
            <div className="mb-4 w-full">
              <Label htmlFor="name" className="text-muted-foreground">
                <Trans>Name</Trans>
              </Label>
              <Input
                id="name"
                name="name"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t`Your name`}
                className={fieldClass}
              />
            </div>
          ) : null}
          <div className="w-full">
            <Label htmlFor="email" className="text-muted-foreground">
              <Trans>Email</Trans>
            </Label>
            <Input
              ref={emailRef}
              id="email"
              name="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t`Your email address`}
              type="email"
              required
              readOnly={
                signInUnavailable ||
                signInStep === "password" ||
                (signInStep === "email" && pending)
              }
              className={fieldClass}
            />
            {signInStep === "password" || signInUnavailable ? (
              <div className="mt-2 text-right text-sm">
                <Button
                  type="button"
                  variant="link"
                  onClick={changeEmail}
                  className="h-auto p-0 font-medium text-foreground"
                >
                  <Trans>Use a different email</Trans>
                </Button>
              </div>
            ) : null}
          </div>
          {signInStep === "sso_unavailable" ? (
            <p role="status" className="mt-4 w-full text-sm text-muted-foreground">
              <Trans>
                Microsoft sign-in for your organization isn't available in Agent Hub yet. Ask your
                admin to enable password sign-in for your account.
              </Trans>
            </p>
          ) : null}
          {signInStep === "desktop_sso_unavailable" ? (
            <p role="status" className="mt-4 w-full text-sm text-muted-foreground">
              <Trans>
                Microsoft sign-in isn't available in the desktop app yet. Open Agent Hub in your
                browser.
              </Trans>{" "}
              <span className="select-all font-medium text-foreground">
                {window.location.origin}
              </span>
            </p>
          ) : null}
          {signInStep === "other_sso_unavailable" ? (
            <p role="status" className="mt-4 w-full text-sm text-muted-foreground">
              <Trans>
                Single sign-on for your organization isn't available in Agent Hub yet. Ask your
                admin to enable password sign-in for your account.
              </Trans>
            </p>
          ) : null}
          {mode !== "forgot" && (signInStep === null || signInStep === "password") ? (
            <div className="mt-4 w-full">
              <Label htmlFor={passwordFieldId} className="text-muted-foreground">
                <Trans>Password</Trans>
              </Label>
              <Input
                ref={passwordRef}
                id={passwordFieldId}
                name="password"
                autoComplete={mode === "in" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t`Password`}
                type="password"
                required
                minLength={8}
                className={fieldClass}
              />
              {mode === "in" && reset?.passwordReset ? (
                <div className="mt-2 text-right text-sm">
                  <Link to="/forgot-password" className="font-medium text-foreground">
                    <Trans>Forgot password?</Trans>
                  </Link>
                </div>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 w-full text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {signInUnavailable ? null : (
            <Button type="submit" size="lg" disabled={pending} className={submitClass}>
              {pending ? (
                <Trans>Working…</Trans>
              ) : signInStep === "email" ? (
                <Trans>Continue</Trans>
              ) : signInStep === "password" ? (
                <Trans>Sign in</Trans>
              ) : mode === "forgot" ? (
                <Trans>Send reset link</Trans>
              ) : (
                <Trans>Create account</Trans>
              )}
            </Button>
          )}
          {reset.sso && mode !== "forgot" ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              disabled={pending}
              className="mt-3 text-muted-foreground"
              onClick={() => void signInWithSso()}
            >
              <Trans>Continue with {reset.sso.name}</Trans>
            </Button>
          ) : null}
          {!hubMode ? (
            <p className="mt-8 text-muted-foreground">
              {mode === "in" ? (
                <>
                  <Trans>Don’t have an account?</Trans>{" "}
                  <Link to="/sign-up" className="font-medium text-foreground">
                    <Trans>Sign up</Trans>
                  </Link>
                </>
              ) : mode === "up" ? (
                <>
                  <Trans>Already have an account?</Trans>{" "}
                  <Link to="/sign-in" className="font-medium text-foreground">
                    <Trans>Sign in</Trans>
                  </Link>
                </>
              ) : (
                <Link to="/sign-in" className="font-medium text-foreground">
                  <Trans>Back to sign in</Trans>
                </Link>
              )}
            </p>
          ) : null}
        </>
      )}
    </AuthFrame>
  );
}

export function PasswordResetPage() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(
    params.get("error") || !params.get("token") ? t`This reset link is invalid or expired` : null,
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const token = params.get("token");
    if (!token) return;
    if (password !== confirmation) {
      setError(t`Passwords do not match`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        setError(authErrorText(result.error, t`Could not reset password`));
        return;
      }
      setComplete(true);
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthFrame onSubmit={submit} title={<Trans>Choose a new password</Trans>}>
      {complete ? (
        <div role="status" className="w-full text-center">
          <p className="text-lg">
            <Trans>Password updated</Trans>
          </p>
          <Link to="/sign-in" className="mt-6 inline-block font-medium">
            <Trans>Sign in</Trans>
          </Link>
        </div>
      ) : (
        <>
          <PasswordField
            id="new-password"
            label={t`New password`}
            value={password}
            onChange={setPassword}
          />
          <PasswordField
            id="confirm-password"
            label={t`Confirm password`}
            value={confirmation}
            onChange={setConfirmation}
            className="mt-4"
          />
          {error ? (
            <p role="alert" className="mt-3 w-full text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            disabled={pending || !params.get("token")}
            className={submitClass}
          >
            {pending ? <Trans>Working…</Trans> : <Trans>Reset password</Trans>}
          </Button>
          <Link to="/sign-in" className="mt-6 font-medium">
            <Trans>Back to sign in</Trans>
          </Link>
        </>
      )}
    </AuthFrame>
  );
}

export function AuthFrame({
  title,
  onSubmit,
  children,
}: {
  title: React.ReactNode;
  onSubmit: (event: React.FormEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden bg-brand-surface px-5 py-10 text-brand-surface-foreground sm:px-6 sm:py-16">
      <div
        aria-hidden="true"
        className="absolute -left-24 -top-24 h-80 w-80 rounded-full bg-brand/10 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="absolute -bottom-32 -right-20 h-96 w-96 rounded-full bg-brand/8 blur-3xl"
      />
      <form
        onSubmit={onSubmit}
        className="relative flex w-full max-w-[500px] flex-col items-center rounded-[28px] border border-white/10 bg-card px-6 py-9 text-card-foreground shadow-2xl shadow-black/30 sm:px-10 sm:py-11"
      >
        <img
          src="/brand/cortexai-icon.png"
          alt="CortexAI logo"
          data-testid="cortexai-logo"
          className="h-[82px] w-[82px] object-contain"
        />
        <h1
          aria-live="polite"
          className="mb-9 mt-6 w-full text-center text-3xl font-medium tracking-tight sm:text-4xl"
        >
          {title}
        </h1>
        {children}
      </form>
    </div>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  className = "",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={`w-full ${className}`}>
      <Label htmlFor={id} className="text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        name={id}
        autoComplete="new-password"
        type="password"
        required
        minLength={8}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={fieldClass}
      />
    </div>
  );
}
