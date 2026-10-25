import { Plus } from "lucide-react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon } from "./icon.js";

describe("Icon", () => {
  it("draws lucide glyphs at 16px with a 1.75 stroke, hidden from assistive tech", () => {
    const html = renderToString(<Icon icon={Plus} />);
    expect(html).toContain('width="16"');
    expect(html).toContain('stroke-width="1.75"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("lets a chip glyph opt into a smaller size", () => {
    expect(renderToString(<Icon icon={Plus} size={12} />)).toContain('width="12"');
  });
});
