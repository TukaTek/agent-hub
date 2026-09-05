import { Trans } from "@lingui/react/macro";
import { useNavigate } from "react-router-dom";
import { WindowChrome } from "./WindowChrome";

export function WelcomePage() {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-full flex-col bg-background">
      <div className="app-drag flex gap-2 px-5 py-[18px]">
        <WindowChrome />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-11 px-6 pb-[90px]">
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:gap-[26px]">
          <img
            src="/brand/cortexai-icon.png"
            alt="CortexAI logo"
            data-testid="cortexai-logo"
            className="h-[104px] w-[104px] object-contain"
          />
          <div className="text-center text-[48px] leading-none tracking-[-0.03em] text-foreground sm:text-left md:text-[76px]">
            CortexAI Agent Hub
          </div>
        </div>
        <p className="max-w-[600px] text-center text-[27px] leading-[1.4] text-foreground/75">
          <Trans>
            Your team of always-on agents
            <br />
            that you can give real work to.
          </Trans>
        </p>
        <button
          type="button"
          onClick={() => navigate("/sign-up")}
          className="app-no-drag rounded-full bg-brand px-[34px] py-[15px] text-[19px] font-medium text-brand-foreground transition hover:scale-[1.04] hover:bg-brand/90 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand"
        >
          <Trans>Sign up</Trans>&nbsp;&nbsp;→
        </button>
      </div>
    </div>
  );
}
