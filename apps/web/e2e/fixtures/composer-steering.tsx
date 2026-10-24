import { I18nProvider } from "@lingui/react";
import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { applyResolvedAppearance } from "../../src/lib/ui-appearance";
import { Composer } from "../../src/pages/shell/composer";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "idle";
applyResolvedAppearance(params.get("theme") === "dark" ? "dark" : "light");

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <main className="mx-auto flex min-h-screen max-w-[760px] flex-col justify-end bg-background">
        <Composer
          artifactTarget={{ botId: "bot-1" }}
          activeName="Chief"
          running={state !== "idle"}
          pendingAttachments={[]}
          attachmentNotice={null}
          sendError={null}
          onOpenModels={() => {}}
          runError={null}
          runErrorId={null}
          onRunErrorPresented={() => {}}
          onDismissError={() => {}}
          sending={false}
          fileInputRef={createRef()}
          onAttachmentPick={() => true}
          onRemoveAttachment={() => {}}
          onSend={async () => true}
          onStop={async () => {}}
          draftKey="fixture"
          enterToSend={params.get("enter") !== "mod"}
        />
      </main>
    </I18nProvider>,
  );
});
