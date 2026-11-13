import { pageKitPalette } from "@cortexai-agent-hub/ui-tokens";
// Charts and data display. Kept apart from the base kit styles so each family reads on its own.
export const DATAVIZ_CSS = `
:root{--cortexai-agent-hub-axis:color-mix(in srgb,var(--foreground) 58%,transparent);--cortexai-agent-hub-hover:color-mix(in srgb,var(--foreground) 4%,transparent);--cortexai-agent-hub-hover-strong:color-mix(in srgb,var(--foreground) 12%,transparent);--cortexai-agent-hub-line-strong:color-mix(in srgb,var(--foreground) 30%,transparent);--cortexai-agent-hub-hairline-soft:color-mix(in srgb,var(--foreground) 6%,transparent);--cortexai-agent-hub-fill-strong:${pageKitPalette.dark.fillStrong};--cortexai-agent-hub-surface:color-mix(in srgb,var(--foreground) 7%,var(--background))}
[data-theme="light"]{--cortexai-agent-hub-fill-strong:${pageKitPalette.light.fillStrong};--cortexai-agent-hub-surface:var(--background)}
.cortexai-agent-hub-chart{position:relative}
.cortexai-agent-hub-frame{padding:1.25rem;border:1px solid var(--cortexai-agent-hub-line);border-radius:16px}
:is(.cortexai-agent-hub-section[data-card],.cortexai-agent-hub-grid>*,.cortexai-agent-hub-frame) .cortexai-agent-hub-frame{padding:0;border:0;border-radius:0}
.cortexai-agent-hub-axis-arrow{display:inline-block;width:.7rem;height:.7rem;margin-inline-start:.25rem;vertical-align:-.05rem;fill:none;stroke:currentColor;stroke-width:1.2;stroke-linecap:round;stroke-linejoin:round}
.cortexai-agent-hub-bar[data-negative] .cortexai-agent-hub-bar-fill{background:var(--cortexai-agent-hub-negative)}
.cortexai-agent-hub-bar[data-negative] .cortexai-agent-hub-bar-value{color:var(--cortexai-agent-hub-danger)}
.cortexai-agent-hub-sort-mark{width:.7rem;height:.7rem;fill:none;stroke:currentColor;stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round}
.cortexai-agent-hub-sort-mark[data-down]{transform:rotate(180deg)}
.cortexai-agent-hub-delta-arrow{width:.5rem;height:.5rem;fill:currentColor;align-self:center}
.cortexai-agent-hub-table[data-wide] td:first-child{min-width:8rem}
.cortexai-agent-hub-tone-success.cortexai-agent-hub-tone-success{color:var(--cortexai-agent-hub-success)}
.cortexai-agent-hub-tone-warning.cortexai-agent-hub-tone-warning{color:var(--cortexai-agent-hub-warning)}
.cortexai-agent-hub-tone-danger.cortexai-agent-hub-tone-danger{color:var(--cortexai-agent-hub-danger)}
.cortexai-agent-hub-tone-accent.cortexai-agent-hub-tone-accent{color:var(--cortexai-agent-hub-accent)}
.cortexai-agent-hub-rows[data-leads]{display:grid;grid-template-columns:auto minmax(0,1fr) auto}
.cortexai-agent-hub-rows[data-leads] .cortexai-agent-hub-row{grid-column:1/-1;grid-template-columns:subgrid}
.cortexai-agent-hub-plot{position:relative}
.cortexai-agent-hub-chart svg text{font-family:var(--cortexai-agent-hub-font)}
.cortexai-agent-hub-tick{fill:var(--cortexai-agent-hub-axis);font-size:12px;letter-spacing:.01em;font-variant-numeric:tabular-nums}
.cortexai-agent-hub-grid-line{stroke:var(--cortexai-agent-hub-hairline-soft);shape-rendering:crispEdges}
.cortexai-agent-hub-key{margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:.25rem 1rem;font-size:.75rem;line-height:1rem;letter-spacing:.01em;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-key-item{display:inline-flex;align-items:center;gap:.375rem;min-width:0}
.cortexai-agent-hub-key-dot{flex:none;width:8px;height:8px;border-radius:50%}
.cortexai-agent-hub-key-dot[data-small]{width:6px;height:6px}
.cortexai-agent-hub-chart .cortexai-agent-hub-key-line{display:block;flex:none;width:14px;height:2px;overflow:visible}
.cortexai-agent-hub-chart>.cortexai-agent-hub-key+*{margin-top:-.15rem}
.cortexai-agent-hub-column-value{fill:var(--cortexai-agent-hub-axis);font-size:12px;letter-spacing:.01em;font-variant-numeric:tabular-nums}
[data-emphasis] .cortexai-agent-hub-column-value,[data-emphasis] .cortexai-agent-hub-column-label{fill:var(--foreground);font-weight:500}
.cortexai-agent-hub-reference-line{stroke:var(--cortexai-agent-hub-secondary);stroke-dasharray:3 3;shape-rendering:crispEdges}
.cortexai-agent-hub-reference-label{fill:var(--cortexai-agent-hub-secondary);font-size:12px;font-weight:500;paint-order:stroke;stroke:var(--background);stroke-width:4px;stroke-linejoin:round}
.cortexai-agent-hub-trend{stroke:var(--cortexai-agent-hub-tertiary);stroke-width:1.5;stroke-dasharray:4 3}
.cortexai-agent-hub-dot{stroke:var(--background);stroke-width:1}
.cortexai-agent-hub-outlier{fill:var(--cortexai-agent-hub-secondary);font-size:11.5px;paint-order:stroke;stroke:var(--background);stroke-width:3px;stroke-linejoin:round}
.cortexai-agent-hub-stacked{display:grid;grid-template-columns:fit-content(min(12rem,40%)) minmax(0,1fr);gap:.75rem .75rem;align-items:center;font-size:.8125rem;line-height:1.125rem;letter-spacing:.015em}
.cortexai-agent-hub-stacked-row{display:contents}
.cortexai-agent-hub-stacked-label{min-width:3rem;text-align:right;color:var(--cortexai-agent-hub-secondary);overflow-wrap:anywhere}
.cortexai-agent-hub-stacked-track{display:flex;align-items:center;gap:.5rem;min-width:0}
.cortexai-agent-hub-stacked-bar{display:flex;gap:2px;height:10px;min-width:2px}
.cortexai-agent-hub-stacked-part{display:block;min-width:2px;border-radius:2px}
.cortexai-agent-hub-stacked-part:first-child{border-radius:0 2px 2px 0}
.cortexai-agent-hub-stacked-value{flex:none;font-variant-numeric:tabular-nums;white-space:nowrap}
.cortexai-agent-hub-ramp{display:flex;align-items:center;gap:4px;font-size:.75rem;line-height:1rem;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-ramp-step{width:16px;height:10px;border-radius:2px}
.cortexai-agent-hub-heatmap-scroll,.cortexai-agent-hub-calendar-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:2px}
.cortexai-agent-hub-heatmap{display:grid;grid-template-columns:max-content repeat(var(--cortexai-agent-hub-heat-columns),minmax(8px,3.375rem));gap:3px;font-size:.75rem;line-height:1rem;color:var(--cortexai-agent-hub-secondary);width:max-content;max-width:100%;min-width:0}
.cortexai-agent-hub-heatmap-column{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-bottom:3px}
.cortexai-agent-hub-heatmap[data-thin] .cortexai-agent-hub-heatmap-column{overflow:visible}
.cortexai-agent-hub-heatmap-row{padding:6px 8px 0 0;max-width:9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cortexai-agent-hub-heatmap-cell{height:27px;border-radius:4px;outline-offset:1px}
.cortexai-agent-hub-calendar{position:relative;display:flex;flex-direction:column;gap:1rem;min-width:0}
.cortexai-agent-hub-calendar-grid{display:grid;grid-template-columns:auto repeat(var(--cortexai-agent-hub-weeks),12px);grid-template-rows:16px repeat(7,12px);gap:3px;width:max-content;font-size:.6875rem;line-height:1rem;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-calendar-month{font-size:.75rem;white-space:nowrap;align-self:start;line-height:12px}
.cortexai-agent-hub-calendar-weekday{padding-right:5px;line-height:12px}
.cortexai-agent-hub-day{border-radius:2px}
.cortexai-agent-hub-day[data-active],.cortexai-agent-hub-heatmap-cell[data-active]{outline:2px solid var(--foreground);outline-offset:1px}
.cortexai-agent-hub-calendar-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.25rem 1rem;font-size:.75rem;line-height:1rem;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-venn svg{overflow:visible}
.cortexai-agent-hub-venn-set{fill-opacity:.24;stroke-width:1}
[data-theme="light"] .cortexai-agent-hub-venn-set{fill-opacity:.16}
.cortexai-agent-hub-venn-name{fill:var(--foreground);font-size:12px;font-weight:500}
.cortexai-agent-hub-venn-count{fill:var(--cortexai-agent-hub-secondary);font-size:12px;font-variant-numeric:tabular-nums}
.cortexai-agent-hub-venn-overlap{fill:var(--foreground);font-size:12px;font-weight:500;font-variant-numeric:tabular-nums}
.cortexai-agent-hub-matrix{display:flex;gap:.5rem;min-width:0}
.cortexai-agent-hub-chart svg[tabindex]{touch-action:pan-y}
.cortexai-agent-hub-matrix-y{display:flex;flex-direction:row;justify-content:space-between;width:1rem;writing-mode:vertical-rl;transform:rotate(180deg);font-size:.75rem;line-height:1rem;color:var(--cortexai-agent-hub-axis);white-space:nowrap;padding-bottom:1.5rem}
.cortexai-agent-hub-matrix-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:.5rem}
.cortexai-agent-hub-matrix-plot{position:relative;height:17rem;border:1px solid var(--cortexai-agent-hub-line);border-radius:10px;background:linear-gradient(var(--cortexai-agent-hub-line),var(--cortexai-agent-hub-line)) 50% 0/1px 100% no-repeat,linear-gradient(var(--cortexai-agent-hub-line),var(--cortexai-agent-hub-line)) 0 50%/100% 1px no-repeat}
.cortexai-agent-hub-matrix-quadrant{position:absolute;max-width:calc(50% - 1.5rem);font-size:.75rem;line-height:1rem;font-weight:500;color:var(--cortexai-agent-hub-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cortexai-agent-hub-matrix-quadrant[data-corner="0"]{left:.75rem;top:.625rem}
.cortexai-agent-hub-matrix-quadrant[data-corner="1"]{left:calc(50% + .75rem);top:.625rem}
.cortexai-agent-hub-matrix-quadrant[data-corner="2"]{left:.75rem;bottom:.5rem}
.cortexai-agent-hub-matrix-quadrant[data-corner="3"]{left:calc(50% + .75rem);bottom:.5rem}
.cortexai-agent-hub-matrix-point{position:absolute;display:flex;align-items:center;gap:5px;transform:translate(-5px,-50%);max-width:45%;font-size:.75rem;line-height:1rem;white-space:nowrap}
.cortexai-agent-hub-matrix-point[data-flip]{flex-direction:row-reverse;transform:translate(calc(-100% + 5px),-50%)}
.cortexai-agent-hub-matrix-dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--cortexai-agent-hub-c1);box-shadow:0 0 0 2px var(--background)}
.cortexai-agent-hub-matrix-point{z-index:1}
.cortexai-agent-hub-matrix-label{overflow:hidden;text-overflow:ellipsis;padding:0 .25rem;border-radius:4px;background:color-mix(in srgb,var(--background) 85%,transparent)}
.cortexai-agent-hub-matrix-x{display:flex;justify-content:space-between;gap:.75rem;font-size:.75rem;line-height:1rem;color:var(--cortexai-agent-hub-axis)}
.cortexai-agent-hub-stamp{display:inline-flex;flex-wrap:wrap;align-items:center;gap:.25rem .5rem;font-size:.75rem;line-height:1rem;letter-spacing:.01em;color:var(--cortexai-agent-hub-axis);font-variant-numeric:tabular-nums}
.cortexai-agent-hub-stamp-pill{padding:.0625rem .5rem;border-radius:999px;background:var(--cortexai-agent-hub-fill-strong);color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-stamp-pill[data-error]{background:color-mix(in srgb,var(--cortexai-agent-hub-warning) 17%,transparent);color:var(--cortexai-agent-hub-warning)}
.cortexai-agent-hub-chart-empty{display:grid;place-items:center;min-height:5rem;border:1px dashed var(--cortexai-agent-hub-line);border-radius:12px;font-size:.8125rem;color:var(--cortexai-agent-hub-axis)}
.cortexai-agent-hub-tip{position:absolute;z-index:3;pointer-events:none;min-width:7rem;max-width:16rem;padding:.5rem .625rem;border-radius:10px;background:var(--cortexai-agent-hub-surface);border:1px solid var(--cortexai-agent-hub-line);box-shadow:0 6px 24px ${pageKitPalette.shared.tipShadow};font-size:.75rem;line-height:1.05rem;color:var(--foreground);font-variant-numeric:tabular-nums;transform:translate(-50%,calc(-100% - 10px));white-space:nowrap}
.cortexai-agent-hub-tip-title{margin-bottom:.2rem;color:var(--cortexai-agent-hub-secondary)}
.cortexai-agent-hub-tip-row{display:flex;align-items:center;gap:.4rem}
.cortexai-agent-hub-tip-row b{margin-left:auto;padding-left:.75rem;font-weight:500}
.cortexai-agent-hub-tip-swatch{flex:none;width:7px;height:7px;border-radius:50%}
.cortexai-agent-hub-crosshair{stroke:var(--cortexai-agent-hub-line);stroke-width:1;shape-rendering:crispEdges}
.cortexai-agent-hub-focus-ring:focus-visible{outline:2px solid var(--ring);outline-offset:4px;border-radius:6px}
.cortexai-agent-hub-chart [data-dim]{opacity:.45;transition:opacity .14s}
@media (prefers-reduced-motion:no-preference){
.cortexai-agent-hub-draw{stroke-dasharray:1;stroke-dashoffset:1;animation:cortexai-agent-hub-draw .7s cubic-bezier(.16,1,.3,1) forwards}
}
@keyframes cortexai-agent-hub-draw{to{stroke-dashoffset:0}}
@media (max-width:720px){
.cortexai-agent-hub-matrix-plot{height:14rem}
}
@media print{
:root,[data-theme]{--cortexai-agent-hub-fill-strong:${pageKitPalette.light.fillStrong};--cortexai-agent-hub-surface:${pageKitPalette.shared.paper}}
.cortexai-agent-hub-tip,.cortexai-agent-hub-table-filter,.cortexai-agent-hub-table-more button{display:none}
.cortexai-agent-hub-table-scroll{-webkit-mask-image:none;mask-image:none;max-height:none!important;overflow:visible}
.cortexai-agent-hub-draw{animation:none!important;stroke-dasharray:none;stroke-dashoffset:0}
.cortexai-agent-hub-heatmap-scroll,.cortexai-agent-hub-calendar-scroll{overflow:visible}
.cortexai-agent-hub-frame,.cortexai-agent-hub-matrix,.cortexai-agent-hub-calendar,.cortexai-agent-hub-venn,.cortexai-agent-hub-stacked{break-inside:avoid}
}
`;
