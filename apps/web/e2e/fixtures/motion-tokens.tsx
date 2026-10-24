import "../../src/styles.css";
import { createRoot } from "react-dom/client";

const animations = [
  "animate-panel-in",
  "animate-pop-in",
  "animate-pop-out",
  "animate-msg-in",
  "animate-shimmer",
  "animate-status-pulse",
  "animate-rise",
  "animate-spot-in",
];

createRoot(document.getElementById("root")!).render(
  <div className="grid min-h-screen place-items-center gap-6 bg-app p-8 text-ink">
    <div className="flex flex-wrap gap-3">
      {animations.map((name) => (
        <span
          key={name}
          data-testid="motion-token"
          data-animation={name.replace("animate-", "")}
          className={`${name} rounded-lg bg-raised px-3 py-2 text-ink-secondary`}
        >
          {name}
        </span>
      ))}
      <span
        data-testid="motion-token-variant"
        data-open=""
        className="data-open:animate-pop-in rounded-lg bg-raised px-3 py-2"
      >
        data-open
      </span>
    </div>
    <div data-testid="glass" className="glass-surface w-80 rounded-2xl p-6">
      <p className="chat-copy">Glass surface</p>
    </div>
  </div>,
);
