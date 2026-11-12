import type { WebColorTokens } from "@cortexai-agent-hub/ui-tokens";
import {
  cssVariableName,
  pageKitPalette,
  renderTokensCss,
  webLightTokens,
} from "@cortexai-agent-hub/ui-tokens";
import { CALENDAR_CSS } from "./calendar.js";
import { CONTROLS_CSS } from "./controls.js";
import { DATAVIZ_CSS } from "./dataviz-styles.js";
import { MEDIA_CSS } from "./media.js";
import { TEXT_KIT_CSS } from "./text.js";

// Print is always light: paper has no dark mode, and shadows print as grey smudges.
const printTokens = (Object.keys(webLightTokens) as (keyof WebColorTokens)[])
  .map((token) => `${cssVariableName(token)}:${webLightTokens[token]};`)
  .join("");

const palette = (tones: (typeof pageKitPalette)["dark" | "light"]) =>
  Object.entries(tones)
    .map(([name, value]) => `--rk-${name}:${value};`)
    .join("");
const DARK_PALETTE = palette(pageKitPalette.dark);
const LIGHT_PALETTE = palette(pageKitPalette.light);

// Sizes are in rem so the whole page steps up together on wide screens.
const KIT_CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{--cortexai-agent-hub-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",sans-serif;--cortexai-agent-hub-secondary:color-mix(in srgb,var(--foreground) 60%,transparent);--cortexai-agent-hub-tertiary:color-mix(in srgb,var(--foreground) 40%,transparent);--cortexai-agent-hub-line:color-mix(in srgb,var(--foreground) 15%,transparent);--cortexai-agent-hub-hairline:color-mix(in srgb,var(--foreground) 9%,transparent);--cortexai-agent-hub-track:color-mix(in srgb,var(--foreground) 8%,transparent);--cortexai-agent-hub-fill:color-mix(in srgb,var(--foreground) 7%,transparent);${DARK_PALETTE}}
[data-theme="light"]{${LIGHT_PALETTE}--cortexai-agent-hub-secondary:color-mix(in srgb,var(--foreground) 64%,transparent);--cortexai-agent-hub-on-c5:${pageKitPalette.shared.onDeepTone}}
:root{--cortexai-agent-hub-on-c1:${pageKitPalette.shared.onTone};--cortexai-agent-hub-on-c2:${pageKitPalette.shared.onTone};--cortexai-agent-hub-on-c3:${pageKitPalette.shared.onTone};--cortexai-agent-hub-on-c4:${pageKitPalette.shared.onTone};--cortexai-agent-hub-on-c5:${pageKitPalette.shared.onTone}}
html{font-size:16px}
html,body{margin:0;background:var(--background);color:var(--foreground);font-family:var(--cortexai-agent-hub-font);line-height:1.5;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;-webkit-text-size-adjust:100%}
body{font-size:1rem}
.cortexai-agent-hub-page{max-width:calc(700px + 6rem);margin:0 auto;padding:2.25rem 3rem calc(2.5rem + var(--cortexai-agent-hub-bottom-inset,0px));display:flex;flex-direction:column;gap:1rem}
.cortexai-agent-hub-page[data-width="wide"]{max-width:calc(1280px + 6rem)}
.cortexai-agent-hub-page[data-width="full"]{max-width:none}
.cortexai-agent-hub-header{display:flex;flex-direction:column;gap:.75rem;margin-bottom:1.75rem}
.cortexai-agent-hub-title{margin:0;font-size:1.875rem;line-height:1.2;font-weight:600;letter-spacing:-0.012em;overflow-wrap:anywhere}
.cortexai-agent-hub-summary{margin:0;font-size:1rem;line-height:1.5}
.cortexai-agent-hub-section{min-width:0;display:flex;flex-direction:column;gap:0.9rem}
.cortexai-agent-hub-page>.cortexai-agent-hub-section{margin-bottom:.5rem}
.cortexai-agent-hub-page>:not(.cortexai-agent-hub-header)+.cortexai-agent-hub-section[data-headed]{margin-top:1.25rem}
.cortexai-agent-hub-section-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:0.6rem 1.2rem}
.cortexai-agent-hub-actions{display:flex;flex-wrap:wrap;align-items:flex-end;gap:.5rem 1rem}
.cortexai-agent-hub-heading{margin:0;font-size:1.5rem;line-height:1.25;font-weight:500;letter-spacing:-0.01em}
.cortexai-agent-hub-section .cortexai-agent-hub-section .cortexai-agent-hub-heading{font-size:1.25rem}
.cortexai-agent-hub-section[data-card]{padding:1.125rem 1.125rem 1.25rem;border:1px solid var(--cortexai-agent-hub-line);border-radius:16px;gap:0.96rem}
.cortexai-agent-hub-section[data-card]>.cortexai-agent-hub-section-head .cortexai-agent-hub-heading{font-size:1rem;line-height:1.3;font-weight:600;letter-spacing:0}
.cortexai-agent-hub-caption{margin:-.4rem 0 0;font-size:.875rem;line-height:1.4;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-grid{display:grid;gap:1rem;align-items:stretch;grid-template-columns:repeat(var(--cortexai-agent-hub-columns),minmax(0,1fr))}
.cortexai-agent-hub-text{margin:0;font-size:1rem;line-height:1.5;overflow-wrap:anywhere}
.cortexai-agent-hub-link{color:var(--cortexai-agent-hub-accent);text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 40%,transparent);text-underline-offset:2px;overflow-wrap:anywhere}
.cortexai-agent-hub-code{padding:.05em .3em;border-radius:4px;background:var(--cortexai-agent-hub-fill);font:.875em/1 ui-monospace,SFMono-Regular,Menlo,monospace}
.cortexai-agent-hub-callout{padding:.875rem 1rem;border-radius:12px;background:var(--cortexai-agent-hub-fill);font-size:1rem;line-height:1.5;overflow-wrap:anywhere}
.cortexai-agent-hub-callout p{margin:0}
.cortexai-agent-hub-callout-lead{font-weight:600}
.cortexai-agent-hub-callout[data-tone]{background:color-mix(in srgb,var(--cortexai-agent-hub-tone) 14%,transparent)}
.cortexai-agent-hub-callout[data-tone] .cortexai-agent-hub-callout-lead{color:var(--cortexai-agent-hub-tone)}
.cortexai-agent-hub-callout[data-tone="info"]{--cortexai-agent-hub-tone:var(--cortexai-agent-hub-accent)}
.cortexai-agent-hub-callout[data-tone="success"]{--cortexai-agent-hub-tone:var(--cortexai-agent-hub-success)}
.cortexai-agent-hub-callout[data-tone="warning"]{--cortexai-agent-hub-tone:var(--cortexai-agent-hub-warning)}
.cortexai-agent-hub-callout[data-tone="danger"]{--cortexai-agent-hub-tone:var(--cortexai-agent-hub-danger)}
.cortexai-agent-hub-metrics{display:grid;gap:1rem 1.75rem;grid-template-columns:repeat(auto-fit,minmax(max(min(100%,var(--cortexai-agent-hub-metric-min,7rem)),calc((100% - (var(--cortexai-agent-hub-columns) - 1) * 1.75rem) / var(--cortexai-agent-hub-columns))),1fr));padding-top:.5rem}
.cortexai-agent-hub-metric{min-width:0}
.cortexai-agent-hub-metric-value{font-size:1.5rem;line-height:1.875rem;font-weight:500;letter-spacing:-.016em;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.cortexai-agent-hub-metric-label{margin-top:.5rem;font-size:.875rem;line-height:1.25rem;letter-spacing:.006em}
.cortexai-agent-hub-metric-detail{margin-top:.25rem;font-size:.875rem;line-height:1.25rem;letter-spacing:.006em;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-delta{display:inline-flex;align-items:baseline;gap:.25rem;font-weight:500;font-variant-numeric:tabular-nums}
.cortexai-agent-hub-metric-detail-note{color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-spark{display:block;width:100%;max-width:9rem;height:1.5rem;margin-top:.5rem;overflow:visible}
.cortexai-agent-hub-spark polyline{fill:none;stroke:var(--cortexai-agent-hub-c1);stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}
.cortexai-agent-hub-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.cortexai-agent-hub-tone-success{color:var(--cortexai-agent-hub-success)}
.cortexai-agent-hub-tone-warning{color:var(--cortexai-agent-hub-warning)}
.cortexai-agent-hub-tone-danger{color:var(--cortexai-agent-hub-danger)}
.cortexai-agent-hub-tone-accent{color:var(--cortexai-agent-hub-accent)}
.cortexai-agent-hub-status{display:inline-flex;align-items:center;gap:.375rem;max-width:100%;padding:.125rem .5rem;border-radius:999px;background:var(--cortexai-agent-hub-fill-strong);font-size:.75rem;line-height:1rem;font-weight:500;letter-spacing:.01em;color:var(--cortexai-agent-hub-secondary);vertical-align:middle;white-space:nowrap}
.cortexai-agent-hub-status-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--cortexai-agent-hub-tertiary)}
.cortexai-agent-hub-status[class*="cortexai-agent-hub-tone-"]{background:color-mix(in srgb,currentColor 17%,transparent)}
.cortexai-agent-hub-status[class*="cortexai-agent-hub-tone-"] .cortexai-agent-hub-status-dot{background:currentColor}
.cortexai-agent-hub-status-text{min-width:0;overflow:hidden;text-overflow:ellipsis}
.cortexai-agent-hub-properties{display:grid;grid-template-columns:fit-content(40%) minmax(0,1fr);gap:.5rem .75rem;margin:0}
.cortexai-agent-hub-properties[data-card]{padding:1rem 1.125rem;border:1px solid var(--cortexai-agent-hub-line);border-radius:16px}
.cortexai-agent-hub-property{display:grid;grid-column:1/-1;grid-template-columns:subgrid;align-items:baseline;font-size:.875rem;line-height:1.25rem;letter-spacing:.006em}
.cortexai-agent-hub-property dt{min-width:6rem;color:var(--cortexai-agent-hub-secondary);overflow-wrap:anywhere}
.cortexai-agent-hub-property dd{margin:0;min-width:0;overflow-wrap:anywhere}
.cortexai-agent-hub-rows,.cortexai-agent-hub-checklist{margin:0;padding:0;list-style:none}
.cortexai-agent-hub-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0 .75rem;align-items:start;padding:.625rem 0;border-top:1px solid var(--cortexai-agent-hub-hairline-soft)}
.cortexai-agent-hub-row-lead{max-width:33vw;color:var(--cortexai-agent-hub-axis);font-size:1rem;line-height:1.5rem;font-variant-numeric:tabular-nums}
.cortexai-agent-hub-row-main{min-width:0}
.cortexai-agent-hub-row-title{font-size:1rem;line-height:1.5rem;letter-spacing:.006em;overflow-wrap:anywhere}
.cortexai-agent-hub-row-status{font-weight:500;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-row-detail{font-size:.875rem;line-height:1.25rem;letter-spacing:.006em;color:var(--cortexai-agent-hub-secondary);overflow-wrap:anywhere}
.cortexai-agent-hub-row-meta{max-width:45vw;padding-top:.125rem;font-size:.875rem;line-height:1.25rem;color:var(--cortexai-agent-hub-axis);text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.cortexai-agent-hub-steps{display:flex;flex-direction:column;gap:1rem;margin:0;padding:0;list-style:none}
.cortexai-agent-hub-step{display:flex;gap:.8rem;align-items:flex-start}
.cortexai-agent-hub-step-number{flex:none;display:grid;place-items:center;width:1.6rem;height:1.6rem;border-radius:50%;background:var(--cortexai-agent-hub-fill);font-size:.8125rem;font-weight:500;font-variant-numeric:tabular-nums;line-height:1}
.cortexai-agent-hub-step-title{font-size:1rem;line-height:1.6rem;font-weight:500}
.cortexai-agent-hub-step-detail{font-size:.875rem;line-height:1.45;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-checklist li{padding:.55rem 0;border-top:1px solid var(--cortexai-agent-hub-hairline)}
.cortexai-agent-hub-checklist li:first-child{border-top:0;padding-top:0}
.cortexai-agent-hub-check input{position:absolute;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}
.cortexai-agent-hub-check{position:relative;display:flex;align-items:flex-start;gap:.65rem;font-size:1rem;line-height:1.45}
.cortexai-agent-hub-check-mark{flex:none;width:1.1rem;height:1.1rem;margin-top:.13rem;fill:none;stroke:var(--cortexai-agent-hub-tertiary);stroke-width:1.5}
.cortexai-agent-hub-check[data-done="true"] .cortexai-agent-hub-check-mark circle{fill:var(--cortexai-agent-hub-success);stroke:var(--cortexai-agent-hub-success)}
.cortexai-agent-hub-check[data-done="true"] .cortexai-agent-hub-check-mark path{stroke:var(--background);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.cortexai-agent-hub-check[data-done="true"] .cortexai-agent-hub-check-text{color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-check-meta{margin:.1rem 0 0 1.75rem;font-size:.8125rem;line-height:1.4;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-table-wrap{display:flex;flex-direction:column;gap:.5rem;min-width:0}
.cortexai-agent-hub-table-filter{align-self:flex-start;width:min(16rem,100%);height:1.75rem;padding:0 .625rem;border:1px solid var(--cortexai-agent-hub-line);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:.8125rem}
.cortexai-agent-hub-table-filter::placeholder{color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-table-filter:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.cortexai-agent-hub-table-box{border:1px solid var(--cortexai-agent-hub-line);border-radius:12px;overflow:hidden}
.cortexai-agent-hub-section[data-card] .cortexai-agent-hub-table-box{border-radius:8px}
.cortexai-agent-hub-table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;--cortexai-agent-hub-fade-start:${pageKitPalette.shared.mask};--cortexai-agent-hub-fade-end:${pageKitPalette.shared.mask};-webkit-mask-image:linear-gradient(to right,var(--cortexai-agent-hub-fade-start),${pageKitPalette.shared.mask} 2.5rem,${pageKitPalette.shared.mask} calc(100% - 2.5rem),var(--cortexai-agent-hub-fade-end));mask-image:linear-gradient(to right,var(--cortexai-agent-hub-fade-start),${pageKitPalette.shared.mask} 2.5rem,${pageKitPalette.shared.mask} calc(100% - 2.5rem),var(--cortexai-agent-hub-fade-end))}
.cortexai-agent-hub-table-scroll[data-fade-start]{--cortexai-agent-hub-fade-start:transparent}
.cortexai-agent-hub-table-scroll[data-fade-end]{--cortexai-agent-hub-fade-end:transparent}
.cortexai-agent-hub-table-scroll[data-long]{max-height:34rem;overflow-y:auto}
.cortexai-agent-hub-table-box:has(.cortexai-agent-hub-table-scroll:focus-visible){outline:2px solid var(--ring);outline-offset:2px}
.cortexai-agent-hub-table-scroll:focus-visible{outline:0}
.cortexai-agent-hub-table{width:100%;border-collapse:separate;border-spacing:0;font-size:.9375rem;line-height:1.375rem;letter-spacing:.006em}
.cortexai-agent-hub-table th,.cortexai-agent-hub-table td{padding:.5rem .625rem;border-left:1px solid var(--cortexai-agent-hub-line);border-top:1px solid var(--cortexai-agent-hub-line);text-align:left;vertical-align:middle}
.cortexai-agent-hub-table th{font-size:.875rem;line-height:1.25rem;font-weight:500;white-space:nowrap;border-top:0;background:var(--background)}
.cortexai-agent-hub-table-scroll[data-long] thead th{position:sticky;top:0;z-index:1;box-shadow:0 1px 0 var(--cortexai-agent-hub-line)}
.cortexai-agent-hub-table tr>:first-child{border-left:0}
.cortexai-agent-hub-table tbody tr:hover td{background:var(--cortexai-agent-hub-hover)}
.cortexai-agent-hub-table .cortexai-agent-hub-align-end{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.cortexai-agent-hub-table .cortexai-agent-hub-align-center{text-align:center}
.cortexai-agent-hub-table .cortexai-agent-hub-emphasis{font-weight:500}
.cortexai-agent-hub-table-none{color:var(--cortexai-agent-hub-axis);text-align:center!important}
.cortexai-agent-hub-sort{all:unset;display:inline-flex;align-items:center;gap:.25rem;cursor:pointer;border-radius:4px}
.cortexai-agent-hub-sort:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.cortexai-agent-hub-sort-mark{opacity:0;color:var(--cortexai-agent-hub-tertiary);transition:opacity .14s,transform .14s}
.cortexai-agent-hub-sort:hover .cortexai-agent-hub-sort-mark,.cortexai-agent-hub-sort-mark[data-on]{opacity:1}
.cortexai-agent-hub-table-more{display:flex;align-items:center;justify-content:space-between;gap:1rem;font-size:.8125rem;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-table-more button{height:1.75rem;padding:0 .75rem;border:0;border-radius:8px;background:var(--cortexai-agent-hub-fill-strong);color:var(--foreground);font:inherit;cursor:pointer}
.cortexai-agent-hub-table-more button:hover{background:var(--cortexai-agent-hub-hover-strong)}
.cortexai-agent-hub-table-more button:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.cortexai-agent-hub-segmented{display:flex;flex-wrap:wrap;align-self:flex-start;max-width:100%;gap:.3rem .85rem}
.cortexai-agent-hub-segmented{min-width:0;margin:0;padding:0;border:0;display:flex;flex-wrap:wrap;align-self:flex-start;max-width:100%;gap:16px}
.cortexai-agent-hub-segmented button{appearance:none;display:block;border:0;margin:0;padding:0;background:transparent;color:var(--cortexai-agent-hub-secondary);font:inherit;font-size:13px;line-height:18px;letter-spacing:.195px;white-space:nowrap;cursor:pointer;transition:color .14s}
.cortexai-agent-hub-segment{display:inline-block;padding:2px 0;border-bottom:1px solid transparent;transition:border-color .14s}
.cortexai-agent-hub-segment-count{margin-left:5px;font-size:12px;line-height:16px;letter-spacing:.12px;color:var(--cortexai-agent-hub-secondary);font-variant-numeric:tabular-nums}
.cortexai-agent-hub-segmented button:hover{color:color-mix(in srgb,var(--foreground) 80%,transparent)}
.cortexai-agent-hub-segmented button[aria-pressed="true"]{color:var(--foreground);font-weight:500}
.cortexai-agent-hub-segmented button[aria-pressed="true"] .cortexai-agent-hub-segment{border-bottom-color:currentColor}
.cortexai-agent-hub-segmented button:focus-visible{outline:2px solid var(--ring);outline-offset:2px;border-radius:2px}
.cortexai-agent-hub-chart{display:flex;flex-direction:column;gap:.75rem;min-width:0}
.cortexai-agent-hub-chart svg{display:block;width:100%;overflow:visible}
.cortexai-agent-hub-line{fill:none;stroke:var(--cortexai-agent-hub-series,var(--cortexai-agent-hub-c1));stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.cortexai-agent-hub-line-dot{fill:var(--cortexai-agent-hub-series,var(--cortexai-agent-hub-c1))}
.cortexai-agent-hub-line-value{fill:var(--foreground);font-size:12px;font-weight:500;font-variant-numeric:tabular-nums}
.cortexai-agent-hub-line-secondary{fill:none;stroke:var(--cortexai-agent-hub-other);stroke-width:1.25;stroke-dasharray:3 3;stroke-linejoin:round}
.cortexai-agent-hub-line-area{fill:var(--cortexai-agent-hub-c1);fill-opacity:var(--cortexai-agent-hub-area)}
.cortexai-agent-hub-annotation line{stroke:var(--cortexai-agent-hub-line-strong)}
.cortexai-agent-hub-annotation circle{stroke:var(--background);stroke-width:1.5}
.cortexai-agent-hub-annotation text{fill:var(--cortexai-agent-hub-secondary);font-size:12px;paint-order:stroke;stroke:var(--background);stroke-width:3px;stroke-linejoin:round}
.cortexai-agent-hub-hover-dot{stroke:var(--background);stroke-width:2}
.cortexai-agent-hub-bars{display:grid;grid-template-columns:fit-content(min(14rem,40%)) minmax(0,1fr) auto;gap:.625rem .75rem;align-items:center;margin:0;padding:0;list-style:none;font-size:.8125rem;line-height:1.125rem;letter-spacing:.015em}
.cortexai-agent-hub-bar{display:contents}
.cortexai-agent-hub-bar-label{min-width:3rem;overflow-wrap:anywhere;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-bar[data-emphasis="true"] .cortexai-agent-hub-bar-label{color:var(--foreground)}
.cortexai-agent-hub-bar-value{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.cortexai-agent-hub-bar-track{height:6px;border-radius:999px;background:var(--cortexai-agent-hub-fill-strong);overflow:hidden}
.cortexai-agent-hub-bar-fill{display:block;height:100%;border-radius:999px;background:var(--cortexai-agent-hub-rest)}
.cortexai-agent-hub-bar[data-emphasis="true"] .cortexai-agent-hub-bar-fill{background:var(--cortexai-agent-hub-c1)}
.cortexai-agent-hub-pie{display:flex;flex-wrap:wrap;align-items:center;gap:1rem 1.5rem}
.cortexai-agent-hub-pie-ring{position:relative;flex:none;width:120px;height:120px}
.cortexai-agent-hub-pie svg{display:block;width:120px;height:120px}
.cortexai-agent-hub-pie-total{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
.cortexai-agent-hub-pie-total-figure{font-size:.875rem;line-height:1.25rem;font-weight:500;font-variant-numeric:tabular-nums}
.cortexai-agent-hub-pie-total-label{font-size:.75rem;line-height:1rem;color:var(--cortexai-agent-hub-axis)}
.cortexai-agent-hub-pie-legend{display:flex;flex-direction:column;gap:.375rem;margin:0;padding:0;list-style:none;font-size:.8125rem;line-height:1.125rem;letter-spacing:.015em}
.cortexai-agent-hub-pie-legend li{display:flex;align-items:baseline;gap:.5rem;font-variant-numeric:tabular-nums;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-pie-legend li::before{content:"";flex:none;align-self:center;width:8px;height:8px;border-radius:50%;background:var(--cortexai-agent-hub-swatch)}
.cortexai-agent-hub-pie-legend li[data-emphasis] .cortexai-agent-hub-pie-value{color:var(--foreground);font-weight:500}
.cortexai-agent-hub-pie-share{color:var(--cortexai-agent-hub-axis)}
.cortexai-agent-hub-diagram{overflow-x:auto;-webkit-overflow-scrolling:touch}
.cortexai-agent-hub-diagram svg{display:block;width:100%;height:auto;overflow:visible}
.cortexai-agent-hub-diagram-node{fill:var(--background);stroke:var(--cortexai-agent-hub-line);stroke-width:1.25}
.cortexai-agent-hub-diagram-label{fill:var(--foreground);font-size:14px;font-weight:500}
.cortexai-agent-hub-diagram-detail{fill:var(--cortexai-agent-hub-secondary);font-size:12.5px}
.cortexai-agent-hub-diagram-edge{fill:none;stroke:var(--cortexai-agent-hub-tertiary);stroke-width:1.5}
.cortexai-agent-hub-diagram-arrow{fill:none;stroke:var(--cortexai-agent-hub-tertiary);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.cortexai-agent-hub-diagram-edge-label{fill:var(--cortexai-agent-hub-secondary);font-size:12px;paint-order:stroke;stroke:var(--background);stroke-width:5px;stroke-linejoin:round}
.cortexai-agent-hub-sources{margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--cortexai-agent-hub-hairline);font-size:.8125rem;line-height:1.5;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-sources-heading{margin:0 0 .3rem;font-size:.8125rem;font-weight:500;color:var(--foreground)}
.cortexai-agent-hub-sources ol{margin:0;padding-left:1.2rem}
.cortexai-agent-hub-error{width:100%;max-width:640px;margin:0 auto;padding:1rem 1.2rem;border:1px solid var(--cortexai-agent-hub-line);border-radius:12px}
.cortexai-agent-hub-error-title{margin:0 0 .4rem;font-size:1rem;font-weight:600}
.cortexai-agent-hub-error pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:.8rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--cortexai-agent-hub-secondary)}
@media (min-width:721px){[data-touch] .cortexai-agent-hub-page{padding:2rem 2rem calc(2.5rem + var(--cortexai-agent-hub-bottom-inset,0px))}[data-touch] .cortexai-agent-hub-header{margin-bottom:1.5rem}[data-touch] .cortexai-agent-hub-properties{gap:.52rem}}
@media (max-width:720px){
.cortexai-agent-hub-page{padding:1.5rem 1rem calc(2rem + var(--cortexai-agent-hub-bottom-inset,0px));gap:.75rem}
.cortexai-agent-hub-header{gap:.5rem;margin-bottom:.75rem}
.cortexai-agent-hub-title{font-size:1.625rem}
.cortexai-agent-hub-heading{font-size:1.25rem}
.cortexai-agent-hub-page>.cortexai-agent-hub-section{margin-bottom:0}
.cortexai-agent-hub-page>:not(.cortexai-agent-hub-header)+.cortexai-agent-hub-section[data-headed]{margin-top:1rem}
.cortexai-agent-hub-section[data-card]{padding:1rem .875rem 1.125rem}
.cortexai-agent-hub-grid{grid-template-columns:minmax(0,1fr)}
.cortexai-agent-hub-properties{grid-template-columns:fit-content(45%) minmax(0,1fr)}
.cortexai-agent-hub-table th,.cortexai-agent-hub-table[data-wide] td{white-space:nowrap}
.cortexai-agent-hub-metrics{gap:1.25rem 1rem;--cortexai-agent-hub-columns:2!important}
}
@media print{
html{font-size:14px}
:root,[data-theme]{${printTokens}${LIGHT_PALETTE};color-scheme:light}
.cortexai-agent-hub-page{max-width:none;padding:0}
.cortexai-agent-hub-section[data-card],.cortexai-agent-hub-properties[data-card],.cortexai-agent-hub-table tr,.cortexai-agent-hub-chart,.cortexai-agent-hub-pie,.cortexai-agent-hub-diagram,.cortexai-agent-hub-callout{break-inside:avoid}
.cortexai-agent-hub-heading{break-after:avoid}
}
`;

/**
 * The vertical rhythm inside a section, last so it wins over each block's own margin reset: a
 * heading holds its first block close, prose runs at reading distance, separate blocks get room,
 * and a nested section gets the most. Cards use the tighter set.
 */
const RHYTHM_CSS = `
.cortexai-agent-hub-section,.cortexai-agent-hub-section-body{gap:0;--cortexai-agent-hub-lead:.75rem;--cortexai-agent-hub-prose:1rem;--cortexai-agent-hub-block:1.25rem;--cortexai-agent-hub-sub:1.75rem}
.cortexai-agent-hub-section[data-card]{--cortexai-agent-hub-prose:.75rem;--cortexai-agent-hub-block:1rem;--cortexai-agent-hub-sub:1.25rem}
@media (max-width:720px){.cortexai-agent-hub-section,.cortexai-agent-hub-section-body{--cortexai-agent-hub-lead:.625rem;--cortexai-agent-hub-block:1rem;--cortexai-agent-hub-sub:1.5rem}.cortexai-agent-hub-section[data-card]{--cortexai-agent-hub-block:.875rem}}
:is(.cortexai-agent-hub-section,.cortexai-agent-hub-section-body)>*+*{margin-top:var(--cortexai-agent-hub-block)}
:is(.cortexai-agent-hub-section,.cortexai-agent-hub-section-body)>:is(.cortexai-agent-hub-text,.cortexai-agent-hub-list)+:is(.cortexai-agent-hub-text,.cortexai-agent-hub-list){margin-top:var(--cortexai-agent-hub-prose)}
:is(.cortexai-agent-hub-section,.cortexai-agent-hub-section-body)>:is(.cortexai-agent-hub-segmented,.cortexai-agent-hub-section-head)+*{margin-top:var(--cortexai-agent-hub-lead)}
:is(.cortexai-agent-hub-section,.cortexai-agent-hub-section-body)>.cortexai-agent-hub-caption[data-figure]{margin-top:.5rem}
:is(.cortexai-agent-hub-section,.cortexai-agent-hub-section-body)>*+.cortexai-agent-hub-section{margin-top:var(--cortexai-agent-hub-sub)}
.cortexai-agent-hub-section>.cortexai-agent-hub-section-head+.cortexai-agent-hub-section-fold:not([data-open]){margin-top:0}
`;

export const PAGE_STYLES = `${renderTokensCss()}\n${KIT_CSS}\n${TEXT_KIT_CSS}\n${DATAVIZ_CSS}\n${CONTROLS_CSS}\n${MEDIA_CSS}\n${CALENDAR_CSS}\n${RHYTHM_CSS}`;
